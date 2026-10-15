"""Let the site's own assistant (Практикум ИИ) drive the tools.

The assistant only has a chat box, so the protocol is text: it gets the tool
list and a task, answers with `CALL {"tool": …, "args": …}` lines, we run them
through the bridge and send the results back, until it writes `ANSWER: …`.
Every round is one chat message (ask_platform_ai), and irreversible tools still
wait for the user's approval in the page overlay. The platform keeps a separate
chat per lesson, so after a page change the next message repeats the protocol,
the task and a log of what was done. Before round 1 the lesson's chat is reset
(reset_platform_ai_chat, approved by the user) unless --keep-chat is given.

    uv run practicum-platform-agent "Пройди текущий урок …" [--rounds 10]
"""

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path

from mcp.client import Client

from .call import drop_proxies_for_loopback

SELF = "ask_platform_ai"
# Driver-only tools the model must not see or call.
HIDDEN = {SELF, "reset_platform_ai_chat"}
MAX_RESULT_CHARS = 9000
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


def tool_lines(tools) -> str:
    lines = []
    for t in tools:
        if t.name in HIDDEN:
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


async def run(task: str, rounds: int, url: str, log_path: Path, keep_chat: bool = False) -> int:
    drop_proxies_for_loopback(url)
    log = log_path.open("a", encoding="utf-8")

    def note(kind: str, text: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        print(f"\n[{stamp}] ── {kind} ──\n{text}", flush=True)
        log.write(f"\n[{stamp}] ── {kind} ──\n{text}\n")
        log.flush()

    async with Client(url) as client:
        tools = (await client.list_tools()).tools
        known = {t.name for t in tools}
        intro = INTRO.format(tools=tool_lines(tools), task=task)
        history: list[str] = []  # one line per executed call, for self-contained messages

        async def page() -> str:
            r = await client.call_tool("where_am_i", {})
            text = "\n".join(getattr(x, "text", "") for x in r.content)
            return next((l for l in text.splitlines() if l.startswith("URL:")), text[:200])

        def full(results: str = "") -> str:
            # The platform chat is per lesson: after a page change (or when the
            # model lost the thread) it has no memory of the protocol or the task.
            done = "\n\nУже сделано:\n" + "\n".join(history[-15:]) if history else ""
            latest = f"\n\nРезультаты последних вызовов:\n\n{results}" if results else ""
            return intro + done + latest + "\n\nПродолжай: CALL-строки или ANSWER: ..."

        if not keep_chat:
            # A fresh chat, so earlier conversations in this lesson don't steer the model.
            r = await client.call_tool("reset_platform_ai_chat", {})
            note("reset chat", "\n".join(getattr(x, "text", "") for x in r.content))
            if r.is_error:
                return 1

        read_only = {t.name for t in tools if t.annotations and t.annotations.read_only_hint}
        where = await page()
        message = intro
        for rnd in range(1, rounds + 1):
            note(f"to Практикум ИИ (round {rnd})", message)
            res = await client.call_tool(SELF, {"question": message})
            text = "\n".join(getattr(c, "text", "") for c in res.content)
            if res.is_error:
                note("ask_platform_ai failed", text)
                return 1
            reply = strip_suggestions(text)
            note("Практикум ИИ", reply)

            calls, answer, bad = parse_reply(reply)
            if not calls:
                if answer is not None:
                    note("done", answer)
                    return 0
                note("off format", "resending the protocol and the task")
                message = "Ответ не по формату.\n\n" + full()
                continue

            results = []
            changed = None
            for i, c in enumerate(calls):
                if c["tool"] in HIDDEN or c["tool"] not in known:
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
                note("page changed", f"{where}\n→ {now}\nnext message is self-contained")
                where = now
                message = "Открылась новая страница, поэтому повторяю инструкции.\n\n" + full(joined)
            else:
                message = "Результаты вызовов:\n\n" + joined + "\n\nПродолжай: CALL-строки или ANSWER: ..."

        note("stopped", f"round limit ({rounds}) reached")
        return 2


def main() -> None:
    p = argparse.ArgumentParser(prog="practicum-platform-agent", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("task")
    p.add_argument("--rounds", type=int, default=10)
    p.add_argument("--url", default="http://127.0.0.1:8766/mcp")
    p.add_argument("--log", type=Path, default=Path("platform-agent.log"))
    p.add_argument("--keep-chat", action="store_true", help="don't start a new Практикум ИИ chat first")
    a = p.parse_args()
    sys.exit(asyncio.run(run(a.task, a.rounds, a.url, a.log, a.keep_chat)))


if __name__ == "__main__":
    main()
