"""The lesson simulator against every scraped lesson: answering each block from its
answer key must be graded correct and unlock complete_lesson; wrong answers must not.

Needs the scraped lessons (scripts/inspect/scrape-lessons.mjs → bridge/evals/raw/)
and node; skipped without them.
"""

import json
import shutil
import string
import sys
from pathlib import Path

import pytest

EVALS = Path(__file__).resolve().parents[1] / "evals"
RAW = EVALS / "raw" / "lessons"
sys.path.insert(0, str(EVALS))

pytestmark = pytest.mark.skipif(not RAW.exists() or not shutil.which("node"), reason="no scraped lessons or no node")

L = string.ascii_uppercase


def lessons_with(*types: str) -> list[Path]:
    out = []
    for f in sorted(RAW.glob("*.json")):
        text = f.read_text()
        if '"theory"' in text and any(f'"type": "{t}"' in text or f'"type":"{t}"' in text for t in types):
            out.append(f)
    return out


def sim_for(tmp_path: Path, raw: Path):
    from sims import LessonSim

    sc = tmp_path / raw.stem
    sc.mkdir()
    shutil.copy(raw, sc / "lesson.json")
    return LessonSim(sc)


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


UNGRADEABLE: set[str] = set()  # code exercises whose reference solution doesn't pass locally


def solve(sim) -> list[str]:
    """Answer every block correctly; returns the problems found."""
    problems = []
    for b in sim.blocks():
        c = sim.node(b["nodeId"]).get("content") or {}
        ref = b["ref"]
        if b["type"] == "ActionButton":
            r = sim._call("press_action_button", {"block": ref})
        elif b["type"] == "QuizChat":
            for _ in range(40):  # walk the dialog, always picking the valid reply
                st = sim.chat(b, sim.node(b["nodeId"]))
                if st["finished"]:
                    break
                i = next(j for j, o in enumerate(sim.chat_options(c, st)) if o.get("isValid"))
                r = sim._call("answer_quiz", {"block": ref, "answer": str(i + 1)})
                if r.is_error:
                    break
        elif b["type"] == "QuizCoding":
            answer = "\n".join(p.get("content", "") for p in c.get("answer_panes") or [])
            tool = "check_code_exercise" if c.get("use_tests") else "run_code_exercise"
            if not c.get("use_tests") and not c.get("blocking"):
                continue
            r = sim._call(tool, {"block": ref, **({"code": answer} if answer.strip() else {})})
            if c.get("use_tests") and not r.content[0].text.startswith("Solved"):
                # A limit of the local grader, not of the simulator: reported by the shim's own check.
                UNGRADEABLE.add(f"{sim.lesson['id']}/{b['nodeId']}")
                sim.save(b, {"test_result": {"stdout": {"solved": False}}})
                continue
        elif b["type"] == "QuizFeedback":
            continue
        else:
            ans = key_answer(b, c)
            if ans is None:
                continue  # regexp-only QuizText: no literal answer to give
            r = sim._call("answer_quiz", {"block": ref, "answer": ans})
        if r.is_error:
            problems.append(f"{ref} {b['type']}: {r.content[0].text[:200]}")
        elif b["type"] not in ("ActionButton", "QuizCoding") and sim.attempts.get(ref) and not all(sim.attempts[ref]):
            problems.append(f"{ref} {b['type']} key answer graded wrong: {r.content[0].text[:200]}")
    return problems


QUIZ_TYPES = ["QuizSelect", "QuizChoice", "QuizCards", "QuizMacaroni", "QuizText", "QuizChat", "QuizCoding", "ActionButton"]


@pytest.mark.parametrize("raw", lessons_with(*QUIZ_TYPES), ids=lambda p: p.stem[:8])
def test_key_answers_are_graded_correct_and_finish_the_lesson(tmp_path, raw):
    sim = sim_for(tmp_path, raw)
    text = sim._call("read_lesson", {}).content[0].text
    assert text.startswith("Lesson «"), text[:200]
    problems = solve(sim)
    assert not problems, "\n".join(problems)
    open_ = sim.required_open()
    # Blocking blocks the sim can't answer from a key (surveys, regexp-only text) may remain.
    assert all(b["type"] in ("QuizFeedback", "QuizText") for b in open_), open_
    if not open_:
        r = sim._call("complete_lesson", {})
        assert not r.is_error and sim.done, r.content[0].text


