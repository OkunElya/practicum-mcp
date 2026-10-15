"""Let the site's own assistant (Практикум ИИ) drive the tools.

The assistant only has a chat box, so the protocol is text: it gets the tool
list and a task, answers with `CALL {"tool": …, "args": …}` lines, we run them
through the bridge and send the results back, until it writes `ANSWER: …`.
Every round is one chat message (ask_platform_ai), and irreversible tools still
wait for the user's approval in the page overlay. The platform keeps a separate
chat per lesson, so after a page change the next message repeats the protocol,
the task and a log of what was done. Before round 1 the lesson's chat is reset
(reset_platform_ai_chat, approved by the user) unless --keep-chat is given.

The same loop also drives a local model through Ollama (`practicum-local-agent`):
the conversation is kept here, so nothing has to be repeated after a page change,
and the local model may consult Практикум ИИ through ask_platform_ai.

    uv run practicum-platform-agent "Пройди текущий урок …" [--rounds 10]
    uv run practicum-local-agent --model gpt-oss-32k "Пройди текущий урок …"
"""

import argparse
import asyncio
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from pathlib import Path

from mcp.client import Client

from .call import drop_proxies_for_loopback

SELF = "ask_platform_ai"
# Driver-only tools the model must not see or call (dev_* test tools are hidden too).
HIDDEN = {SELF, "reset_platform_ai_chat"}
MAX_RESULT_CHARS = 9000
ASK_RETRIES = 3
ASK_RETRY_WAIT_S = 70
CALL_RE = re.compile(r"^\s*CALL\s+(\{.*\})\s*$")
ANSWER_RE = re.compile(r"^\s*ANSWER:\s*(.*)$", re.S)

INTRO = """\
Я подключил к своему браузеру расширение, которое даёт ассистенту инструменты для работы с \
платформой Практикума от моего имени (каждое действие видно мне на странице, необратимые \
действия я подтверждаю сам). Ты управляешь ими через этот чат.

Инструменты:
{tools}

Как вызывать: отвечай ТОЛЬКО строками вида
CALL {{"tool": "<имя>", "args": {{...}}}}
по одной на строку, без пояснений. Я выполню вызовы по порядку и пришлю результаты.
Когда задача выполнена (или выполнить её нельзя), напиши одну строку
ANSWER: <что сделано>

Правила: за один ответ — не больше ОДНОГО действия (ответ на тест, нажатие кнопки, переход); \
чтения (read_lesson, where_am_i и т. п.) можно добавлять. Остальное я не выполню: сначала \
посмотри результат. Не придумывай номера блоков и не пиши ANSWER, пока не увидел результаты. Большинство тестов принимают ответ только один раз — сначала прочитай урок \
(read_lesson) и отвечай, только когда уверен. read_lesson с {{"blocks": true}} показывает только \
задания с пронумерованными вариантами; в answer_quiz передавай номера вариантов, например "2".

Задача: {task}"""


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


Note = Callable[[str, str], None]


class PlatformBackend:
    """Практикум ИИ through ask_platform_ai. Its chat lives per lesson on the server."""

    name = "Практикум ИИ"
    hidden = HIDDEN
    remembers_across_pages = False

    def __init__(self, client: Client, note: Note, keep_chat: bool = False):
        self.client, self.note, self.keep_chat = client, note, keep_chat

    async def start(self) -> bool:
        if self.keep_chat:
            return True
        # A fresh chat, so earlier conversations in this lesson don't steer the model.
        r = await self.client.call_tool("reset_platform_ai_chat", {})
        self.note("reset chat", "\n".join(getattr(x, "text", "") for x in r.content))
        return not r.is_error

    async def ask(self, message: str, self_contained: Callable[[str], str]) -> str | None:
        for attempt in range(1, ASK_RETRIES + 1):
            res = await self.client.call_tool(SELF, {"question": message})
            text = "\n".join(getattr(c, "text", "") for c in res.content)
            if not res.is_error:
                return strip_suggestions(text)
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
                r = await self.client.call_tool("reset_platform_ai_chat", {})
                self.note("Практикум ИИ still unavailable → new chat", "\n".join(getattr(x, "text", "") for x in r.content))
                if r.is_error:
                    return None
                message = "Чат пришлось начать заново.\n\n" + self_contained(message)
                self.note("resend (new chat)", message)
        return None


