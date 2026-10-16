"""Chat with an agent that works on Practicum through the bridge.

Every message you type runs the agent loop (tool calls, results, more calls)
until the model answers in text; the conversation carries over to the next
message. Ctrl+C interrupts the current run (a running tool is cancelled in the
browser too); Ctrl+D or /quit exits. Irreversible actions still wait for your
approval in the page overlay.

    uv run practicum-chat --model gpt-oss-32k [--think low]
    uv run practicum-chat --platform            (Практикум ИИ drives instead)

Type /help inside the chat for the commands.
"""

import argparse
import asyncio
import json
import os
import signal
import sys
import time
from pathlib import Path

from mcp.client import Client

from .call import drop_proxies_for_loopback
from .platform_agent import OllamaBackend, Outcome, PlatformBackend, Session, visible

HISTORY_FILE = Path.home() / ".config" / "practicum-mcp" / "chat_history"

HELP = """\
Commands:
  /help                   this list
  /tools                  tools the model can call
  /where                  where_am_i: the page the agent is on
  /call TOOL [JSON]       run a tool yourself, e.g. /call read_lesson {"blocks": true};
                          the model is told about it with your next message
  /continue [N]           let the model keep going (after a round limit), N more rounds
  /rounds N               round limit per message (now {rounds})
  /clear                  start the conversation over{clear_note}
  /verbose                show tool results and messages in full (now {verbose})
  /log                    path of the full log
  /quit                   exit (Ctrl+D also works){ollama}
A line ending with \\ continues on the next line. Ctrl+C stops the current run."""

OLLAMA_HELP = """
  /prompt                 the system prompt the model works with (prompts.py)
  /model NAME             switch the Ollama model (the conversation is kept)
  /think low|medium|high|off|default   reasoning effort
  /temp X                 sampling temperature"""

OUTCOME_HINT = {
    1: "the model or the bridge failed (see above); send a message to try again",
    2: "round limit reached; /continue lets the model keep going",
    3: "stopped after repeated failed checks; tell the model what to do next",
    4: "stopped: the model kept repeating a failing call; tell it what to do differently",
    5: "stopped: no progress for several rounds; see the driver summary",
}


