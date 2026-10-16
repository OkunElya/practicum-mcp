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
PREVIEW = "https://3f1c2a9e-5b7d-4c1e-9a2f-6d8e4b0c7a15.serverhub.praktikum-services.ru/"
SIM_HIDDEN: set[str] = set()
RAW = HERE / "raw"
# What the model sees when it acts outside the task (as when the user declines in the overlay).
DENIED = "[denied] the user did not approve: {what}. Don't retry unless the user asks."
PLATFORM_DOWN = "[platform] Сервис временно недоступен. Попробуйте позже."
# Present on each kind of page; the rest fail as "not available here".
COMMON_TOOLS = {"where_am_i", "read_lesson", "get_progress", "open_lesson", "go_home", "ask_platform_ai", "reset_platform_ai_chat"}
TRAINER_TOOLS = COMMON_TOOLS | {"read_task", "get_code", "set_code", "create_file", "run_code", "check_task", "show_hint", "deploy", "fetch_preview", "next_task"}
LESSON_TOOLS = COMMON_TOOLS | {"answer_quiz", "press_action_button", "run_code_exercise", "check_code_exercise", "reset_code_exercise", "show_hint", "complete_lesson"}
TRAINER_ONLY = TRAINER_TOOLS - LESSON_TOOLS
NEXT_BUTTON = "next-lesson-control-button"
RETRYABLE = {"QuizCards", "QuizChoice"}  # as in the extension's theory.ts


def result(text: str, error: bool = False):
    return SimpleNamespace(content=[SimpleNamespace(text=text)], is_error=error)


class SimError(Exception):
    """A tool failure, shown to the model as "[tool] message" like the extension's ToolError."""

    kind = "tool"


class PlatformError(SimError):
    kind = "platform"


# ---------------------------------------------------------------- the course around a scenario

