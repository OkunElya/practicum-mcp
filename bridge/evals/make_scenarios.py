"""Build eval scenarios from the scraped lessons (bridge/evals/raw, see
scripts/inspect/scrape-lessons.mjs) into bridge/evals/scenarios/.

Theory lessons: for every interactive block type, the shortest lessons that
contain it and that the simulator can grade end to end (no feedback survey, no
graded code exercise without tests). Plus two basic ones: a lesson with nothing
to answer and one with only buttons.

Trainer tasks: the three tasks of lesson 3 of «Пути и view-функции» (route the
home page, create about/urls.py, create ice_cream/urls.py), built on the lesson 4
project captured earlier (scenarios/lesson4-start), since a task's starter files
aren't in the lesson JSON.

Journeys (several pages in a row, to test moving between lessons and tasks):
journey-routes follows that topic from its first theory lesson to the lesson 4
task; journey-theory-* is three consecutive theory lessons of one topic.

    uv run python evals/make_scenarios.py [--per-type 2]
"""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT = HERE / "scenarios"
sys.path.insert(0, str(HERE))

TYPES = ["QuizSelect:radio", "QuizSelect:checkbox", "QuizChoice", "QuizCards", "QuizMacaroni", "QuizText", "QuizChat", "QuizCoding", "ActionButton"]
MAX_CHARS = 20_000  # rendered lesson size: keep runs short and inside a 32k context


def nodes(n: dict):
    yield n
    for c in n.get("nested") or []:
        yield from nodes(c)


def kinds(lesson: dict) -> set[str]:
    out = set()
    for n in nodes(lesson["theory"]):
        t, c = n["type"], n.get("content") or {}
        if t == "QuizSelect":
            out.add(f"QuizSelect:{c.get('type')}")
        elif t == "QuizCoding":
            if c.get("use_tests"):
                out.add("QuizCoding")
        elif t.startswith("Quiz") or t == "ActionButton":
            out.add(t)
    return out


def gradeable(lesson: dict) -> bool:
    for n in nodes(lesson["theory"]):
        c = n.get("content") or {}
        if n["type"] == "QuizFeedback":
            return False  # the user's own opinion: the agent must not fill it in
        if n["type"] == "QuizCoding" and c.get("use_tests") and not (c.get("test") and c.get("answer_panes")):
            return False
    return True


def theory_scenarios(per_type: int) -> list[str]:
    from sims import Helper

    helper = Helper.get()
    index = {l["id"]: l for l in json.loads((RAW / "index.json").read_text())["lessons"]}
    pool = []
    for f in sorted((RAW / "lessons").glob("*.json")):
        lesson = json.loads(f.read_text())
        if lesson.get("lesson_type") != "web" or not lesson.get("theory") or not gradeable(lesson):
            continue
        size = len(helper(op="render", lesson=lesson, answers=[], opts={"maxChars": 10**6})["text"])
        if size <= MAX_CHARS:
            pool.append((size, lesson, kinds(lesson)))
    pool.sort(key=lambda x: x[0])

    picked: dict[str, tuple[str, dict]] = {}
    for t in TYPES:
        for size, lesson, ks in [p for p in pool if t in p[2]][:per_type]:
            picked.setdefault(lesson["id"], (t, lesson))
    plain = next((l for s, l, ks in pool if not ks and s > 3000), None)
    buttons = next((l for s, l, ks in pool if ks == {"ActionButton"} and l["id"] not in picked), None)

    names = []
    for label, lesson in [*picked.values(), *([("basic-read", plain)] if plain else []), *([("basic-buttons", buttons)] if buttons else [])]:
        slug = label.lower().replace("quiz", "").replace(":", "-")
        name = f"theory-{slug}-{lesson['id'][:6]}"
        write_lesson(OUT / name, lesson, index, label)
        names.append(name)

    # Three consecutive theory lessons of one topic, the smallest such run.
    ok = {l["id"]: s for s, l, ks in pool}
    runs = []
    order = json.loads((RAW / "index.json").read_text())["lessons"]
    for i in range(len(order) - 2):
        trio = order[i : i + 3]
        if len({l["topic"] for l in trio}) == 1 and all(l["id"] in ok for l in trio):
            runs.append((sum(ok[l["id"]] for l in trio), trio))
    if runs:
        trio = min(runs, key=lambda r: r[0])[1]
        name = f"journey-theory-{trio[0]['pos'].replace('.', '-')}"
        pages = []
        for k, l in enumerate(trio):
            page = f"pages/{k + 1:02d}-{l['pos']}"
            write_lesson(OUT / name / page, json.loads((RAW / "lessons" / f"{l['id']}.json").read_text()), index, "journey")
            pages.append(page)
        (OUT / name / "journey.json").write_text(json.dumps({"pages": pages}, indent=1))
        names.append(name)
    return names


