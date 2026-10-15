"""Let the site's own assistant (Практикум ИИ) drive the tools.

The assistant only has a chat box, so the protocol is text: it gets the tool
list and a task, answers with `CALL {"tool": …, "args": …}` lines, we run them
through the bridge and send the results back, until it writes `ANSWER: …`.
Every round is one chat message (ask_platform_ai), and irreversible tools still
wait for the user's approval in the page overlay. The platform keeps a separate
chat per lesson, so after a page change the next message repeats the protocol,
the task and a log of what was done. Before round 1 the lesson's chat is reset
(reset_platform_ai_chat, approved by the user) unless --keep-chat is given.

The same loop also drives a local model through Ollama (`practicum-local-agent`)
with native tool calling and its own system prompt (prompts.py): the conversation
is kept here, so nothing has to be repeated after a page change, and the local
model may consult Практикум ИИ through ask_platform_ai.

A Session keeps one conversation open across several user messages; the
one-shot commands below send a single task, `practicum-chat` (chat.py) is the
interactive front end.

    uv run practicum-platform-agent "Пройди текущий урок …" [--rounds 10]
    uv run practicum-local-agent --model gpt-oss-32k "Пройди текущий урок …"
"""

import argparse
import asyncio
import http.client
import json
import re
import sys
import threading
import time
from dataclasses import dataclass
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

from mcp.client import Client

from .call import drop_proxies_for_loopback
from .prompts import LOCAL_PAGE, LOCAL_SYSTEM, PLATFORM_INTRO

SELF = "ask_platform_ai"
# Driver-only tools the model must not see or call (dev_* test tools are hidden too).
HIDDEN = {SELF, "reset_platform_ai_chat"}
MAX_RESULT_CHARS = 9000
ASK_RETRIES = 3
# Failed checks in a row on one task before the driver stops (each check is a recorded attempt).
MAX_FAILED_CHECKS = 3
CHECK_TOOLS = {"check_task", "check_code_exercise"}
# The same call failing with the same error this many times in a row is not run again…
REPEAT_LIMIT = 2
# …and after this many such refused repeats the driver stops: the model is looping.
LOOP_STOP = 3
ASK_RETRY_WAIT_S = 70
CALL_RE = re.compile(r"^\s*CALL\s+(\{.*\})\s*$")
ANSWER_RE = re.compile(r"^\s*ANSWER:\s*(.*)$", re.S)

def visible(name: str, hidden: set[str]) -> bool:
    return name not in hidden and not name.startswith("dev_")


def tool_lines(tools, hidden: set[str] = HIDDEN) -> str:
    lines = []
    for t in tools:
        if not visible(t.name, hidden):
            continue
        props = (t.input_schema or {}).get("properties", {})
        required = set((t.input_schema or {}).get("required", []))
        args = ", ".join(f"{k}{'' if k in required else '?'}" for k in props)
        desc = re.split(r"(?<=[.!?])\s", t.description or "")[0]
        if len(desc) > 140:
            desc = desc[:137] + "…"
        lines.append(f"- {t.name}({args}) — {desc}")
    return "\n".join(lines)


def strip_suggestions(text: str) -> str:
    return text.split("\nSuggested follow-up questions:")[0].strip()


def _parse_lines(lines: list[str]) -> tuple[list[dict], str | None, list[str]]:
    calls, bad = [], []
    answer = None
    for raw in lines:
        line = raw.strip().strip("`")
        if m := CALL_RE.match(line):
            try:
                obj = json.loads(m.group(1))
                calls.append({"tool": str(obj["tool"]), "args": obj.get("args") or {}})
            except (ValueError, KeyError, TypeError):
                bad.append(line)
        elif line.startswith("CALL"):
            bad.append(line)
        elif answer is None and (m := ANSWER_RE.match(line)):
            answer = m.group(1).strip()
    return calls, answer, bad


