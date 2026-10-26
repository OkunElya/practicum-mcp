"""The agent the bridge runs itself in agent mode: you talk to it in the extension's sidebar.

The extension tells the bridge its mode ({"type": "mode"}, see link.py). In agent
mode this host announces an agent to the sidebar, lists the Ollama models and
Strata's ("strata/<id>") for its picker, and on the first message opens the same Session that practicum-chat uses
(platform_agent.py), with tools called straight through the extension link (tagged
"agent", so the sidebar tells them from an outside MCP client's calls).

What reaches the sidebar:
- the model's reply and thinking, streamed (delta / turn_end);
- the driver's notes (refusals, page changes, the summary) as messages;
- status (thinking, acting, waiting for you, done, stopped);
- the lesson solver's questions, answered in the sidebar.
Tool calls themselves are shown by the extension, which runs them.

Messages typed while a run is going wait for it to end. Stop cancels the run,
New chat drops the conversation, /continue lets the model go on after the round
limit. Everything is also appended to the agent log.
"""

import asyncio
import json
import logging
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

from .agent_link import HostedChannel
from .config import CONFIG_DIR
from .link import ExtensionLink, ToolCallError
from .platform_agent import STRATA_KEY, OllamaBackend, Outcome, PlatformBackend, Session, StrataBackend, is_strata, local_backend
from .server import text_result, to_mcp_tool

log = logging.getLogger(__name__)

DEFAULT_LOG = CONFIG_DIR / "agent.log"
AGENT_NAME = "Agent"
# Note kinds that are shown elsewhere or are only for the log.
QUIET = {"round", "user message", "reset chat", "done", "driver summary", "tokens", "resend (new chat)"}
HINTS = {
    1: "the model or the bridge failed (see the notes above); send a message to try again",
    2: "round limit reached; /continue lets the model keep going",
    3: "stopped after repeated failed checks; tell the agent what to do next",
    4: "stopped: the model kept repeating a failing call; tell it what to do differently",
    5: "stopped: no progress for several rounds; see the driver summary",
}


class LinkClient:
    """What Session and the backends use of mcp.client.Client, served by the extension link directly."""

    def __init__(self, link: ExtensionLink, static_specs: list[dict]):
        self.link, self.static_specs = link, static_specs

    def specs(self) -> list[dict]:
        return self.link.tools if self.link.connected and self.link.tools else self.static_specs

    async def list_tools(self):
        return SimpleNamespace(tools=[to_mcp_tool(s) for s in self.specs()])

    async def call_tool(self, name: str, arguments: dict | None = None, **_):
        spec = next((s for s in self.specs() if s["name"] == name), None)
        if spec is None:
            return text_result(f"unknown tool {name!r}", is_error=True)
        try:
            out = await self.link.call(name, dict(arguments or {}), float(spec.get("timeout_s", 60)), source="agent")
        except ToolCallError as e:
            return text_result(f"[{e.kind}] {e}", is_error=True)
        return text_result(out)