class Course:
    """The scraped profession (raw/index.json + lessons): pages beyond a scenario, get_progress,
    reading other lessons. Answers like the real tools, so the model can't tell it from the site."""

    _shared = None

    def __init__(self):
        idx = json.loads((RAW / "index.json").read_text()) if (RAW / "index.json").exists() else {"profession": "", "lessons": []}
        self.name, self.lessons = idx.get("profession", ""), idx["lessons"]
        self.by_id = {l["id"]: l for l in self.lessons}

    @classmethod
    def get(cls) -> "Course":
        if cls._shared is None:
            cls._shared = Course()
        return cls._shared

    def find(self, ref) -> dict | None:
        r = str(ref or "").strip().lower()
        return self.by_id.get(r) or next((l for l in self.lessons if l["pos"] == r), None)

    def raw(self, lesson_id: str) -> dict | None:
        f = RAW / "lessons" / f"{lesson_id}.json"
        return json.loads(f.read_text()) if f.exists() else None

    def render(self, ref, offset=None, blocks=None) -> str:
        entry = self.find(ref)
        lesson = self.raw(entry["id"]) if entry else None
        if lesson is None:
            raise SimError(f'"{ref}" is not a lesson id or a position like 5.1.3 (see get_progress)')
        return Helper.get()(op="render", lesson=lesson, answers=[], opts={"offset": offset or 0, "blocksOnly": bool(blocks)})["text"]

    def where(self, entry: dict) -> str:
        """where_am_i for a freshly opened lesson (as formatWhere prints it)."""
        lesson = self.raw(entry["id"]) or {}
        trainer = entry["type"] in ("web_server", "serverless")
        slug = lesson.get("profession_slug", "ap-backend-st")
        url = (f"https://practicum.yandex.ru/trainer/{slug}/lesson/{entry['id']}/" if trainer else
               f"https://practicum.yandex.ru/learn/{slug}/courses/{lesson.get('course_id')}/sprints/{lesson.get('sprint_id')}/topics/{lesson.get('topic_id')}/lessons/{entry['id']}/")
        topic = [l for l in self.lessons if l["topic"] == entry["topic"] and l["course"] == entry["course"]]
        lines = [f"Page: {'code trainer' if trainer else 'theory lesson'}", f"URL: {url}",
                 f"Course: {entry['course']} › Topic: {entry['topic']}",
                 f"Lesson {topic.index(entry) + 1 if entry in topic else 1}/{len(topic) or 1}: «{entry['name']}» [{entry['type']}] id={entry['id']}, {'solved' if entry.get('solved') else 'not solved'}"]
        if trainer and lesson.get("tasks"):
            lines.append("Tasks: " + ", ".join(str(i + 1) for i in range(len(lesson["tasks"]))))
        if lesson.get("next_lesson_id"):
            lines.append(f"Lesson after this one: id={lesson['next_lesson_id']} (complete_lesson or the last task's next_task opens it; no need to open_lesson)")
        if trainer and lesson.get("tasks"):
            lines.append(f"Current task: 1 id={lesson['tasks'][0]['id']}, not solved")
            lines += ["Buttons on screen:", "- Проверить (check-task-button)", "- Подсказка (trainer-hint-button)"]
        else:
            lines += ["Buttons on screen:", f"- К следующему уроку ({NEXT_BUTTON})", "- Чат с Практикум ИИ (sidebar-gpt-button)"]
        return "\n".join(lines)

    def progress(self, course=None) -> str:
        courses: list[str] = []
        for l in self.lessons:
            if l["course"] not in courses:
                courses.append(l["course"])
        solved = lambda ls: f"{sum(1 for x in ls if x.get('solved'))}/{len(ls)}"  # noqa: E731
        lines = [f"Profession: {self.name} — {solved(self.lessons)} lessons solved"]
        if not course:
            lines.append("Courses (number. name — solved lessons):")
            lines += [f"{i + 1}. {c} — {solved([l for l in self.lessons if l['course'] == c])}" for i, c in enumerate(courses)]
            lines.append("Call get_progress with course=<number> for its topics and lessons.")
            return "\n".join(lines)
        q = str(course).strip().lower()
        ci = int(q) - 1 if q.isdigit() else next((i for i, c in enumerate(courses) if q in c.lower()), -1)
        if not 0 <= ci < len(courses):
            raise SimError(f'no course "{course}"; call get_progress without arguments for the list')
        ls = [l for l in self.lessons if l["course"] == courses[ci]]
        lines.append(f"Course {ci + 1}. {courses[ci]} — {solved(ls)}")
        lines.append("Lessons are numbered course.topic.lesson; open_lesson and read_lesson accept that number. ✓ = solved, ↺ = topic was reset.")
        topics: list[str] = []
        for l in ls:
            if l["topic"] not in topics:
                topics.append(l["topic"])
                lines.append(f"{ci + 1}.{len(topics)} {l['topic']} — {solved([x for x in ls if x['topic'] == l['topic']])}")
            lines.append(f"  {l['pos']} {'✓' if l.get('solved') else ' '} {l['name']} [{l['type']}]")
        return "\n".join(lines)


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
        self.after: "AfterPage | None" = None  # the page the task led to once it was done
        self.course = Course.get()

    async def list_tools(self):
        return SimpleNamespace(tools=self.tools)

    async def call_tool(self, name: str, args: dict):
        import asyncio

        r = await asyncio.to_thread(self._call, name, args)
        self.log.append((name, args, r.is_error))
        return r

    def _call(self, name: str, args: dict):
        if self.after is not None:
            return self.after._call(name, args)
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
            return result(f"[{e.kind}] {e}", True)

    def unavailable(self, name: str) -> str:
        return f"[tool] {name} is not available on this page ({self.page})"

    # -- tools that work the same on every page

    def lesson_id(self) -> str:
        return ""

    def t_get_progress(self, course=None):
        return result(self.course.progress(course))

    def t_open_lesson(self, lesson):
        entry = self.course.find(lesson)
        if entry and entry["id"] == self.lesson_id():
            return result("Already open.\n" + self.t_where_am_i().content[0].text)
        if entry is None:
            raise SimError(f'"{lesson}" is not a lesson id or a position like 5.1.3 (see get_progress)')
        return result(DENIED.format(what=f"Open «{entry['name']}»"), True)

    def t_go_home(self):
        return result(DENIED.format(what="Go to the main page"), True)

    def t_ask_platform_ai(self, question):
        return result(PLATFORM_DOWN, True)

    def t_reset_platform_ai_chat(self):
        return result(PLATFORM_DOWN, True)

    def leave_to(self, lesson_id: str | None) -> str:
        """Move on to the next lesson (beyond the task); returns its where_am_i."""
        self.after = AfterPage(self.course.find(lesson_id) if lesson_id else None)
        return self.after.t_where_am_i().content[0].text