# Free-text tasks whose answer comes from the student's own machine: an agent can't know it and
# should leave them for the user (lesson 8.2.5 asks for pytest output on the student's computer).
USER_ONLY = re.compile(r"Выполните (эту )?команд|Запустите (тесты|команд)|на своём компьютере|в своём терминале", re.I)


def user_only(lesson: dict) -> list[str]:
    return [n["id"] for n in nodes(lesson["theory"]) if n["type"] == "QuizText" and USER_ONLY.search(str((n.get("content") or {}).get("content", "")))]


def write_lesson(d: Path, lesson: dict, index: dict, label: str) -> None:
    d.mkdir(parents=True, exist_ok=True)
    (d / "lesson.json").write_text(json.dumps(lesson, ensure_ascii=False))
    nxt = index.get(lesson.get("next_lesson_id") or "", {})
    meta = {"kind": "lesson", "focus": label, "types": sorted(kinds(lesson)), "pos": index.get(lesson["id"], {}).get("pos"), "next": {"name": nxt.get("name"), "type": nxt.get("type")}, "user_only": user_only(lesson)}
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))


EMPTY_VIEWS = {
    "homepage/views.py": "from django.http import HttpResponse\n\n\ndef index(request):\n    return HttpResponse()\n",
    "about/views.py": "from django.http import HttpResponse\n\n\ndef description(request):\n    return HttpResponse()\n",
    "ice_cream/views.py": "from django.http import HttpResponse\n\n\ndef ice_cream_list(request):\n    return HttpResponse()\n\n\ndef ice_cream_detail(request, pk):\n    return HttpResponse()\n",
    "homepage/urls.py": "from django.urls import path\n\nfrom . import views\n\nurlpatterns = [\n    path('', views.index),\n]\n",
}
ROOT_URLS = "from django.contrib import admin\nfrom django.urls import include, path\n\nurlpatterns = [\n{paths}    path('admin/', admin.site.urls),\n]\n"
ABOUT_URLS = "from django.urls import path\n\nfrom . import views\n\nurlpatterns = [\n    path('', views.description),\n]\n"


