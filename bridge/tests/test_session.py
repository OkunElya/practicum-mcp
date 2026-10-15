"""Session (the agent loop shared by the one-shot agents and practicum-chat) with fake parts."""

import asyncio
from types import SimpleNamespace

from practicum_bridge.platform_agent import INTERRUPTED, MAX_FAILED_CHECKS, Session, Turn, clean_args


def tool(name, read_only=False):
    return SimpleNamespace(name=name, description=name, input_schema={}, annotations=SimpleNamespace(read_only_hint=read_only))


class FakeClient:
    def __init__(self, replies=None, block=None):
        self.calls = []
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
        return SimpleNamespace(content=[SimpleNamespace(text=text)], is_error=False)


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

    def user(self, text, page_changed):
        self.users.append((text, page_changed))

    async def turn(self):
        return self.turns.pop(0) if self.turns else Turn([], "done", [])

    def off_format(self):
        pass

    def results(self, done, bad, page_changed):
        self.reported.append(done)


def make(turns, **client):
    c = FakeClient(**client)
    s = Session(c, FakeBackend(turns), lambda kind, text: None)
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
    assert s.backend.users[1][1] is True and "другая страница" in s.backend.users[1][0]


def test_failed_checks_stop_and_new_message_lifts_it():
    check = Turn([{"tool": "check_task", "args": {}}], None, [])
    c, s = make([check] * MAX_FAILED_CHECKS + [check, Turn([], "ok", [])], replies={"check_task": "Not solved"})

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