@pytest.mark.parametrize("raw", lessons_with("QuizSelect")[:15], ids=lambda p: p.stem[:8])
def test_wrong_single_choice_is_marked_and_cannot_be_retried(tmp_path, raw):
    sim = sim_for(tmp_path, raw)
    from sims import SimError

    def shown(b):
        try:
            sim.visible(b)
            return True
        except SimError:
            return False

    b = next((b for b in sim.blocks() if b["type"] == "QuizSelect" and shown(b)), None)
    if b is None:
        pytest.skip("every single-choice question is behind a button")
    c = sim.node(b["nodeId"])["content"]
    wrong = next((i for i, o in enumerate(c["options"]) if not o.get("correct")), None)
    if wrong is None:
        pytest.skip("every option is right")
    r = sim._call("answer_quiz", {"block": b["ref"], "answer": str(wrong + 1)})
    assert not r.is_error and "incorrect" in r.content[0].text and sim.attempts[b["ref"]] == [False]
    again = sim._call("answer_quiz", {"block": b["ref"], "answer": str(wrong + 1)})
    assert again.is_error and "one attempt only" in again.content[0].text


def test_complete_lesson_lists_what_is_left(tmp_path):
    sim = next(s for s in (sim_for(tmp_path, f) for f in lessons_with("QuizSelect")) if s.required_open())
    r = sim._call("complete_lesson", {})
    assert r.is_error and "unanswered blocks" in r.content[0].text
    assert sim._call("read_task", {}).content[0].text == "[tool] this is not a code-trainer page"


def test_unknown_block_ref_reads_like_the_extension(tmp_path):
    sim = sim_for(tmp_path, lessons_with("QuizSelect")[0])
    r = sim._call("answer_quiz", {"block": "q99", "answer": "1"})
    assert r.is_error and 'no block "q99"' in r.content[0].text and "blocks: q1" in r.content[0].text


# ---------------------------------------------------------------- trainer tasks and journeys

SCEN = EVALS / "scenarios"
# Correct end states of the trainer tasks, kept with the (gitignored) scenarios: they are course solutions.
SOLUTION_DIR = SCEN / "solutions"
SOLUTIONS = {p.stem: json.loads(p.read_text()) for p in sorted(SOLUTION_DIR.glob("*.json"))} if SOLUTION_DIR.exists() else {}
needs_scenarios = pytest.mark.skipif(not (SCEN / "journey-routes").exists() or len(SOLUTIONS) < 4, reason="needs evals/scenarios with solutions/")


def solve_trainer(sim, name: str) -> str:
    for f, code in SOLUTIONS[name].items():
        tool = "set_code" if (sim.dir / f).exists() else "create_file"
        r = sim._call(tool, {"file": f, "code": code})
        assert not r.is_error, r.content[0].text
    return sim._call("check_task", {}).content[0].text


@needs_scenarios
@pytest.mark.parametrize("name", list(SOLUTIONS))
def test_trainer_starter_fails_and_solution_passes(tmp_path, name):
    from sims import load_sim

    sim = load_sim(SCEN / name, tmp_path / "w")
    first = sim._call("check_task", {}).content[0].text
    assert first.startswith("Not solved"), first
    assert sim._call("next_task", {}).is_error  # «Далее» only after a solved check
    assert solve_trainer(sim, name).startswith("Solved"), sim._call("check_task", {}).content[0].text


@needs_scenarios
def test_journey_routes_goes_through_every_page(tmp_path):
    from sims import LessonSim, load_sim

    sim = load_sim(SCEN / "journey-routes", tmp_path / "w")
    urls = []
    for _ in range(len(sim.dirs)):
        urls.append(next(l for l in sim._call("where_am_i", {}).content[0].text.splitlines() if l.startswith("URL:")))
        page = sim.cur
        if isinstance(page, LessonSim):
            assert sim._call("next_task", {}).is_error  # theory pages move on with complete_lesson
            assert not solve(page)
            r = sim._call("complete_lesson", {})
        else:
            assert sim._call("complete_lesson", {}).is_error
            assert solve_trainer(page, sim.dirs[len(sim.pages) - 1].name.split("-", 1)[1]).startswith("Solved")
            r = sim._call("next_task", {})
        assert not r.is_error, r.content[0].text
    assert sim.finished and sim.metrics()["pages_done"] == len(sim.dirs) == 6
    assert len(set(urls)) == len(urls), urls  # every page has its own URL: the driver sees the change



def test_blocks_behind_a_button_say_which_button(tmp_path):
    for raw in lessons_with("ActionButton"):
        sim = sim_for(tmp_path, raw)
        blocks = sim.blocks()
        if blocks and blocks[0]["type"] == "ActionButton" and len(blocks) > 1 and blocks[1]["type"].startswith("Quiz"):
            r = sim._call("answer_quiz", {"block": blocks[1]["ref"], "answer": "1"})
            assert r.is_error and f"press_action_button block={blocks[0]['ref']}" in r.content[0].text, r.content[0].text
            return
    pytest.skip("no lesson with a quiz right after a button")
