"""Work through a theory lesson one block at a time.

A small model given a whole lesson pattern-fills answers (1=A; 2=B…), answers
blocks out of order and mixes up lessons. Here the driver walks the blocks in
order itself (buttons are pressed without the model) and gives the model one
question at a time, in a fresh call: the lesson text up to that question, the
question, and a JSON form that makes it judge every option or item separately.

Each question is sampled a few times. Agreeing samples are submitted; when they
disagree, Практикум ИИ is asked a concept question about the disputed options
(not "what is the answer", which a tutor may refuse) and the model tries again
with its explanation. If the samples still disagree, the question goes to the
user (asked in the terminal by practicum-chat, otherwise left and reported).

Block layout comes from read_lesson's own rendering (extension/src/shared/lesson.ts).
"""

import json
import re
from collections import Counter
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

AskUser = Callable[[str, str, list[str]], Awaitable[str | None]]  # (ref, block text, candidates) → answer or None

HEAD = re.compile(r"^\[(q\d+) · (.+)\]\s*$", re.M)
MORE = re.compile(r"…\((\d+) more characters: call again with offset=(\d+)\)\s*$")
LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
# The platform lets these be answered again (a chat quiz repeats a wrongly answered question):
# a majority guess is cheap there, so only one-attempt quizzes need agreeing samples.
RETRYABLE = {"chat", "choice", "cards"}
MARKS = re.compile(r"The page marks (\d+) correct, (\d+) incorrect")

SYSTEM = """\
You answer ONE question from a Yandex Practicum lesson (in Russian). You get the lesson text up to \
the question (what the student has read by then) and the question itself. Decide every option or \
item on its own, from the lesson; never fill a pattern like 1=A; 2=B; 3=C. Quote the lesson where \
you can. Reply only with the JSON asked for."""


@dataclass
class Block:
    ref: str
    kind: str  # button, radio, checkbox, choice, cards, macaroni, text, code, example, chat, survey, other
    header: str
    body: str
    done: bool
    hidden: bool
    numbers: list[str] = field(default_factory=list)  # items/options numbered 1, 2, …
    letters: list[str] = field(default_factory=list)  # options/groups/right items lettered A, B, …


def _section(body: str, start: str, end: str | None) -> str:
    i = body.find(start)
    if i < 0:
        return ""
    j = body.find(end, i) if end else -1
    return body[i : j if j >= 0 else None]


def _nums(text: str) -> list[str]:
    return re.findall(r"^  (\d+)\. ", text, re.M)


def _lets(text: str) -> list[str]:
    return re.findall(r"^  ([A-Z])\. ", text, re.M)


def parse_blocks(text: str) -> list[Block]:
    """Blocks of read_lesson output (blocks=true or the full text), in order."""
    heads = list(HEAD.finditer(text))
    out = []
    for i, m in enumerate(heads):
        body = text[m.end() : heads[i + 1].start() if i + 1 < len(heads) else len(text)].strip("\n")
        header = m.group(2)
        parts = [p.strip() for p in header.split(" · ")]
        desc = parts[0]
        status = " · ".join(parts[1:])
        hidden = "hidden until" in header
        b = Block(m.group(1), "other", header, body, False, hidden)
        if desc.startswith("button"):
            b.kind, b.done = "button", "not pressed" not in status
        elif desc.startswith("single choice") or desc.startswith("multiple choice"):
            b.kind = "radio" if desc.startswith("single") else "checkbox"
            b.done = "not answered" not in status
            b.numbers = _nums(body)
        elif desc.startswith("match each item"):
            b.kind, b.done = "choice", "not answered" not in status
            b.numbers, b.letters = _nums(_section(body, "  Items:", "  Options:")), _lets(_section(body, "  Options:", None))
        elif desc.startswith("sort cards"):
            b.kind, b.done = "cards", "not answered" not in status
            b.numbers, b.letters = _nums(_section(body, "  Cards:", "  Groups:")), _lets(_section(body, "  Groups:", None))
        elif desc.startswith("connect each left"):
            b.kind, b.done = "macaroni", "not answered" not in status
            b.numbers, b.letters = _nums(_section(body, "  Left:", "  Right:")), _lets(_section(body, "  Right:", None))
        elif desc.startswith("free-text"):
            b.kind, b.done = "text", "not answered" not in status
        elif desc.startswith("graded code exercise"):
            b.kind, b.done = "code", status.startswith("solved")
        elif desc.startswith("code example"):
            b.kind, b.done = "example", "was run" in status or "run it to unlock" not in status
        elif desc.startswith("chat quiz"):
            b.kind = "chat"
            b.done = "On screen: finished" in body or ("answered" in status and "not answered" not in status)
            b.numbers = _nums(_section(body, "Replies (answer_quiz uses these numbers):", None))
        elif desc.startswith("sprint feedback survey"):
            b.kind, b.done = "survey", "not answered" not in status
        out.append(b)
    return out


