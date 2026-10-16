/**
 * The sidebar, in the spirit of Claude Code's side panel: one timeline of the
 * session (your messages, the model's thinking and replies, every tool call with
 * its steps and result), and at the bottom what needs you (approvals, the agent's
 * questions) and the message box. In MCP mode it shows an outside client's calls.
 *
 * The background sends a snapshot on connect, then batches of changed items.
 * Items are keyed by id and redrawn only when their `rev` changes; open/closed
 * state of thinking and tool details survives redraws.
 */
import type { AgentState, HudRequest, HudState, ModelList, SidebarMessage } from '../shared/hud';
import { blocks } from '../shared/markdown';
import type { Item, QuestionItem, ThinkingItem, ToolItem } from '../shared/transcript';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../background/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const timeline = $('timeline');
const input = $<HTMLTextAreaElement>('input');
const modelSel = $<HTMLSelectElement>('model');
const thinkRange = $<HTMLInputElement>('think');
/** The slider's stops; '' (auto) leaves it to the model. */
const LEVELS = ['off', 'low', 'medium', 'high'] as const;
type Think = Settings['agent']['think'];

let settings: Settings = DEFAULT_SETTINGS;
let head: HudState | null = null;
let models: ModelList | null = null;
/** id -> [rev drawn, element] */
const drawn = new Map<string, [number, HTMLElement]>();
/** Details the user opened or closed by hand (id -> open). */
const opened = new Map<string, boolean>();
let answerDraft = '';

const STATE: Record<AgentState, string> = {
  idle: 'ready',
  thinking: 'thinking…',
  acting: 'working',
  waiting_user: 'waiting for you',
  done: 'done',
  stopped: 'stopped',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function send(msg: HudRequest): void {
  void browser.runtime.sendMessage(msg).catch(() => {});
}

function busy(): boolean {
  const s = head?.agent?.state;
  return !!head?.current || s === 'thinking' || s === 'acting' || s === 'waiting_user';
}

// ── timeline items ──────────────────────────────────────────────────────────

function markdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const b of blocks(text)) {
    if (b.kind === 'code') {
      frag.append(el('pre', '', b.text));
      continue;
    }
    const p = el('p');
    for (const s of b.spans) p.append(s.kind === 'text' ? document.createTextNode(s.text) : el(s.kind === 'code' ? 'code' : 'b', '', s.text));
    frag.append(p);
  }
  return frag;
}

/** A <details> whose open state is the user's choice once they toggled it. */
function details(id: string, cls: string, defaultOpen: boolean): HTMLDetailsElement {
  const d = el('details', cls);
  setOpen(d, opened.get(id) ?? defaultOpen);
  // "toggle" also fires for changes made here; only a click that differs from them is the user's choice.
  d.addEventListener('toggle', () => {
    if (d.open !== (d.dataset.open === '1')) {
      opened.set(id, d.open);
      d.dataset.open = d.open ? '1' : '';
    }
  });
  return d;
}

