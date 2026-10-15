"""Sanity-check testlib_shim against every graded QuizCoding exercise in raw/.

    cd bridge && uv run python evals/check_testlib_shim.py [-v]

For each exercise: the reference solution must pass its own test, and the
starter code should fail it. Exercises whose scraped content carries no
test / reference are listed as "no data". Always exits 0.
"""

from __future__ import annotations

import glob
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testlib_shim import grade  # noqa: E402

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw", "lessons")


def walk(node):
    yield node
    for child in node.get("nested") or []:
        yield from walk(child)


def pane_code(panes):
    return "\n".join(p.get("content") or "" for p in panes or [])


def exercises():
    for path in sorted(glob.glob(os.path.join(RAW, "*.json"))):
        lesson = json.load(open(path, encoding="utf-8"))
        if not lesson.get("theory"):
            continue
        for node in walk(lesson["theory"]):
            c = node.get("content") or {}
            if node.get("type") == "QuizCoding" and c.get("use_tests"):
                yield lesson["id"], node["id"], c


def check(item):
    lesson_id, block_id, c = item
    row = {
        "lesson": lesson_id[:8],
        "block": block_id[:8],
        "testlib": c.get("testlib_version") or "-",
        "panes": len(c.get("panes") or []),
    }
    if not c.get("test") or not c.get("answer_panes"):
        row.update(status="no data", ref="-", starter="-", msg="no test/answer_panes in scrape")
        return row
    answer = pane_code(c["answer_panes"])
    starter = pane_code(c.get("panes"))
    precode = (c.get("coderun_config") or {}).get("precode") or ""
    ref = grade(answer, answer, c["test"], precode)
    st = grade(starter, answer, c["test"], precode)
    row["ref"] = "PASS" if ref["solved"] else "FAIL"
    row["starter"] = "fails" if not st["solved"] else "PASSES"
    row["status"] = "ok" if ref["solved"] and not st["solved"] else "BAD"
    msg = st["message"] if ref["solved"] else "ref: " + ref["message"]
    row["msg"] = " ".join(msg.split())
    row["full"] = (ref, st)
    return row


def main():
    verbose = "-v" in sys.argv
    items = list(exercises())
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        rows = list(pool.map(check, items))

    print(f"{'lesson':8}  {'block':8}  {'testlib':24}  {'ref':4}  {'starter':7}  message")
    for r in rows:
        print(
            f"{r['lesson']:8}  {r['block']:8}  {r['testlib']:24}  {r['ref']:4}  "
            f"{r['starter']:7}  {r['msg'][:90]}"
        )
        if verbose and r["status"] == "BAD":
            for label, res in zip(("reference", "starter"), r["full"]):
                print(f"    {label}: {json.dumps(res, ensure_ascii=False)[:1500]}")

    total = len(rows)
    ok = sum(r["status"] == "ok" for r in rows)
    nodata = sum(r["status"] == "no data" for r in rows)
    ref_fail = sum(r.get("ref") == "FAIL" for r in rows)
    st_pass = sum(r.get("starter") == "PASSES" for r in rows)
    multi = sum(r["panes"] > 1 for r in rows)
    print()
    print(f"graded exercises: {total}")
    print(f"  with test data: {total - nodata}   no test/answer in scrape: {nodata}")
    print(f"  reference passes AND starter fails: {ok}")
    print(f"  reference fails: {ref_fail}   starter passes: {st_pass}   multi-pane: {multi}")


if __name__ == "__main__":
    main()
    sys.exit(0)
