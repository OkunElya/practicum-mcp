"""Generate docs/model-view.md: what the local model sees, from the real driver code.

    uv run python evals/model_view.py   (needs the scraped lessons and scenarios; the output is gitignored:
    it contains course content and answers)

A scripted backend replays fixed tool calls through the real Session against the
simulator, so every prompt, tool description, tool result and driver message in the
document is the one the model would get.
"""

import asyncio
import json
import re
import sys
import tempfile
from pathlib import Path

BRIDGE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BRIDGE / "evals"))
sys.path.insert(0, str(BRIDGE / "tests"))

from practicum_bridge.lesson_solver import SYSTEM as SOLVER_SYSTEM, LessonSolver, form, parse_blocks  # noqa: E402
from practicum_bridge.platform_agent import PARSE_NUDGE, STALL_WARN, OllamaBackend, Session, Turn  # noqa: E402
from sims import key_answer, load_sim  # noqa: E402

SC = BRIDGE / "evals" / "scenarios"
OUT = BRIDGE.parent / "docs" / "model-view.md"


class Scripted(OllamaBackend):
    """OllamaBackend whose replies are scripted: everything else (prompt, history, results) is real."""

    def __init__(self, script):
        super().__init__(lambda k, t: None, "gpt-oss-32k", "http://127.0.0.1:9", 32768, 0.2)
        self.script = list(script)

    async def turn(self):
        if not self.script:
            return Turn([], "(конец примера)", [])
        step = self.script.pop(0)
        calls = step(self) if callable(step) else step
        self.messages.append({"role": "assistant", "content": "", "tool_calls": [{"function": {"name": c["tool"], "arguments": c["args"]}} for c in calls]})
        return Turn(calls, None, [])


def call(tool, **args):
    return [{"tool": tool, "args": args}]


def clip(text: str, lines: int = 30) -> str:
    rows = text.rstrip().splitlines()
    return text.rstrip() if len(rows) <= lines else "\n".join(rows[:lines]) + f"\n… (ещё {len(rows) - lines} строк)"


def transcript(messages: list[dict], skip_first: int) -> str:
    out = []
    for m in messages[skip_first:]:
        if m["role"] == "assistant" and m.get("tool_calls"):
            for c in m["tool_calls"]:
                out.append(f"**→ {c['function']['name']}**(`{json.dumps(c['function']['arguments'], ensure_ascii=False)}`)\n")
        elif m["role"] == "tool":
            out.append("**←**\n~~~text\n" + clip(m["content"]) + "\n~~~\n")
        elif m["role"] == "user":
            out.append("**user (driver)**\n~~~text\n" + clip(m["content"]) + "\n~~~\n")
    return "\n".join(out)


async def run_lesson(tmp: Path):
    sim = load_sim(SC / "theory-macaroni-bbb48a", tmp / "lesson")  # strict: blocking quizzes block, as on the site
    blocks = sim.blocks()
    mac = next(b for b in blocks if b["type"] == "QuizMacaroni")
    q = {b["ref"]: b for b in blocks}  # q1 button, q2 single choice, q3 button, q4 pairs, q5 single choice
    key = lambda b: key_answer(b, sim.node(b["nodeId"])["content"])  # noqa: E731
    n_left = len(key(mac).split("; "))
    pattern = "; ".join(f"{i + 1}={chr(65 + i)}" for i in range(max(3, n_left)))
    script = [
        call("answer_quiz", block="q4", answer=key(mac)),  # before reading: refused by the driver
        call("read_lesson", blocks=True),
        call("answer_quiz", block="q4", answer=key(mac)),  # hidden behind q1-q3
        call("press_action_button", block="q1"),
        call("answer_quiz", block="q2", answer=key(q["q2"])),
        call("press_action_button", block="q3"),
        call("answer_quiz", block="q4", answer=pattern),  # questioned once
        call("answer_quiz", block="q4", answer=key(mac)),
        call("complete_lesson"),  # q5 is still open
        call("answer_quiz", block="q5", answer=key(q["q5"])),
        call("complete_lesson"),
        call("read_lesson", blocks=True),  # the next lesson, read like any page
        call("answer_quiz", block="q1", answer="1"),  # but acting there is outside the task: declined
        call("finish", summary="Урок пройден: кнопки нажаты, q2, q4 и q5 отвечены верно, урок отмечен решённым.", status="done"),
    ]
    backend = Scripted(script)
    session = Session(sim, backend, lambda k, t: None, solver=False)
    await session.open()
    out = await session.ask("Пройди текущий урок: выполни все задания в нём и нажми кнопку перехода к следующему уроку (complete_lesson). Дальше не переходи; когда закончишь, кратко напиши итог.", 30)
    return backend, out