class AfterPage(BaseSim):
    """The lesson the task led to: readable like any page, but the user declines every action
    there (it is outside what they asked for)."""

    kind = "after"
    page = "lesson"

    def __init__(self, entry: dict | None):
        super().__init__(HERE)
        self.entry = entry or {"id": "", "name": "Следующий урок", "type": "web", "course": "", "topic": "", "pos": ""}
        self.page = "code trainer" if self.entry["type"] in ("web_server", "serverless") else "theory lesson"
        self.denied = 0

    def lesson_id(self) -> str:
        return self.entry["id"]

    def _call(self, name: str, args: dict):
        schema = self.schemas.get(name)
        if schema is None:
            return result(f"[tool] unknown tool {name}", True)
        reads = {"where_am_i", "read_lesson", "get_progress", "read_task", "open_lesson"}
        if name not in reads:
            self.denied += 1
            spec = next((t for t in self.tools if t.name == name), None)
            return result(DENIED.format(what=f"{name} on «{self.entry['name']}»"), True) if spec else result(f"[tool] unknown tool {name}", True)
        try:
            return getattr(self, f"t_{name}")(**args)
        except SimError as e:
            return result(f"[{e.kind}] {e}", True)
        except TypeError:
            return result(f"[args] bad arguments for {name}", True)

    def t_where_am_i(self):
        if not self.entry["id"]:
            return result("Page: theory lesson\nURL: https://practicum.yandex.ru/learn/\nLesson: «Следующий урок», not solved")
        return result(self.course.where(self.entry))

    def t_read_lesson(self, lesson=None, offset=None, blocks=None):
        return result(self.course.render(lesson or self.entry["id"], offset, blocks))

    def t_read_task(self):
        lesson = self.course.raw(self.entry["id"]) or {}
        if self.page != "code trainer" or not lesson.get("tasks"):
            raise SimError("this is not a code-trainer page")
        t = lesson["tasks"][0]
        return result(f"Lesson «{lesson['name']}» [{lesson['lesson_type']}], not solved\nTask 1/{len(lesson['tasks'])} id={t['id']}, not solved\n\n{t['description'].strip()}")

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

    def lesson_id(self) -> str:
        m = re.search(r"\bid=([0-9a-f-]{36}),", (self.sc / "where.txt").read_text())
        return m.group(1) if m else ""

    def t_where_am_i(self):
        text = self.status((self.sc / "where.txt").read_text())
        text = re.sub(r"^Next lesson id: (\S+)$", r"Lesson after this one: id=\1 (complete_lesson or the last task's next_task opens it; no need to open_lesson)", text, flags=re.M)
        if self.solved and "next-task-button" not in text:
            text = text.rstrip("\n") + "\n- Далее (next-task-button)\n"  # the real page shows it after a solved check
        return result(text)

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
            return result(self.course.render(lesson, offset, blocks))
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
        raw = self.course.raw(self.lesson_id()) or {}
        return result(self.leave_to(raw.get("next_lesson_id")))

    def metrics(self) -> dict:
        return {"solved": self.solved, "checks": self.attempts, "past_end": self.after.denied if self.after else 0}


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
        raise PlatformError("Неизвестная ошибка 400.py.checkTask")
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

    def __init__(self, scenario: Path, workdir: Path | None = None, lenient: bool = False):
        super().__init__(scenario)
        self.lesson = json.loads((scenario / "lesson.json").read_text())
        if lenient:
            # Testing: a question nobody answered must not hold the lesson up. Quizzes stop being
            # blocking (the renderer, the hidden-block check and complete_lesson all read this flag);
            # buttons still gate what follows them, as on the page.
            for n in self.nodes():
                if n["type"] != "ActionButton" and isinstance(n.get("content"), dict):
                    n["content"]["blocking"] = False
        meta = scenario / "meta.json"
        self.meta = json.loads(meta.read_text()) if meta.exists() else {}
        self.helper = Helper.get()
        self.answers: list[dict] = []  # SavedAnswer objects, as GET /api/lessons/{id}/quizzes/ returns them
        self.attempts: dict[str, list[bool]] = {}  # block ref → correctness of each attempt
        self.code: dict[str, str] = {}  # block ref → code in its editor
        self.chats: dict[str, dict] = {}  # block ref → {"msg", "used", "pending"}
        self.done = False
        self.asked_user = 0  # questions the solver handed to the (simulated) user
        self.user_answered: set[str] = set()  # refs the simulated user answered (not the model's answers)

    # -- helpers

    def blocks(self) -> list[dict]:
        return self.helper(op="blocks", lesson=self.lesson, answers=self.answers)["blocks"]

    def block(self, ref: str, answer: str | None = None) -> tuple[dict, dict, dict | None]:
        """(brief block, its theory node, the parsed answer plan) for a ref like q3."""
        r = self.helper(op="plan", lesson=self.lesson, answers=self.answers, ref=ref, **({"answer": answer} if answer is not None else {}))
        return r["block"], self.node(r["block"]["nodeId"]), r.get("plan")

    def nodes(self):
        stack = [self.lesson["theory"]]
        while stack:
            n = stack.pop()
            yield n
            stack.extend(n.get("nested") or [])

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
        if name in TRAINER_ONLY:
            return "[tool] this is not a code-trainer page"
        if name == "next_task":
            return "[tool] there is no «Далее» button on a theory lesson; use complete_lesson"
        return super().unavailable(name)

    def acting(self) -> None:
        """Actions after the lesson is done go to the next page (BaseSim.after); nothing to check here."""

    def lesson_id(self) -> str:
        return self.lesson["id"]

    def visible(self, b: dict) -> None:
        """The page renders nothing below an unanswered button or blocking quiz (as the extension reports it)."""
        before = []
        for x in self.blocks():
            if x["nodeId"] == b["nodeId"]:
                break
            c = self.node(x["nodeId"]).get("content") or {}
            if not x["answered"] and (x["type"] == "ActionButton" or c.get("blocking")):
                before.append(x)
        if before:
            how = lambda x: f"press_action_button block={x['ref']} («{(self.node(x['nodeId']).get('content') or {}).get('text', 'button')}»)" if x["type"] == "ActionButton" else f"{x['ref']} {x['type']}"  # noqa: E731
            raise SimError(f"{b['ref']} is still hidden on the page: first deal with {', '.join(how(x) for x in before)}, then try {b['ref']} again (blocks go in order)")

    # -- read tools

    def t_where_am_i(self):
        l = self.lesson
        lines = [
            "Page: theory lesson",
            f"URL: {self.url()}",
            f"Course: {l.get('course_name', '')} › Topic: {l.get('topic_name', '')}",
            f"Lesson {int(l.get('position') or 0) + 1}/{l.get('topic_lessons_count', '?')}: «{l['name']}» [{l.get('lesson_type')}] id={l['id']}, {'solved' if l.get('solved') else 'not solved'}",
        ]
        if l.get("next_lesson_id"):
            lines.append(f"Lesson after this one: id={l['next_lesson_id']} (complete_lesson or the last task's next_task opens it; no need to open_lesson)")
        lines.append("Buttons on screen:")
        label = "Перейти к заданию" if self.meta.get("practice_next") else "К следующему уроку"
        lines.append(f"- {label} ({NEXT_BUTTON})" if not self.required_open() else f"- {label} ({NEXT_BUTTON}) [disabled]")
        lines.append("- Чат с Практикум ИИ (sidebar-gpt-button)")
        return result("\n".join(lines))

    def t_read_lesson(self, lesson=None, offset=None, blocks=None):
        if lesson and str(lesson).strip().lower() not in (self.lesson["id"], str(self.meta.get("pos") or "")):
            return result(self.course.render(lesson, offset, blocks))
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
        self.visible(b)
        label = str((n.get("content") or {}).get("text") or "button")
        self.save(b, {})
        return result(f"Pressed «{label}» ({b['ref']}). The content after it is now shown; read_lesson to continue.")

    def t_answer_quiz(self, block, answer, retry=None):
        self.acting()
        b, n, _ = self.block(block)
        self.visible(b)
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
        self.visible(b)
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
        where = self.leave_to(self.lesson.get("next_lesson_id"))
        return result(f"«{self.lesson['name']}»: marked solved.\nNow:\n{where}")

    # -- scoring

    def metrics(self) -> dict:
        user_only = set(self.meta.get("user_only") or [])
        blocks = self.blocks()
        graded = [b for b in blocks if b["nodeId"] not in user_only and b["type"] not in ("ActionButton", "QuizFeedback") and not (b["type"] == "QuizCoding" and not (self.node(b["nodeId"]).get("content") or {}).get("use_tests"))]
        graded = [b for b in graded if b["ref"] not in self.user_answered]  # score the model's own answers
        first = sum(1 for b in graded if self.attempts.get(b["ref"], [False])[0])
        final = sum(1 for b in graded if any(self.attempts.get(b["ref"], [])))
        # Tasks that ask for the student's own result (pytest output on their machine) are left out of
        # the score: leaving them is right, and a model can sometimes work the answer out (it did).
        return {
            "solved": self.done,
            "asked_user": self.asked_user,
            "past_end": self.after.denied if self.after else 0,
            "user_only_answered": sum(1 for b in blocks if b["nodeId"] in user_only and self.attempts.get(b["ref"])),
            "blocks": len(graded),
            "first_try": first,
            "correct": final,
            "attempts": sum(len(v) for v in self.attempts.values()),
            "unanswered": len(self.required_open()),
            # Exercises left out: not needed for the «next» button, but the lesson isn't really done.
            "skipped": sum(1 for b in graded if not self.attempts.get(b["ref"])),
            "wrong": sum(1 for b in graded if self.attempts.get(b["ref"]) and not self.attempts[b["ref"]][0]),
            "checks": sum(len(self.attempts.get(b["ref"], [])) for b in graded if b["type"] == "QuizCoding"),
        }


