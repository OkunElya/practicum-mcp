"""Run a local model on simulated Practicum pages, without touching the account.

Scenarios are directories (sims.py describes both kinds; make_scenarios.py
builds lesson scenarios from scraped lessons):

  trainer  a code-trainer task: files/, task.txt, lesson.txt, where.txt, checks.json
  lesson   a theory lesson: lesson.json (raw lesson JSON) + meta.json

Each run drives the real Session + OllamaBackend against the scenario's
simulator. Results go to evals/results/*.jsonl (with a transcript per run) and a
summary table per prompt and temperature.

    uv run python evals/tune.py evals/scenarios/lesson4-broken --temps 0,0.3,0.6,1 --repeats 3
    uv run python evals/tune.py SCENARIO --system-file old.txt --system-file new.txt   # A/B prompts
"""

import argparse
import asyncio
import json
import random
import statistics
import sys
import tempfile
import time
from pathlib import Path

from practicum_bridge.platform_agent import OllamaBackend, Session

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sims import load_sim, oracle_user  # noqa: E402

HERE = Path(__file__).resolve().parent
TASKS = {
    "trainer": "Реши текущую задачу тренажёра и проверь решение (check_task). На следующую задачу не переходи; когда закончишь, кратко напиши итог.",
    "lesson": "Пройди текущий урок: выполни все задания в нём и нажми кнопку перехода к следующему уроку (complete_lesson). Дальше не переходи; когда закончишь, кратко напиши итог.",
    # Scoped like a real request ("пройди следующие 2 урока"), so the model knows when it is done.
    "journey": "Пройди по порядку {n} урока подряд, начиная с открытого: в каждом выполни все задания (в тренажёре — все задачи урока) и переходи к следующему. Когда пройдёшь эти {n} урока, остановись и кратко напиши итог.",
}
# Round budget per kind; gpt-oss makes one call per reply.
ROUNDS = {"trainer": 30, "lesson": 40, "journey": 150}


async def run_one(scenario: Path, model: str, ollama: str, temperature: float, think, rounds: int, seed: int, num_ctx, transcript: Path, prompt: tuple[str, str | None], solver: bool = True, user: str = "none", lenient: bool = True) -> dict:
    events: list[tuple[str, str]] = []
    note = lambda kind, text: events.append((kind, text))  # noqa: E731
    with tempfile.TemporaryDirectory(prefix="sim-") as tmp:
        client = load_sim(scenario, Path(tmp), lenient)
        label, system = prompt
        backend = OllamaBackend(note, model, ollama, num_ctx, temperature, think, **({"system": system} if system else {}))
        backend.options["seed"] = seed
        session = Session(client, backend, note, solver)
        if user == "oracle":
            session.ask_user = oracle_user(client)  # the solver's handoffs get the key answer; counted as asked_user
        t0 = time.monotonic()
        await session.open()
        task = TASKS[client.kind]
        if client.kind == "journey":
            task = task.format(n=json.loads((scenario / "journey.json").read_text()).get("lessons", len(client.dirs)))
        out = await session.ask(task, rounds or ROUNDS[client.kind])
        took = time.monotonic() - t0
    transcript.write_text("".join(f"\n── {k} ──\n{t}\n" for k, t in events))
    # where_am_i is also called by the driver itself after every action.
    acted = [(n, e) for n, a, e in client.log if n != "where_am_i"]
    return {
        "scenario": scenario.name,
        "prompt": label + ("" if solver else "-nosolver"),
        "model": model,
        "temperature": temperature,
        "think": think,
        "seed": seed,
        "kind": client.kind,
        **client.metrics(),
        "outcome": out.code,
        "rounds": sum(1 for k, _ in events if k == "round"),
        "tool_errors": sum(1 for n, e in acted if e),
        "calls": len(acted),
        "off_format": sum(1 for k, _ in events if k == "off format"),
        "ollama_errors": sum(1 for k, _ in events if k == "ollama error"),
        "prompt_tokens": backend.prompt_tokens,
        "seconds": round(took, 1),
        "answer": (out.answer or "")[:300],
        "tools_used": [n for n, e in acted],
    }


def by_scenario(rows: list[dict]) -> str:
    out = ["scenario                          runs solved  first-try  wrong  skipped  to-user  pages  checks  rounds  tool-err  sec"]
    for sc in sorted({r["scenario"] for r in rows}):
        rs = [r for r in rows if r["scenario"] == sc]
        avg = lambda k: statistics.mean(r.get(k) or 0 for r in rs)  # noqa: E731
        ft = f"{sum(r.get('first_try', 0) for r in rs)}/{sum(r.get('blocks', 0) for r in rs)}" if any(r.get("blocks") for r in rs) else "-"
        pages = f"{sum(r.get('pages_done', 0) for r in rs)}/{sum(r.get('pages', 0) for r in rs)}" if any(r.get("pages") for r in rs) else "-"
        out.append(f"{sc[:33]:<33} {len(rs):<4} {sum(bool(r['solved']) for r in rs)}/{len(rs):<5} {ft:<10} {sum(r.get('wrong', 0) for r in rs):<6} {sum(r.get('skipped', 0) for r in rs):<8} {sum(r.get('asked_user', 0) for r in rs):<8} {pages:<6} {avg('checks'):<7.1f} {avg('rounds'):<7.0f} {avg('tool_errors'):<9.1f} {avg('seconds'):.0f}")
    return "\n".join(out)


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
        row = await run_one(Path(sc), a.model, a.ollama, t, a.think, a.rounds, a.seed + i, a.num_ctx, transcript, pr, not a.no_solver, a.user, not a.strict)
        rows.append(row)
        with path.open("a") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"[{n}/{len(plan)}] {row['scenario']} {pr[0]} T={t} seed={row['seed']}: {'SOLVED' if row['solved'] else 'not solved'}, "
              f"{row['checks']} checks, {row['rounds']} rounds, {row['tool_errors']} tool errors, {row['seconds']} s", flush=True)
    print(f"\n{by_scenario(rows)}\n\n{summary(rows)}\n\nresults: {path}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("scenario", nargs="+", help="scenario directories")
    p.add_argument("--model", default="gpt-oss-32k")
    p.add_argument("--ollama", default="http://127.0.0.1:11434")
    p.add_argument("--temps", default="0.2")
    p.add_argument("--system-file", type=Path, action="append", default=[], help="system prompt to try instead of the built-in one; repeat to compare")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--rounds", type=int, help="round budget (default per kind: trainer 30, lesson 40, journey 150)")
    p.add_argument("--think", choices=["low", "medium", "high"])
    p.add_argument("--num-ctx", type=int)
    p.add_argument("--seed", type=int, default=random.randrange(10_000))
    p.add_argument("--summary", type=Path, help="only print the summary of a results file")
    p.add_argument("--no-solver", action="store_true", help="run without solve_current_lesson")
    p.add_argument("--strict", action="store_true", help="unanswered blocking quizzes block the lesson, as on the site (default: they don't, so a left question doesn't stop a test)")
    p.add_argument("--user", choices=["none", "oracle"], default="none", help="who answers what the solver hands to the user: nobody, or a simulated user with the key (to test journeys apart from answer quality)")
    a = p.parse_args()
    if a.summary:
        rows = [json.loads(l) for l in a.summary.read_text().splitlines() if l.strip()]
        print(f"{by_scenario(rows)}\n\n{summary(rows)}")
        return
    asyncio.run(amain(a))


if __name__ == "__main__":
    sys.exit(main())