async def run_trainer(tmp: Path):
    sim = load_sim(SC / "trainer-create-about-urls", tmp / "trainer")
    root = "from django.contrib import admin\nfrom django.urls import include, path\n\nurlpatterns = [\n    path('', include('homepage.urls')),\n    path('about/', include('about.urls')),\n    path('admin/', admin.site.urls),\n]\n"
    wrong = "from django.urls import path\n\nfrom . import views\n\nurlpatterns = [\n    path('about/', views.description),\n]\n"
    right = wrong.replace("path('about/', views.description)", "path('', views.description)")
    script = [
        call("read_task"),
        call("get_code", file="urls.py"),  # a guessed path
        call("get_code", file="anfisa_for_friends/urls.py"),
        call("create_file", file="about/urls.py", code=wrong),
        call("set_code", file="anfisa_for_friends/urls.py", code=root),
        call("deploy"),
        call("fetch_preview", path="/about/"),
        call("check_task"),
        call("check_task"),  # nothing changed: refused
        call("set_code", file="about/urls.py", code=right),
        call("check_task"),
        call("next_task"),
        call("finish", summary="Задача 2 решена: создан about/urls.py, корневой urls.py подключает его через include.", status="done"),
    ]
    backend = Scripted(script)
    session = Session(sim, backend, lambda k, t: None, solver=False)
    await session.open()
    out = await session.ask("Реши текущую задачу тренажёра и проверь решение (check_task). На следующую задачу не переходи; когда закончишь, кратко напиши итог.", 30)
    return backend, out


async def solver_prompt(tmp: Path) -> tuple[str, dict]:
    """The isolated per-question call the lesson solver makes (captured, not sent)."""
    sim = load_sim(SC / "theory-macaroni-bbb48a", tmp / "solver", lenient=True)
    seen = {}

    class Capture:
        async def structured(self, messages, schema, temperature, seed):
            seen.setdefault("messages", messages)
            seen.setdefault("schema", schema)
            return None

    async def bridge(tool, args):
        r = sim._call(tool, args)
        return r.content[0].text, r.is_error

    solver = LessonSolver(bridge, Capture(), lambda k, t: None, None, samples=1, consult=False)
    full = await solver.read(blocks=False)
    blocks = parse_blocks(await solver.read(blocks=True))
    b = next(x for x in blocks if x.kind == "macaroni")
    await solver.sample(b, solver.context(full, b))
    return seen["messages"][1]["content"], seen["schema"]


def tools_section(backend: Scripted) -> str:
    rows = []
    for t in backend.tools:
        f = t["function"]
        props = f["parameters"].get("properties", {})
        req = set(f["parameters"].get("required", []))
        args = ", ".join(f"`{k}`{'' if k in req else '?'}" for k in props) or "—"
        rows.append(f"### `{f['name']}`\nArguments: {args}\n\n{f['description']}\n")
        for k, p in props.items():
            if p.get("description"):
                rows.append(f"- `{k}`: {p['description']}" + (f" (one of {', '.join(p['enum'])})" if p.get("enum") else ""))
        rows.append("")
    return "\n".join(rows)


