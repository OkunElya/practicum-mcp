/**
 * On-page overlay: what the agent is doing, the recent log, a Stop button,
 * approval prompts, and a highlight box around the element about to be used.
 * Lives in a closed shadow root so page styles can't break it (and vice versa).
 */
import type { HudRequest, HudState, LogLevel } from '../shared/hud';

const CSS = `
:host { all: initial; }
.hud { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 320px; max-width: calc(100vw - 32px);
  font: 12px/1.4 system-ui, sans-serif; color: var(--fg); background: var(--bg); border: 1px solid var(--line);
  border-radius: 8px; box-shadow: 0 4px 18px #0003; overflow: hidden; }
.hud { --bg: #fff; --fg: #222; --muted: #777; --line: #ccc; --run: #1a5fb4; --ok: #2a8a2a; --err: #c33; --ask: #b5730a; }
@media (prefers-color-scheme: dark) { .hud { --bg: #23252b; --fg: #e8e8e8; --muted: #999; --line: #444; --run: #78aeed; --ok: #6c6; --err: #f77; --ask: #e5a50a; } }
.hud.hidden { display: none; }
.hud.ask { border-color: var(--ask); box-shadow: 0 0 0 2px var(--ask), 0 4px 18px #0003; }
header { display: flex; align-items: center; gap: 6px; padding: 6px 8px; cursor: pointer; user-select: none; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.on { background: var(--ok); }
.dot.busy { background: var(--run); animation: pulse 1s infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.title { font-weight: 600; flex: none; }
.current { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.body { border-top: 1px solid var(--line); padding: 6px 8px; }
.collapsed .body { display: none; }
ol { list-style: none; margin: 0; padding: 0; max-height: 160px; overflow: auto; }
li { padding: 1px 0; overflow-wrap: anywhere; }
li.run { color: var(--run); } li.ok { color: var(--ok); } li.error { color: var(--err); } li.ask { color: var(--ask); }
li time { color: var(--muted); margin-right: 4px; font-variant-numeric: tabular-nums; }
.confirm { margin-top: 6px; padding: 6px; border-radius: 6px; background: color-mix(in srgb, var(--ask) 15%, transparent); }
.confirm p { margin: 0 0 6px; font-weight: 600; overflow-wrap: anywhere; }
.row { display: flex; gap: 6px; margin-top: 6px; }
button { flex: 1; font: inherit; padding: 4px 6px; border-radius: 5px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
button.stop { border-color: var(--err); color: var(--err); font-weight: 600; }
button.approve { border-color: var(--ok); color: var(--ok); font-weight: 600; }
button.deny { border-color: var(--err); color: var(--err); }
.box { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid var(--run); border-radius: 4px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--run) 25%, transparent); transition: opacity .3s; --run: #1a5fb4; }
.box span { position: absolute; left: -2px; bottom: 100%; margin-bottom: 2px; background: var(--run); color: #fff;
  font: 11px/1.3 system-ui, sans-serif; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
`;

let root: ShadowRoot | null = null;
let collapsed = true;
let last: HudState | null = null;

function ensureRoot(): ShadowRoot {
  if (root?.host.isConnected) return root;
  // A previous instance of the extension (reloaded during development) leaves its HUD behind.
  for (const old of document.querySelectorAll('practicum-mcp-hud')) old.remove();
  const host = document.createElement('practicum-mcp-hud');
  document.documentElement.append(host);
  root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.append(style);
  return root;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function send(msg: HudRequest): void {
  void browser.runtime.sendMessage(msg).catch(() => {});
}

export function renderHud(state: HudState): void {
  last = state;
  const r = ensureRoot();
  r.querySelector('.hud')?.remove();
  const busy = !!state.current || !!state.confirm;
  const box = el('div', 'hud');
  if (!state.connected && !busy) box.classList.add('hidden');
  if (state.confirm) box.classList.add('ask');
  if (collapsed && !busy) box.classList.add('collapsed');

  const header = el('header');
  const dot = el('span', `dot ${busy ? 'busy' : state.connected ? 'on' : ''}`);
  header.append(dot, el('span', 'title', 'Practicum MCP'));
  const current = state.current ? `▶ ${state.current}${state.queued ? ` (+${state.queued} queued)` : ''}` : state.connected ? 'idle' : 'bridge not connected';
  header.append(el('span', 'current', current));
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    if (last) renderHud(last);
  });
  box.append(header);

  const body = el('div', 'body');
  const list = el('ol');
  for (const e of state.entries) {
    const li = el('li', e.level satisfies LogLevel);
    li.append(el('time', '', new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), document.createTextNode(e.text));
    list.append(li);
  }
  body.append(list);

  if (state.confirm) {
    const c = el('div', 'confirm');
    c.append(el('p', '', state.confirm.text));
    const row = el('div', 'row');
    const yes = el('button', 'approve', 'Approve');
    const no = el('button', 'deny', 'Deny');
    const id = state.confirm.id;
    yes.addEventListener('click', () => send({ target: 'background', type: 'confirm', id, approved: true }));
    no.addEventListener('click', () => send({ target: 'background', type: 'confirm', id, approved: false }));
    row.append(yes, no);
    c.append(row);
    body.append(c);
  }
  if (busy) {
    const row = el('div', 'row');
    const stop = el('button', 'stop', 'Stop');
    stop.addEventListener('click', () => send({ target: 'background', type: 'stop' }));
    row.append(stop);
    body.append(row);
  }
  box.append(body);
  r.append(box);
  list.scrollTop = list.scrollHeight;
}

/** Draw a labelled box around `target` for `ms`, so the user sees what is about to be used. */
export function highlight(target: Element, label: string, ms = 900): void {
  const r = ensureRoot();
  const rect = target.getBoundingClientRect();
  const box = el('div', 'box');
  Object.assign(box.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  box.append(el('span', '', label));
  r.append(box);
  setTimeout(() => {
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 350);
  }, ms);
}

/** Ask the background for the current state (after a page load). */
export function initHud(): void {
  void browser.runtime
    .sendMessage({ target: 'background', type: 'hud' } satisfies HudRequest)
    .then((s: HudState) => s && renderHud(s))
    .catch(() => {});
}
