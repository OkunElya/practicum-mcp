"""Tune a local model's sampling on simulated trainer tasks, without touching the account.

A scenario is a directory captured from a real task:

    task.txt      read_task output (the "Files (N): …" line is rebuilt from files/)
    lesson.txt    read_lesson output
    where.txt     where_am_i output
    hint.txt      optional show_hint text
    checks.json   {"settings": "pkg.settings", "pages": [{"path", "text", "view"?, "urls_file"?}]}
    files/        the project as the task starts

Each run copies files/ to a temp dir and drives the real Session + OllamaBackend
against SimClient: trainer tools work on that copy, check_task and fetch_preview
run the project with Django (django_probe.py), everything else fails the way it
would on a trainer page. Results go to evals/results/*.jsonl and a summary table.

    uv run python evals/tune.py evals/scenarios/lesson4-broken --temps 0,0.3,0.6,1 --repeats 3
    uv run python evals/tune.py SCENARIO --system-file old.txt --system-file new.txt   # A/B prompts
"""

import argparse
import asyncio
import json
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

from practicum_bridge.config import load_tool_specs
from practicum_bridge.platform_agent import OllamaBackend, Session
from practicum_bridge.server import to_mcp_tool

HERE = Path(__file__).resolve().parent
PROBE = HERE / "django_probe.py"
DJANGO = ["uv", "run", "--no-project", "--with", "django>=5,<6", "python", "-I"]
TASK = "Реши текущую задачу тренажёра и проверь решение (check_task). На следующую задачу не переходи; когда закончишь, кратко напиши итог."
PREVIEW = "https://sim-preview.local/"
# Present on a trainer page; the rest fail as "not available here".
TRAINER_TOOLS = {"where_am_i", "read_task", "read_lesson", "get_code", "set_code", "create_file", "run_code", "check_task", "show_hint", "deploy", "fetch_preview", "next_task", "get_progress"}
SIM_HIDDEN = {"ask_platform_ai", "reset_platform_ai_chat"}  # no Практикум ИИ in the simulation


def result(text: str, error: bool = False):
    return SimpleNamespace(content=[SimpleNamespace(text=text)], is_error=error)


class SimClient:
    """The bridge's MCP client, answered by a local copy of the trainer project."""

    def __init__(self, scenario: Path, workdir: Path):
        self.sc, self.dir = scenario, workdir
        shutil.copytree(scenario / "files", workdir, dirs_exist_ok=True)
        self.tools = [to_mcp_tool(s) for s in load_tool_specs() if s["name"] not in SIM_HIDDEN and not s["name"].startswith("dev_")]
        self.schemas = {t.name: t.input_schema for t in self.tools}
        self.solved = False
        self.deployed = False
        self.attempts = 0
        self.current = None  # file open in the editor
        self.log: list[tuple[str, dict, bool]] = []  # (tool, args, error)

    async def list_tools(self):
        return SimpleNamespace(tools=self.tools)

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

    async def call_tool(self, name: str, args: dict):
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
        if name not in TRAINER_TOOLS:
            return result(f"[tool] {name} is not available on this page (code trainer)", True)
        return getattr(self, f"t_{name}")(**args)

    def t_where_am_i(self):
        return result(self.status((self.sc / "where.txt").read_text()))

    def t_get_progress(self, course=None):
        return result("[tool] get_progress is not available in the simulation", True)

    def t_read_task(self):
        lines = []
        for l in self.status((self.sc / "task.txt").read_text()).splitlines():
            if l.startswith("Files ("):
                fs = self.files()
                l = f"Files ({len(fs)}): " + ", ".join(fs)
            lines.append(l)
        return result("\n".join(lines))

    def t_read_lesson(self, lesson=None, offset=None, blocks=None):
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


