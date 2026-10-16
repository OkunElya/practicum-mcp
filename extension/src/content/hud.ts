/**
 * On-page overlay for MCP mode: the running tool, the tool log, a Stop button, and
 * at the bottom what needs the user (approval prompts, a connected agent's
 * questions). In agent mode the sidebar shows all of that and the overlay stays
 * hidden while a sidebar is open. Also draws a highlight box around the element
 * about to be used (in both modes). Lives in a closed shadow root so page styles
 * can't break it (and vice versa).
 */
import type { AgentState, AgentView, HudRequest, HudState, LogLevel } from '../shared/hud';

const CSS = `
:host { all: initial; }
.hud { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 360px; max-width: calc(100vw - 32px);
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
.state { display: flex; gap: 6px; align-items: baseline; font-weight: 600; margin-bottom: 4px; }
.state small { font-weight: 400; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state.thinking, .state.acting { color: var(--run); } .state.waiting_user { color: var(--ask); }
.state.done { color: var(--ok); } .state.stopped { color: var(--err); } .state.idle { color: var(--muted); }
.state.thinking .icon { animation: pulse 1s infinite; }
input { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 5px; padding: 4px 6px; box-sizing: border-box; flex: 3; min-width: 0; }
.hint { color: var(--muted); margin-bottom: 6px; }
.question { margin-top: 6px; padding: 6px; border-radius: 6px; background: color-mix(in srgb, var(--ask) 15%, transparent); }
.question p { margin: 0 0 4px; font-weight: 600; }
.question pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 140px; overflow: auto; font: inherit; }
.cands { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.cands button { flex: none; }
.box { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid var(--run); border-radius: 4px;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--run) 25%, transparent); transition: opacity .3s; --run: #1a5fb4; }
.box span { position: absolute; left: -2px; bottom: 100%; margin-bottom: 2px; background: var(--run); color: #fff;
  font: 11px/1.3 system-ui, sans-serif; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
`;

let root: ShadowRoot | null = null;
let collapsed = true;
let last: HudState | null = null;
// What the user is typing survives re-renders (the whole overlay is redrawn on every change).
let answerDraft = '';

const STATE: Record<AgentState, [string, string]> = {
  idle: ['·', 'idle'],
  thinking: ['💭', 'thinking'],
  acting: ['▶', 'working'],
  waiting_user: ['⏳', 'waiting for you'],
  done: ['✓', 'done'],
  stopped: ['■', 'stopped'],
};

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

function agentLine(a: AgentView): HTMLElement {
  const [icon, word] = STATE[a.state] ?? ['·', a.state];
  const st = el('div', `state ${a.state}`);
  st.append(el('span', 'icon', icon), el('span', '', `${a.name}: ${word}`), el('small', '', a.text));
  return st;
}

function questionBox(q: NonNullable<AgentView['question']>): HTMLElement {
  const box = el('div', 'question');
  box.append(el('p', '', `The agent isn't sure about ${q.ref} — your answer?`), el('pre', '', q.text));
  const answer = (text: string | null) => {
    answerDraft = '';
    send({ target: 'background', type: 'agent_answer', id: q.id, text });
  };
  if (q.candidates.length) {
    const cands = el('div', 'cands');
    for (const c of q.candidates) {
      const b = el('button', '', c);
      b.title = 'Answer with this';
      b.addEventListener('click', () => answer(c));
      cands.append(b);
    }
    box.append(cands);
  }
  const row = el('div', 'row');
  const input = el('input');
  input.placeholder = 'Your answer (as for answer_quiz)';
  input.value = answerDraft;
  input.dataset.keep = 'answer';
  input.addEventListener('input', () => (answerDraft = input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) answer(input.value.trim());
  });
  const ok = el('button', 'approve', 'Answer');
  ok.style.flex = 'none';
  ok.addEventListener('click', () => input.value.trim() && answer(input.value.trim()));
  const leave = el('button', '', 'Leave it');
  leave.style.flex = 'none';
  leave.addEventListener('click', () => answer(null));
  row.append(input, ok, leave);
  box.append(row);
  return box;
}

export function renderHud(state: HudState): void {
  last = state;
  const r = ensureRoot();
  // Keep focus and the caret in whatever the user was typing into.
  const focused = r.activeElement as HTMLInputElement | null;
  const keep = focused?.dataset?.keep;
  const caret = keep ? [focused!.selectionStart, focused!.selectionEnd] : null;
  r.querySelector('.hud')?.remove();
  // Agent mode: the sidebar shows everything, approvals included.
  if (state.mode === 'agent' && state.sidebar) return;

  const a = state.agent;
  const agentBusy = !!a && (a.state === 'thinking' || a.state === 'acting' || a.state === 'waiting_user' || !!a.question);
  const busy = !!state.current || !!state.confirm || agentBusy;
  const box = el('div', 'hud');
  if (!state.connected && !busy) box.classList.add('hidden');
  if (state.confirm || a?.question) box.classList.add('ask');
  if (collapsed && !busy && !keep) box.classList.add('collapsed');

  const header = el('header');
  const dot = el('span', `dot ${busy ? 'busy' : state.connected ? 'on' : ''}`);
  header.append(dot, el('span', 'title', 'Practicum MCP'));
  let current = state.current ? `▶ ${state.current}${state.queued ? ` (+${state.queued} queued)` : ''}` : state.connected ? 'idle' : 'bridge not connected';
  if (state.confirm) current = '⏳ approve or deny below';
  else if (a?.question) current = `⏳ ${a.question.ref}: your answer is needed`;
  else if (a && !state.current) current = `${STATE[a.state]?.[0] ?? ''} ${STATE[a.state]?.[1] ?? a.state}${a.text ? ` · ${a.text}` : ''}`;
  header.append(el('span', 'current', current));
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    if (last) renderHud(last);
  });
  box.append(header);

  const body = el('div', 'body');
  if (state.mode === 'agent') body.append(el('div', 'hint', 'Agent mode: open the Practicum sidebar (toolbar button → Agent) to chat with the agent.'));
  if (a) body.append(agentLine(a));
  const list = el('ol');
  for (const e of state.entries) {
    const li = el('li', e.level satisfies LogLevel);
    li.append(el('time', '', new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })), document.createTextNode(e.text));
    list.append(li);
  }
  body.append(list);

  // What needs the user goes last, right under the tool calls.
  if (a?.question) body.append(questionBox(a.question));
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
  if (state.current || state.confirm) {
    const row = el('div', 'row');
    const stop = el('button', 'stop', 'Stop');
    stop.addEventListener('click', () => send({ target: 'background', type: 'stop' }));
    row.append(stop);
    body.append(row);
  }
  box.append(body);
  r.append(box);
  list.scrollTop = list.scrollHeight;
  if (keep) {
    const again = r.querySelector<HTMLInputElement>(`[data-keep="${keep}"]`);
    if (again) {
      again.focus();
      if (caret) again.setSelectionRange(caret[0], caret[1]);
    }
  }
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
