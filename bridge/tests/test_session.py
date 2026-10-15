"""Session (the agent loop shared by the one-shot agents and practicum-chat) with fake parts."""

import asyncio
from types import SimpleNamespace

from practicum_bridge.platform_agent import INTERRUPTED, LOOP_STOP, MAX_FAILED_CHECKS, REPEAT_LIMIT, Session, Turn, clean_args, looks_patterned


def tool(name, read_only=False):
    return SimpleNamespace(name=name, description=name, input_schema={}, annotations=SimpleNamespace(read_only_hint=read_only))


class FakeClient:
    def __init__(self, replies=None, block=None, errors=()):
        self.calls = []
        self.errors = set(errors)  # tools that always fail
        self.url = "URL: https://practicum.yandex.ru/a"
        self.replies = replies or {}
        self.block = block  # tool name that hangs until cancelled

    async def list_tools(self):
        return SimpleNamespace(tools=[tool("where_am_i", True), tool("read_lesson", True), tool("press"), tool("check_task")])

    async def call_tool(self, name, args):
        if name != "where_am_i":
            self.calls.append((name, args))
        if name == self.block:
            await asyncio.Event().wait()
        text = self.url if name == "where_am_i" else self.replies.get(name, f"{name} ok")
        return SimpleNamespace(content=[SimpleNamespace(text=text)], is_error=name in self.errors)


class FakeBackend:
    hidden = set()
    name = "fake"

    def __init__(self, turns):
        self.turns = list(turns)
        self.users, self.reported = [], []

    async def start(self, tools, full):
        return True

    async def reset(self):
        return True

    def user(self, text, page_changed, page):
        self.users.append((text, page_changed, page))

    async def turn(self):
        return self.turns.pop(0) if self.turns else Turn([], "done", [])

    def off_format(self):
        pass

    def results(self, done, bad, page_changed):
        self.reported.append(done)


def make(turns, read=True, **client):
    c = FakeClient(**client)
    s = Session(c, FakeBackend(turns), lambda kind, text: None)
    s.must_read = not read  # most tests start as if the page had been read; test_read_first doesn't
    return c, s


def test_clean_args_drops_empty_keys():
    assert clean_args({"": "", "block": "q1"}) == {"block": "q1"}
    assert clean_args(None) == {}


def test_one_action_per_round_and_conversation_carries_over():
    c, s = make([
        Turn([{"tool": "read_lesson", "args": {"": ""}}, {"tool": "press", "args": {}}, {"tool": "press", "args": {}}], None, []),
        Turn([], "first done", []),
        Turn([], "second done", []),
    ])

    async def go():
        assert await s.open()
        first = await s.ask("do it", 5)
        c.url = "URL: https://practicum.yandex.ru/b"  # the user moved on between messages
        second = await s.ask("and now this", 5)
        return first, second

    first, second = asyncio.run(go())
    assert (first.code, first.answer, second.answer) == (0, "first done", "second done")
    # Reads and one action ran; the second action was skipped, empty arg keys dropped.
    assert c.calls == [("read_lesson", {}), ("press", {})]
    assert s.backend.reported[0][2].skipped
    assert s.backend.users[1][1] is True and "practicum.yandex.ru/b" in s.backend.users[1][2]


def test_failed_checks_stop_and_new_message_lifts_it():
    check = Turn([{"tool": "check_task", "args": {}}], None, [])
    edit = Turn([{"tool": "press", "args": {}}], None, [])  # a change between checks, as a real fix would be
    tries = [check] + [edit, check] * (MAX_FAILED_CHECKS - 1)
    c, s = make(tries + [check, Turn([], "ok", [])], replies={"check_task": "Not solved"})

    async def go():
        await s.open()
        return await s.ask("solve", 10), await s.ask("try once more", 10)

    stopped, again = asyncio.run(go())
    assert stopped.code == 3
    assert again.code == 0
    assert sum(1 for n, _ in c.calls if n == "check_task") == MAX_FAILED_CHECKS + 1


def test_interrupt_reports_every_planned_call():
    c, s = make([Turn([{"tool": "press", "args": {}}, {"tool": "read_lesson", "args": {}}], None, [])], block="press")

    async def go():
        await s.open()
        task = asyncio.ensure_future(s.ask("go", 5))
        await asyncio.sleep(0.05)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return True
        return False

    assert asyncio.run(go())
    [done] = s.backend.reported
    assert [e.call["tool"] for e in done] == ["press", "read_lesson"]
    assert all(e.skipped and INTERRUPTED in e.skipped for e in done)


def test_repeated_failing_call_is_refused_then_stops():
    bad = Turn([{"tool": "press", "args": {"x": 1}}], None, [])
    c, s = make([bad] * 10, replies={"press": "no such button"}, errors={"press"})

    async def go():
        await s.open()
        return await s.ask("press it", 20)

    out = asyncio.run(go())
    assert out.code == 4
    assert [n for n, _ in c.calls] == ["press"] * REPEAT_LIMIT
    refused = [r[0] for r in s.backend.reported[REPEAT_LIMIT:]]
    assert len(refused) == LOOP_STOP and all(e.skipped for e in refused)


def test_local_model_gets_its_own_prompt_and_the_page():
    from practicum_bridge.platform_agent import OllamaBackend
    from practicum_bridge.prompts import LOCAL_SYSTEM

    b = OllamaBackend(lambda k, t: None, "m", "http://127.0.0.1:1", None, 0.2)
    assert b.system == LOCAL_SYSTEM and "CALL" not in LOCAL_SYSTEM
    b.messages = [{"role": "system", "content": b.system}]
    b.user("реши задачу", False, "URL: a")
    b.user("и ещё", False, "URL: a")
    b.user("теперь тут", True, "URL: b")
    first, second, third = (m["content"] for m in b.messages[1:])
    assert "URL: a" in first and "URL:" not in second and "URL: b" in third