# ---------------------------------------------------------------- several pages in a row

class JourneySim(BaseSim):
    """Pages one after another, as the course has them: complete_lesson on a theory
    lesson, or next_task after a solved check, moves to the next page. Tests what
    single-page scenarios can't: noticing the page changed, and carrying on."""

    kind = "journey"

    def __init__(self, scenario: Path, workdir: Path, lenient: bool = False):
        super().__init__(scenario)
        self.lenient = lenient
        spec = json.loads((scenario / "journey.json").read_text())
        self.dirs = [scenario / p for p in spec["pages"]]
        self.work = workdir
        self.pages = [self.load(0)]
        self.finished = False

    def load(self, i: int):
        sim = load_sim(self.dirs[i], self.work / f"page{i + 1}", self.lenient)
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
        if self.after is not None:
            return self.after._call(name, args)  # the lesson after the last page: readable, actions declined
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
            self.after = self.cur.after  # where the last page's button led
            return r
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
            "skipped": sum(m.get("skipped", 0) for m in per),
            "wrong": sum(m.get("wrong", 0) for m in per),
            "asked_user": sum(m.get("asked_user", 0) for m in per),
            "past_end": self.after.denied if self.after else 0,
        }


L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def key_answer(b: dict, c: dict) -> str | None:
    """The right answer in read_lesson's numbering, from the lesson's own keys."""
    t = b["type"]
    if t == "QuizSelect":
        right = [str(i + 1) for i, o in enumerate(c["options"]) if o.get("correct")] or ["1"]  # no key: a poll
        return right[0] if c.get("type") == "radio" else ", ".join(right)
    if t == "QuizChoice":
        ids = [o["id"] for o in c["options"]]
        return "; ".join(f"{i + 1}={L[ids.index(q['correct_option'])]}" for i, q in enumerate(c["questions"]))
    if t == "QuizCards":
        ids = [s["id"] for s in c["sections"]]
        return "; ".join(f"{i + 1}={L[ids.index(o['correct_section'])]}" for i, o in enumerate(c["options"]))
    if t == "QuizMacaroni":
        return "; ".join(f"{l + 1}={L[r]}" for l, r in sorted(c["correct_answers"][0]))
    if t == "QuizText":
        strict = [v["match"] for v in c.get("validations") or [] if v.get("type") == "strict"]
        return strict[0] if strict else None
    return None



def oracle_user(sim):
    """A simulated user for the lesson solver's fallback: answers from the lesson's key, and counts."""

    async def ask(ref: str, block: str, candidates: list[str]) -> str | None:
        page = sim.cur if isinstance(sim, JourneySim) else sim
        if not isinstance(page, LessonSim):
            return None
        b = next((x for x in page.blocks() if x["ref"] == ref), None)
        if b is None:
            return None
        page.asked_user += 1
        page.user_answered.add(ref)
        n = page.node(b["nodeId"])
        c = n.get("content") or {}
        if b["type"] == "QuizChat":
            st = page.chat(b, n)
            return next((str(i + 1) for i, o in enumerate(page.chat_options(c, st)) if o.get("isValid")), None)
        return key_answer(b, c)

    return ask


def load_sim(scenario: Path, workdir: Path, lenient: bool = False):
    """The simulator for a scenario directory. lenient: unanswered quizzes don't block (for testing)."""
    if (scenario / "journey.json").exists():
        return JourneySim(scenario, workdir, lenient)
    if (scenario / "lesson.json").exists():
        return LessonSim(scenario, workdir, lenient)
    return TrainerSim(scenario, workdir)
