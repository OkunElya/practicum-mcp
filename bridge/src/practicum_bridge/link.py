"""WebSocket server the browser extension dials into.

Extensions can't listen on ports, so the extension connects here and the bridge
sends it tool calls. Protocol (JSON text frames):

    ext -> bridge  {"type": "hello", "token", "version", "tools": [...]}
    bridge -> ext  {"type": "welcome"}            (or close 4401 on a bad token)
    bridge -> ext  {"type": "call", "id", "tool", "args"}
    bridge -> ext  {"type": "cancel", "id"}       (MCP request cancelled or timed out)
    ext -> bridge  {"type": "progress", "id", "text"}
    ext -> bridge  {"type": "result", "id", "ok": true, "output"}
                   {"type": "result", "id", "ok": false, "error", "kind"}

An agent driver (practicum-chat, practicum-local-agent) may connect at /agent, so
the on-page overlay can show what it does and pass the user's messages back:

    agent -> bridge  {"type": "agent_hello", "token", "name", "chat": bool}
    bridge -> agent  {"type": "welcome"}
    agent -> bridge  {"type": "agent_event", "event": {...}}   relayed: bridge -> ext {"type": "agent", "event"}
    ext -> bridge    {"type": "agent_input", "input": {...}}   relayed: bridge -> agent {"type": "agent_input", "input"}

Browsers always send an Origin header, so /agent only accepts clients without one
(local processes), and they need the token too.
"""

import asyncio
import hmac
import itertools
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

log = logging.getLogger(__name__)

ProgressFn = Callable[[str], Awaitable[None]]


class ToolCallError(Exception):
    """A failed call. `kind` tells the model why: tool, platform, denied, stopped,
    timeout, no_tab, no_extension, disconnected."""

    def __init__(self, message: str, kind: str = "tool"):
        super().__init__(message)
        self.kind = kind


@dataclass
class _Pending:
    conn: ServerConnection
    future: asyncio.Future[str]
    on_progress: ProgressFn | None