class OllamaBackend:
    """A local model via Ollama's /api/chat. The conversation is kept here."""

    hidden = {"reset_platform_ai_chat"}  # it may consult Практикум ИИ via ask_platform_ai
    remembers_across_pages = True
    KEEP_FULL = 6  # most recent messages sent in full; older tool results are shortened

    def __init__(self, note: Note, model: str, base_url: str, num_ctx: int | None, temperature: float, think: str | None = None):
        self.note, self.model, self.base_url, self.think = note, model, base_url.rstrip("/"), think
        self.options: dict = {"temperature": temperature}
        if num_ctx:
            self.options["num_ctx"] = num_ctx
        self.name = model
        self.messages: list[dict] = []
        # Talk to Ollama directly: the system proxy must not see loopback traffic.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    async def start(self) -> bool:
        return True

    def _view(self) -> list[dict]:
        out = []
        cut = len(self.messages) - self.KEEP_FULL
        for i, m in enumerate(self.messages):
            if 0 < i < cut and m["role"] == "user" and len(m["content"]) > 600:
                m = {**m, "content": m["content"][:600] + "\n…(старый результат сокращён)"}
            out.append(m)
        return out

    def _post(self) -> dict:
        payload = {"model": self.model, "messages": self._view(), "stream": False, "options": self.options}
        if self.think:
            payload["think"] = self.think  # gpt-oss: reasoning effort low/medium/high
        body = json.dumps(payload).encode()
        req = urllib.request.Request(f"{self.base_url}/api/chat", data=body, headers={"content-type": "application/json"})
        with self.opener.open(req, timeout=900) as r:
            return json.loads(r.read())

    async def ask(self, message: str, self_contained: Callable[[str], str]) -> str | None:
        self.messages.append({"role": "user", "content": message})
        for attempt in (1, 2):
            try:
                data = await asyncio.to_thread(self._post)
                break
            except (urllib.error.URLError, TimeoutError, ValueError) as e:
                self.note("ollama error", f"{e}")
                if attempt == 2:
                    return None
                await asyncio.sleep(5)
        msg = data.get("message") or {}
        thinking = (msg.get("thinking") or "").strip()
        if thinking:
            self.note(f"{self.name} thinking", short(thinking, 1200))
        if data.get("done_reason") == "length":
            self.note("warning", "the model hit its output/context limit (done_reason=length); raise num_ctx")
        content = (msg.get("content") or "").strip()
        if not content and thinking:
            self.note("warning", "empty reply: the model only reasoned; it will be asked again")
        self.messages.append({"role": "assistant", "content": content})
        prompt, gen = data.get("prompt_eval_count"), data.get("eval_count")
        if prompt is not None:
            self.note("tokens", f"prompt {prompt}, reply {gen}")
        return content