def parse_reply(text: str) -> tuple[list[dict], str | None, list[str]]:
    """CALL lines, the ANSWER text (if any), and CALL lines that couldn't be parsed.

    When the reply also contains chat prose, lines inside ``` fences are
    ignored: they are examples (e.g. "ANSWER: v1.2.3"), not instructions. A
    reply that is nothing but fenced CALL lines is still accepted.
    """
    lines, fenced = [], False  # (line, inside a fence), in order
    for raw in text.splitlines():
        if raw.strip().startswith("```"):
            fenced = not fenced
        else:
            lines.append((raw, fenced))
    prose = any(
        l.strip() and not fenced and not l.strip().strip("`").startswith("CALL") and not ANSWER_RE.match(l.strip())
        for l, fenced in lines
    )
    return _parse_lines([l for l, fenced in lines if not (prose and fenced)])


def short(s: str, n: int = 200) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n] + "…"


def clip(s: str, n: int = MAX_RESULT_CHARS) -> str:
    if len(s) <= n:
        return s
    return s[:n] + f"\n…(обрезано, ещё {len(s) - n} символов; для read_lesson используй offset из подсказки в тексте или blocks=true)"


def clean_args(args) -> dict:
    """gpt-oss sends {"": ""} for tools without parameters; drop keys the schema can't have."""
    if not isinstance(args, dict):
        return {}
    return {k: v for k, v in args.items() if isinstance(k, str) and k.strip()}


def text_of(result) -> str:
    return "\n".join(getattr(x, "text", "") for x in result.content)


Note = Callable[[str, str], None]
Stream = Callable[[str, str], None]  # (kind, chunk) for tokens as they arrive; not logged
INTERRUPTED = "прервано пользователем"

@dataclass
class Turn:
    calls: list[dict]  # {"tool", "args"}
    answer: str | None
    bad: list[str]


@dataclass
class Executed:
    call: dict
    out: str
    err: bool
    skipped: str | None = None  # reason when the call was not run


class PlatformBackend:
    """Практикум ИИ through ask_platform_ai, text protocol. Its chat lives per lesson on the server."""

    name = "Практикум ИИ"
    hidden = HIDDEN

    def __init__(self, client: Client, note: Note, keep_chat: bool = False):
        self.client, self.note, self.keep_chat = client, note, keep_chat
        self.full: Callable[[str], str] = lambda r: r
        self.message = ""
        self.fresh = True  # the chat on the server hasn't seen the protocol yet

    async def start(self, tools, full: Callable[[str], str]) -> bool:
        self.full = full
        if self.keep_chat:
            return True
        return await self.reset()

    async def reset(self) -> bool:
        # A fresh chat, so earlier conversations in this lesson don't steer the model.
        r = await self.client.call_tool("reset_platform_ai_chat", {})
        self.note("reset chat", text_of(r))
        self.fresh = True
        return not r.is_error

    def user(self, text: str, page_changed: bool, page: str) -> None:
        url = next((l for l in page.splitlines() if l.startswith("URL:")), "")
        moved = f"\n\n(Сейчас открыта другая страница: {url})" if page_changed and url else ""
        if self.fresh or page_changed:
            # full() carries the protocol, the (new) task and the log of what was done.
            self.message = self.full("") + moved
            self.fresh = False
        else:
            self.message = f"Новое сообщение от пользователя:\n{text}\n\nОтвечай как раньше: CALL-строки или ANSWER: ..."

    async def turn(self) -> Turn | None:
        message = self.message
        self.note(f"to {self.name}", message)
        for attempt in range(1, ASK_RETRIES + 1):
            res = await self.client.call_tool(SELF, {"question": message})
            text = "\n".join(getattr(c, "text", "") for c in res.content)
            if not res.is_error:
                reply = strip_suggestions(text)
                self.note(self.name, reply)
                calls, answer, bad = parse_reply(reply)
                return Turn(calls, answer, bad)
            if "[platform]" not in text or attempt == ASK_RETRIES:
                self.note("ask_platform_ai failed", text)
                return None
            if attempt == 1:
                # «Сервис временно недоступен…»: wait and resend.
                self.note("Практикум ИИ unavailable", f"{text}\nwaiting {ASK_RETRY_WAIT_S} s, then resending")
                await asyncio.sleep(ASK_RETRY_WAIT_S)
            else:
                # Continuing this chat keeps failing (stream/message answers "500" in a 200);
                # a new chat goes through ask_in_lesson, so start one with a self-contained message.
                self.note("Практикум ИИ still unavailable", "starting a new chat")
                if not await self.reset():
                    return None
                self.fresh = False
                message = "Чат пришлось начать заново.\n\n" + self.full(message)
                self.note("resend (new chat)", message)
        return None

    def off_format(self) -> None:
        self.message = "Ответ не по формату.\n\n" + self.full("")

    def results(self, done: list[Executed], bad: list[str], page_changed: bool) -> None:
        parts = []
        for e in done:
            if e.skipped:
                parts.append(f"{e.call['tool']}({json.dumps(e.call['args'], ensure_ascii=False)}) → НЕ ВЫПОЛНЕН: {e.skipped}")
            else:
                parts.append(f"{e.call['tool']} {'→ ОШИБКА' if e.err else '→'}\n{clip(e.out)}")
        joined = "\n\n".join(parts) + (f"\nНе разобраны строки: {bad}" if bad else "")
        if page_changed:
            # The platform chat is per lesson: the new page's chat has never seen the protocol.
            self.message = "Открылась новая страница, поэтому повторяю инструкции.\n\n" + self.full(joined)
        else:
            self.message = "Результаты вызовов:\n\n" + joined + "\n\nПродолжай: CALL-строки или ANSWER: ..."


