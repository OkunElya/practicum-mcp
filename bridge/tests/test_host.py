"""Agent mode: the bridge runs the agent; the (fake) extension's sidebar talks to it."""

import asyncio
import json

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from practicum_bridge.host import AgentHost
from practicum_bridge.platform_agent import ThinkSplitter, Turn, split_think

from test_bridge import SPECS, TOKEN, bridge, fake_extension, run, wait_connected

TOOLS = SPECS + [{"name": "where_am_i", "description": "where", "effect": "read", "timeout_s": 2, "params": {}}]


class FakeBackend:
    """Replies from a script; streams a little thinking and text first, like Ollama."""

    name = "fake"
    hidden: set = set()
    finish_hint = "write the answer"

    def __init__(self, note, stream, script):
        self.note, self.stream, self.script = note, stream, script

    async def start(self, tools, full):
        return True

    async def reset(self):
        return True

    def user(self, text, page_changed, page):
        pass

    async def turn(self):
        step = self.script.pop(0)
        if callable(step):
            step = await step()
        self.stream("fake thinking", "\n\n")
        self.stream("fake thinking", "hmm")
        if step.answer:
            self.stream("fake", step.answer)
        self.note("tokens", "prompt 10/100, reply 2")
        self.note(self.name, step.answer or "CALL …")
        return step

    def nudge(self, text):
        pass

    def off_format(self):
        pass

    def results(self, done, bad, page_changed):
        pass


def answering(seen, hang=()):
    """A fake extension that records everything and answers calls (except tools in `hang`)."""

    def handle(msg):
        seen.append(msg)
        if msg["type"] == "call" and msg["tool"] not in hang:
            out = "URL: https://practicum.yandex.ru/x" if msg["tool"] == "where_am_i" else f"ran {msg['tool']}"
            return [{"type": "result", "id": msg["id"], "ok": True, "output": out}]
        return None

    return handle


async def until(pred, what="condition"):
    for _ in range(300):
        if pred():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def events(seen):
    return [m["event"] for m in seen if m["type"] == "agent"]


def setup_host(link, tmp_path, script):
    host = AgentHost(link, TOOLS, log_path=tmp_path / "agent.log",
                     make_backend=lambda client, note, cfg: FakeBackend(note, host.stream, script))
    host._ollama_models = lambda: ["fake", "other"]
    link.host = host
    return host


AGENT_MODE = {"type": "mode", "mode": "agent", "agent": {"backend": "ollama", "model": "", "think": ""}}


def test_agent_mode_runs_a_message_end_to_end(tmp_path):
    async def main():
        async with bridge() as (link, url):
            script = [Turn([{"tool": "echo", "args": {"text": "hi"}}], None, []), Turn([], "Готово.", [])]
            host = setup_host(link, tmp_path, script)
            seen = []
            ws, task = await fake_extension(url, answering(seen), tools=TOOLS)
            await wait_connected(link)
            await ws.send(json.dumps(AGENT_MODE))
            await until(lambda: any(e["kind"] == "status" and e["state"] == "idle" for e in events(seen)), "idle")
            evs = events(seen)
            assert evs[0] == {"kind": "hello", "name": "Agent", "chat": True}
            assert evs[1] == {"kind": "models", "models": ["fake", "other"], "platform": True, "current": "fake"}

            await ws.send(json.dumps({"type": "agent_input", "input": {"kind": "say", "text": "пройди урок"}}))
            await until(lambda: any(e["kind"] == "status" and e["state"] == "done" for e in events(seen)), "done")

            calls = [m for m in seen if m["type"] == "call"]
            assert {c["source"] for c in calls} == {"agent"}
            assert "echo" in [c["tool"] for c in calls]
            evs = events(seen)
            kinds = [(e["kind"], e.get("role") or e.get("part")) for e in evs]
            assert ("message", "user") in kinds
            # Streamed thinking and text, without the blank lines the reply starts with.
            deltas = [e for e in evs if e["kind"] == "delta"]
            assert deltas[0]["part"] == "thinking" and deltas[0]["text"] == "hmm"
            assert {"kind": "delta", "turn": deltas[-1]["turn"], "part": "text", "text": "Готово."} in evs
            assert any(e["kind"] == "turn_end" for e in evs)
            # The answer arrives once streamed and once as the final message (the sidebar merges them);
            # the model's text note isn't sent again.
            assert [e["text"] for e in evs if e["kind"] == "message" and e["role"] == "agent"] == ["Готово."]
            # The order in the timeline: user message, then the call, then the answer.
            # Seen live: the call overtook the message that led to it. The order in the timeline:
            # the session's first look at the page, the user's message, its calls, the answer.
            order = [m.get("tool") or m.get("event", {}).get("role") for m in seen if m["type"] == "call" or (m["type"] == "agent" and m["event"]["kind"] == "message" and m["event"]["role"] in ("user", "agent"))]
            assert order == ["where_am_i", "user", "where_am_i", "echo", "where_am_i", "agent"]
            assert (tmp_path / "agent.log").read_text().count("── fake ──") == 2
            await ws.close()
            task.cancel()
            assert host.active

    run(main())


