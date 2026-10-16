"""The agent's side of the on-page overlay: what the agent is doing, its messages, and
questions for the user, shown in the extension's overlay; the user's messages and
answers come back. Goes through the bridge's /agent WebSocket (see link.py).

Everything here is best effort: without a bridge the agent runs as before.
"""

import asyncio
import itertools
import json
import logging

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .config import load_or_create_token

log = logging.getLogger(__name__)

STATES = ("idle", "thinking", "acting", "waiting_user", "done", "stopped")


class PageChannel:
    def __init__(self, name: str, chat: bool, url: str = "ws://127.0.0.1:8765/agent", token: str | None = None):
        self.name, self.chat, self.url = name, chat, url
        self.token = token or load_or_create_token()
        self.ws: ClientConnection | None = None
        self.said: asyncio.Queue[str] = asyncio.Queue()  # messages the user typed in the overlay
        self._answers: dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._reader: asyncio.Task | None = None

    @property
    def connected(self) -> bool:
        return self.ws is not None

    async def open(self) -> bool:
        try:
            self.ws = await asyncio.wait_for(connect(self.url, max_size=4 * 2**20), 3)
            await self.ws.send(json.dumps({"type": "agent_hello", "token": self.token, "name": self.name, "chat": self.chat}))
            if json.loads(await asyncio.wait_for(self.ws.recv(), 3)).get("type") != "welcome":
                raise ConnectionError("no welcome")
        except (OSError, TimeoutError, ConnectionClosed, InvalidStatus, ValueError, ConnectionError) as e:
            log.info("no overlay channel: %s", e)
            self.ws = None
            return False
        self._reader = asyncio.ensure_future(self._read())
        return True

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self.ws:
            await self.ws.close()
            self.ws = None

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                inp = msg.get("input") if msg.get("type") == "agent_input" else None
                if not isinstance(inp, dict):
                    continue
                if inp.get("kind") == "say" and str(inp.get("text", "")).strip():
                    await self.said.put(str(inp["text"]).strip())
                elif inp.get("kind") == "answer":
                    fut = self._answers.get(str(inp.get("id")))
                    if fut and not fut.done():
                        fut.set_result(inp.get("text") or None)
        except (ConnectionClosed, ValueError):
            pass
        finally:
            self.ws = None

    def _send(self, event: dict) -> None:
        if self.ws is None:
            return

        async def send() -> None:
            try:
                await self.ws.send(json.dumps({"type": "agent_event", "event": event}))
            except (ConnectionClosed, AttributeError):
                pass

        asyncio.ensure_future(send())

    def status(self, state: str, text: str = "") -> None:
        self._send({"kind": "status", "state": state, "text": text[:300]})

    def message(self, role: str, text: str) -> None:
        """role: user, agent (the model's words) or note (the driver's)."""
        self._send({"kind": "message", "role": role, "text": text[:4000]})

    async def ask(self, ref: str, block: str, candidates: list[str], timeout: float = 900) -> str | None:
        """Show a question in the overlay and wait for the user's answer (None: left, or no answer)."""
        if self.ws is None:
            return None
        qid = str(next(self._ids))
        fut = asyncio.get_running_loop().create_future()
        self._answers[qid] = fut
        self._send({"kind": "question", "id": qid, "ref": ref, "text": block[:2500], "candidates": candidates[:6]})
        self.status("waiting_user", f"{ref}: your answer is needed")
        try:
            return await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            return None
        finally:
            self._answers.pop(qid, None)
            self._send({"kind": "question_closed", "id": qid})
