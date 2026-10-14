# Scaffold plan: extension + Python MCP bridge

Status: **in progress.** Milestone 1 done (bridge, link, `where_am_i` end to end).

## 1. Shape

```
MCP client (Claude Code, small-LLM agent loop, …)
      │  MCP: streamable HTTP  http://127.0.0.1:8766/mcp   (or stdio)
      ▼
Python bridge (bridge/)            ── long-running process, binds loopback only
      ▲  WebSocket ws://127.0.0.1:8765, JSON messages, token auth
      │  (the extension dials out, because extensions can't listen on ports)
Firefox/Waterfox extension (extension/), MV2, persistent background
  background: link · queue · tab tracking · confirmations · log · tool macros
      │  runtime messages
  content script on practicum.yandex.ru: page ops (state, input, editor, HUD)
```

**Why the bridge runs long (HTTP) instead of being spawned per client (stdio):** the
extension needs a stable WebSocket listener. With stdio, each MCP client spawns its own
bridge, and two of them would fight over port 8765. `--stdio` stays available for a single
client like Claude Code, which can also connect to the HTTP URL directly.

## 2. Layout

```
shared/tools.json              tool specs: name, description, params, effect, timeout_s
                               (one source for the extension and the bridge)
extension/
  manifest.json                MV2, gecko id, host perms practicum.yandex.ru + *.serverhub…
  build.mjs                    esbuild → extension/dist/
  src/background/
    main.ts                    wiring
    link.ts                    WS client: hello+token, reconnect with backoff, heartbeat
    queue.ts                   one tool at a time, per-tool timeout, Stop = abort current + queued
    tabs.ts                    pick the practicum tab, survive full page loads
                               (wait tabs.onUpdated complete + content "ready")
    confirm.ts                 irreversible tools ask the user in the HUD (Approve / Deny)
    log.ts                     ring buffer of actions → HUD and popup
    tools/{nav,lesson,quiz,trainer,ai}.ts   macros: read → act → verify
  src/content/
    main.ts                    op dispatcher, "ready" message on load
    page.ts                    page access via wrappedJSObject: Redux store (fiber walk
                               from #mount), history, monaco; clone page data out safely
    input.ts                   press(el): scroll, highlight, pointer/mouse/click sequence at
                               the element centre (react-aria needs it); setText(el, text):
                               native setter + input event; "visible modal only" rule
    wait.ts                    waitFor(condition, timeout, abortSignal)
    hud.ts                     shadow-DOM overlay: current action, last N log lines,
                               Stop button, confirm prompt, highlight box on the target
    ops/*.ts                   page-level ops the background macros call
  src/popup/                   connection status, bridge URL, token, confirm toggle, Stop
bridge/src/practicum_bridge/
  __main__.py                  CLI: --ws-port 8765 --http-port 8766 | --stdio
  link.py                      WS server: one extension at a time, Origin = moz-extension://,
                               token check, request/response by id, disconnect → fail pending
  server.py                    mcp lowlevel Server (on_list_tools / on_call_tool),
                               tools from the extension's hello, else shared/tools.json;
                               tools/list_changed when the extension (re)connects
  config.py                    token in ~/.config/practicum-mcp/token (generated on first run)
```

`src/tools/` (drafts written before inspection): keep `coerceArgs` (lenient argument coercion
for small models) and the fiber helpers from `react.ts`, moved into the extension. Delete
`refs.ts` / `snapshot.ts`: the tools are semantic, so no generic element refs are needed.

## 3. Wire protocol (extension ⇄ bridge)

| Direction | Message |
|---|---|
| ext → bridge | `{"type":"hello","token","version","tools":[…specs]}` → `{"type":"welcome"}` or close 4401 |
| bridge → ext | `{"type":"call","id","tool","args"}` |
| bridge → ext | `{"type":"cancel","id"}` when the MCP request is cancelled or times out |
| ext → bridge | `{"type":"progress","id","text"}` (forwarded as MCP progress / log) |
| ext → bridge | `{"type":"result","id","ok":true,"output"}` or `{"ok":false,"error","kind"}` with kind `tool` · `platform` · `denied` · `stopped` · `timeout` · `no_tab` |
| — | liveness: WebSocket protocol pings (websockets default, 20 s); no app-level ping |

The MCP result is text. Errors return `isError: true` with a message the model can act on
(e.g. "platform error 400.py.checkTask after 3 retries, try again later", "user denied").

## 4. Tools, v1

Effects come from [actions.md](actions.md). `irrev` tools go through the confirmation
prompt (on by default, can be switched off in the popup).