def test_stop_cancels_the_run_and_the_running_call(tmp_path):
    async def main():
        async with bridge() as (link, url):
            script = [Turn([{"tool": "echo", "args": {"text": "slow"}}], None, [])]
            setup_host(link, tmp_path, script)
            seen = []
            ws, task = await fake_extension(url, answering(seen, hang={"echo"}), tools=TOOLS)
            await wait_connected(link)
            await ws.send(json.dumps(AGENT_MODE))
            await until(lambda: any(e["kind"] == "models" for e in events(seen)), "models")
            await ws.send(json.dumps({"type": "agent_input", "input": {"kind": "say", "text": "go"}}))
            await until(lambda: any(m["type"] == "call" and m["tool"] == "echo" for m in seen), "the call")
            await ws.send(json.dumps({"type": "agent_input", "input": {"kind": "stop"}}))
            await until(lambda: any(m["type"] == "cancel" for m in seen), "cancel")
            await until(lambda: any(e["kind"] == "status" and e["state"] == "stopped" for e in events(seen)), "stopped")
            await until(lambda: any(e["kind"] == "message" and e["text"].startswith("stopped") for e in events(seen)), "note")
            await ws.close()
            task.cancel()

    run(main())


def test_question_answered_from_the_sidebar(tmp_path):
    async def main():
        async with bridge() as (link, url):
            host = setup_host(link, tmp_path, [])
            seen = []
            ws, task = await fake_extension(url, answering(seen), tools=TOOLS)
            await wait_connected(link)
            await ws.send(json.dumps(AGENT_MODE))
            await until(lambda: host.active, "agent mode")
            asked = asyncio.ensure_future(host.channel.ask("q3", "Какой код?", ["1", "2"]))
            await until(lambda: any(e["kind"] == "question" for e in events(seen)), "question")
            qid = next(e["id"] for e in events(seen) if e["kind"] == "question")
            await ws.send(json.dumps({"type": "agent_input", "input": {"kind": "answer", "id": qid, "text": "2"}}))
            assert await asked == "2"
            await until(lambda: {"kind": "question_closed", "id": qid} in events(seen), "closed")
            await ws.close()
            task.cancel()

    run(main())


def test_mcp_mode_ends_the_agent_and_agent_mode_holds_the_slot(tmp_path):
    async def main():
        async with bridge() as (link, url):
            host = setup_host(link, tmp_path, [])
            seen = []
            ws, task = await fake_extension(url, answering(seen), tools=TOOLS)
            await wait_connected(link)
            await ws.send(json.dumps(AGENT_MODE))
            await until(lambda: host.active, "agent mode")

            # One agent at a time: practicum-chat can't attach while the browser's agent runs.
            other = await connect(f"{url}/agent")
            await other.send(json.dumps({"type": "agent_hello", "token": TOKEN, "name": "cli", "chat": True}))
            with pytest.raises(ConnectionClosed) as e:
                await other.recv()
            assert e.value.rcvd.code == 4409

            # An extension that reconnects gets the agent replayed.
            ws2, task2 = await fake_extension(url, answering(seen2 := []), tools=TOOLS)
            await until(lambda: len(events(seen2)) >= 3, "replay")
            assert {e["kind"] for e in events(seen2)} >= {"hello", "models", "status"}

            await ws2.send(json.dumps({"type": "mode", "mode": "mcp", "agent": {}}))
            await until(lambda: not host.active, "agent mode off")
            await until(lambda: {"kind": "gone"} in events(seen2), "gone")
            for w, t in ((ws, task), (ws2, task2)):
                await w.close()
                t.cancel()

    run(main())


def test_think_tags_split_across_chunks():
    sp = ThinkSplitter()
    out = []
    for chunk in ["<thi", "nk>hm", "m</th", "ink>Ответ <", "b>"]:
        out += sp.feed(chunk)
    out += sp.flush()
    joined = {p: "".join(t for q, t in out if q == p) for p in ("thinking", "text")}
    assert joined == {"thinking": "hmm", "text": "Ответ <b>"}
    assert split_think("<think>a</think>b") == ("a", "b")
    assert split_think("no tags") == ("", "no tags")