async def main():
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        lesson_backend, lesson_out = await run_lesson(tmp)
        trainer_backend, trainer_out = await run_trainer(tmp)
        q_prompt, q_schema = await solver_prompt(tmp)
    sys_msg = lesson_backend.messages[0]["content"]
    first_user = lesson_backend.messages[1]["content"]
    report = Path(next(iter(sorted((BRIDGE / "evals" / "results").glob("2026*-gpt-oss-32k/001-theory-choice-3d55ce*.log"), reverse=True)))).read_text()
    m = re.search(r"── solve_current_lesson\(\{\}\) ──\n(.*?)\n\n\[|── solve_current_lesson\(\{\}\) ──\n(.*?)\n\n── ", report, re.S)
    solver_report = (m.group(1) or m.group(2)) if m else "(no solver report in the latest results)"

    doc = f"""# What the local model sees

Generated from the real driver code (`Session`, `OllamaBackend`, `prompts.py`, the tool specs in
`shared/tools.json`) with a scripted model replaying fixed tool calls against the simulator. Every
prompt, tool result and driver message below is verbatim what gpt-oss gets through Ollama's
`/api/chat`. The calls themselves are chosen to show each behaviour, not made by a model.

How a turn looks to the model:
- `system`: the prompt in section 1.
- `tools`: the definitions in section 2 (name, description, JSON schema).
- `user`: the task plus the current page (section 3).
- Each reply is a tool call; its result comes back as a `tool` message (sections 4–5). The driver
  also adds `user` messages of its own (section 7).

## 1. System prompt

```text
{sys_msg}
```

## 2. Tools ({len(lesson_backend.tools)})

`finish` and `solve_current_lesson` are run by the driver itself; the rest go to the extension.
`reset_platform_ai_chat` is hidden from local models.

{tools_section(lesson_backend)}
## 3. First user message (task + current page)

```text
{first_user}
```

## 4. Example: a theory lesson, call by call

Lesson with a button, a connect-the-pairs quiz and a single-choice question (scenario
`theory-macaroni-bbb48a`, the site's own blocking rules). Shows: the read-first refusal, a block
hidden behind a button, a patterned answer questioned once, `complete_lesson` listing what is left,
the move to the next lesson, an action outside the task being declined, and `finish`.

{transcript(lesson_backend.messages, 2)}

Driver summary returned with the outcome (logged; shown in `practicum-chat`):

```text
{lesson_out.facts}
```

## 5. Example: a code-trainer task

Task 2 of lesson 5.2.3 (create `about/urls.py`). Shows: a guessed file path, a failed check with
the checker's message, a re-check of unchanged code refused, a solved check and `next_task`.

{transcript(trainer_backend.messages, 2)}

Driver summary:

```text
{trainer_out.facts}
```

## 6. `solve_current_lesson`

What the model gets back (real report from the latest test run, `theory-choice-3d55ce`):

```text
{solver_report.strip()}
```

Inside, each question is a separate call with no tools and no history. The user message of one
such call (the system message is `lesson_solver.SYSTEM`):

```text
{SOLVER_SYSTEM}
```

```text
{clip(q_prompt, 45)}
```

The reply must match this JSON schema (Ollama `format`); three samples must agree:

```json
{json.dumps(q_schema, ensure_ascii=False, indent=1)}
```

## 7. Messages the driver adds on its own

- After `{STALL_WARN}` rounds without progress (no successful action, no page change):
  > Уже {STALL_WARN} ходов ничего не меняется (только чтения, ошибки или отказы). Если задача выполнена или дальше идти нельзя — {OllamaBackend.finish_hint}. Иначе сделай конкретное действие.

  Four rounds later the run stops (outcome 5) with the driver summary.
- When Ollama can't parse a tool call (the model reasoned inside its JSON):
  > {PARSE_NUDGE}
- When a reply is empty or a tool call written as text:
  > Ответ не по формату: пустой или вызов инструмента, написанный текстом. Вызови нужный инструмент (через tool call) или напиши итог обычным текстом.
- On a theory lesson, the first `answer_quiz` / `press_action_button` / `complete_lesson` / code
  exercise call is replaced by `solve_current_lesson` (when the driver has it).
- Refusals (shown as the call's result, in the examples above): reading the page first, a
  patterned answer, the same failing call or the same read three times, re-checking unchanged code,
  answering on a lesson the solver already did.
"""
    OUT.write_text(doc)
    print(OUT, len(doc.splitlines()), "lines")


asyncio.run(main())