| Tool | Args | Does | Effect | Catalogue |
|---|---|---|---|---|
| ✅ `where_am_i` | — | page kind, lesson/task, solved, which actions are available now (next, check, deploy, chat) | read | A, B |
| `get_progress` | `course?` | courses → topics → lessons with solved and ids (profile state, else API) | read | A3, A10 |
| `read_lesson` | `lesson_id?` | lesson as Markdown with block ids; quizzes with options and answered status, **answer keys stripped** | read | B1, B4 |
| `open_lesson` | `lesson_id` | navigate (full load if needed), wait until loaded | nav | A8, A1 |
| `go_home` | — | profile page | nav | A1 |
| `complete_lesson` | — | "К следующему уроку" / "Перейти к заданию", verify solved + new URL | irrev | A11, A12 |
| `press_action_button` | `block_id` | ActionButton, verify the following blocks appear | irrev | C1 |
| `answer_quiz` | `block_id`, `answer` | one flat string per quiz type: select `"opt1, opt2"` (texts or ids) · choice/cards/macaroni `"left=right; …"` · text as is; fills via UI, submits, returns the result shown | irrev | C2–C7 |
| `read_task` | — | trainer task text, files, hints count, solved | read | B3, E1 |
| `get_code` | `file?` | editor content | read | D1, E1 |
| `set_code` | `code`, `file?` | open the file if needed, replace content via Monaco | rev | D1, E2, E3 |
| `run_code` | — | serverless run, stdout/stderr; retries platform errors | rev | D2 |
| `check_task` | — | check, wait for the verdict, retry platform errors; `{solved, message}` | irrev | D3, E8 |
| `show_hint` | — | press hint, return the next hint text | read | D4 |
| `next_task` | `direction=next\|prev` | next/previous task or next lesson | nav | A13, A14 |
| `deploy` | — | web_server deploy, wait for running, return preview URL | rev | E4 |
| `fetch_preview` | `path="/"` | GET the deployed site | read | E5 |
| `ask_platform_ai` | `question` | open chat, type, send, wait for the streamed answer, return text + suggestions | irrev | F1–F3 |

Left out on purpose: survey (C8, user's opinion), topic reset (A17), new AI chat (F5),
ratings/notes (G), search (backend down). They can be added later.

## 5. Robustness and visibility rules (apply to every act tool)

1. Read from state or API, act through the real UI, verify through state.
2. Before each input: scroll into view, draw the highlight box with the action name, log it,
   wait ~300 ms so the user sees it.
3. Every wait has a timeout and the Stop signal; nothing waits forever.
4. One tool at a time (queue). Stop aborts the current tool and drops the queue.
5. Platform errors (`400 PY.*`, `400.py.runCode`, `408.previewTimeout`, 5xx) → retry with
   backoff (3 tries), reported as `platform`, never as "wrong solution".
6. Full page loads (profile ⇄ /learn ⇄ /trainer): the macro in the background waits for the
   new content script before verifying.
7. Only click confirm buttons inside `.skills-modal_visible`.
8. Selectors live in one file (`content/selectors.ts`) so a site change is a one-file fix.

## 6. Security

- Both bridge ports bind 127.0.0.1 only.
- WebSocket: `Origin` must start with `moz-extension://`, and the first message must carry
  the token. The bridge generates the token on first run and prints it; you paste it into
  the popup once.
- MCP HTTP: DNS-rebinding protection (allowed Host `127.0.0.1:8766` / `localhost:8766`).

## 7. Testing

- **Bridge (pytest):** a fake extension client, covering hello/auth reject, call round trip,
  extension disconnect fails the pending call, and tool list fallback.
- **Extension pure logic (vitest + jsdom):** argument coercion, lesson → Markdown renderer,
  answer key stripping, answer string parsing.
- **Live:** `scripts/dev/install-ext.mjs` installs the build as a temporary add-on through BiDi
  `webExtension.install` (no signing needed), starts the bridge, and calls tools through a
  small MCP client script. **Read-only tools are tested automatically. Every write tool is
  tested only after you approve it,** like during inspection.

## 8. Milestones

1. Bridge + protocol + extension link + `where_am_i` end to end (MCP client → bridge →
   extension → page → back).
2. Framework: queue, HUD (log, highlight, Stop), confirmations, popup, tab tracking across
   full page loads.
3. Read tools: `get_progress`, `read_lesson`, `read_task`, `get_code`.
4. Navigation + theory: `open_lesson`, `go_home`, `complete_lesson`, `press_action_button`,
   `answer_quiz`.
5. Trainer: `set_code`, `run_code`, `check_task`, `show_hint`, `next_task`, `deploy`,
   `fetch_preview`.
6. `ask_platform_ai`.
7. README: how to run the bridge, load the extension, and connect an MCP client.

Each milestone ends with a live check before the next one starts.