# ---------------------------------------------------------------- forms (JSON schemas) and their answers

def _obj(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


VERDICTS = {"type": "array", "items": _obj({"n": {"type": "integer"}, "right": {"type": "boolean"}, "quote": {"type": "string"}}, ["n", "right", "quote"])}
PAIRS = {"type": "array", "items": _obj({"item": {"type": "integer"}, "pick": {"type": "string"}, "why": {"type": "string"}}, ["item", "pick", "why"])}


def form(b: Block) -> tuple[dict, str]:
    """(JSON schema, instruction) for a block's kind."""
    if b.kind == "radio":
        return _obj({"options": VERDICTS, "answer": {"type": "integer"}}, ["options", "answer"]), (
            f"Single choice. For every option 1–{len(b.numbers)} say whether it is the right answer (right, quote); "
            "then answer = the number of the one best option."
        )
    if b.kind == "checkbox":
        return _obj({"options": VERDICTS}, ["options"]), (
            f"Multiple choice: several options can be right. For every option 1–{len(b.numbers)} decide on its own "
            "whether it is right (right, quote). Don't mark them all right to be safe: wrong picks count."
        )
    if b.kind in ("choice", "cards", "macaroni"):
        what = {"choice": "item → option", "cards": "card → group", "macaroni": "left item → right item"}[b.kind]
        return _obj({"pairs": PAIRS}, ["pairs"]), (
            f"Pair every {what}: for each item 1–{len(b.numbers)} pick one letter {b.letters[0] if b.letters else 'A'}–"
            f"{b.letters[-1] if b.letters else 'Z'} with a short reason. Decide each item from the lesson."
        )
    if b.kind == "text":
        return _obj({"answer": {"type": "string"}, "needs_user": {"type": "boolean"}, "why": {"type": "string"}}, ["answer", "needs_user", "why"]), (
            "Free-text answer: give exactly what is asked (a word, a number, a command's output), never a placeholder. "
            "needs_user = true only if the answer depends on something the student must do themselves "
            "(run a command on their own computer, use an outside service); then leave answer empty."
        )
    if b.kind == "chat":
        return _obj({"reply": {"type": "integer"}, "why": {"type": "string"}}, ["reply", "why"]), (
            f"Chat quiz: the bot's current question and its replies are under «On screen now». reply = the number (1–{len(b.numbers)}) of the right reply."
        )
    if b.kind == "code":
        return _obj({"code": {"type": "string"}}, ["code"]), "Code exercise: write the complete program (the whole editor content) that solves it."
    raise ValueError(b.kind)


def answer_of(b: Block, reply: dict | None) -> str | None:
    """The answer_quiz string a form reply stands for, or None when the reply is unusable."""
    if not isinstance(reply, dict):
        return None
    try:
        if b.kind == "radio":
            n = int(reply["answer"])
            return str(n) if str(n) in b.numbers else None
        if b.kind == "checkbox":
            picks = sorted({int(o["n"]) for o in reply["options"] if o.get("right") and str(int(o["n"])) in b.numbers})
            return ", ".join(map(str, picks)) or None
        if b.kind in ("choice", "cards", "macaroni"):
            pairs = {}
            for p in reply["pairs"]:
                item, pick = str(int(p["item"])), str(p["pick"]).strip().upper()[:1]
                if item in b.numbers and pick in b.letters:
                    pairs[item] = pick
            if set(pairs) != set(b.numbers):
                return None  # every item needs a pick
            return "; ".join(f"{k}={pairs[k]}" for k in sorted(pairs, key=int))
        if b.kind == "text":
            if reply.get("needs_user"):
                return "\0user"
            a = str(reply.get("answer", "")).strip()
            return a or None
        if b.kind == "chat":
            n = int(reply["reply"])
            return str(n) if str(n) in b.numbers else None
    except (KeyError, TypeError, ValueError):
        return None
    return None


# ---------------------------------------------------------------- the solver

class LessonSolver:
    def __init__(self, call, backend, note, ask_user: AskUser | None = None, samples: int = 3, temperature: float = 0.5, consult: bool = True):
        self.call = call  # async (tool, args) -> (text, is_error), the bridge's tools
        self.backend = backend  # OllamaBackend (structured calls)
        self.note, self.ask_user = note, ask_user
        self.samples, self.temperature, self.consult = samples, temperature, consult
        self.seed = 1000

    async def read(self, blocks: bool) -> str:
        """The whole read_lesson output, following its offset pages."""
        text, offset = "", 0
        for _ in range(20):
            out, err = await self.call("read_lesson", {"blocks": blocks, **({"offset": offset} if offset else {})})
            if err:
                raise RuntimeError(out)
            m = MORE.search(out)
            page = out[: m.start()] if m else out
            if offset:
                page = page.split(f"…(from character {offset})\n", 1)[-1]
            text += page
            if not m:
                return text
            offset = int(m.group(2))
        return text

    def context(self, full: str, b: Block, limit: int = 9000) -> str:
        """Lesson text before the block: what the student has read when they get to it."""
        i = full.find(f"[{b.ref} · ")
        before = full[: i if i >= 0 else len(full)]
        return before[-limit:]

    async def sample(self, b: Block, ctx: str, extra: str = "") -> list[str | None]:
        schema, instruction = form(b)
        msgs = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"Lesson text up to the question:\n\n{ctx}\n\n---\nQuestion {b.ref}:\n{b.body}\n\n{extra}{instruction}"},
        ]
        out = []
        for _ in range(self.samples):
            self.seed += 1
            reply = await self.backend.structured(msgs, schema, self.temperature, self.seed)
            out.append(answer_of(b, reply))
        return out

    async def decide(self, b: Block, ctx: str, lines: list[str], extra: str = "") -> str | None:
        """An answer the samples agree on, after consulting Практикум ИИ if needed; else the user's, or None."""
        votes = await self.sample(b, ctx, extra)
        self.note("solver", f"{b.ref} {b.kind}: samples {votes}")
        agreed = self.agreed(votes)
        if agreed is None and b.kind in RETRYABLE:
            usable = [v for v in votes if v and v != "\0user"]
            if usable:
                return Counter(usable).most_common(1)[0][0]  # a wrong answer can be corrected
        if agreed is None and self.consult:
            explanation = await self.ask_tutor(b)
            if explanation:
                votes = await self.sample(b, ctx, f"Практикум ИИ explained:\n{explanation}\n\n")
                self.note("solver", f"{b.ref}: samples after Практикум ИИ {votes}")
                agreed = self.agreed(votes)
        if agreed == "\0user" or agreed is None:
            candidates = [v for v, _ in Counter(v for v in votes if v and v != "\0user").most_common()]
            why = "needs the student's own action" if agreed == "\0user" else f"the model isn't sure ({' / '.join(candidates) or 'no usable answer'})"
            if self.ask_user:
                got = await self.ask_user(b.ref, f"[{b.ref} · {b.header}]\n{b.body}", candidates)
                if got:
                    lines.append(f"{b.ref}: the user answered «{got}»")
                    return got
            lines.append(f"{b.ref} {b.kind}: LEFT FOR THE USER — {why}")
            return None
        return agreed

    @staticmethod
    def agreed(votes: list[str | None]) -> str | None:
        usable = [v for v in votes if v]
        if usable and len(usable) == len(votes) and len(set(usable)) == 1:
            return usable[0]
        return None

    async def ask_tutor(self, b: Block) -> str | None:
        """A concept question about the block (tutors refuse "what's the answer to q3")."""
        stem = b.body.split("\n  1.")[0].strip()[:600]
        if b.kind in ("radio", "checkbox"):
            q = f"Помоги разобраться в теме урока. Вопрос: «{stem}». Для каждого утверждения объясни, верно ли оно и почему:\n" + "\n".join(
                f"— {line.split('. ', 1)[-1].strip()}" for line in b.body.splitlines() if re.match(r"^  \d+\. ", line)
            )
        elif b.kind in ("choice", "cards", "macaroni"):
            q = f"Помоги разобраться в теме урока: «{stem}». Объясни, как связаны эти понятия:\n{b.body[len(stem):][:1200]}"
        elif b.kind == "text":
            q = f"Помоги разобраться: как решить такую задачу из урока? Объясни ход решения.\n{b.body[:1200]}"
        else:
            return None
        out, err = await self.call("ask_platform_ai", {"question": q})
        if err:
            self.note("solver", f"{b.ref}: Практикум ИИ unavailable: {out[:200]}")
            return None
        text = out.split("\nSuggested follow-up questions:")[0].strip()
        return text[:3000] or None

    async def answer(self, b: Block, ans: str, lines: list[str], retry: bool = False) -> str | None:
        """answer_quiz; the tool's output, or None when it failed."""
        out, err = await self.call("answer_quiz", {"block": b.ref, "answer": ans, **({"retry": True} if retry else {})})
        verdict = next((l for l in out.splitlines() if l.startswith(("The page marks", "Verdict", "Correct", "Not correct"))), "")
        lines.append(f"{b.ref} {b.kind}: answered «{ans}»" + (f" → {verdict}" if verdict else "") if not err else f"{b.ref}: answer_quiz failed: {out[:200]}")
        return None if err else out

    async def code(self, b: Block, ctx: str, lines: list[str]) -> None:
        """Write, run, and check a graded code exercise; up to three checks."""
        if "hint:" in b.header:
            hint, err = await self.call("show_hint", {"block": b.ref})
            if not err:
                ctx += f"\n\n{hint}"
        schema, instruction = form(b)
        feedback = ""
        for attempt in range(1, 4):
            self.seed += 1
            msgs = [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"Lesson text up to the exercise:\n\n{ctx}\n\n---\nExercise {b.ref}:\n{b.body}\n\n{feedback}{instruction}"},
            ]
            reply = await self.backend.structured(msgs, schema, 0.2, self.seed)
            code = (reply or {}).get("code") if isinstance(reply, dict) else None
            if not code:
                break
            run, _ = await self.call("run_code_exercise", {"block": b.ref, "code": code})
            out, err = await self.call("check_code_exercise", {"block": b.ref, "code": code})
            if not err and out.startswith("Solved"):
                lines.append(f"{b.ref} code: solved on check {attempt}")
                return
            feedback = f"Your previous code:\n```\n{code}\n```\nRun: {run[:1500]}\nCheck: {out[:1500]}\nFix it.\n\n"
        lines.append(f"{b.ref} code: LEFT FOR THE USER — not solved after the checks above")

    async def solve(self) -> str:
        lines: list[str] = []
        full = await self.read(blocks=False)
        left: set[str] = set()  # refs left for the user
        for _ in range(80):
            blocks = parse_blocks(await self.read(blocks=True))
            todo = [b for b in blocks if not b.done and b.ref not in left and b.kind != "survey"]
            if not todo:
                break
            b = todo[0]
            if b.hidden:
                # Hidden behind something already left for the user: the rest of the lesson can't be reached.
                lines.append(f"{b.ref}: still hidden behind {', '.join(sorted(left)) or 'an earlier block'}; stopping here")
                break
            ctx = self.context(full, b)
            if b.kind == "button":
                out, err = await self.call("press_action_button", {"block": b.ref})
                lines.append(f"{b.ref} button pressed" if not err else f"{b.ref}: press failed: {out[:200]}")
                if err:
                    left.add(b.ref)
            elif b.kind == "example":
                out, err = await self.call("run_code_exercise", {"block": b.ref})
                lines.append(f"{b.ref} code example run" if not err else f"{b.ref}: run failed: {out[:200]}")
                if err:
                    left.add(b.ref)
            elif b.kind == "code":
                await self.code(b, ctx, lines)
                left.add(b.ref)  # solved or not, don't loop on it
            elif b.kind == "chat":
                for _ in range(12):  # one reply per question; a wrong reply may be retried
                    ans = await self.decide(b, ctx, lines)
                    if not ans or await self.answer(b, ans, lines) is None:
                        left.add(b.ref)
                        break
                    b = next((x for x in parse_blocks(await self.read(blocks=True)) if x.ref == b.ref), b)
                    if b.done:
                        break
            elif b.kind in ("radio", "checkbox", "choice", "cards", "macaroni", "text"):
                ans = await self.decide(b, ctx, lines)
                out = await self.answer(b, ans, lines) if ans else None
                if out is None:
                    left.add(b.ref)
                for _ in range(2 if b.kind in RETRYABLE else 0):
                    m = MARKS.search(out or "")
                    if not m or m.group(2) == "0":
                        break
                    # Matching and cards can be answered again: retry with what the page showed.
                    shown = (out or "").split("The quiz now shows:", 1)[-1].strip()[:1500]
                    extra = f"Your previous answer «{ans}» got {m.group(1)} right and {m.group(2)} wrong. The page showed:\n{shown}\n\n"
                    ans = await self.decide(b, ctx, lines, extra)
                    out = await self.answer(b, ans, lines, retry=True) if ans else None
            else:
                lines.append(f"{b.ref}: {b.kind} block, skipped")
                left.add(b.ref)
        surveys = [b.ref for b in parse_blocks(await self.read(blocks=True)) if b.kind == "survey" and not b.done]
        if surveys:
            lines.append(f"{', '.join(surveys)}: feedback survey — the user's own opinion, left for the user")
        out, err = await self.call("complete_lesson", {})
        lines.append(f"complete_lesson: {out.splitlines()[0] if out else ''}" if not err else f"complete_lesson not done: {out[:300]}")
        if not err and "\nNow:\n" in out:
            now = out.split("\nNow:\n", 1)[1]
            lines.append("Now on:\n" + now[:600])
            # Seen in a journey: the model opened the «Next lesson id» (the lesson after this one) and skipped it.
            nxt = "call solve_current_lesson again" if "Page: theory lesson" in now else "read_task, then solve the task"
            lines.append(f"If your task includes more lessons, this new page is the next one: {nxt}. If it doesn't, call finish.")
        return "\n".join(lines)


SOLVE_TOOL = {
    "name": "solve_current_lesson",
    "description": (
        "On a theory lesson: work through all its blocks in order — presses buttons, answers every quiz "
        "and chat quiz one question at a time with self-checked answers, runs and checks code exercises — "
        "asking Практикум ИИ or the user when unsure, then presses complete_lesson. Returns what was done "
        "and what was left for the user."
    ),
}