class AgentHost:
    def __init__(
        self,
        link: ExtensionLink,
        specs: list[dict],
        ollama: str = "http://127.0.0.1:11434",
        model: str | None = None,
        rounds: int | None = None,
        log_path: Path = DEFAULT_LOG,
        make_backend: Callable | None = None,  # (client, note, config) -> backend; for tests
        strata: str = "",  # Strata's OpenAI-compatible base URL; empty: don't look for it
    ):
        self.link, self.ollama, self.default_model, self.rounds = link, ollama.rstrip("/"), model, rounds
        self.strata = strata.rstrip("/")
        self.client = LinkClient(link, specs)
        self.make_backend = make_backend
        self.log_path = log_path
        self.config: dict = {}
        self.model = ""
        self.channel: HostedChannel | None = None
        self.session: Session | None = None
        self.backend = None
        self.worker: asyncio.Task | None = None
        self.run: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self.turn = 0  # one per model reply, for grouping streamed chunks; never reset
        self.streamed: set[tuple[int, str]] = set()
        self.tokens = ""
        self.loop: asyncio.AbstractEventLoop | None = None
        self._log = None

    @property
    def active(self) -> bool:
        return self.channel is not None

    # ── mode ────────────────────────────────────────────────────────────────

    async def set_mode(self, mode: str, config: dict) -> None:
        cfg = {
            "backend": "platform" if config.get("backend") == "platform" else "ollama",
            "model": str(config.get("model") or ""),
            "think": str(config.get("think") or ""),
        }
        async with self.lock:
            if mode != "agent":
                await self._stop()
                return
            if self.channel is not None:
                if cfg == self.config:
                    return  # the extension reconnected; link.py replayed the agent to it
                same_server = is_strata(cfg["model"] or self.default_model or self.model) == isinstance(self.backend, StrataBackend)
                if cfg["backend"] == self.config["backend"] == "ollama" and isinstance(self.backend, OllamaBackend) and same_server:
                    await self._retune(cfg)  # same conversation, another model or effort
                    return
                await self._stop()
            self.config = cfg
            await self._start()

    async def _start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.channel = HostedChannel(AGENT_NAME, self._emit)
        self.link.emit_agent({"kind": "hello", "name": AGENT_NAME, "chat": True})
        models = await asyncio.to_thread(self._ollama_models) + await asyncio.to_thread(self._strata_models)
        self.model = self.config["model"] or self.default_model or (models[0] if models else "")
        self.link.emit_agent({"kind": "models", "models": models, "platform": True, "current": self.model})
        self.worker = asyncio.create_task(self._work())
        if self.config["backend"] == "ollama" and not self.model:
            self.channel.status("stopped", "no local model found: start Ollama or Strata, or pick Практикум ИИ")
        else:
            self.channel.status("idle", f"{self._who()} · waiting for your message")
        log.info("agent mode: %s", self._who())

    async def _retune(self, cfg: dict) -> None:
        self.config = cfg
        model = cfg["model"] or self.default_model or self.model
        if model != self.backend.model:
            await self.backend.set_model(model)
            self.channel.message("note", f"model: {model} (the conversation goes on)")
        self.model = model
        self.backend.think = cfg["think"] or None

    async def _stop(self) -> None:
        for task in (self.run, self.worker):
            if task and not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.run = self.worker = None
        self.session = self.backend = None
        if self.channel is not None:
            self.channel = None
            self.link.emit_agent({"kind": "gone"})
            log.info("agent mode off")

    def _who(self) -> str:
        if self.config.get("backend") == "platform":
            return "Практикум ИИ"
        return self.model + (f", think {self.config['think']}" if self.config.get("think") else "")

    def _ollama_models(self) -> list[str]:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(f"{self.ollama}/api/tags", timeout=3) as r:
                names = [m.get("name", "") for m in json.loads(r.read()).get("models", [])]
        except (OSError, ValueError):
            return []
        return sorted(n.removesuffix(":latest") for n in names if n)

    def _strata_models(self) -> list[str]:
        if not self.strata:
            return []
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        req = urllib.request.Request(f"{self.strata}/models", headers={"authorization": f"Bearer {STRATA_KEY}"})
        try:
            with opener.open(req, timeout=3) as r:
                ids = [m.get("id", "") for m in json.loads(r.read()).get("data", [])]
        except (OSError, ValueError, AttributeError):
            return []
        return sorted(f"strata/{i}" for i in ids if i)

    # ── input ───────────────────────────────────────────────────────────────

    def input(self, inp: dict) -> None:
        if self.channel is None:
            return
        kind = inp.get("kind")
        if kind == "stop":
            while not self.channel.said.empty():  # what was typed during the run goes too
                self.channel.said.get_nowait()
            if self.run and not self.run.done():
                self.run.cancel()
        elif kind == "clear":
            asyncio.ensure_future(self._clear())
        else:
            self.channel.deliver(inp)

    async def _clear(self) -> None:
        if self.run and not self.run.done():
            self.run.cancel()
            await asyncio.gather(self.run, return_exceptions=True)
        # The next message opens a new session (Практикум ИИ: in a new chat).
        self.session = self.backend = None
        if self.channel:
            self.channel.status("idle", f"{self._who()} · new conversation")

    async def _work(self) -> None:
        assert self.channel is not None
        while True:
            text = await self.channel.said.get()
            if text.startswith("/continue"):
                if self.session is None or not self.session.task:
                    self.channel.message("note", "nothing to continue yet; send a message")
                    continue
                rest = text.removeprefix("/continue").strip()
                coro = self.session.resume(int(rest) if rest.isdigit() else self._rounds())
            else:
                if self.session is None and not await self._open():
                    continue
                coro = self.session.ask(text, self._rounds())
            self.run = asyncio.ensure_future(coro)
            try:
                out: Outcome = await self.run
                if out.code in HINTS:
                    self.channel.message("note", HINTS[out.code])
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise  # agent mode is ending
                self.channel.message("note", "stopped; send a message to go on")
                self.channel.status("stopped", "stopped by you")
                continue
            except Exception as e:  # a bug must not end agent mode
                log.exception("agent run failed")
                self.channel.message("note", f"the agent failed: {type(e).__name__}: {e}")
                self.channel.status("stopped", "failed (see the bridge log)")
                continue
            finally:
                self.run = None
            if self.channel.said.empty():
                self.channel.status("idle" if out.code == 0 else "stopped", "waiting for your message")

    def _rounds(self) -> int:
        # gpt-oss makes one call per reply: a simple trainer task takes 14-19 rounds.
        return self.rounds or (10 if self.config.get("backend") == "platform" else 30)

    async def _open(self) -> bool:
        assert self.channel is not None
        if self.config["backend"] == "ollama" and not self.model:
            self.channel.message("note", "no local model: start Ollama or Strata (then switch modes) or pick Практикум ИИ")
            return False
        self.channel.status("thinking", "starting: reading the page")
        if self.make_backend:
            backend = self.make_backend(self.client, self.note, self.config)
        elif self.config["backend"] == "platform":
            backend = PlatformBackend(self.client, self.note)
        else:
            backend = local_backend(self.note, self.model, self.ollama, self.strata, None, 0.2, self.config["think"] or None, self.stream)
        session = Session(self.client, backend, self.note, solver=True)
        session.overlay = self.channel  # status, messages and the solver's questions
        self.backend = backend
        try:
            ok = await session.open()
        except Exception as e:
            log.exception("could not open the session")
            ok, why = False, f"{type(e).__name__}: {e}"
        else:
            why = "see the notes above"
        if not ok:
            self.backend = None
            self.channel.message("note", f"could not start the agent ({why})")
            self.channel.status("stopped", "could not start")
            return False
        self.session = session
        return True

    # ── what the session reports ────────────────────────────────────────────

    def _emit(self, event: dict) -> None:
        if event.get("kind") == "status" and event.get("state") in ("thinking", "acting") and self.tokens:
            event = {**event, "text": f"{event['text']} · {self.tokens}".strip(" ·")}
        self.link.emit_agent(event)

    def stream(self, kind: str, chunk: str) -> None:
        """Called from the local model's reading thread for every chunk."""
        part = "thinking" if kind.endswith(" thinking") else "text"
        key = (self.turn, part)
        if key not in self.streamed and not chunk.strip():
            return  # the blank lines a reply starts with
        # Marked here, not in the loop: the note with the whole reply must see it.
        self.streamed.add(key)
        event = {"kind": "delta", "turn": str(self.turn), "part": part, "text": chunk}
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.link.emit_agent, event)

    def note(self, kind: str, text: str) -> None:
        self._write_log(kind, text)
        if self.channel is None:
            return
        name = getattr(self.backend, "name", None)
        if kind == "round":
            self.turn += 1
            self.streamed = {k for k in self.streamed if k[0] >= self.turn - 1}
            return
        if kind == "tokens":
            self.tokens = text.split(",")[0]  # "prompt N/ctx"
            self.link.emit_agent({"kind": "turn_end", "turn": str(self.turn)})
            return
        if name and kind == f"{name} thinking":
            if (self.turn, "thinking") not in self.streamed:
                self.channel.message("thinking", text)
            return
        if name and kind == name:
            if (self.turn, "text") in self.streamed:
                return
            # Практикум ИИ's protocol lines are shown as the calls they make and the answer.
            prose = "\n".join(l for l in text.splitlines() if not l.strip().strip("`").startswith(("CALL ", "CALL{", "ANSWER:"))).strip()
            if prose and prose != "(empty)":
                self.channel.message("agent", prose)
            return
        if kind in QUIET or kind.startswith("to ") or kind.endswith((")", ") ERROR")):
            return  # tool calls: the extension shows them as it runs them
        self.channel.message("note", f"{kind}: {text}" if text.strip() else kind)

    def _write_log(self, kind: str, text: str) -> None:
        try:
            if self._log is None:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                self._log = self.log_path.open("a", encoding="utf-8")
            self._log.write(f"\n[{time.strftime('%H:%M:%S')}] ── {kind} ──\n{text}\n")
            self._log.flush()
        except OSError:
            pass
