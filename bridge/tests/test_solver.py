"""The block-by-block lesson solver against the lesson simulator (needs the scraped lessons)."""

import asyncio
import re
import sys
from pathlib import Path

import pytest

from practicum_bridge.lesson_solver import LessonSolver, answer_of, form, parse_blocks

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_sims import RAW, key_answer, lessons_with, pytestmark, sim_for  # noqa: E402,F401

L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


class Oracle:
    """A model that fills every form from the lesson's own key (and solves code with the reference)."""

    def __init__(self, sim):
        self.sim = sim

    async def structured(self, messages, schema, temperature, seed):
        ref = re.search(r"(?:Question|Exercise) (q\d+):", messages[-1]["content"]).group(1)
        b = next(x for x in self.sim.blocks() if x["ref"] == ref)
        n = self.sim.node(b["nodeId"])
        c = n.get("content") or {}
        if b["type"] == "QuizCoding":
            return {"code": "\n".join(p.get("content", "") for p in c.get("answer_panes") or [])}
        if b["type"] == "QuizChat":
            st = self.sim.chat(b, n)
            i = next(j for j, o in enumerate(self.sim.chat_options(c, st)) if o.get("isValid"))
            return {"reply": i + 1, "why": ""}
        key = key_answer(b, c)
        if b["type"] == "QuizSelect":
            right = {int(x) for x in key.split(", ")}
            opts = [{"n": i + 1, "right": i + 1 in right, "quote": ""} for i in range(len(c["options"]))]
            return {"options": opts, "answer": min(right)}
        if b["type"] == "QuizText":
            return {"answer": key or "", "needs_user": key is None, "why": ""}
        return {"pairs": [{"item": int(a), "pick": p, "why": ""} for a, p in (x.split("=") for x in key.split("; "))]}


class Unsure:
    """A model whose samples never agree."""

    def __init__(self):
        self.k = 0

    async def structured(self, messages, schema, temperature, seed):
        self.k += 1
        return {"options": [{"n": 1 + self.k % 2, "right": True, "quote": ""}], "answer": 1 + self.k % 2, "pairs": [], "answer_text": "", "reply": 1, "code": ""}


def solver_for(sim, model, ask_user=None):
    async def call(tool, args):
        r = sim._call(tool, args)
        return r.content[0].text, r.is_error

    return LessonSolver(call, model, lambda k, t: None, ask_user)


def gradeable(raw: Path) -> bool:
    text = raw.read_text()
    if '"QuizFeedback"' in text:
        return False
    sim = None
    return True


@pytest.mark.parametrize("raw", [p for p in lessons_with("QuizSelect", "QuizChoice", "QuizCards", "QuizMacaroni", "QuizChat", "ActionButton") if gradeable(p)][:40], ids=lambda p: p.stem[:8])
def test_oracle_model_answers_everything_right_in_order(tmp_path, raw):
    sim = sim_for(tmp_path, raw)
    report = asyncio.run(solver_for(sim, Oracle(sim)).solve())
    wrong = {ref: a for ref, a in sim.attempts.items() if not a[0] and sim.blocks()[int(ref[1:]) - 1]["type"] != "QuizCoding"}
    assert not wrong, report
    left = [l for l in report.splitlines() if "LEFT FOR THE USER" in l]
    if not left and not sim.required_open():
        assert sim.done, report


def test_blocks_parse_from_the_real_rendering(tmp_path):
    sim = sim_for(tmp_path, lessons_with("QuizChoice")[0])
    text = sim._call("read_lesson", {"blocks": True}).content[0].text
    blocks = parse_blocks(text)
    assert [b.ref for b in blocks] == [b["ref"] for b in sim.blocks()]
    choice = next(b for b in blocks if b.kind == "choice")
    assert choice.numbers and choice.letters and choice.numbers[0] == "1" and choice.letters[0] == "A"
    schema, instruction = form(choice)
    assert "pairs" in schema["properties"]
    assert answer_of(choice, {"pairs": [{"item": int(n), "pick": "A", "why": ""} for n in choice.numbers]}) == "; ".join(f"{n}=A" for n in choice.numbers)
    assert answer_of(choice, {"pairs": [{"item": 1, "pick": "A", "why": ""}]}) is None or len(choice.numbers) == 1  # every item needs a pick


def test_unsure_model_falls_back_to_the_user(tmp_path):
    raw = next(p for p in lessons_with("QuizSelect") if gradeable(p))
    sim = sim_for(tmp_path, raw)
    asked = []

    async def ask_user(ref, block, candidates):
        asked.append((ref, candidates))
        return None  # the user leaves it

    report = asyncio.run(solver_for(sim, Unsure(), ask_user).solve())
    assert asked and "LEFT FOR THE USER" in report
    # Nothing was guessed: every QuizSelect the solver reached is still unanswered.
    assert not any(sim.attempts.get(r) for r, _ in asked)