class Console:
    """Compact terminal view of the agent's events; everything goes to the log in full."""

    def __init__(self, log_path: Path, verbose: bool):
        self.log_path, self.verbose = log_path, verbose
        self.log = log_path.open("a", encoding="utf-8")
        self.color = sys.stdout.isatty() and not os.environ.get("NO_COLOR")
        self.model_kinds: set[str] = set()  # kinds that carry the model's replies
        self.streaming: str | None = None  # kind currently being streamed
        self.streamed: set[str] = set()  # kinds already shown token by token in this turn

    def paint(self, code: str, s: str) -> str:
        return f"\033[{code}m{s}\033[0m" if self.color else s

    def _end_stream(self) -> None:
        if self.streaming:
            print(flush=True)
            self.streaming = None

    def stream(self, kind: str, chunk: str) -> None:
        if kind != self.streaming:
            self._end_stream()
            thinking = kind.endswith(" thinking")
            print(self.paint("2" if thinking else "1;35", f"{'… ' if thinking else ''}{kind}:"), end=" ", flush=True)
            self.streaming = kind
            self.streamed.add(kind)
        print(self.paint("2", chunk) if kind.endswith(" thinking") else chunk, end="", flush=True)

    def clipped(self, text: str, lines: int) -> str:
        rows = text.splitlines() or [""]
        if self.verbose or len(rows) <= lines:
            return text
        return "\n".join(rows[:lines]) + "\n" + self.paint("2", f"… (+{len(rows) - lines} lines; /verbose or the log has them)")

    def __call__(self, kind: str, text: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log.write(f"\n[{stamp}] ── {kind} ──\n{text}\n")
        self.log.flush()
        self._end_stream()
        if kind in self.streamed:
            self.streamed.discard(kind)
            return
        if self.verbose:
            print(f"\n{self.paint('2', f'[{stamp}]')} {self.paint('1', f'── {kind} ──')}\n{text}", flush=True)
            return
        if kind.startswith("to ") or kind in ("round", "reset chat", "user message", "driver summary"):
            return  # prompts are long, the answer was shown as the model's reply
        if kind == "done" and text.startswith("["):  # finish(status, summary): the model's own words weren't streamed
            print(f"{self.paint('1;35', 'summary:')} {text}", flush=True)
            return
        if kind == "done":
            return
        if kind == "tokens":
            print(self.paint("2", f"  [{text}]"), flush=True)
        elif kind.endswith(" thinking"):
            print(self.paint("2", "… " + self.clipped(text, 4)), flush=True)
        elif kind in self.model_kinds:
            if all(l.startswith("CALL ") for l in text.splitlines()):
                return  # the calls are shown as they run
            print(f"{self.paint('1;35', kind + ':')} {text}", flush=True)
        elif "(" in kind:  # a tool call: "name({args})"
            error = kind.endswith(" ERROR")
            print(self.paint("1;31" if error else "36", "▸ " + kind), flush=True)
            if text.strip():
                print(self.paint("2", self.clipped(text, 8)), flush=True)
        else:  # warnings, page changes, stops
            print(self.paint("33", f"● {kind}") + (f": {self.clipped(text, 6)}" if text.strip() else ""), flush=True)


class Chat:
    def __init__(self, session: Session, console: Console, rounds: int):
        self.session, self.console, self.rounds = session, console, rounds
        self.backend = session.backend
        self.running: asyncio.Task | None = None

    def on_sigint(self) -> None:
        if self.running and not self.running.done():
            self.running.cancel()
        else:
            print(self.console.paint("2", "\n(Ctrl+D or /quit to exit)"), flush=True)

    async def run_task(self, coro) -> None:
        self.running = asyncio.ensure_future(coro)
        try:
            out: Outcome = await self.running
        except asyncio.CancelledError:
            self.console._end_stream()
            self.console.streamed.clear()
            self.console("interrupted", "the current run was stopped; send a message to go on")
            return
        finally:
            self.running = None
        if out.code in OUTCOME_HINT:
            self.console("note", OUTCOME_HINT[out.code])
        if out.facts:
            print(self.console.paint("2", out.facts), flush=True)

    async def read(self) -> str | None:
        prompt = "\001\033[1;32m\002you›\001\033[0m\002 " if self.console.color else "you> "
        lines = []
        while True:
            try:
                line = await asyncio.to_thread(input, prompt if not lines else "  … ")
            except EOFError:
                return None
            if line.endswith("\\"):
                lines.append(line[:-1])
                continue
            lines.append(line)
            return "\n".join(lines).strip()

    async def command(self, line: str) -> bool:
        """Handle a /command; False means quit."""
        name, _, rest = line[1:].partition(" ")
        rest = rest.strip()
        ollama = isinstance(self.backend, OllamaBackend)
        say = lambda s: print(self.console.paint("2", s), flush=True)  # noqa: E731
        match name:
            case "quit" | "exit" | "q":
                return False
            case "help" | "?":
                print(HELP.format(
                    rounds=self.rounds,
                    verbose="on" if self.console.verbose else "off",
                    clear_note=" (and a new Практикум ИИ chat)" if not ollama else "",
                    ollama=OLLAMA_HELP if ollama else "",
                ))
            case "tools":
                for t in self.session.tools:
                    if visible(t.name, self.backend.hidden):
                        props = ", ".join((t.input_schema or {}).get("properties", {}))
                        first = (t.description or "").split(". ")[0]
                        print(f"  {self.console.paint('36', t.name)}({props}) — {first}")
            case "where":
                out, _ = await self.session.call("where_am_i", {})
                print(out)
            case "call":
                tool, _, raw = rest.partition(" ")
                if not tool:
                    say("usage: /call TOOL [JSON args]")
                    return True
                try:
                    args = json.loads(raw) if raw.strip() else {}
                except ValueError as e:
                    say(f"bad JSON: {e}")
                    return True
                await self.run_task(self._user_call(tool, args))
            case "continue":
                if not self.session.task:
                    say("nothing to continue yet; send a message")
                    return True
                n = int(rest) if rest.isdigit() else self.rounds
                await self.run_task(self.session.resume(n))
            case "rounds":
                if rest.isdigit() and int(rest) > 0:
                    self.rounds = int(rest)
                say(f"round limit per message: {self.rounds}")
            case "clear":
                ok = await self.session.reset()
                say("conversation cleared" if ok else "could not reset the chat (see above)")
            case "verbose":
                self.console.verbose = not self.console.verbose
                say(f"verbose {'on' if self.console.verbose else 'off'}")
            case "log":
                say(str(self.console.log_path.resolve()))
            case "prompt" if ollama:
                print(self.backend.system)
            case "model" if ollama:
                if rest:
                    await self.backend.set_model(rest)
                    self.console.model_kinds.add(rest)
                say(f"model {self.backend.model}, context {self.backend.ctx or '?'}")
            case "think" if ollama:
                if rest:
                    self.backend.think = None if rest == "default" else rest
                say(f"think: {self.backend.think or 'model default'}")
            case "temp" if ollama:
                try:
                    self.backend.options["temperature"] = float(rest)
                except ValueError:
                    pass
                say(f"temperature {self.backend.options['temperature']}")
            case _:
                say(f"unknown command /{name}; /help lists them")
        return True

    async def _user_call(self, tool: str, args: dict) -> Outcome:
        if tool not in {t.name for t in self.session.tools}:
            self.console("note", f"no tool named {tool!r}; /tools lists them")
            return Outcome(0)
        out, err = await self.session.user_call(tool, args)
        self.console(f"{tool}({json.dumps(args, ensure_ascii=False)}){' ERROR' if err else ''}", out)
        return Outcome(0)

    async def loop(self) -> None:
        loop = asyncio.get_running_loop()
        loop.add_signal_handler(signal.SIGINT, self.on_sigint)
        name = self.backend.name
        print(self.console.paint("2", f"Chatting with {name} — {len(self.session.known)} tools, page {self.session.where.removeprefix('URL: ')}. /help for commands."))
        while True:
            line = await self.read()
            if line is None:
                print()
                return
            if not line:
                continue
            if line.startswith("/"):
                if not await self.command(line):
                    return
                continue
            self.console.log.write(f"\n[{time.strftime('%H:%M:%S')}] ── you ──\n{line}\n")
            await self.run_task(self.session.ask(line, self.rounds))


def setup_readline() -> None:
    try:
        import readline
    except ImportError:
        return
    try:
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        readline.read_history_file(HISTORY_FILE)
    except OSError:
        pass
    readline.set_history_length(1000)
    import atexit

    atexit.register(lambda: _save_history(readline))


def _save_history(readline) -> None:
    try:
        readline.write_history_file(HISTORY_FILE)
    except OSError:
        pass


async def amain(a: argparse.Namespace) -> int:
    drop_proxies_for_loopback(a.url)
    console = Console(a.log, a.verbose)
    async with Client(a.url) as client:
        if a.platform:
            backend = PlatformBackend(client, console, a.keep_chat)
        else:
            backend = OllamaBackend(console, a.model, a.ollama, a.num_ctx, a.temperature, a.think, None if a.no_stream else console.stream)
        console.model_kinds.add(backend.name)

        async def ask_user(ref: str, block: str, candidates: list[str]) -> str | None:
            console._end_stream()
            print(console.paint("1;33", f"\nThe lesson solver isn't sure about {ref}:"))
            print(block[:2500])
            if candidates:
                print(console.paint("2", "Model's candidates: " + " / ".join(f"«{c}»" for c in candidates)))
            line = await asyncio.to_thread(input, f"Your answer for {ref} (as for answer_quiz; Enter to leave it): ")
            return line.strip() or None
        session = Session(client, backend, console, solver=not a.no_solver)
        session.ask_user = ask_user
        if not await session.open():
            return 1
        # gpt-oss makes one call per reply: a simple trainer task takes 14-19 rounds.
        await Chat(session, console, a.rounds or (10 if a.platform else 30)).loop()
    return 0


def main() -> None:
    p = argparse.ArgumentParser(prog="practicum-chat", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    who = p.add_mutually_exclusive_group(required=True)
    who.add_argument("--model", help="Ollama model, e.g. gpt-oss-32k")
    who.add_argument("--platform", action="store_true", help="let Практикум ИИ drive through its chat")
    p.add_argument("--rounds", type=int, help="round limit per message (default: 30 for local models, 10 for Практикум ИИ)")
    p.add_argument("--url", default="http://127.0.0.1:8766/mcp", help="the bridge's MCP endpoint")
    p.add_argument("--log", type=Path, default=Path("chat.log"))
    p.add_argument("--verbose", action="store_true", help="print every event in full")
    p.add_argument("--keep-chat", action="store_true", help="(--platform) don't start a new Практикум ИИ chat first")
    p.add_argument("--ollama", default="http://127.0.0.1:11434", help="Ollama base URL")
    p.add_argument("--num-ctx", type=int, default=None, help="context window to request (default: the model's own setting)")
    p.add_argument("--temperature", type=float, default=0.2, help="0.2 scored best in evals/tune.py")
    p.add_argument("--think", choices=["low", "medium", "high", "off"], help="reasoning effort for models that support it")
    p.add_argument("--no-stream", action="store_true", help="show replies when complete instead of token by token")
    p.add_argument("--no-solver", action="store_true", help="don't offer solve_current_lesson (block-by-block lesson solver)")
    a = p.parse_args()
    setup_readline()
    try:
        sys.exit(asyncio.run(amain(a)))
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