function setOpen(d: HTMLDetailsElement, open: boolean): void {
  d.dataset.open = open ? '1' : '';
  d.open = open;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Expanded while the model thinks (the text flows in), collapsed once it's done, unless the user chose. */
function thinkingEl(it: ThinkingItem): HTMLElement {
  const d = details(it.id, '', it.streaming);
  const sum = el('summary');
  sum.append(el('span', 'sum'));
  d.append(sum, el('div', 'body'));
  updateThinking(d, it);
  return d;
}

/** Updated in place while streaming: redrawing the block every batch made it jump. */
function updateThinking(d: HTMLDetailsElement, it: ThinkingItem): void {
  d.className = `thinking${it.streaming ? ' streaming' : ''}`;
  d.querySelector('.sum')!.textContent = it.streaming ? 'Thinking…' : `Thought${it.ms ? ` for ${seconds(it.ms)}` : ''}`;
  const body = d.querySelector<HTMLElement>('.body')!;
  const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  body.textContent = it.text.trim();
  setOpen(d, opened.get(it.id) ?? it.streaming);
  if (follow) body.scrollTop = body.scrollHeight;
}

const TOOL_ICON: Record<ToolItem['status'], string> = { queued: '○', approval: '⏳', running: '●', ok: '✓', error: '✗', denied: '⊘', stopped: '■' };

function argsLine(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ')
    .replace(/\s+/g, ' ');
}

function toolEl(it: ToolItem): HTMLElement {
  const d = details(it.id, `tool ${it.status}`, false);
  const sum = el('summary');
  const args = argsLine(it.args);
  sum.append(el('span', 'icon', TOOL_ICON[it.status]), el('span', 'name', it.name), el('span', 'sum args', args));
  if (it.source === 'mcp') sum.append(el('span', 'badge', 'mcp'));
  const meta = it.status === 'approval' ? 'needs approval' : it.status === 'queued' ? 'queued' : it.status === 'running' ? (it.steps.at(-1) ?? 'running') : it.ms ? seconds(it.ms) : it.status;
  sum.append(el('span', 'meta', meta.length > 40 ? `${meta.slice(0, 40)}…` : meta));
  d.append(sum);
  if (args) {
    d.append(el('div', 'label', 'Arguments'), el('pre', '', JSON.stringify(it.args, null, 2)));
  }
  if (it.approval) d.append(el('div', 'label', 'Approval'), el('div', '', it.approval));
  if (it.steps.length) {
    const ul = el('ul');
    for (const s of it.steps) ul.append(el('li', '', s));
    d.append(el('div', 'label', 'Steps'), ul);
  }
  if (it.result) d.append(el('div', 'label', it.status === 'ok' ? 'Result' : `Error${it.kind ? ` (${it.kind})` : ''}`), el('pre', 'result', it.result));
  return d;
}

function questionEl(it: QuestionItem): HTMLElement {
  const box = el('div', 'q');
  const state = it.open ? 'waiting for your answer' : it.answer === undefined ? 'no answer' : it.answer === null ? 'left to you' : `you answered «${it.answer}»`;
  box.append(el('span', 'who', `Question about ${it.ref}`), document.createTextNode(` — ${state}`));
  return box;
}

function noteEl(id: string, text: string): HTMLElement {
  const lines = text.trim().split('\n');
  if (lines.length <= 3) return el('div', 'note', text.trim());
  const d = details(id, 'note', false);
  const sum = el('summary');
  sum.append(el('span', 'sum', lines[0]));
  d.append(sum, el('div', 'body', lines.slice(1).join('\n')));
  return d;
}

function render(it: Item): HTMLElement {
  switch (it.type) {
    case 'user':
      return el('div', 'user', it.text);
    case 'text': {
      const d = el('div', `text${it.streaming ? ' streaming' : ''}`);
      d.append(markdown(it.text));
      return d;
    }
    case 'thinking':
      return thinkingEl(it);
    case 'tool':
      return toolEl(it);
    case 'note':
      return noteEl(it.id, it.text);
    case 'question':
      return questionEl(it);
  }
}

function atBottom(): boolean {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 40;
}

function upsert(items: Item[], dropped: string[]): void {
  const stick = atBottom();
  for (const id of dropped) {
    drawn.get(id)?.[1].remove();
    drawn.delete(id);
    opened.delete(id);
  }
  for (const it of items) {
    const prev = drawn.get(it.id);
    if (prev && prev[0] === it.rev) continue;
    if (prev && it.type === 'thinking') {
      updateThinking(prev[1] as HTMLDetailsElement, it);
      drawn.set(it.id, [it.rev, prev[1]]);
      continue;
    }
    const node = render(it);
    node.dataset.id = it.id;
    if (prev) prev[1].replaceWith(node);
    else timeline.append(node);
    drawn.set(it.id, [it.rev, node]);
  }
  timeline.querySelector('.empty')?.remove();
  if (!drawn.size) timeline.append(emptyState());
  if (stick) timeline.scrollTop = timeline.scrollHeight;
}

function emptyState(): HTMLElement {
  const text =
    settings.mode === 'agent'
      ? 'Tell the agent what to do on Practicum, e.g. «пройди текущий урок» or «где я?». Irreversible actions wait for your approval here.'
      : 'MCP mode: tool calls from your MCP client (Claude Code, …) show up here. Switch to Agent to chat.';
  return el('div', 'empty', text);
}

// ── header, dock ────────────────────────────────────────────────────────────

function renderHeader(): void {
  $('mode-mcp').setAttribute('aria-pressed', String(settings.mode === 'mcp'));
  $('mode-agent').setAttribute('aria-pressed', String(settings.mode === 'agent'));
  $('dot').className = `dot ${busy() ? 'busy' : head?.connected ? 'on' : ''}`;
  $('dot').title = head?.connected ? 'bridge connected' : 'bridge not connected';

  const status = $('status');
  const a = head?.agent;
  status.replaceChildren();
  if (!head?.connected) status.append('Bridge not connected — start it: uv run practicum-bridge');
  else if (a) {
    status.className = `status ${a.state}`;
    status.append(el('b', '', `${a.name}: ${STATE[a.state] ?? a.state}`), a.text ? ` · ${a.text}` : '');
    return;
  } else if (head.current) status.append(el('b', '', `▶ ${head.current}`), head.queued ? ` (+${head.queued} queued)` : '');
  else status.append(settings.mode === 'agent' ? 'Starting the agent…' : 'Waiting for MCP calls');
  status.className = 'status';
}

function renderModels(): void {
  const want = settings.agent.backend === 'platform' ? 'platform' : `ollama:${settings.agent.model || models?.current || ''}`;
  const opts: [string, string][] = [];
  for (const m of models?.models ?? []) opts.push([`ollama:${m}`, m]);
  if (!opts.some(([v]) => v === want) && want !== 'platform') opts.unshift([want, settings.agent.model || models?.current || 'default model']);
  if (models?.platform ?? true) opts.push(['platform', 'Практикум ИИ']);
  const key = JSON.stringify([opts, want]);
  if (modelSel.dataset.key === key) return;
  modelSel.dataset.key = key;
  modelSel.replaceChildren(...opts.map(([v, label]) => Object.assign(el('option', '', label), { value: v })));
  modelSel.value = want;
}

/** From the settings only, so a redraw can't move the slider under the user's hand. */
function renderThink(): void {
  const think = settings.agent.think;
  // Практикум ИИ has no reasoning setting.
  $('thinkrow').hidden = settings.agent.backend === 'platform';
  const auto = think === '';
  const at = auto ? LEVELS.indexOf('medium') : LEVELS.indexOf(think);
  thinkRange.value = String(at);
  thinkRange.setAttribute('aria-valuetext', auto ? 'auto (the model decides)' : think);
  $('think-slider').classList.toggle('auto', auto);
  $('think-auto').setAttribute('aria-pressed', String(auto));
  $('think-chip').textContent = `Thinking: ${auto ? 'auto' : think}`;
  showTick(at);
}

function showTick(at: number): void {
  $('think-slider').querySelectorAll('.ticks span').forEach((t, i) => t.classList.toggle('on', i === at));
}

function thinkMenu(open: boolean): void {
  $('think-menu').hidden = !open;
  $('think-chip').setAttribute('aria-expanded', String(open));
}

function setThink(think: Think): void {
  thinkMenu(false);
  void saveSettings({ agent: { ...settings.agent, think } });
}

function renderApproval(): void {
  const box = $('approval');
  const c = head?.confirm;
  box.hidden = !c;
  if (!c || box.dataset.id === c.id) return;
  box.dataset.id = c.id;
  const row = el('div', 'row');
  const yes = el('button', 'approve', 'Approve');
  const no = el('button', 'deny', 'Deny');
  yes.addEventListener('click', () => send({ target: 'background', type: 'confirm', id: c.id, approved: true }));
  no.addEventListener('click', () => send({ target: 'background', type: 'confirm', id: c.id, approved: false }));
  row.append(yes, no);
  box.replaceChildren(el('p', '', 'Approve this action?'), el('pre', '', c.text), row);
}

function renderQuestion(): void {
  const box = $('question');
  const q = head?.agent?.question;
  box.hidden = !q;
  if (!q || box.dataset.id === q.id) return;
  box.dataset.id = q.id;
  answerDraft = '';
  const answer = (text: string | null) => {
    answerDraft = '';
    send({ target: 'background', type: 'agent_answer', id: q.id, text });
  };
  const cands = el('div', 'row');
  for (const c of q.candidates) {
    const b = el('button', '', c);
    b.title = 'Answer with this';
    b.addEventListener('click', () => answer(c));
    cands.append(b);
  }
  const row = el('div', 'row');
  const field = el('input');
  field.placeholder = 'Your answer (as for answer_quiz)';
  field.addEventListener('input', () => (answerDraft = field.value));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && field.value.trim()) answer(field.value.trim());
  });
  const ok = el('button', 'approve', 'Answer');
  ok.addEventListener('click', () => field.value.trim() && answer(field.value.trim()));
  const leave = el('button', '', 'Leave it');
  leave.addEventListener('click', () => answer(null));
  row.append(field, ok, leave);
  box.replaceChildren(el('p', '', `The agent isn't sure about ${q.ref} — your answer?`), el('pre', '', q.text), ...(q.candidates.length ? [cands] : []), row);
  field.value = answerDraft;
}

