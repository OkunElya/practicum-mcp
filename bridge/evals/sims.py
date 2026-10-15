"""Simulated Practicum pages for evals: the bridge's MCP client, answered locally.

Two kinds of scenario directories (see make_scenarios.py and tune.py):

  trainer   files/ + task.txt, lesson.txt, where.txt, checks.json, hint.txt?
            A code-trainer task: file tools work on a temp copy of the project;
            check_task and fetch_preview run it with Django (django_probe.py).
  lesson    lesson.json (raw GET /api/lessons/{id}/) + meta.json
            A theory lesson: read_lesson is rendered by the extension's own code
            (lesson_helper.ts), answer_quiz is parsed by it too and graded with the
            answer keys the lesson JSON carries; code exercises are graded by
            testlib_shim.py when it can, else by comparing output with the
            reference solution.

Every tool takes the real schema (tools.json) and fails the way the extension
would on that page. Nothing here talks to the browser or the account.
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace

from practicum_bridge.config import load_tool_specs
from practicum_bridge.server import to_mcp_tool

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PROBE = HERE / "django_probe.py"
DJANGO = ["uv", "run", "--no-project", "--with", "django>=5,<6", "python", "-I"]
PREVIEW = "https://sim-preview.local/"
SIM_HIDDEN = {"ask_platform_ai", "reset_platform_ai_chat"}  # no Практикум ИИ in the simulation
# Present on each kind of page; the rest fail as "not available here".
TRAINER_TOOLS = {"where_am_i", "read_task", "read_lesson", "get_code", "set_code", "create_file", "run_code", "check_task", "show_hint", "deploy", "fetch_preview", "next_task"}
LESSON_TOOLS = {"where_am_i", "read_lesson", "answer_quiz", "press_action_button", "run_code_exercise", "check_code_exercise", "reset_code_exercise", "show_hint", "complete_lesson"}
TRAINER_ONLY = TRAINER_TOOLS - LESSON_TOOLS
NEXT_BUTTON = "next-lesson-control-button"
RETRYABLE = {"QuizCards", "QuizChoice"}  # as in the extension's theory.ts
END = "[tool] the simulation ends here: the lesson is complete. Stop and write the summary."


def result(text: str, error: bool = False):
    return SimpleNamespace(content=[SimpleNamespace(text=text)], is_error=error)


class SimError(Exception):
    """A tool failure, shown to the model as "[tool] message" like the extension's ToolError."""


# ---------------------------------------------------------------- lesson helper (node)

