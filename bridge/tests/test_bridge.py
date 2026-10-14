"""Bridge tests with a fake extension on the WebSocket side and an in-process MCP client."""

import asyncio
import json
from contextlib import asynccontextmanager

import pytest
from mcp.client import Client
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from practicum_bridge.config import load_tool_specs
from practicum_bridge.link import ExtensionLink
from practicum_bridge.server import build_server, input_schema

TOKEN = "test-token"
ORIGIN = "moz-extension://0000-test"
SPECS = [
    {"name": "echo", "description": "echo", "effect": "read", "timeout_s": 2,
     "params": {"text": {"type": "string", "description": "text"}}},
    {"name": "answer", "description": "irreversible", "effect": "irrev", "timeout_s": 0.5, "params": {}},
]


@asynccontextmanager
async def bridge():
    link = ExtensionLink(TOKEN)
    task = asyncio.create_task(link.serve("127.0.0.1", 0))
    await link.listening.wait()
    try:
        yield link, f"ws://127.0.0.1:{link.port}"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def fake_extension(url, handle, token=TOKEN, tools=SPECS):
    """Connect like the extension and answer calls with `handle(msg) -> reply dict | None`."""
    ws = await connect(url, origin=ORIGIN)
    await ws.send(json.dumps({"type": "hello", "token": token, "version": "test", "tools": tools}))
    assert json.loads(await ws.recv()) == {"type": "welcome"}

    async def loop():
        async for raw in ws:
            msg = json.loads(raw)
            for reply in handle(msg) or []:
                await ws.send(json.dumps(reply))

    return ws, asyncio.create_task(loop())


async def wait_connected(link):
    for _ in range(100):
        if link.connected:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("extension never connected")


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, 10))


def test_round_trip_with_progress():
    async def main():
        async with bridge() as (link, url):
            def handle(msg):
                if msg["type"] == "call":
                    return [{"type": "progress", "id": msg["id"], "text": "working"},
                            {"type": "result", "id": msg["id"], "ok": True, "output": "got " + msg["args"]["text"]}]
            ws, _ = await fake_extension(url, handle)
            await wait_connected(link)
            async with Client(build_server(link, [])) as client:
                tools = {t.name: t for t in (await client.list_tools()).tools}
                assert set(tools) == {"echo", "answer"}
                assert tools["answer"].annotations.destructive_hint is True
                assert tools["echo"].annotations.read_only_hint is True
                seen = []

                async def progress(p, total, message):
                    seen.append(message)

                res = await client.call_tool("echo", {"text": "hi"}, progress_callback=progress)
                assert not res.is_error
                assert res.content[0].text == "got hi"
                assert seen == ["working"]
            await ws.close()
    run(main())


def test_tool_error_kind_is_reported():
    async def main():
        async with bridge() as (link, url):
            def handle(msg):
                if msg["type"] == "call":
                    return [{"type": "result", "id": msg["id"], "ok": False, "error": "user said no", "kind": "denied"}]
            ws, _ = await fake_extension(url, handle)
            await wait_connected(link)
            async with Client(build_server(link, [])) as client:
                res = await client.call_tool("answer", {})
                assert res.is_error and res.content[0].text == "[denied] user said no"
            await ws.close()
    run(main())


def test_not_connected_uses_static_specs():
    async def main():
        async with bridge() as (link, _):
            async with Client(build_server(link, SPECS)) as client:
                assert [t.name for t in (await client.list_tools()).tools] == ["echo", "answer"]
                res = await client.call_tool("echo", {"text": "x"})
                assert res.is_error and res.content[0].text.startswith("[no_extension]")
    run(main())


def test_timeout_sends_cancel():
    async def main():
        async with bridge() as (link, url):
            cancels = []

            def handle(msg):
                if msg["type"] == "cancel":
                    cancels.append(msg["id"])
            ws, _ = await fake_extension(url, handle)
            await wait_connected(link)
            async with Client(build_server(link, [])) as client:
                res = await client.call_tool("answer", {})
                assert res.is_error and res.content[0].text.startswith("[timeout]")
            await asyncio.sleep(0.1)
            assert cancels == ["1"]
            await ws.close()
    run(main())


def test_disconnect_fails_pending_call():
    async def main():
        async with bridge() as (link, url):
            ws, _ = await fake_extension(url, lambda msg: None)
            await wait_connected(link)
            call = asyncio.create_task(link.call("echo", {"text": "x"}, timeout=5))
            await asyncio.sleep(0.1)
            await ws.close()
            with pytest.raises(Exception) as err:
                await call
            assert getattr(err.value, "kind", None) == "disconnected"
    run(main())


def test_bad_token_and_bad_origin_rejected():
    async def main():
        async with bridge() as (link, url):
            ws = await connect(url, origin=ORIGIN)
            await ws.send(json.dumps({"type": "hello", "token": "wrong"}))
            with pytest.raises(ConnectionClosed) as closed:
                await ws.recv()
            assert closed.value.rcvd.code == 4401
            with pytest.raises(InvalidStatus):
                await connect(url, origin="https://evil.example")
            with pytest.raises(InvalidStatus):
                await connect(url)
            assert not link.connected
    run(main())


def test_shared_specs_are_valid():
    specs = load_tool_specs()
    assert specs, "shared/tools.json has no tools"
    for s in specs:
        assert s["effect"] in {"read", "nav", "rev", "irrev"}, s["name"]
        input_schema(s.get("params", {}))


def test_input_schema_required_and_defaults():
    schema = input_schema({
        "a": {"type": "string", "description": "a"},
        "b": {"type": "integer", "description": "b", "optional": True},
        "c": {"type": "string", "description": "c", "enum": ["x", "y"], "default": "x"},
    })
    assert schema["required"] == ["a"]
    assert schema["properties"]["c"] == {"type": "string", "description": "c", "enum": ["x", "y"], "default": "x"}