async def run_one(scenario: Path, model: str, ollama: str, temperature: float, think, rounds: int, seed: int, num_ctx, transcript: Path, prompt: tuple[str, str | None]) -> dict:
    events: list[tuple[str, str]] = []
    note = lambda kind, text: events.append((kind, text))  # noqa: E731
    with tempfile.TemporaryDirectory(prefix="sim-") as tmp:
        client = SimClient(scenario, Path(tmp))
        label, system = prompt
        backend = OllamaBackend(note, model, ollama, num_ctx, temperature, think, **({"system": system} if system else {}))
        backend.options["seed"] = seed
        session = Session(client, backend, note)
        t0 = time.monotonic()
        await session.open()
        out = await session.ask(TASK, rounds)
        took = time.monotonic() - t0
    transcript.write_text("".join(f"\n── {k} ──\n{t}\n" for k, t in events))
    # where_am_i is also called by the driver itself after every action.
    acted = [(n, e) for n, a, e in client.log if n != "where_am_i"]
    return {
        "scenario": scenario.name,
        "prompt": label,
        "model": model,
        "temperature": temperature,
        "think": think,
        "seed": seed,
        "solved": client.solved,
        "outcome": out.code,
        "rounds": sum(1 for k, _ in events if k == "round"),
        "checks": client.attempts,
        "tool_errors": sum(1 for n, e in acted if e),
        "calls": len(acted),
        "off_format": sum(1 for k, _ in events if k == "off format"),
        "ollama_errors": sum(1 for k, _ in events if k == "ollama error"),
        "prompt_tokens": backend.prompt_tokens,
        "seconds": round(took, 1),
        "answer": (out.answer or "")[:300],
        "tools_used": [n for n, e in acted],
    }


def summary(rows: list[dict]) -> str:
    out = ["prompt        temp  runs  solved  checks/run  rounds/run  tool-err/run  off-format  sec/run"]
    for p, t in sorted({(r.get("prompt", "default"), r["temperature"]) for r in rows}):
        rs = [r for r in rows if r.get("prompt", "default") == p and r["temperature"] == t]
        avg = lambda k: statistics.mean(r[k] for r in rs)  # noqa: E731
        out.append(
            f"{p[:13]:<13} {t:<5} {len(rs):<5} {sum(r['solved'] for r in rs)}/{len(rs):<6} {avg('checks'):<11.1f} {avg('rounds'):<11.1f} "
            f"{avg('tool_errors'):<13.1f} {sum(r['off_format'] for r in rs):<11} {avg('seconds'):.0f}"
        )
    return "\n".join(out)


async def amain(a) -> None:
    out_dir = HERE / "results"
    out_dir.mkdir(exist_ok=True)
    path = out_dir / f"{time.strftime('%Y%m%d-%H%M%S')}-{a.model}.jsonl"
    temps = [float(t) for t in a.temps.split(",")]
    rows = []
    # Interleave temperatures so a slow stretch on the GPU doesn't bias one of them.
    prompts = [(f.stem, f.read_text()) for f in a.system_file] or [("default", None)]
    plan = [(sc, t, i, pr) for i in range(a.repeats) for sc in a.scenario for t in temps for pr in prompts]
    for n, (sc, t, i, pr) in enumerate(plan, 1):
        transcript = path.with_suffix("") / f"{n:03d}-{Path(sc).name}-{pr[0]}-T{t}.log"
        transcript.parent.mkdir(exist_ok=True)
        row = await run_one(Path(sc), a.model, a.ollama, t, a.think, a.rounds, a.seed + i, a.num_ctx, transcript, pr)
        rows.append(row)
        with path.open("a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"[{n}/{len(plan)}] {row['scenario']} {pr[0]} T={t} seed={row['seed']}: {'SOLVED' if row['solved'] else 'not solved'}, "
              f"{row['checks']} checks, {row['rounds']} rounds, {row['tool_errors']} tool errors, {row['seconds']} s", flush=True)
    print(f"\n{summary(rows)}\n\nresults: {path}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scenario", nargs="+", help="scenario directories")
    p.add_argument("--model", default="gpt-oss-32k")
    p.add_argument("--ollama", default="http://127.0.0.1:11434")
    p.add_argument("--temps", default="0.2")
    p.add_argument("--system-file", type=Path, action="append", default=[], help="system prompt to try instead of the built-in one; repeat to compare")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--rounds", type=int, default=25)
    p.add_argument("--think", choices=["low", "medium", "high"])
    p.add_argument("--num-ctx", type=int)
    p.add_argument("--seed", type=int, default=random.randrange(10_000))
    p.add_argument("--summary", type=Path, help="only print the summary of a results file")
    a = p.parse_args()
    if a.summary:
        print(summary([json.loads(l) for l in a.summary.read_text().splitlines() if l.strip()]))
        return
    asyncio.run(amain(a))


if __name__ == "__main__":
    sys.exit(main())
