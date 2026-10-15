can you # Practicum MCP

Lets an MCP client (Claude Code, a small local LLM agent, …) study on
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

4. **Connect a client**, e.g. Claude Code:
   ```sh
   claude mcp add --transport http practicum http://127.0.0.1:8766/mcp
   ```
   Clients that only launch stdio servers can run `uv run --directory bridge
   practicum-bridge --stdio` instead. Only one bridge can own the extension port at
   a time.

For a quick manual test without a client: `cd bridge && uv run practicum-call` lists
the tools, `uv run practicum-call where_am_i` calls one.

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

## Chatting with the agent

`uv run --directory bridge practicum-chat --model gpt-oss-32k [--think low]` (or `--platform` for
Практикум ИИ) opens an interactive chat over the same loop. Each message runs the agent until the
model answers in text, and the conversation carries over to the next message. Tool calls show as
short `▸ tool(args)` lines with clipped results, and local models stream their replies. The full
record goes to `chat.log`.

- **Ctrl+C** stops the current run; a running tool is cancelled in the browser too.
- **Ctrl+D** or `/quit` exits.
- `/call TOOL {json}` runs a tool yourself; the model hears about it with your next message.
- `/continue` lets the model go on after the round limit.
- `/clear` starts over.
- `/help` lists the rest: `/where`, `/tools`, `/rounds`, `/verbose`, `/model`, `/think`, `/temp`.

If the same call fails twice with the same error, the driver refuses to run it again. After
three refusals it stops the run. A new message lifts both this stop and the stop after
repeated failed checks. Once a local model's context is 75%
full, older messages are cut harder; the token readout shows `prompt N/context`.

## Tuning local models offline

`uv run --directory bridge python evals/tune.py evals/scenarios/<name> --temps 0,0.2,0.5,1 --repeats 6`
runs the real agent loop against a simulated trainer task. Nothing reaches the account:
- File tools work on a temp copy of the project.
- `check_task` and `fetch_preview` run the project with Django.

A scenario directory holds a captured task: `task.txt`, `lesson.txt` and `where.txt` (outputs of
`read_task`, `read_lesson` and `where_am_i`), `files/` (the project), and `checks.json` (the pages
and texts the checker expects).

The tool writes a table of solved runs, checks, rounds and tool errors per temperature, plus
transcripts of every run. Scenarios contain course material and are not committed.

## Installing the extension permanently

`npm run package` builds `extension/practicum-mcp-<version>.xpi` (no token, no dev tools). Waterfox
installs it from `about:addons` → *Install Add-on From File…* after setting
`xpinstall.signatures.required = false`; release Firefox needs a signed build (or use
`about:debugging` for a temporary load). Paste the token from `~/.config/practicum-mcp/token` into
the toolbar popup.

## Staying in control

- **Overlay** (bottom right of every Practicum tab): the running tool, the step log,
  **Stop**, and **Approve / Deny** for actions that change your account. Each element
  is highlighted before it is clicked or typed into.
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
bridge/                    Python: WebSocket link + MCP server (uv project)
extension/src/background/  link, queue/router, approvals, activity log, tool macros (tools/)
extension/src/content/     page access (Redux store, Monaco via wrappedJSObject), input, overlay, ops/
extension/src/shared/      protocol, lesson renderer, answer parser
scripts/inspect/           probes used to map the site (BiDi + puppeteer-core)
docs/                      platform findings, action catalogue, scaffold plan
```

How the site works, and why the tools do what they do:
[`docs/platform-findings.md`](docs/platform-findings.md),
[`docs/actions.md`](docs/actions.md), [`docs/scaffold-plan.md`](docs/scaffold-plan.md).

### Known gaps

- Search, notes, ratings and the AI summary button have no tools.