class OllamaBackend:
    """A local model via Ollama's /api/chat with native tool calling. History is kept here.

    (gpt-oss routes text-protocol "CALL {…}" lines into its tool channel, which Ollama
    then fails to parse with a 500, so local models get real function definitions.)
    With `stream`, tokens are shown as they arrive.
    """

    hidden = {"reset_platform_ai_chat"}  # it may consult Практикум ИИ via ask_platform_ai
    KEEP_FULL = 8  # most recent messages sent in full; older tool results are shortened
    PINNED = ("read_task",)  # tools whose latest result is never shortened
    SQUEEZE_AT = 0.75  # share of the context window after which older messages are cut harder

    def __init__(
        self,
        note: Note,
        model: str,
        base_url: str,
        num_ctx: int | None,
        temperature: float,
        think: str | None = None,
        stream: Stream | None = None,
        system: str = LOCAL_SYSTEM,
    ):
        self.note, self.base_url, self.think, self.stream, self.system = note, base_url.rstrip("/"), think, stream, system
        self.options: dict = {"temperature": temperature}
        if num_ctx:
            self.options["num_ctx"] = num_ctx
        self.model = self.name = model
        self.ctx: int | None = num_ctx  # context window, for the squeeze and the token readout
        self.prompt_tokens = 0
        self.messages: list[dict] = []
        self.tools: list[dict] = []
        # Talk to Ollama directly: the system proxy must not see loopback traffic.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self._abort = threading.Event()  # set when the user interrupts a streaming reply

    def _request(self, path: str, payload: dict, timeout: float):
        req = urllib.request.Request(f"{self.base_url}{path}", data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
        return self.opener.open(req, timeout=timeout)

    def _model_ctx(self) -> int | None:
        if n := self.options.get("num_ctx"):
            return n
        try:
            with self._request("/api/show", {"model": self.model}, 10) as r:
                params = json.loads(r.read()).get("parameters") or ""
        except (OSError, ValueError):
            return None
        m = re.search(r"^num_ctx\s+(\d+)", params, re.M)
        return int(m.group(1)) if m else None

    async def set_model(self, model: str) -> None:
        self.model = self.name = model
        self.ctx = await asyncio.to_thread(self._model_ctx)

    async def start(self, tools, full: Callable[[str], str]) -> bool:
        self.tools = [
            {"type": "function", "function": {"name": t.name, "description": t.description or "", "parameters": t.input_schema or {"type": "object", "properties": {}}}}
            for t in tools
            if visible(t.name, self.hidden)
        ]
        self.ctx = await asyncio.to_thread(self._model_ctx)
        self.messages = [{"role": "system", "content": self.system}]
        self.note(f"to {self.name}", f"{len(self.tools)} tools, context {self.ctx or '?'}\n{self.system}")
        return True

    async def reset(self) -> bool:
        self.messages = self.messages[:1]
        self.prompt_tokens = 0
        return True

    def user(self, text: str, page_changed: bool, page: str) -> None:
        # The page goes with the first message and after a change, which saves a where_am_i round.
        first = not any(m["role"] == "user" for m in self.messages)
        if page and (first or page_changed):
            text += LOCAL_PAGE.format(page=page)
        self.messages.append({"role": "user", "content": text})

    def _view(self) -> list[dict]:
        squeeze = bool(self.ctx) and self.prompt_tokens > self.SQUEEZE_AT * self.ctx
        limit = 300 if squeeze else 800
        # The latest read_task stays whole: its file list is at the end, and without it
        # the model starts guessing paths (project/urls.py, …).
        pinned = {max((i for i, m in enumerate(self.messages) if m.get("tool_name") == t), default=-1) for t in self.PINNED}
        out = []
        cut = len(self.messages) - self.KEEP_FULL
        for i, m in enumerate(self.messages):
            if 0 < i < cut and i not in pinned and m["role"] in ("tool", "assistant") and len(m["content"]) > limit:
                if m["role"] == "tool" or squeeze:
                    # Keep both ends: results often put the summary first and lists last.
                    head, tail = m["content"][: limit * 2 // 3], m["content"][-limit // 3 :]
                    m = {**m, "content": f"{head}\n…(старое сообщение сокращено)…\n{tail}"}
            out.append(m)
        return out

    def _post(self) -> dict:
        payload = {"model": self.model, "messages": self._view(), "tools": self.tools, "stream": self.stream is not None, "options": self.options}
        if self.think:
            # gpt-oss: reasoning effort low/medium/high; "off" for models that can skip it.
            payload["think"] = False if self.think == "off" else self.think
        with self._request("/api/chat", payload, 900) as r:
            if self.stream is None:
                return json.loads(r.read())
            content, thinking, calls, last = [], [], [], {}
            for line in r:
                if self._abort.is_set():
                    break
                if not line.strip():
                    continue
                chunk = json.loads(line)
                if chunk.get("error"):
                    raise ValueError(chunk["error"])
                m = chunk.get("message") or {}
                if t := m.get("thinking"):
                    thinking.append(t)
                    self.stream(f"{self.name} thinking", t)
                if c := m.get("content"):
                    content.append(c)
                    self.stream(self.name, c)
                calls += m.get("tool_calls") or []
                if chunk.get("done"):
                    last = chunk
                    break
            return {**last, "message": {"role": "assistant", "content": "".join(content), "thinking": "".join(thinking), "tool_calls": calls}}

    async def turn(self) -> Turn | None:
        data = None
        self._abort.clear()
        for attempt in (1, 2, 3):
            try:
                data = await asyncio.to_thread(self._post)
                break
            except asyncio.CancelledError:
                self._abort.set()  # the reading thread stops at the next chunk
                raise
            except (OSError, http.client.HTTPException, ValueError) as e:
                body = ""
                if isinstance(e, urllib.error.HTTPError):
                    try:
                        body = e.read().decode(errors="replace")[:500]
                    except Exception:
                        pass
                self.note("ollama error", f"{e} {body}".strip())
                if attempt == 3:
                    return None
                await asyncio.sleep(3)
        msg = data.get("message") or {}
        thinking = (msg.get("thinking") or "").strip()
        if thinking:
            self.note(f"{self.name} thinking", short(thinking, 1200))
        if data.get("done_reason") == "length":
            self.note("warning", "the model hit its output/context limit (done_reason=length); raise num_ctx")
        content = (msg.get("content") or "").strip()
        raw_calls = msg.get("tool_calls") or []
        self.messages.append({"role": "assistant", "content": content, **({"tool_calls": raw_calls} if raw_calls else {})})
        was_squeezed = bool(self.ctx) and self.prompt_tokens > self.SQUEEZE_AT * self.ctx
        self.prompt_tokens = data.get("prompt_eval_count") or self.prompt_tokens
        self.note("tokens", f"prompt {self.prompt_tokens}{f'/{self.ctx}' if self.ctx else ''}, reply {data.get('eval_count')}")
        if self.ctx and self.prompt_tokens > self.SQUEEZE_AT * self.ctx and not was_squeezed:
            self.note("warning", f"context {self.prompt_tokens * 100 // self.ctx}% full: older messages are cut harder from now on; /clear starts over")
        calls = []
        for c in raw_calls:
            fn = c.get("function") or {}
            args = fn.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = {}
            calls.append({"tool": str(fn.get("name", "")), "args": clean_args(args)})
        self.note(self.name, "\n".join(f"CALL {json.dumps(c, ensure_ascii=False)}" for c in calls) or content or "(empty)")
        answer = None if calls else (re.sub(r"^\s*ANSWER:\s*", "", content) or None)
        return Turn(calls, answer, [])

    def off_format(self) -> None:
        self.messages.append({"role": "user", "content": "Пустой ответ. Вызови нужный инструмент или напиши итог текстом."})

    def results(self, done: list[Executed], bad: list[str], page_changed: bool) -> None:
        for i, e in enumerate(done):
            content = f"НЕ ВЫПОЛНЕН: {e.skipped}" if e.skipped else (("ОШИБКА: " if e.err else "") + clip(e.out))
            if page_changed and i == len(done) - 1:
                content += "\n\n(Открылась другая страница.)"
            self.messages.append({"role": "tool", "tool_name": e.call["tool"], "content": content})


@dataclass
class Outcome:
    code: int  # 0 answered, 1 the model or the bridge failed, 2 round limit, 3 stopped after failed checks, 4 looping
    answer: str | None = None


class Session:
    """One conversation with a model over the bridge's tools.

    Each user message runs the agent loop until the model answers in text (or a
    limit stops it); the conversation, the log of executed calls and the page
    tracking carry over to the next message.
    """

    def __init__(self, client: Client, backend, note: Note):
        self.client, self.backend, self.note = client, backend, note
        self.tools: list = []
        self.known: set[str] = set()
        self.read_only: set[str] = set()
        self.history: list[str] = []  # one line per executed call, for self-contained messages
        self.task = ""
        self.where = ""
        self.failed_checks: dict[tuple, int] = {}
        self.errors: dict[tuple, tuple[str, int]] = {}  # call → (its last error, how many times in a row)
        self.refused = 0  # repeats of a failing call that were not run
        self.by_user: list[str] = []  # calls the user made by hand, reported with the next message
        self.page_text = ""  # the last where_am_i, in full

    async def open(self) -> bool:
        self.tools = (await self.client.list_tools()).tools
        self.known = {t.name for t in self.tools if visible(t.name, self.backend.hidden)}
        self.read_only = {t.name for t in self.tools if t.annotations and t.annotations.read_only_hint}
        self.where = await self.page()
        return await self.backend.start(self.tools, self.full)

    async def page(self) -> str:
        r = await self.client.call_tool("where_am_i", {})
        text = self.page_text = text_of(r)
        return next((l for l in text.splitlines() if l.startswith("URL:")), text[:200])

    def full(self, results: str = "") -> str:
        # For a model without memory of this conversation (the platform chat after a
        # page change, or a lost thread): protocol, task, log of what was done, results.
        intro = PLATFORM_INTRO.format(tools=tool_lines(self.tools, self.backend.hidden), task=self.task)
        done = "\n\nУже сделано:\n" + "\n".join(self.history[-15:]) if self.history else ""
        latest = f"\n\nРезультаты последних вызовов:\n\n{results}" if results else ""
        return intro + done + latest + "\n\nПродолжай: CALL-строки или ANSWER: ..."

    async def call(self, tool: str, args: dict) -> tuple[str, bool]:
        r = await self.client.call_tool(tool, clean_args(args))
        return text_of(r), bool(r.is_error)

    async def user_call(self, tool: str, args: dict) -> tuple[str, bool]:
        """A call the user makes by hand; the model hears about it with the next message."""
        out, err = await self.call(tool, args)
        sig = f"{tool}({json.dumps(clean_args(args), ensure_ascii=False)})"
        self.history.append(f"- {sig} → {short(out)} (вызвал пользователь)")
        self.by_user.append(f"{sig} {'→ ОШИБКА' if err else '→'}\n{clip(out, 3000)}")
        return out, err

    async def reset(self) -> bool:
        self.history.clear()
        self.by_user.clear()
        self.failed_checks.clear()
        self.errors.clear()
        self.refused = 0
        self.task = ""
        return await self.backend.reset()

    async def ask(self, text: str, rounds: int) -> Outcome:
        now = await self.page()
        changed = now != self.where
        if changed:
            self.note("page changed", f"{self.where}\n→ {now}")
            self.where = now
        if self.by_user:
            text = "Я сам выполнил вызовы:\n\n" + "\n\n".join(self.by_user) + "\n\n" + text
            self.by_user = []
        self.task = text
        # A new message from the user lifts the failed-check and loop stops.
        self.failed_checks.clear()
        self.errors.clear()
        self.refused = 0
        self.backend.user(text, changed, self.page_text)
        return await self.resume(rounds)

    async def resume(self, rounds: int) -> Outcome:
        for rnd in range(1, rounds + 1):
            self.note("round", str(rnd))
            turn = await self.backend.turn()
            if turn is None:
                return Outcome(1)
            if not turn.calls:
                if turn.answer is not None:
                    self.note("done", turn.answer)
                    return Outcome(0, turn.answer)
                self.note("off format", "asking again")
                self.backend.off_format()
                continue
            if code := await self._execute(turn):
                return Outcome(code)
        self.note("stopped", f"round limit ({rounds}) reached")
        return Outcome(2)

    async def _execute(self, turn: Turn) -> int | None:
        """Run one turn's calls and report the results to the backend; an Outcome code when the driver must stop."""
        done: list[Executed] = []
        changed = None
        stop_reason = None
        halted = None
        try:
            for c in turn.calls:
                c = {"tool": c["tool"], "args": clean_args(c["args"])}
                if stop_reason:
                    # Later calls were planned without the result: at most one action per round.
                    done.append(Executed(c, "", False, stop_reason))
                    continue
                key = (c["tool"], json.dumps(c["args"], sort_keys=True))
                last = self.errors.get(key)
                if last and last[1] >= REPEAT_LIMIT:
                    # Small models retry a failing call verbatim (15 times in the tuning runs).
                    self.refused += 1
                    self.note("repeat refused", f"{c['tool']} already failed {last[1]} times with the same error")
                    done.append(Executed(c, "", True, f"этот вызов уже {last[1]} раза подряд завершился ошибкой «{short(last[0], 300)}»; повторять его бесполезно — сделай что-то другое"))
                    if self.refused >= LOOP_STOP:
                        self.note("stopped", "the model keeps repeating a failing call; handing back to the user")
                        halted = 4
                    stop_reason = "предыдущий вызов не выполнен; посмотри результат и реши заново"
                    continue
                if c["tool"] not in self.known:
                    out, err = f"инструмент {c['tool']!r} недоступен", True
                else:
                    try:
                        out, err = await self.call(c["tool"], c["args"])
                    except asyncio.CancelledError:
                        done.append(Executed(c, "", True, INTERRUPTED + " (результат неизвестен)"))
                        raise
                sig = f"{c['tool']}({json.dumps(c['args'], ensure_ascii=False)})"
                self.note(f"{sig}{' ERROR' if err else ''}", out)
                done.append(Executed(c, out, err))
                self.history.append(f"- {sig} → {short(out)}")
                if err:
                    self.errors[key] = (out, last[1] + 1 if last and last[0] == out else 1)
                else:
                    self.errors.pop(key, None)
                    if c["tool"] not in self.read_only:
                        self.errors.clear()  # the project or the page changed: earlier failures may not repeat
                if c["tool"] in CHECK_TOOLS and not err:
                    key = (c["tool"], self.where, json.dumps(c["args"], sort_keys=True))
                    self.failed_checks[key] = 0 if out.startswith("Solved") else self.failed_checks.get(key, 0) + 1
                    if self.failed_checks[key] >= MAX_FAILED_CHECKS:
                        self.note("stopped", f"{MAX_FAILED_CHECKS} failed checks in a row on this task; handing back to the user")
                        halted = 3
                        stop_reason = f"проверка не прошла {MAX_FAILED_CHECKS} раза подряд; решение за пользователем"
                        continue
                acted = c["tool"] not in self.read_only
                if not err and acted and (now := await self.page()) != self.where:
                    changed = now
                if err:
                    stop_reason = "предыдущий вызов завершился ошибкой; посмотри результат и реши заново"
                elif acted:
                    stop_reason = "за один ответ выполняется только одно действие; посмотри результат и реши заново"
        except asyncio.CancelledError:
            # Keep the conversation well-formed: every planned call gets a result.
            for c in turn.calls[len(done):]:
                done.append(Executed(c, "", False, INTERRUPTED))
            self.backend.results(done, turn.bad, False)
            raise

        now = changed or await self.page()
        page_changed = now != self.where
        if page_changed:
            self.note("page changed", f"{self.where}\n→ {now}")
            self.where = now
        self.backend.results(done, turn.bad, page_changed)
        return halted


def log_note(log_path: Path) -> Note:
    """Print every event in full and append it to the log."""
    log = log_path.open("a", encoding="utf-8")

    def note(kind: str, text: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        print(f"\n[{stamp}] ── {kind} ──\n{text}", flush=True)
        log.write(f"\n[{stamp}] ── {kind} ──\n{text}\n")
        log.flush()

    return note


async def run(task: str, rounds: int, url: str, log_path: Path, make_backend: Callable[[Client, Note], object]) -> int:
    drop_proxies_for_loopback(url)
    note = log_note(log_path)
    async with Client(url) as client:
        session = Session(client, make_backend(client, note), note)
        if not await session.open():
            return 1
        out = await session.ask(task, rounds)
        if out.code == 0:
            # The model's summary can be wrong; log what the page actually says.
            note("actual state", text_of(await client.call_tool("where_am_i", {})))
        return out.code


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("task")
    p.add_argument("--rounds", type=int, default=10)
    p.add_argument("--url", default="http://127.0.0.1:8766/mcp", help="the bridge's MCP endpoint")


def main() -> None:
    p = argparse.ArgumentParser(prog="practicum-platform-agent", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    _common(p)
    p.add_argument("--log", type=Path, default=Path("platform-agent.log"))
    p.add_argument("--keep-chat", action="store_true", help="don't start a new Практикум ИИ chat first")
    a = p.parse_args()
    make = lambda client, note: PlatformBackend(client, note, a.keep_chat)  # noqa: E731
    sys.exit(asyncio.run(run(a.task, a.rounds, a.url, a.log, make)))


def local_main() -> None:
    p = argparse.ArgumentParser(prog="practicum-local-agent", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    _common(p)
    p.add_argument("--model", required=True, help="Ollama model, e.g. gpt-oss-32k")
    p.add_argument("--ollama", default="http://127.0.0.1:11434", help="Ollama base URL")
    p.add_argument("--num-ctx", type=int, default=None, help="context window to request (default: the model's own setting)")
    p.add_argument("--temperature", type=float, default=0.2, help="0.2 scored best in evals/tune.py")
    p.add_argument("--think", choices=["low", "medium", "high"], help="reasoning effort for models that support it (gpt-oss)")
    p.add_argument("--log", type=Path, default=Path("local-agent.log"))
    p.set_defaults(rounds=30)  # one tool call per reply: a simple trainer task takes 14-19 rounds
    a = p.parse_args()
    make = lambda client, note: OllamaBackend(note, a.model, a.ollama, a.num_ctx, a.temperature, a.think)  # noqa: E731
    sys.exit(asyncio.run(run(a.task, a.rounds, a.url, a.log, make)))


if __name__ == "__main__":
    main()
