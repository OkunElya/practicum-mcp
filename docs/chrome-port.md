# Chrome support: what a port would take

Status: **not started**. This is an assessment, written on 2026-10-16 against extension 0.2.2
(commit `14b039a`). Line numbers may have moved since; the file names are what matter.

The extension targets Firefox/Waterfox: Manifest V2, a persistent background page, the
`sidebar_action` sidebar and Firefox's Xray access to page objects.

**Verdict:** a medium port, about 2–4 days of focused work, with no redesign.
- **Unchanged:** the bridge, the agent and the tool specs.
- **Real work, in three areas:**
  - reaching the page's own objects;
  - the MV3 service worker;
  - the side panel.
- **Mechanical:** everything else.

## Hard parts

### 1. Reaching the page's own objects (largest)

The content script uses Firefox-only Xray helpers to reach the site's JavaScript objects:
- `wrappedJSObject`
- `cloneInto`
- `XPCNativeWrapper`

They give it the Redux store, React fibers, the Monaco and CodeMirror editors, and
page-native events. The globals are declared in `extension/src/content/globals.d.ts`.

| File | What it reaches |
|---|---|
| `content/page.ts` | `pageWindow()`, the Redux store through `#mount` |
| `content/react.ts` | React fibers and props (already falls back when `wrappedJSObject` is undefined, as in a MAIN-world script) |
| `content/input.ts` | page-native events built with the page's constructors (`cloneInto` for the init dicts) |
| `content/ops/trainer.ts` | Monaco: `XPCNativeWrapper` for the editor DOM, `cloneInto` for the edits passed to `executeEdits` |
| `content/ops/coding.ts` | CodeMirror instance on the element |

Chrome's content scripts live in an isolated world, with no way to reach page objects.
The fix:
- Add a second script that runs in the page itself: a manifest content script with
  `"world": "MAIN"`, or `chrome.scripting.executeScript({ world: 'MAIN' })`.
- Move the page-object code into it.
- Have the content script call it over `window.postMessage` or `CustomEvent`s: request id
  in, JSON result out.
- Only plain data can cross, so return what the ops already return, not live objects.

DOM-only work stays in the content script as is: reading the page, clicking,
highlighting, the overlay.

This is the riskiest part. Verify it first on a real trainer task (`set_code` into
Monaco) and a quiz, before porting anything else.

### 2. Background becomes a service worker

Chrome only takes Manifest V3, whose background is a service worker that is stopped when
idle. The background (`background/main.ts`) keeps a lot in memory:
- the WebSocket to the bridge (`link.ts`);
- the call queue and the AbortControllers behind Stop (`router.ts`);
- pending approvals with their 2-minute timers (`activity.ts`);
- the sidebar's timeline (`shared/transcript.ts`).

What's needed:
- **Keepalive:** since Chrome 116, WebSocket traffic keeps the worker alive, but only
  with messages flowing regularly. The extension should send a small app-level message
  about every 20 s; the bridge can ignore it.
- **The timeline:** mirror it to `chrome.storage.session`, so the sidebar's history
  survives a restart of the worker.
- **A restart:** must behave like a bridge reconnect. Calls cut off mid-way already fail
  as `disconnected` (`link.py`), and the bridge replays the agent's hello, status and
  models to a reconnecting extension. So mostly this needs testing, not new code.

### 3. Sidebar becomes Chrome's side panel

| Firefox | Chrome (114+, `open()` 116+) |
|---|---|
| `sidebar_action` in the manifest | `side_panel: { default_path: 'sidebar.html' }` + `sidePanel` permission |
| `browser.sidebarAction.open()` (`popup/popup.ts`) | `chrome.sidePanel.open({ windowId })`; also needs a user gesture |
| `_execute_sidebar_action` command (Alt+Shift+P) | no equivalent: a custom command that calls `sidePanel.open`, or `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` |

`sidebar/sidebar.html` and `sidebar/sidebar.ts` stay the same.

## Mechanical changes

- **Manifest:** a separate one for Chrome; keep Firefox on MV2 so nothing there changes.
  - `manifest_version: 3`;
  - `action` instead of `browser_action`;
  - `host_permissions` split out of `permissions`;
  - add `scripting` (and `sidePanel`);
  - drop `browser_specific_settings.gecko`;
  - background `service_worker`.
- **APIs:** about 25 `browser.*` calls. Use `webextension-polyfill` or a small alias; MV3
  `chrome.*` already returns promises. Renames:
  - `browserAction.*` → `action.*` (badge and title in `main.ts`);
  - `tabs.executeScript` → `scripting.executeScript` (`background/page.ts`, where the
    content script is re-injected);
  - `sidebarAction` → `sidePanel`.
- **Build** (`extension/build.mjs`): a `--target chrome` flag that picks the manifest,
  emits the service worker and the MAIN-world script, and packs a `.zip` for the Chrome
  Web Store or an unpacked folder instead of the `.xpi`.
- **Bridge** (`bridge/src/practicum_bridge/link.py`, `_check_origin`): it only accepts
  `moz-extension://` origins. Also accept `chrome-extension://<id>`, preferably that exact
  id (a Chrome extension's id is fixed by its key). The `/agent` rule (no Origin header) is
  unaffected.
- **Dev tooling:**
  - `scripts/dev/install-ext.mjs` and `scripts/inspect/*` use WebDriver BiDi against
    Waterfox. For Chrome, use puppeteer's default protocol.
  - Recent official Chrome builds dropped the `--load-extension` switch. Automate against
    Chromium or Chrome for Testing; in everyday Chrome, use "Load unpacked" once.
  - `dev_open_sidebar_tab` works unchanged.

## What doesn't change

- **Python:** all of it except the origin check — the MCP server, `host.py`, `Session`,
  the lesson solver, prompts and evals.
- **Shared code:** `shared/tools.json`, `shared/transcript.ts`, `shared/lesson.ts`,
  `shared/answers.ts`, `shared/markdown.ts`, and their vitest tests.
- **The UI:** the sidebar and the overlay. It uses a closed shadow root and
  `color-mix()`, both fine in Chrome.
- **The tool macros** in `background/tools/*`, apart from how they reach the page.

## Order

1. A small compatibility layer (API alias, sidebar open) and the `--target chrome` build.
2. The MAIN-world split. Check `set_code` on a trainer task and `answer_quiz` on a theory
   lesson in Chrome before going on.
3. Service-worker keepalive and timeline persistence; test by stopping the worker from
   `chrome://serviceworker-internals` during a run.
4. The side panel, the bridge origin, dev tooling, a README section.