class Helper:
    """The extension's lesson code (render, block lookup, answer parsing) in a node process."""

    _shared = None
    _lock = threading.Lock()

    def __init__(self):
        out = HERE / ".build" / "lesson_helper.cjs"
        sources = [HERE / "lesson_helper.ts", ROOT / "extension/src/shared/lesson.ts", ROOT / "extension/src/shared/answers.ts"]
        if not out.exists() or out.stat().st_mtime < max(p.stat().st_mtime for p in sources):
            out.parent.mkdir(exist_ok=True)
            subprocess.run(
                [str(ROOT / "node_modules/.bin/esbuild"), str(HERE / "lesson_helper.ts"), "--bundle", "--platform=node", "--format=cjs", f"--outfile={out}", "--log-level=warning"],
                check=True, cwd=ROOT,
            )
        self.proc = subprocess.Popen(["node", str(out)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    @classmethod
    def get(cls) -> "Helper":
        with cls._lock:
            if cls._shared is None or cls._shared.proc.poll() is not None:
                cls._shared = Helper()
            return cls._shared

    def __call__(self, **req) -> dict:
        with self._lock:
            self.proc.stdin.write(json.dumps(req, ensure_ascii=False) + "\n")
            self.proc.stdin.flush()
            reply = json.loads(self.proc.stdout.readline())
        if "error" in reply:
            raise SimError(reply["error"])
        return reply


# ---------------------------------------------------------------- shared base

class BaseSim:
    kind = ""
    page = ""
    tools_here: set[str] = set()

    def __init__(self, scenario: Path):
        self.sc = scenario
        self.tools = [to_mcp_tool(s) for s in load_tool_specs() if s["name"] not in SIM_HIDDEN and not s["name"].startswith("dev_")]
        self.schemas = {t.name: t.input_schema for t in self.tools}
        self.log: list[tuple[str, dict, bool]] = []  # (tool, args, error)

    async def list_tools(self):
        return SimpleNamespace(tools=self.tools)

    async def call_tool(self, name: str, args: dict):
        import asyncio

        r = await asyncio.to_thread(self._call, name, args)
        self.log.append((name, args, r.is_error))
        return r

    def _call(self, name: str, args: dict):
        schema = self.schemas.get(name)
        if schema is None:
            return result(f"[tool] unknown tool {name}", True)
        extra = set(args) - set(schema["properties"])
        if extra:
            return result(f"[args] unknown argument(s) {sorted(extra)} for {name}", True)
        missing = [k for k in schema.get("required", []) if k not in args]
        if missing:
            return result(f"[args] missing argument(s) {missing} for {name}", True)
        if name not in self.tools_here:
            return result(self.unavailable(name), True)
        try:
            return getattr(self, f"t_{name}")(**args)
        except SimError as e:
            return result(f"[tool] {e}", True)

    def unavailable(self, name: str) -> str:
        if name in ("open_lesson", "go_home", "get_progress"):
            return f"[tool] {name} is not available in the simulation: stay on this page"
        return f"[tool] {name} is not available on this page ({self.page})"

    def metrics(self) -> dict:
        return {}


class TrainerSim(BaseSim):
    """A code-trainer task, answered by a local copy of its project."""

    kind = "trainer"
    page = "code trainer"
    tools_here = TRAINER_TOOLS

    def __init__(self, scenario: Path, workdir: Path):
        super().__init__(scenario)
        self.dir = workdir
        shutil.copytree(scenario / "files", workdir, dirs_exist_ok=True)
        self.solved = False
        self.deployed = False
        self.attempts = 0
        self.current = None  # file open in the editor

    def files(self) -> list[str]:
        return sorted(str(p.relative_to(self.dir)) for p in self.dir.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".sqlite3")

    def status(self, text: str) -> str:
        return text.replace("not solved", "solved") if self.solved else text

    def probe(self, mode: str, *arg: str) -> dict:
        r = subprocess.run([*DJANGO, str(PROBE), str(self.dir), str(self.sc / "checks.json"), mode, *arg], capture_output=True, text=True, timeout=120)
        try:
            return json.loads(r.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            return {"setup_error": (r.stderr or r.stdout)[-1500:]}

    def path(self, file) -> Path | None:
        if not isinstance(file, str) or not file.strip():
            return None
        p = (self.dir / file.strip().lstrip("/")).resolve()
        return p if p.is_relative_to(self.dir.resolve()) else None

    def t_where_am_i(self):
        return result(self.status((self.sc / "where.txt").read_text()))

    def t_read_task(self):
        lines = []
        for l in self.status((self.sc / "task.txt").read_text()).splitlines():
            if l.startswith("Files ("):
                fs = self.files()
                l = f"Files ({len(fs)}): " + ", ".join(fs)
            lines.append(l)
        return result("\n".join(lines))

    def t_read_lesson(self, lesson=None, offset=None, blocks=None):
        raw = self.sc / "lesson_raw.json"
        if raw.exists() and not lesson:
            opts = {"offset": offset or 0, "blocksOnly": bool(blocks)}
            return result(Helper.get()(op="render", lesson=json.loads(raw.read_text()), answers=[], opts=opts)["text"])
        if lesson:
            return result("[tool] only the current lesson can be read in the simulation", True)
        text = self.status((self.sc / "lesson.txt").read_text())
        if blocks:
            text = "\n".join(text.splitlines()[:3])
        return result(text[int(offset or 0):])

    def t_get_code(self, file=None):
        p = self.path(file) if file else (self.path(self.current) if self.current else None)
        if p is None or not p.is_file():
            return result(f'[tool] no file "{file}" (use create_file to add it). Files: {", ".join(self.files())}' if file else "[tool] no code editor on this page", True)
        self.current = str(p.relative_to(self.dir.resolve()))
        return result(f"File: {self.current}\n```\n{p.read_text()}\n```")

    def t_set_code(self, code, file=None):
        p = self.path(file) if file else (self.path(self.current) if self.current else None)
        if p is None or not p.is_file():
            return result(f'[tool] "{file}" is not in the project\'s file tree (to add a new file use create_file). Files: {", ".join(self.files())}' if file else "[tool] no editor model found", True)
        before = len(p.read_text())
        p.write_text(code)
        self.current = str(p.relative_to(self.dir.resolve()))
        return result(f"Wrote {len(code)} characters to {self.current} (it had {before}). The user can undo this with Ctrl+Z in the editor.")

    def t_create_file(self, file, code=None):
        p = self.path(file)
        if p is None:
            return result(f"[tool] bad file name {file!r}", True)
        rel = str(p.relative_to(self.dir.resolve()))
        if p.exists():
            msg = f"{rel} already exists."
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("")
            msg = f"Created {rel}."
        if code:
            p.write_text(code)
            msg += f" Wrote {len(code)} characters to {rel}."
        self.current = rel
        return result(msg)

    def t_run_code(self):
        return result("[tool] this is a web project: there is no «Выполнить код» button; use deploy and fetch_preview", True)

    def t_check_task(self):
        self.attempts += 1
        r = self.probe("check")
        if "setup_error" in r:
            r = {"solved": False, "message": "Проект не запускается:\n" + r["setup_error"]}
        self.solved = self.solved or r["solved"]
        lines = [f"{'Solved ✓' if r['solved'] else 'Not solved.'} (attempt {self.attempts})"]
        if r["message"]:
            lines.append(f"Checker: {r['message']}")
        if r["solved"]:
            lines += ["Page: Задание выполнено", "Next: «Далее» (next_task)", "The lesson is solved."]
        return result("\n".join(lines))

    def t_show_hint(self, number=None, block=None):
        hint = self.sc / "hint.txt"
        if block:
            return result("[tool] this is a trainer task, not a theory block", True)
        if not hint.exists():
            return result("This task has no hints.")
        return result(f"Hint 1/1:\n{hint.read_text().strip()}")

    def t_deploy(self):
        self.deployed = True
        return result(f"Deployed. Preview: {PREVIEW} (fetch_preview reads it).")

    def t_fetch_preview(self, path=None):
        if not self.deployed:
            return result("[tool] nothing is deployed; call deploy first", True)
        path = "/" + str(path or "/").removeprefix(PREVIEW).lstrip("/")
        r = self.probe("get", path)
        if "setup_error" in r:
            return result(f"HTTP 500 (server error; the Django traceback may be in the page):\n{r['setup_error']}")
        if r["status"] >= 500:
            return result(f"HTTP {r['status']} (server error; the Django traceback may be in the page):\n{r['body'][:8000]}")
        return result(f"HTTP {r['status']}\n{r['body'][:8000]}")

    def t_next_task(self, direction=None):
        if direction == "prev":
            return result("[tool] there is no previous task", True)
        if not self.solved:
            return result("[tool] the «Далее» button appears only after the task is solved (check_task)", True)
        return result("Page: theory lesson\nURL: https://practicum.yandex.ru/learn/next-lesson/\n(The simulation ends here.)")

    def metrics(self) -> dict:
        return {"solved": self.solved, "checks": self.attempts}


# ---------------------------------------------------------------- theory lesson

def _feedback(o: dict, ok: bool) -> str:
    return str(o.get("feedback-positive" if ok else "feedback-negative") or o.get("feedback") or "").strip()


def run_python(code: str, timeout: float = 10) -> tuple[str, bool]:
    """Run a snippet like the platform's «Запустить»: (output, failed)."""
    with tempfile.TemporaryDirectory(prefix="sim-run-") as tmp:
        f = Path(tmp) / "main.py"
        f.write_text(code)
        try:
            r = subprocess.run([sys.executable, "-I", str(f)], capture_output=True, text=True, timeout=timeout, cwd=tmp)
        except subprocess.TimeoutExpired:
            return f"Превышено время выполнения ({timeout:.0f} с)", True
    if r.returncode != 0:
        err = "\n".join(r.stderr.strip().splitlines()[-6:]).replace(str(f), "main.py")
        return (r.stdout + err).strip(), True
    return r.stdout.rstrip(), False


def grade_code(code: str, content: dict) -> dict:
    """{"solved", "message", "stdout"}: the platform's test via testlib_shim, else the reference output."""
    answer = "\n".join(p.get("content", "") for p in content.get("answer_panes") or [])
    try:
        from testlib_shim import grade  # written alongside; optional
    except ImportError:
        grade = None
    if not content.get("test") or not content.get("answer_panes"):
        # 21 of the scraped graded exercises ship neither (make_scenarios.py skips their lessons).
        raise SimError("the simulation can't check this exercise: the lesson data has no tests for it")
    if grade:
        r = grade(code, answer, content["test"], precode=(content.get("coderun_config") or {}).get("precode", ""))
        return {"solved": bool(r["solved"]), "message": r.get("message", ""), "stdout": r.get("stdout", "")}
    out, failed = run_python(code)
    ref, _ = run_python(answer)
    if failed:
        return {"solved": False, "message": out.splitlines()[-1] if out else "ошибка выполнения", "stdout": out}
    ok = out.strip() == ref.strip()
    return {"solved": ok, "message": "" if ok else f"Проверьте, что выведенный текст соответствует ожидаемому.\nВаш вывод:\n\n```\n{out}\n```\n\nА должно быть:\n\n```\n{ref}\n```", "stdout": out}


class LessonSim(BaseSim):
    """A theory lesson from its raw JSON: real rendering, answers graded with the lesson's keys."""

    kind = "lesson"
    page = "theory lesson"
    tools_here = LESSON_TOOLS

    def __init__(self, scenario: Path, workdir: Path | None = None):
        super().__init__(scenario)
        self.lesson = json.loads((scenario / "lesson.json").read_text())
        meta = scenario / "meta.json"
        self.meta = json.loads(meta.read_text()) if meta.exists() else {}
        self.helper = Helper.get()
        self.answers: list[dict] = []  # SavedAnswer objects, as GET /api/lessons/{id}/quizzes/ returns them
        self.attempts: dict[str, list[bool]] = {}  # block ref → correctness of each attempt
        self.code: dict[str, str] = {}  # block ref → code in its editor
        self.chats: dict[str, dict] = {}  # block ref → {"msg", "used", "pending"}
        self.done = False

    # -- helpers

    def blocks(self) -> list[dict]:
        return self.helper(op="blocks", lesson=self.lesson, answers=self.answers)["blocks"]

    def block(self, ref: str, answer: str | None = None) -> tuple[dict, dict, dict | None]:
        """(brief block, its theory node, the parsed answer plan) for a ref like q3."""
        r = self.helper(op="plan", lesson=self.lesson, answers=self.answers, ref=ref, **({"answer": answer} if answer is not None else {}))
        return r["block"], self.node(r["block"]["nodeId"]), r.get("plan")

    def node(self, node_id: str) -> dict:
        stack = [self.lesson["theory"]]
        while stack:
            n = stack.pop()
            if n["id"] == node_id:
                return n
            stack.extend(n.get("nested") or [])
        raise SimError(f"no node {node_id}")

    def save(self, b: dict, user_answer) -> None:
        key = f"expander-{b['contentId']}" if b["type"] == "ActionButton" else b["contentId"]
        old = next((a for a in self.answers if a["content_quiz_id"] == key), None)
        if old:
            old["user_answer"] = user_answer
            old["attempts_count"] = old.get("attempts_count", 1) + 1
        else:
            self.answers.append({"content_quiz_id": key, "user_answer": user_answer, "attempts_count": 1})

    def record(self, ref: str, ok: bool) -> None:
        self.attempts.setdefault(ref, []).append(ok)

    def url(self, lesson: dict | None = None) -> str:
        l = lesson or self.lesson
        return f"https://practicum.yandex.ru/learn/{l.get('profession_slug', 'ap-backend-st')}/courses/{l.get('course_id')}/sprints/{l.get('sprint_id')}/topics/{l.get('topic_id')}/lessons/{l['id']}/"

    def required_open(self) -> list[dict]:
        """Blocks that keep the «next» button hidden: buttons and blocking tasks not answered yet."""
        out = []
        for b in self.blocks():
            c = self.node(b["nodeId"]).get("content") or {}
            if not b["answered"] and (b["type"] == "ActionButton" or c.get("blocking")):
                out.append(b)
        return out

    def unavailable(self, name: str) -> str:
        if self.done:
            return END
        if name in TRAINER_ONLY:
            return "[tool] this is not a code-trainer page"
        if name == "next_task":
            return "[tool] there is no «Далее» button on a theory lesson; use complete_lesson"
        return super().unavailable(name)

    def acting(self) -> None:
        if self.done:
            raise SimError(END.removeprefix("[tool] "))

    # -- read tools

    def t_where_am_i(self):
        l = self.lesson
        if self.done:
            nxt = self.meta.get("next") or {}
            return result("\n".join([
                "Page: theory lesson",
                f"URL: https://practicum.yandex.ru/learn/{l.get('profession_slug', 'ap-backend-st')}/lessons/{l.get('next_lesson_id')}/",
                f"Lesson: «{nxt.get('name', 'следующий урок')}» [{nxt.get('type', 'web')}] id={l.get('next_lesson_id')}, not solved",
                "(The simulation ends here.)",
            ]))
        lines = [
            "Page: theory lesson",
            f"URL: {self.url()}",
            f"Course: {l.get('course_name', '')} › Topic: {l.get('topic_name', '')}",
            f"Lesson {int(l.get('position') or 0) + 1}/{l.get('topic_lessons_count', '?')}: «{l['name']}» [{l.get('lesson_type')}] id={l['id']}, {'solved' if l.get('solved') else 'not solved'}",
        ]
        if l.get("next_lesson_id"):
            lines.append(f"Next lesson id: {l['next_lesson_id']}")
        lines.append("Buttons on screen:")
        label = "Перейти к заданию" if self.meta.get("practice_next") else "К следующему уроку"
        lines.append(f"- {label} ({NEXT_BUTTON})" if not self.required_open() else f"- {label} ({NEXT_BUTTON}) [disabled]")
        lines.append("- Чат с Практикум ИИ (sidebar-gpt-button)")
        return result("\n".join(lines))

    def t_read_lesson(self, lesson=None, offset=None, blocks=None):
        if self.done:
            return result(END, True)
        if lesson and str(lesson).strip().lower() not in (self.lesson["id"], ""):
            raise SimError("in the simulation only the current lesson can be read (omit lesson)")
        live = {b["nodeId"]: self.chat_live(b) for b in self.blocks() if b["type"] == "QuizChat"}
        opts = {"offset": offset or 0, "blocksOnly": bool(blocks), "live": live}
        return result(self.helper(op="render", lesson=self.lesson, answers=self.answers, opts=opts)["text"])

    def t_show_hint(self, number=None, block=None):
        if not block:
            raise SimError("this is not a code-trainer page")
        b, n, _ = self.block(block)
        hint = str((n.get("content") or {}).get("hint") or "").strip() if b["type"] == "QuizCoding" else ""
        if not hint:
            raise SimError(f"{b['ref']} has no hint")
        return result(f"Hint for {b['ref']}:\n{hint}")

    # -- actions

    def t_press_action_button(self, block):
        self.acting()
        b, n, _ = self.block(block)
        if b["type"] != "ActionButton":
            raise SimError(f"{b['ref']} is a {b['type']}, not a button; use answer_quiz")
        if b["answered"]:
            return result(f"{b['ref']} was already pressed; its content is visible.")
        label = str((n.get("content") or {}).get("text") or "button")
        self.save(b, {})
        return result(f"Pressed «{label}» ({b['ref']}). The content after it is now shown; read_lesson to continue.")

    def t_answer_quiz(self, block, answer, retry=None):
        self.acting()
        b, n, _ = self.block(block)
        if b["type"] == "QuizChat":
            return self.answer_chat(b, n, str(answer))
        if b["answered"]:
            if b["type"] not in RETRYABLE:
                raise SimError(f"{b['ref']} is already answered and this quiz type allows one attempt only")
            if not retry:
                raise SimError(f"{b['ref']} is already answered; pass retry=true to answer it again")
        _, _, plan = self.block(block, str(answer))
        c = n.get("content") or {}
        grade = getattr(self, f"grade_{b['type']}")
        user_answer, marks, shown = grade(c, plan)
        self.save(b, user_answer)
        good, bad = sum(marks), len(marks) - sum(marks)
        self.record(b["ref"], bad == 0)
        tail = f"\nThe page marks {good} correct, {bad} incorrect." if marks else ""
        return result(f"Answer to {b['ref']} submitted.{tail}\nThe quiz now shows:\n{shown}")

    def grade_QuizSelect(self, c, plan):
        opts = c.get("options") or []
        chosen = set(plan["optionIds"])
        right = {o["id"] for o in opts if o.get("correct")}
        lines, marks = [], []
        for i, o in enumerate(opts):
            picked, correct = o["id"] in chosen, bool(o.get("correct"))
            if picked:
                marks.append(correct)
            if picked or c.get("show_all_feedback"):
                fb = _feedback(o, correct)
                mark = "✓" if picked == correct else "✗"
                lines.append(f"{mark} {i + 1}. {str(o.get('content', '')).strip()}{' (выбран)' if picked else ''}" + (f"\n   {fb}" if fb else ""))
        if not right:
            # No option is marked correct: an opinion question, any answer counts.
            marks = [True] * len(marks)
        elif c.get("type") == "checkbox" and chosen < right:
            # Every pick was right, but some right options were left out.
            marks.append(False)
            lines.append("Выбраны не все правильные варианты.")
        return plan["optionIds"], marks, "\n".join(lines)

    def grade_QuizChoice(self, c, plan):
        qs = c.get("questions") or []
        opts = {o["id"]: o.get("content", "") for o in c.get("options") or []}
        ua, marks, lines = {}, [], []
        for p in plan["picks"]:
            q = qs[p["questionIndex"]]
            ok = q.get("correct_option") == p["optionId"]
            ua[q["id"]] = p["optionId"]
            marks.append(ok)
            lines.append(f"{'✓' if ok else '✗'} {q.get('content', '').strip()} → {opts.get(p['optionId'], '').strip()}")
        tpl = c.get("result_text") or ""
        if tpl:
            lines.append(tpl.replace("{correctCount}", str(sum(marks))).replace("{totalCount}", str(len(marks))).replace("{incorrectCount}", str(len(marks) - sum(marks))))
        return ua, marks, "\n".join(lines)

    def grade_QuizCards(self, c, plan):
        cards = {o["id"]: o for o in c.get("options") or []}
        ua: dict = {"source": []}
        marks, lines = [], []
        for m in plan["moves"]:
            o = cards[m["cardId"]]
            ok = o.get("correct_section") == m["sectionId"]
            ua.setdefault(m["sectionId"], []).append(m["cardId"])
            marks.append(ok)
            fb = _feedback(o, ok)
            lines.append(f"{'✓' if ok else '✗'} {o.get('content', '').strip()} → {m['section']}" + (f"\n   {fb}" if fb else ""))
        return ua, marks, "\n".join(lines)

    def grade_QuizMacaroni(self, c, plan):
        given = {(p["left"], p["right"]) for p in plan["pairs"]}
        keys = [{tuple(x) for x in ans} for ans in c.get("correct_answers") or []]
        best = max(keys, key=lambda k: len(k & given), default=set())
        marks, lines = [], []
        for p in plan["pairs"]:
            ok = (p["left"], p["right"]) in best
            marks.append(ok)
            lines.append(f"{'✓' if ok else '✗'} {p['leftText']} → {p['rightText']}")
        if c.get("feedback"):
            lines.append(str(c["feedback"]).strip())
        return [[p["left"], p["right"]] for p in plan["pairs"]], marks, "\n".join(lines)

    def grade_QuizText(self, c, plan):
        text = plan["text"]
        ok = False
        for v in c.get("validations") or []:
            match = str(v.get("match", ""))
            if v.get("type") == "regexp":
                try:
                    ok = re.search(match, text) is not None
                except re.error:
                    ok = False
            else:
                ok = text.strip() == match.strip()
            if ok:
                break
        fb = str(c.get("feedback_positive" if ok else "feedback_negative") or "").strip()
        return text, [ok], f"{'Верно' if ok else 'Неверно'}: «{text}»" + (f"\n{fb}" if fb else "")

    # -- chat quiz: a state machine; one reply per call

    def chat(self, b: dict, n: dict) -> dict:
        st = self.chats.get(b["ref"])
        if st is None:
            st = self.chats[b["ref"]] = {"msg": None, "used": set(), "finished": False}
            self.chat_goto(n["content"], st, n["content"].get("initial"))
        return st

    def chat_goto(self, c: dict, st: dict, mid) -> None:
        """Follow bot messages without replies («Далее»-less NEXT transitions) to the next question."""
        seen = set()
        while mid and mid not in seen:
            seen.add(mid)
            m = (c.get("messages") or {}).get(mid)
            if m is None:
                break
            if m.get("answers"):
                st.update(msg=mid, used=set(), finished=False)
                return
            on = (c.get("state") or {}).get(mid, {}).get("on") or {}
            mid = on.get("NEXT") or next(iter(on.values()), None)
        st.update(msg=None, used=set(), finished=True)

    def chat_options(self, c: dict, st: dict) -> list[dict]:
        m = (c.get("messages") or {}).get(st["msg"]) or {}
        answers = m.get("answers") or {}
        order = m.get("orderList") or list(answers)
        return [answers[a] for a in order if a in answers]

    def chat_live(self, b: dict) -> str:
        n = self.node(b["nodeId"])
        c, st = n["content"], self.chat(b, n)
        if st["finished"]:
            return "On screen: finished"
        bot = str((c["messages"][st["msg"]].get("content") or "")).strip()
        opts = self.chat_options(c, st)
        return f"On screen now: {bot}\nReplies (answer_quiz uses these numbers):\n" + "\n".join(
            f"  {i + 1}. {str(o.get('content', '')).strip()}{' (already given)' if o['id'] in st['used'] else ''}" for i, o in enumerate(opts)
        )

    def answer_chat(self, b: dict, n: dict, answer: str):
        c, st = n["content"], self.chat(b, n)
        if st["finished"]:
            raise SimError("the chat quiz is already finished")
        opts = self.chat_options(c, st)
        a = answer.strip()
        norm = lambda s: " ".join(str(s).split()).lower()  # noqa: E731
        i = int(a) - 1 if a.isdigit() else next((j for j, o in enumerate(opts) if norm(o.get("content", "")) == norm(a) or norm(o.get("content", "")).startswith(norm(a))), -1)
        if not 0 <= i < len(opts):
            raise SimError(f'"{answer}" is not one of the replies on screen: ' + "; ".join(f"{j + 1}. {str(o.get('content', '')).strip()}" for j, o in enumerate(opts)))
        o = opts[i]
        if o["id"] in st["used"]:
            raise SimError(f"reply {i + 1} «{str(o.get('content', '')).strip()}» was already given; pick another")
        ok = bool(o.get("isValid"))
        self.record(b["ref"], ok)
        before = st["msg"]
        nxt = ((c.get("state") or {}).get(before, {}).get("on") or {}).get(o["id"]) or o.get("nextMessageId")
        lines = [f"{'Correct.' if ok else 'Not correct.'}{(' ' + str(o.get('feedback')).strip()) if o.get('feedback') else ''}"]
        if nxt == before and ok:
            # The last question's right reply loops onto itself: the dialog is over.
            st.update(msg=None, used=set(), finished=True)
        elif nxt == before:
            st["used"].add(o["id"])
            lines.append("The bot asks the same question again.")
        else:
            self.chat_goto(c, st, nxt)
            if not st["finished"]:
                lines.append("Next question:")
        if st["finished"]:
            self.save(b, {"finished": True})
            lines.append("The chat quiz is finished.")
        else:
            lines.append(self.chat_live(b).replace("On screen now: ", "Bot: ", 1))
        return result("\n".join(lines))

    # -- code exercises

    def coding(self, block: str) -> tuple[dict, dict]:
        b, n, _ = self.block(block)
        if b["type"] != "QuizCoding":
            raise SimError(f"{b['ref']} is a {b['type']}, not a code exercise")
        if b["ref"] not in self.code:
            self.code[b["ref"]] = "\n".join(p.get("content", "") for p in (n.get("content") or {}).get("panes") or [])
        return b, n

    def t_run_code_exercise(self, block, code=None):
        self.acting()
        b, n = self.coding(block)
        if code:
            self.code[b["ref"]] = code
        out, failed = run_python(self.code[b["ref"]])
        c = n.get("content") or {}
        if not c.get("use_tests"):
            self.save(b, {"panes": [{"content": self.code[b["ref"]]}], "run_only": True})
        shown = "The program printed nothing." if not out else f"{'Output (error)' if failed else 'Output'}:\n{out}"
        note = " This was a run, not a check: use check_code_exercise to submit." if c.get("use_tests") else ""
        return result(shown + note)

    def t_check_code_exercise(self, block, code=None):
        self.acting()
        b, n = self.coding(block)
        c = n.get("content") or {}
        if not c.get("use_tests"):
            raise SimError(f"{b['ref']} is a runnable example without tests; use run_code_exercise")
        if code:
            self.code[b["ref"]] = code
        r = grade_code(self.code[b["ref"]], c)
        self.record(b["ref"], r["solved"])
        self.save(b, {"panes": [{"content": self.code[b["ref"]]}], "run_only": False, "test_result": {"stdout": {"solved": r["solved"], "error": r["message"]}}})
        lines = ["Solved ✓" if r["solved"] else "Not solved."]
        if r["message"] and not r["solved"]:
            lines.append(f"Checker: {r['message']}")
        if r["solved"] and c.get("success_feedback"):
            lines.append(f"Page: {c['success_feedback']}")
        if r["stdout"]:
            lines.append(f"Output:\n{r['stdout']}")
        return result("\n".join(lines))

    def t_reset_code_exercise(self, block):
        self.acting()
        b, _ = self.coding(block)
        del self.code[b["ref"]]
        self.coding(block)
        return result(f"{b['ref']} starts over with its starter code.")

    def t_complete_lesson(self):
        self.acting()
        open_ = self.required_open()
        if open_:
            raise SimError("the «next» button is not available; unanswered blocks: " + ", ".join(f"{b['ref']} {b['type']}" for b in open_))
        self.done = True
        nxt = self.meta.get("next") or {}
        return result(f"«{self.lesson['name']}»: marked solved.\nNow:\nPage: theory lesson\nLesson: «{nxt.get('name', 'следующий урок')}» id={self.lesson.get('next_lesson_id')}, not solved\n(The simulation ends here.)")

    # -- scoring

    def metrics(self) -> dict:
        graded = [b for b in self.blocks() if b["type"] not in ("ActionButton", "QuizFeedback") and not (b["type"] == "QuizCoding" and not (self.node(b["nodeId"]).get("content") or {}).get("use_tests"))]
        first = sum(1 for b in graded if self.attempts.get(b["ref"], [False])[0])
        final = sum(1 for b in graded if any(self.attempts.get(b["ref"], [])))
        return {
            "solved": self.done,
            "blocks": len(graded),
            "first_try": first,
            "correct": final,
            "attempts": sum(len(v) for v in self.attempts.values()),
            "unanswered": len(self.required_open()),
            "checks": sum(len(self.attempts.get(b["ref"], [])) for b in graded if b["type"] == "QuizCoding"),
        }


# ---------------------------------------------------------------- several pages in a row

class JourneySim(BaseSim):
    """Pages one after another, as the course has them: complete_lesson on a theory
    lesson, or next_task after a solved check, moves to the next page. Tests what
    single-page scenarios can't: noticing the page changed, and carrying on."""

    kind = "journey"

    def __init__(self, scenario: Path, workdir: Path):
        super().__init__(scenario)
        spec = json.loads((scenario / "journey.json").read_text())
        self.dirs = [scenario / p for p in spec["pages"]]
        self.work = workdir
        self.pages = [self.load(0)]
        self.finished = False

    def load(self, i: int):
        sim = load_sim(self.dirs[i], self.work / f"page{i + 1}")
        if isinstance(sim, LessonSim) and i + 1 < len(self.dirs) and not (self.dirs[i + 1] / "lesson.json").exists():
            sim.meta["practice_next"] = True  # the next page is a trainer: «Перейти к заданию»
        return sim

    @property
    def cur(self):
        return self.pages[-1]

    @property
    def page(self) -> str:
        return self.cur.page

    def _call(self, name: str, args: dict):
        if self.finished and name != "where_am_i":
            return result(END.replace("the lesson is complete", "every page of the scenario is done"), name not in ("read_lesson",))
        if self.finished:
            return result("Page: the end of the scenario\nURL: https://practicum.yandex.ru/sim-end/\n(The simulation ends here.)")
        r = self.cur._call(name, args)
        left = not r.is_error and (
            (name == "complete_lesson" and isinstance(self.cur, LessonSim) and self.cur.done)
            or (name == "next_task" and isinstance(self.cur, TrainerSim) and self.cur.solved and args.get("direction") != "prev")
        )
        if not left:
            return r
        head = r.content[0].text.split("\nNow:")[0] if name == "complete_lesson" else ""
        if len(self.pages) == len(self.dirs):
            self.finished = True
            return result((head + "\n" if head else "") + "Now:\nPage: the end of the scenario\n(The simulation ends here.)")
        self.pages.append(self.load(len(self.pages)))
        where = self.cur._call("where_am_i", {}).content[0].text
        # complete_lesson reports the old lesson and the new page; next_task just the new page.
        return result(f"{head}\nNow:\n{where}" if head else where)

    def metrics(self) -> dict:
        per = [p.metrics() for p in self.pages]
        done = len(self.pages) - 1 + (1 if self.finished else 0)
        return {
            "solved": self.finished,
            "pages": len(self.dirs),
            "pages_done": done,
            "stuck_on": None if self.finished else self.dirs[len(self.pages) - 1].name,
            "checks": sum(m.get("checks", 0) for m in per),
            "blocks": sum(m.get("blocks", 0) for m in per),
            "first_try": sum(m.get("first_try", 0) for m in per),
        }


def load_sim(scenario: Path, workdir: Path):
    """The simulator for a scenario directory."""
    if (scenario / "journey.json").exists():
        return JourneySim(scenario, workdir)
    if (scenario / "lesson.json").exists():
        return LessonSim(scenario, workdir)
    return TrainerSim(scenario, workdir)