class ExtensionLink:
    def __init__(self, token: str):
        self._token = token
        self._conn: ServerConnection | None = None
        self._pending: dict[str, _Pending] = {}
        self._ids = itertools.count(1)
        self.tools: list[dict] | None = None
        self.version: str | None = None
        self._background: set[asyncio.Task] = set()
        self.port: int | None = None
        self.listening = asyncio.Event()
        self._agent: ServerConnection | None = None
        self._agent_hello: dict | None = None  # replayed to an extension that connects later
        self._agent_status: dict | None = None

    def _spawn(self, coro: Awaitable[None]) -> None:
        # Keep a reference so fire-and-forget tasks aren't garbage-collected mid-flight.
        task = asyncio.ensure_future(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    @property
    def connected(self) -> bool:
        return self._conn is not None

    async def serve(self, host: str, port: int) -> None:
        async with serve(
            self._handle, host, port, process_request=self._check_origin, max_size=16 * 2**20
        ) as server:
            self.port = server.sockets[0].getsockname()[1]
            self.listening.set()
            log.info("waiting for the extension on ws://%s:%d", host, self.port)
            await server.serve_forever()

    @staticmethod
    def _check_origin(conn: ServerConnection, request: Request) -> Response | None:
        # Web pages can open WebSockets to localhost too; only extensions may connect,
        # and on /agent only local processes (no Origin header at all).
        origin = request.headers.get("Origin")
        if request.path == "/agent":
            return conn.respond(403, "agents connect without an Origin header\n") if origin is not None else None
        if not (origin or "").startswith("moz-extension://"):
            return conn.respond(403, "only the Practicum MCP extension may connect\n")
        return None

    async def _send_ext(self, msg: dict) -> None:
        if self._conn is not None:
            try:
                await self._conn.send(json.dumps(msg))
            except ConnectionClosed:
                pass

    async def _handle_agent(self, conn: ServerConnection) -> None:
        try:
            hello = json.loads(await asyncio.wait_for(conn.recv(), 10))
        except (TimeoutError, ValueError, ConnectionClosed):
            await conn.close(4400, "expected agent_hello")
            return
        token = str(hello.get("token", "")) if isinstance(hello, dict) else ""
        if hello.get("type") != "agent_hello" or not hmac.compare_digest(token.encode(), self._token.encode()):
            await conn.close(4401, "bad token")
            return
        if self._agent is not None:
            await self._agent.close(4000, "replaced by a newer agent")
        self._agent = conn
        self._agent_hello = {"kind": "hello", "name": str(hello.get("name", "agent")), "chat": bool(hello.get("chat"))}
        self._agent_status = None
        await conn.send(json.dumps({"type": "welcome"}))
        await self._send_ext({"type": "agent", "event": self._agent_hello})
        log.info("agent %s connected", self._agent_hello["name"])
        try:
            async for raw in conn:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(msg, dict) and msg.get("type") == "agent_event" and isinstance(msg.get("event"), dict):
                    if msg["event"].get("kind") == "status":
                        self._agent_status = msg["event"]
                    await self._send_ext({"type": "agent", "event": msg["event"]})
        except ConnectionClosed:
            pass
        finally:
            if self._agent is conn:
                self._agent = self._agent_hello = self._agent_status = None
                await self._send_ext({"type": "agent", "event": {"kind": "gone"}})
                log.info("agent disconnected")

    async def _handle(self, conn: ServerConnection) -> None:
        if conn.request is not None and conn.request.path == "/agent":
            await self._handle_agent(conn)
            return
        try:
            hello = json.loads(await asyncio.wait_for(conn.recv(), 10))
        except (TimeoutError, ValueError, ConnectionClosed):
            await conn.close(4400, "expected hello")
            return
        token = str(hello.get("token", "")) if isinstance(hello, dict) else ""
        if hello.get("type") != "hello" or not hmac.compare_digest(token.encode(), self._token.encode()):
            log.warning("rejected extension connection: bad token")
            await conn.close(4401, "bad token")
            return

        if self._conn is not None:
            await self._conn.close(4000, "replaced by a newer connection")
        self._conn = conn
        self.tools = hello.get("tools") if isinstance(hello.get("tools"), list) else None
        self.version = hello.get("version")
        await conn.send(json.dumps({"type": "welcome"}))
        log.info("extension %s connected", self.version)
        for event in (self._agent_hello, self._agent_status):  # an agent that was already running
            if event:
                await conn.send(json.dumps({"type": "agent", "event": event}))

        try:
            async for raw in conn:
                await self._on_message(raw)
        except ConnectionClosed:
            pass
        finally:
            if self._conn is conn:
                self._conn = None
                log.info("extension disconnected")
            for p in [p for p in self._pending.values() if p.conn is conn]:
                if not p.future.done():
                    p.future.set_exception(
                        ToolCallError("the browser extension disconnected during the call", "disconnected")
                    )

    async def _on_message(self, raw: str | bytes) -> None:
        try:
            msg = json.loads(raw)
            pending = self._pending.get(str(msg.get("id")))
        except (ValueError, AttributeError):
            log.warning("ignoring malformed message from the extension")
            return
        if msg.get("type") == "agent_input":
            if self._agent is not None and isinstance(msg.get("input"), dict):
                try:
                    await self._agent.send(json.dumps({"type": "agent_input", "input": msg["input"]}))
                except ConnectionClosed:
                    pass
            return
        if pending is None or pending.future.done():
            return
        if msg.get("type") == "progress":
            # Awaited, not spawned, so progress can't overtake the result that follows it.
            if pending.on_progress:
                try:
                    await asyncio.wait_for(pending.on_progress(str(msg.get("text", ""))), 2)
                except Exception:
                    log.debug("progress callback failed", exc_info=True)
        elif msg.get("type") == "result":
            if msg.get("ok"):
                pending.future.set_result(str(msg.get("output", "")))
            else:
                pending.future.set_exception(
                    ToolCallError(str(msg.get("error", "unknown error")), str(msg.get("kind", "tool")))
                )

    async def call(
        self, tool: str, args: dict, timeout: float, on_progress: ProgressFn | None = None
    ) -> str:
        conn = self._conn
        if conn is None:
            raise ToolCallError(
                "the browser extension is not connected. Ask the user to open Waterfox with the "
                "Practicum MCP extension and check its toolbar popup.",
                "no_extension",
            )
        call_id = str(next(self._ids))
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = _Pending(conn, future, on_progress)
        try:
            await conn.send(json.dumps({"type": "call", "id": call_id, "tool": tool, "args": args}))
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            self._cancel(conn, call_id)
            raise ToolCallError(f"{tool} did not finish within {timeout:.0f} s and was stopped", "timeout")
        except asyncio.CancelledError:
            self._cancel(conn, call_id)
            raise
        except ConnectionClosed:
            raise ToolCallError("the browser extension disconnected", "disconnected")
        finally:
            self._pending.pop(call_id, None)

    def _cancel(self, conn: ServerConnection, call_id: str) -> None:
        async def send() -> None:
            try:
                await conn.send(json.dumps({"type": "cancel", "id": call_id}))
            except ConnectionClosed:
                pass

        self._spawn(send())