def test_unparsable_tool_call_is_retried_with_a_nudge_and_new_seed(monkeypatch):
    import io
    import urllib.error

    from practicum_bridge import platform_agent as pa

    seen = []

    class Flaky(pa.OllamaBackend):
        def _post(self, extra=None, options=None):
            seen.append((extra, (options or self.options).get("seed")))
            if len(seen) == 1:
                body = io.BytesIO(b'{"error":"error parsing tool call: raw=\'{\\"code\\": \\"x Wait we need\'"}')
                raise urllib.error.HTTPError("http://x/api/chat", 500, "Internal Server Error", {}, body)
            return {"message": {"content": "готово"}, "prompt_eval_count": 1, "eval_count": 1}

    async def no_sleep(_):
        return None

    monkeypatch.setattr(pa.asyncio, "sleep", no_sleep)
    b = Flaky(lambda k, t: None, "m", "http://127.0.0.1:1", None, 0.2)
    b.options["seed"] = 5
    b.messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
    turn = asyncio.run(b.turn())
    assert turn.answer == "готово"
    assert seen[0] == (None, 5)
    assert seen[1][0][0]["content"] == pa.PARSE_NUDGE and seen[1][1] != 5
    assert all(m["content"] != pa.PARSE_NUDGE for m in b.messages)  # the nudge isn't kept in the history


def test_same_read_with_same_result_is_refused_after_two():
    read = Turn([{"tool": "read_lesson", "args": {}}], None, [])
    c, s = make([read] * 6, replies={"read_lesson": "the same text"})

    async def go():
        await s.open()
        return await s.ask("read", 20)

    out = asyncio.run(go())
    assert out.code == 4
    assert [n for n, _ in c.calls] == ["read_lesson"] * REPEAT_LIMIT


def test_recheck_without_changes_is_refused():
    check = Turn([{"tool": "check_task", "args": {}}], None, [])
    edit = Turn([{"tool": "press", "args": {}}], None, [])
    c, s = make([check, check, edit, check, Turn([], "ok", [])], replies={"check_task": "Not solved."})

    async def go():
        await s.open()
        return await s.ask("solve", 10)

    assert asyncio.run(go()).code == 0
    # The second check was refused (nothing changed); after an edit checking is allowed again.
    assert [n for n, _ in c.calls] == ["check_task", "press", "check_task"]



def test_read_first_at_start_and_after_a_page_change():
    act = Turn([{"tool": "check_task", "args": {}}], None, [])
    read = Turn([{"tool": "read_lesson", "args": {}}], None, [])
    c, s = make([act, read, act, act, read, act, Turn([], "ok", [])], read=False, replies={"check_task": "Solved"})

    async def go():
        await s.open()
        real = c.call_tool

        async def call_tool(name, args):  # the first check that runs moves to another page
            if name == "check_task" and not any(n == "check_task" for n, _ in c.calls):
                c.url = "URL: https://practicum.yandex.ru/next"
            return await real(name, args)

        c.call_tool = call_tool
        return await s.ask("go", 10)

    assert asyncio.run(go()).code == 0
    # Refused before reading; run after; refused again after the page changed; run after reading it.
    assert [n for n, _ in c.calls] == ["read_lesson", "check_task", "read_lesson", "check_task"]


def test_patterned_answers_are_questioned_once():
    assert looks_patterned("1=A; 2=B; 3=C; 4=D") and looks_patterned("1,2,3,4") and looks_patterned("12345678910")
    assert not looks_patterned("1=B; 2=A; 3=C") and not looks_patterned("2, 4") and not looks_patterned("13486")
    pattern = Turn([{"tool": "answer_quiz", "args": {"block": "q1", "answer": "1=A; 2=B; 3=C"}}], None, [])
    c, s = make([pattern, pattern, Turn([], "ok", [])])

    async def go():
        tools = (await FakeClient().list_tools()).tools + [SimpleNamespace(name="answer_quiz", description="", input_schema={}, annotations=SimpleNamespace(read_only_hint=False))]
        c.list_tools = lambda: _tools(tools)
        await s.open()
        s.must_read = False
        return await s.ask("answer", 10)

    async def _tools(t):
        return SimpleNamespace(tools=t)

    assert asyncio.run(go()).code == 0
    assert [n for n, _ in c.calls] == ["answer_quiz"]  # refused once, sent again, then run



def test_reading_the_open_lesson_by_id_counts_as_reading_it():
    lesson = "0b1f8810-09b3-4f94-9820-8f3ffc6a018b"
    read = Turn([{"tool": "read_lesson", "args": {"lesson": lesson}}], None, [])
    act = Turn([{"tool": "check_task", "args": {}}], None, [])
    c, s = make([read, act, Turn([], "ok", [])], read=False, replies={"read_lesson": f"Lesson «X» [web] id={lesson}, not solved", "check_task": "Solved"})
    c.url = f"URL: https://practicum.yandex.ru/learn/x/lessons/{lesson}/\nLesson 1/1: «X» [web] id={lesson}, not solved"

    async def go():
        await s.open()
        return await s.ask("go", 5)

    assert asyncio.run(go()).code == 0
    assert [n for n, _ in c.calls] == ["read_lesson", "check_task"]
