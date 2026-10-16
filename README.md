# Practicum MCP

Lets an MCP client (Claude Code, …) or a chat agent in the browser's sidebar study on
[Yandex Practicum](https://practicum.yandex.ru) in **your own logged-in browser tab**:
read lessons and progress, answer quizzes, write and check code, ask the platform's
AI. Every action is visible on the page and can be stopped; anything that records
something on your account waits for your approval.

```
MCP client ──HTTP /mcp──▶ Python bridge (bridge/) ◀──WebSocket── Firefox/Waterfox extension (extension/)
             127.0.0.1:8766                          127.0.0.1:8765        acts in the practicum.yandex.ru tab
```

The extension dials out to the bridge because browser extensions can't listen on
ports. Both ports bind to 127.0.0.1 only. The bridge accepts only an extension
origin presenting its pairing token.

## Setup

Requirements: Firefox or Waterfox ≥ 128, Node.js, [uv](https://docs.astral.sh/uv/).

1. **Bridge**
   ```sh
   cd bridge
   uv run practicum-bridge          # MCP at http://127.0.0.1:8766/mcp
   ```
   On first start it creates a pairing token in `~/.config/practicum-mcp/token` and
   prints it.

2. **Extension**
   ```sh
   npm install
   npm run build                    # → extension/dist/
   ```
   In the browser open `about:debugging#/runtime/this-firefox` → *Load Temporary
   Add-on…* → pick `extension/dist/manifest.json`. A temporary add-on stays until the
   browser restarts. A permanent install needs a signed build, or a browser that
   allows unsigned add-ons.

3. **Pair**: click the toolbar button *Practicum MCP*, paste the token, *Save &
   connect*. The badge turns green ("on") and an overlay appears in Practicum tabs.

4. **Pick a mode** in the same popup (see [Modes](#modes)). For MCP mode, connect a client, e.g. Claude Code:
   ```sh
   claude mcp add --transport http practicum http://127.0.0.1:8766/mcp
   ```
   Clients that only launch stdio servers can run `uv run --directory bridge
   practicum-bridge --stdio` instead. Only one bridge can own the extension port at
   a time.

For a quick manual test without a client: `cd bridge && uv run practicum-call` lists
the tools, `uv run practicum-call where_am_i` calls one.

## Modes

The toolbar popup (and the sidebar's header) switches between two modes.

- **MCP**: a plain MCP server. Your MCP client drives. A small overlay in the corner of the
  Practicum tab shows the running tool, the log, **Stop** and **Approve / Deny**.
- **Agent chat**: the bridge runs the agent itself, and you talk to it in the browser's
  **sidebar**. Choosing *Agent chat* (or *Open sidebar*) in the popup opens the sidebar; so do
  **Alt+Shift+P** (change it in `about:addons` → ⚙ → *Manage Extension Shortcuts*), the
  Practicum icon in the browser's sidebar launcher, and *View → Sidebar → Practicum*. Everything moves there, approvals included, and the overlay
  stays hidden while a sidebar is open.

The sidebar shows the session as one timeline, like Claude Code's side panel:
- your messages;
- the model's thinking, as collapsible "Thought for N s" blocks, live while it streams;
- its replies;
- every tool call, as a collapsible row with arguments, progress steps and the result
  (calls from an outside MCP client carry an `mcp` badge);
- the driver's notes.

At the bottom are the approval card, the agent's questions (candidate answers, a field,
*Leave it*) and the message box:
- **Enter** sends, **Shift+Enter** starts a new line.
- **Stop** (or **Esc**) ends the run.
- Messages sent during a run wait for it to finish.
- *New chat* starts over.
- `/continue` lets the model go on after the round limit.

The header picks the model: any installed Ollama model, or Практикум ИИ. It also sets the
reasoning effort.

```sh
uv run --directory bridge practicum-bridge --model gpt-oss-32k   # default model for agent mode
```

- Without `--model`, the bridge uses the sidebar's choice, or else the first installed model.
- Nothing runs until your first message: that is when the agent reads the page.
- The full record goes to `~/.config/practicum-mcp/agent.log` (`--agent-log`).
- Models that reason inside `<think>…</think>` tags get that text shown as thinking too.
- MCP clients keep working in agent mode; their calls queue with the agent's.

## Tools

| Tool | What it does | Effect |
|---|---|---|
| `where_am_i` | current page, lesson/task, solved state, buttons available | read |
| `get_progress` | courses → topics → lessons with solved marks, numbered like `5.1.3` | read |
| `read_lesson` | a lesson as text, quizzes as `q1`, `q2`… with numbered options; answer keys stripped | read |
| `read_task`, `get_code` | trainer task, files, hints count; live editor content | read |
| `open_lesson`, `go_home`, `next_task` | navigation (opening a lesson marks it visited) | nav |
| `complete_lesson` | "К следующему уроку" / "Перейти к заданию" | **asks first** |
| `press_action_button`, `answer_quiz` | theory buttons and quizzes (`"2"`, `"1, 3"`, `"1=B; 2=A"`, free text) | **asks first** |
| `run_code_exercise` | run a code block inside a theory lesson, optionally with new code | reversible |
| `check_code_exercise`, `reset_code_exercise` | submit a graded code block; start a block over | **asks first** |
| `set_code` | replace a file in the editor (undo with Ctrl+Z) | reversible |
| `run_code`, `deploy`, `fetch_preview` | run Python, deploy a Django project, read its pages | reversible / read |
| `check_task` | submit for checking (an attempt) | **asks first** |
| `show_hint` | next hint of the task | read |
| `ask_platform_ai`, `reset_platform_ai_chat` | ask Практикум ИИ in the lesson's chat; start a new chat | **asks first** |

The tool list is defined once in [`shared/tools.json`](shared/tools.json), and the
descriptions there are written for small models. Errors carry a kind: `platform`
(the site's own failures, retried automatically and worth retrying later), `denied`
(you said no), `stopped`, `timeout`, `no_tab`, `tool`.

## Letting Практикум ИИ drive

`uv run --directory bridge practicum-platform-agent "<task>"` lets the site's own assistant use
the tools through its chat: it gets the tool list and the task, replies with
`CALL {"tool": …, "args": …}` lines, the driver runs them and sends the results back until the
assistant writes `ANSWER: …`. The lesson's AI chat is reset first (`--keep-chat` to skip). At most
one action runs per round; every chat message and every action still needs your approval in the
overlay. The platform keeps one chat per lesson, so after a page change the driver repeats the
instructions.

## Local models (Ollama)

`uv run --directory bridge practicum-local-agent --model gpt-oss-32k [--think low] "<task>"` runs the
same loop with a local model through Ollama's `/api/chat`; the conversation is kept by the driver,
and the model may consult Практикум ИИ via `ask_platform_ai`. Ollama's default context is 4k, which
cuts off the tool list: use a variant from [`models/`](models/) or `--num-ctx 32768`.

Local models don't use Практикум ИИ's text protocol. They get real tool definitions and their own
English system prompt, `LOCAL_SYSTEM` in
[`bridge/src/practicum_bridge/prompts.py`](bridge/src/practicum_bridge/prompts.py); `/prompt` in
the chat shows it. It sets out the trainer workflow:
- read the exact paths from `read_task`;
- `set_code` always gets the complete file;
- verify with `deploy` + `fetch_preview` or `run_code` before `check_task`.

The first message also carries the current page. Compared with the shared prompt on the simulated
task, it needed fewer checks per run (1.5 vs 1.8) and solved 22/24 runs vs 21/24. gpt-oss makes
one tool call per reply, so local runs default to 30 rounds.

## Chatting with the agent in a terminal

The sidebar (agent mode) is the main way to chat. In MCP mode,
`uv run --directory bridge practicum-chat --model gpt-oss-32k [--think low]` (or `--platform` for
Практикум ИИ) opens the same chat in a terminal; the sidebar shows it, too, and takes its messages.
In agent mode the bridge refuses it, because only one agent runs at a time. Each message runs the agent until the
model answers in text, and the conversation carries over to the next message. Tool calls show as
short `▸ tool(args)` lines with clipped results, and local models stream their replies. The full
record goes to `chat.log`.

- **Ctrl+C** stops the current run; a running tool is cancelled in the browser too.
- **Ctrl+D** or `/quit` exits.
- `/call TOOL {json}` runs a tool yourself; the model hears about it with your next message.
- `/continue` lets the model go on after the round limit.
- `/clear` starts over.
- `/help` lists the rest: `/where`, `/tools`, `/rounds`, `/verbose`, `/model`, `/think`, `/temp`.

The driver refuses three kinds of repeats:
- a call that has failed twice with the same error;
- a read that has returned the same result twice in a row;
- a check when nothing changed since the last failed check (each check is a recorded attempt).

After three refusals it stops the run. A new message lifts both this stop and the stop after
repeated failed checks. Once a local model's context is 75%
full, older messages are cut harder; the token readout shows `prompt N/context`.

## Testing agents offline

`bridge/evals/` runs the real agent loop (the same `Session` and Ollama backend) against
simulated Practicum pages. Nothing reaches the account.

1. `node scripts/inspect/scrape-lessons.mjs` saves the raw JSON of every accessible lesson to
   `bridge/evals/raw/`. It's read-only: the same `GET /api/lessons/{id}/` that `read_lesson` makes.
2. `uv run --directory bridge python evals/make_scenarios.py` builds `bridge/evals/scenarios/`:
   - **theory lessons:** the shortest lessons for each block type (single choice, multiple choice,
     matching, cards, macaroni, free text, chat quiz, graded code, buttons), plus a lesson with
     nothing to answer and one with only buttons;
   - **trainer tasks:** the three tasks of lesson 5.2.3, which include creating new files;
   - **journeys:** several pages in a row, including the full «Пути и view-функции» topic
     (two theory lessons, four trainer tasks). These test moving between lessons and tasks.
3. `uv run --directory bridge python evals/tune.py $(ls -d bridge/evals/scenarios/*/)` runs the
   model on them and prints a table per scenario.
   - `--temps` and `--repeats` sweep sampling; `--system-file` compares prompts.
   - Every run's transcript is saved.

How the simulator works:
- **Rendering:** `read_lesson`, block lookup and answer parsing are the extension's own code
  (`lesson_helper.ts`, run through node).
- **Quizzes** are graded with the answer keys in the lesson JSON.
- **Code exercises** run the platform's own tests through `testlib_shim.py`, a local stand-in for
  its test library. `check_testlib_shim.py` checks it: the reference solution must pass and the
  starter code must fail.
- **Trainer checks** run the project with Django.

`uv run --directory bridge pytest` includes `tests/test_sims.py`, which replays every scraped
lesson with its key answers and walks every scenario with known solutions. It's skipped without
the scraped data. The scraped lessons, scenarios and solutions are course material and are not
committed.

## Installing the extension permanently

`npm run package` builds `extension/practicum-mcp-<version>.xpi` (no token, no dev tools). Waterfox
installs it from `about:addons` → *Install Add-on From File…* after setting
`xpinstall.signatures.required = false`; release Firefox needs a signed build (or use
`about:debugging` for a temporary load). Paste the token from `~/.config/practicum-mcp/token` into
the toolbar popup.

## Staying in control

- **Overlay** (bottom right of every Practicum tab, MCP mode): the running tool, the step
  log, **Stop**, and **Approve / Deny** for actions that change your account. In agent mode the
  **sidebar** shows all of this. Either way, each element is highlighted before it is clicked
  or typed into.
- **Toolbar popup**: connection state, recent log, *Stop all actions*, and the
  "Ask me before irreversible actions" switch (on by default).
- Tools run one at a time. Stop cancels the running one and everything queued. If
  the bridge disconnects, everything stops.
- Never automated: the sprint feedback survey (it's your opinion), topic reset,
  starting a new AI chat, ratings.

## Development

```sh
npm run typecheck && npm test                 # extension: tsc + vitest
(cd bridge && uv run pytest)                  # bridge
npm run build -- --dev                        # test build: dev_* tools + token baked in
node scripts/dev/install-ext.mjs              # install it into a browser started with
                                              #   --remote-debugging-port 9222 (WebDriver BiDi)
```

Never share a `--dev` build: it contains your token.

Layout:

```
shared/tools.json          tool specs (extension + bridge)
bridge/                    Python: WebSocket link + MCP server + the agent (host.py) (uv project)
extension/src/background/  link, queue/router, approvals, activity log, tool macros (tools/)
extension/src/content/     page access (Redux store, Monaco via wrappedJSObject), input, overlay, ops/
extension/src/sidebar/     the agent chat: timeline, approvals, message box
extension/src/shared/      protocol, transcript (the timeline), lesson renderer, answer parser
scripts/inspect/           probes used to map the site (BiDi + puppeteer-core)
docs/                      platform findings, action catalogue, scaffold plan, Chrome port notes
```

How the site works, and why the tools do what they do:
[`docs/platform-findings.md`](docs/platform-findings.md),
[`docs/actions.md`](docs/actions.md), [`docs/scaffold-plan.md`](docs/scaffold-plan.md).

### Known gaps

- Search, notes, ratings and the AI summary button have no tools.
- Firefox/Waterfox only. What a Chrome port would take: [`docs/chrome-port.md`](docs/chrome-port.md).