async def run(task: str, rounds: int, url: str, log_path: Path, make_backend: Callable[[Client, Note], object]) -> int:
    drop_proxies_for_loopback(url)
    log = log_path.open("a", encoding="utf-8")

    def note(kind: str, text: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        print(f"\n[{stamp}] ── {kind} ──\n{text}", flush=True)
        log.write(f"\n[{stamp}] ── {kind} ──\n{text}\n")
        log.flush()

    async with Client(url) as client:
        backend = make_backend(client, note)
        hidden: set[str] = backend.hidden
        tools = (await client.list_tools()).tools
        known = {t.name for t in tools if visible(t.name, hidden)}
        intro = INTRO.format(tools=tool_lines(tools, hidden), task=task)
        history: list[str] = []  # one line per executed call, for self-contained messages

        async def page() -> str:
            r = await client.call_tool("where_am_i", {})
            text = "\n".join(getattr(x, "text", "") for x in r.content)
            return next((l for l in text.splitlines() if l.startswith("URL:")), text[:200])

        def full(results: str = "") -> str:
            # For a model without memory of this conversation (the platform chat after a
            # page change, or a lost thread): protocol, task, log of what was done, results.
            done = "\n\nУже сделано:\n" + "\n".join(history[-15:]) if history else ""
            latest = f"\n\nРезультаты последних вызовов:\n\n{results}" if results else ""
            return intro + done + latest + "\n\nПродолжай: CALL-строки или ANSWER: ..."

        if not await backend.start():
            return 1

        read_only = {t.name for t in tools if t.annotations and t.annotations.read_only_hint}
        where = await page()
        message = intro
        for rnd in range(1, rounds + 1):
            note(f"to {backend.name} (round {rnd})", message)
            reply = await backend.ask(message, full)
            if reply is None:
                return 1
            note(backend.name, reply)

            calls, answer, bad = parse_reply(reply)
            if not calls:
                if answer is not None:
                    note("done", answer)
                    return 0
                note("off format", "asking again for CALL/ANSWER lines")
                message = (
                    "Ответ не по формату. Пришли строки CALL {\"tool\": ..., \"args\": {...}} или одну строку ANSWER: ..."
                    if backend.remembers_across_pages
                    else "Ответ не по формату.\n\n" + full()
                )
                continue

            results = []
            changed = None
            for i, c in enumerate(calls):
                if c["tool"] not in known:
                    out, err = f"инструмент {c['tool']!r} недоступен", True
                else:
                    r = await client.call_tool(c["tool"], c["args"])
                    out = "\n".join(getattr(x, "text", "") for x in r.content)
                    err = bool(r.is_error)
                note(f"{c['tool']}({json.dumps(c['args'], ensure_ascii=False)}){' ERROR' if err else ''}", out)
                results.append(f"{c['tool']} {'→ ОШИБКА' if err else '→'}\n{clip(out)}")
                history.append(f"- {c['tool']}({json.dumps(c['args'], ensure_ascii=False)}) → {short(out)}")
                if not err and c["tool"] not in read_only and (now := await page()) != where:
                    changed = now
                rest = calls[i + 1 :]
                acted = c["tool"] not in read_only
                if rest and (err or acted):
                    # Later calls were planned without this result: at most one action per
                    # round, so the model sees what it did before deciding the next step.
                    why = "ошибка" if err else "за один ответ выполняется только одно действие"
                    results.append(
                        f"Остальные вызовы не выполнены ({why}): "
                        + ", ".join(f"{x['tool']}({json.dumps(x['args'], ensure_ascii=False)})" for x in rest)
                        + ". Посмотри результат выше и реши заново."
                    )
                    break
            extra = f"\nНе разобраны строки: {bad}" if bad else ""
            joined = "\n\n".join(results) + extra

            now = changed or await page()
            if now != where:
                note("page changed", f"{where}\n→ {now}")
                where = now
                message = (
                    "Открылась новая страница.\n\nРезультаты вызовов:\n\n" + joined + "\n\nПродолжай: CALL-строки или ANSWER: ..."
                    if backend.remembers_across_pages
                    else "Открылась новая страница, поэтому повторяю инструкции.\n\n" + full(joined)
                )
            else:
                message = "Результаты вызовов:\n\n" + joined + "\n\nПродолжай: CALL-строки или ANSWER: ..."

        note("stopped", f"round limit ({rounds}) reached")
        return 2


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
    p.add_argument("--temperature", type=float, default=0.3)
    p.add_argument("--think", choices=["low", "medium", "high"], help="reasoning effort for models that support it (gpt-oss)")
    p.add_argument("--log", type=Path, default=Path("local-agent.log"))
    a = p.parse_args()
    make = lambda client, note: OllamaBackend(note, a.model, a.ollama, a.num_ctx, a.temperature, a.think)  # noqa: E731
    sys.exit(asyncio.run(run(a.task, a.rounds, a.url, a.log, make)))


if __name__ == "__main__":
    main()