def trainer_scenarios() -> list[str]:
    base = OUT / "lesson4-start"
    lesson = json.loads((RAW / "lessons" / "776fba9a-3e2b-454a-bb23-30e149cd62bb.json").read_text())
    if not base.exists():
        print("skipping trainer scenarios: scenarios/lesson4-start is missing", file=sys.stderr)
        return []
    home = "    path('', include('homepage.urls')),\n"
    about = "    path('about/', include('about.urls')),\n"
    rocket = "from django.http import HttpResponse\n\n\ndef index(request):\n    return HttpResponse('<h1>Здесь же была ракета!</h1>')\n"
    no_routes = "from django.urls import path\n\nfrom . import views\n\nurlpatterns = [\n]\n"
    specs = [
        (
            "trainer-route-homepage", 0,
            {**EMPTY_VIEWS, "homepage/views.py": rocket, "homepage/urls.py": no_routes, "anfisa_for_friends/urls.py": "from django.contrib import admin\nfrom django.urls import path\n\nurlpatterns = [\n    path('admin/', admin.site.urls),\n]\n"},
            ["about/urls.py", "ice_cream/urls.py"],
            {"pages": [{"path": "/", "view": "homepage.views.index", "urls_file": "homepage/urls.py", "text": "ракета"}]},
        ),
        (
            "trainer-create-about-urls", 1, {**EMPTY_VIEWS, "anfisa_for_friends/urls.py": ROOT_URLS.format(paths=home)}, ["about/urls.py", "ice_cream/urls.py"],
            {"require_files": ["about/urls.py"], "pages": [
                {"path": "/about/", "view": "about.views.description", "urls_file": "about/urls.py"},
                {"path": "/", "view": "homepage.views.index", "urls_file": "homepage/urls.py"},
            ]},
        ),
        (
            "trainer-create-ice-cream-urls", 2, {**EMPTY_VIEWS, "about/urls.py": ABOUT_URLS, "anfisa_for_friends/urls.py": ROOT_URLS.format(paths=home + about)}, ["ice_cream/urls.py"],
            {"require_files": ["ice_cream/urls.py"], "pages": [
                {"path": "/ice_cream/", "view": "ice_cream.views.ice_cream_list", "urls_file": "ice_cream/urls.py"},
                {"path": "/ice_cream/1/", "view": "ice_cream.views.ice_cream_detail", "urls_file": "ice_cream/urls.py"},
                {"path": "/ice_cream/42/", "view": "ice_cream.views.ice_cream_detail", "urls_file": "ice_cream/urls.py"},
                {"path": "/ice_cream/0/", "view": "ice_cream.views.ice_cream_detail", "urls_file": "ice_cream/urls.py"},
                {"path": "/ice_cream/-1/", "status": 404},
                {"path": "/about/", "view": "about.views.description", "urls_file": "about/urls.py"},
            ]},
        ),
    ]
    names = []
    for name, i, files, remove, checks in specs:
        task = lesson["tasks"][i]
        d = OUT / name
        if d.exists():
            shutil.rmtree(d)
        shutil.copytree(base / "files", d / "files")
        for f in remove:
            (d / "files" / f).unlink(missing_ok=True)
        for f, code in files.items():
            (d / "files" / f).write_text(code)
        (d / "task.txt").write_text(
            f"Lesson «{lesson['name']}» [{lesson['lesson_type']}], not solved\nTask {i + 1}/{len(lesson['tasks'])} id={task['id']}, not solved\n\n"
            f"{task['description'].strip()}\n\nFiles (0): rebuilt by the simulator\nHints available: {len(task['hints'])}\n"
        )
        (d / "hint.txt").write_text(task["hints"][0]["content"] if task["hints"] else "")
        (d / "lesson.txt").write_text((base / "lesson.txt").read_text())
        (d / "lesson_raw.json").write_text(json.dumps(lesson, ensure_ascii=False))  # read_lesson shows this lesson
        (d / "where.txt").write_text(
            "Page: code trainer\n"
            f"URL: https://practicum.yandex.ru/trainer/ap-backend-st/lesson/{lesson['id']}/task/{task['id']}/\n"
            f"Course: {lesson.get('course_name')} › Topic: {lesson.get('topic_name')}\n"
            f"Lesson 3/4: «{lesson['name']}» [web_server] id={lesson['id']}, not solved\n"
            f"Tasks: {', '.join(str(k + 1) + (' ✓' if k < i else '') for k in range(len(lesson['tasks'])))}\n"
            f"Current task: {i + 1} id={task['id']}, not solved\n"
            "Buttons on screen:\n- Проверить (check-task-button)\n- Задеплоить (deploy-button)\n- Подсказка (trainer-hint-button)\n"
        )
        (d / "checks.json").write_text(json.dumps({"settings": "anfisa_for_friends.settings", **checks}, ensure_ascii=False, indent=1))
        names.append(name)
    return names


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--per-type", type=int, default=2)
    a = p.parse_args()
    if not (RAW / "index.json").exists():
        sys.exit("no scraped lessons: run node scripts/inspect/scrape-lessons.mjs first")
    names = theory_scenarios(a.per_type) + trainer_scenarios()
    names += routes_journey()
    print("\n".join(names))


def routes_journey() -> list[str]:
    """«Пути и view-функции» from its first lesson: theory, theory, three trainer tasks, the lesson 4 task."""
    index = {l["id"]: l for l in json.loads((RAW / "index.json").read_text())["lessons"]}
    topic = [l for l in json.loads((RAW / "index.json").read_text())["lessons"] if l["topic"] == "Пути и view-функции"]
    trainers = ["trainer-route-homepage", "trainer-create-about-urls", "trainer-create-ice-cream-urls", "lesson4-start"]
    if not all((OUT / t).exists() for t in trainers):
        return []
    d = OUT / "journey-routes"
    if d.exists():
        shutil.rmtree(d)
    pages = []
    for l in topic[:2]:  # the two theory lessons
        page = f"pages/{len(pages) + 1:02d}-{l['pos']}"
        write_lesson(d / page, json.loads((RAW / "lessons" / f"{l['id']}.json").read_text()), index, "journey")
        pages.append(page)
    for t in trainers:
        page = f"pages/{len(pages) + 1:02d}-{t}"
        shutil.copytree(OUT / t, d / page)
        pages.append(page)
    (d / "journey.json").write_text(json.dumps({"pages": pages}, indent=1))
    return ["journey-routes"]


if __name__ == "__main__":
    main()