function renderComposer(): void {
  const chat = !!head?.connected && !!head.agent?.chat;
  $('composer').hidden = !chat;
  const running = busy();
  $('stop').hidden = !running;
  input.placeholder = running ? 'Message (sent when the current run finishes)…' : 'Ask the agent to do something on Practicum…';
  // MCP mode without a chatting agent: Stop for the outside client's calls.
  $('mcp-stop').hidden = chat || !(head?.current || head?.confirm);
  const hint = $('footer-hint');
  hint.hidden = chat || settings.mode !== 'agent';
  hint.textContent = !head?.connected
    ? 'The bridge is not connected.'
    : 'No agent yet: the bridge starts one in agent mode (uv run practicum-bridge --model <ollama model>).';
}

function renderHead(): void {
  renderHeader();
  renderModels();
  renderApproval();
  renderQuestion();
  renderComposer();
}

// ── input ───────────────────────────────────────────────────────────────────

function submit(): void {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  send({ target: 'background', type: 'agent_say', text });
}

function stop(): void {
  send({ target: 'background', type: 'stop' });
}

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('think-menu').hidden) {
    thinkMenu(false);
    $('think-chip').focus();
  } else if (busy()) stop();
});
$('send').addEventListener('click', submit);
$('stop').addEventListener('click', stop);
$('stop2').addEventListener('click', stop);
$('clear').addEventListener('click', () => send({ target: 'background', type: 'clear' }));
$('mode-mcp').addEventListener('click', () => void saveSettings({ mode: 'mcp' }));
$('mode-agent').addEventListener('click', () => void saveSettings({ mode: 'agent' }));
modelSel.addEventListener('change', () => {
  const v = modelSel.value;
  const agent = v === 'platform' ? { ...settings.agent, backend: 'platform' as const } : { ...settings.agent, backend: 'ollama' as const, model: v.slice('ollama:'.length) };
  void saveSettings({ agent });
});
thinkRange.addEventListener('input', () => {
  $('think-slider').classList.remove('auto');
  showTick(Number(thinkRange.value));
});
thinkRange.addEventListener('change', () => setThink(LEVELS[Number(thinkRange.value)]));
$('think-slider').querySelectorAll('.ticks span').forEach((t, i) => t.addEventListener('click', () => setThink(LEVELS[i])));
$('think-auto').addEventListener('click', () => setThink(''));
$('think-chip').addEventListener('click', () => {
  thinkMenu($('think-menu').hidden === true);
  if (!$('think-menu').hidden) thinkRange.focus();
});
// A click elsewhere or Esc closes the menu (Esc stops a run only when no menu is open).
document.addEventListener('click', (e) => {
  if (!$('thinkrow').contains(e.target as Node)) thinkMenu(false);
});

// ── connection to the background ────────────────────────────────────────────

function connect(): void {
  const port = browser.runtime.connect({ name: 'sidebar' });
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as SidebarMessage;
    head = msg.head;
    models = msg.models;
    if (msg.type === 'snapshot') {
      for (const [, [, node]] of drawn) node.remove();
      drawn.clear();
      upsert(msg.items, []);
      timeline.scrollTop = timeline.scrollHeight;
    } else upsert(msg.items, msg.dropped);
    renderHead();
  });
  // The background was reloaded (extension update): connect to the new one.
  port.onDisconnect.addListener(() => setTimeout(connect, 1000));
}

function applySettings(s: Settings): void {
  const modeChanged = s.mode !== settings.mode;
  settings = s;
  if (modeChanged && !drawn.size) upsert([], []);
  renderHead();
  renderThink();
}

void loadSettings().then((s) => {
  applySettings(s);
  connect();
});
onSettingsChanged(applySettings);
upsert([], []);
