/**
 * One timeline of everything that happens, the way Claude Code shows a session:
 * the user's messages, the model's thinking and text, tool calls (from the agent
 * or an outside MCP client) with their steps and results, the driver's notes and
 * the agent's questions, in the order they happened. Built by the background from
 * agent events and the router's calls; the sidebar renders it.
 */
import type { AgentEvent, AgentView, ModelList } from './hud';
import type { ErrorKind } from './protocol';

export const MAX_ITEMS = 300;
export const MAX_RESULT = 4000;
const MAX_TEXT = 20_000;
const MAX_STEPS = 30;

export type CallSource = 'agent' | 'mcp';
export type ToolStatus = 'queued' | 'approval' | 'running' | 'ok' | 'error' | 'denied' | 'stopped';

interface Base {
  id: string;
  t: number;
  /** Bumped on every change, so a renderer can skip items it already drew. */
  rev: number;
}

export type UserItem = Base & { type: 'user'; text: string };
export type TextItem = Base & { type: 'text'; text: string; streaming: boolean; turn?: string };
export type ThinkingItem = Base & { type: 'thinking'; text: string; streaming: boolean; ms: number; turn?: string };
export type NoteItem = Base & { type: 'note'; text: string };
export type ToolItem = Base & {
  type: 'tool';
  callId: string;
  source: CallSource;
  name: string;
  args: unknown;
  status: ToolStatus;
  steps: string[];
  result: string;
  kind?: ErrorKind;
  /** What the approval prompt asked, once it was asked. */
  approval?: string;
  started?: number;
  ms: number;
};
export type QuestionItem = Base & {
  type: 'question';
  qid: string;
  ref: string;
  text: string;
  candidates: string[];
  /** undefined: not answered (yet); null: left to the user. */
  answer?: string | null;
  open: boolean;
};
export type Item = UserItem | TextItem | ThinkingItem | NoteItem | ToolItem | QuestionItem;

/** What the router reports about each call. */
export type ToolEvent =
  | { kind: 'tool_queued'; callId: string; name: string; args: unknown; source: CallSource }
  | { kind: 'tool_running'; callId: string; args: unknown }
  | { kind: 'tool_step'; callId: string; text: string }
  | { kind: 'tool_approval'; callId: string; text: string }
  | { kind: 'tool_approved'; callId: string }
  | { kind: 'tool_done'; callId: string; ok: true; output: string }
  | { kind: 'tool_done'; callId: string; ok: false; error: string; errorKind: ErrorKind };

type New<T extends Item> = Omit<T, 'id' | 't' | 'rev'>;

export function clipText(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…(${s.length - n} more characters)`;
}

export class Transcript {
  items: Item[] = [];
  agent: AgentView | null = null;
  models: ModelList | null = null;
  private seq = 0;
  private rev = 0;
  private dirty = new Set<string>();
  private dropped: string[] = [];
  private calls = new Map<string, ToolItem>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Items changed since the last call, in timeline order, and ids that fell off the front. */
  takeChanges(): { items: Item[]; dropped: string[] } {
    const items = this.dirty.size ? this.items.filter((i) => this.dirty.has(i.id)) : [];
    const dropped = this.dropped;
    this.dirty = new Set();
    this.dropped = [];
    return { items, dropped };
  }

  clear(): void {
    this.dropped.push(...this.items.map((i) => i.id));
    this.items = [];
    this.calls.clear();
    this.dirty.clear();
  }

  onAgent(ev: AgentEvent): void {
    switch (ev.kind) {
      case 'hello':
        this.closeStreams();
        this.agent = { name: ev.name, chat: ev.chat, state: 'idle', text: '', question: null };
        this.add<NoteItem>({ type: 'note', text: `${ev.name} connected` });
        break;
      case 'gone':
        this.closeStreams();
        if (this.agent) this.add<NoteItem>({ type: 'note', text: `${this.agent.name} left` });
        this.agent = null;
        break;
      case 'models':
        this.models = { models: ev.models, platform: ev.platform, current: ev.current };
        break;
      case 'status':
        if (this.agent) Object.assign(this.agent, { state: ev.state, text: ev.text });
        if (ev.state !== 'thinking') this.closeStreams();
        break;
      case 'message':
        this.message(ev.role, ev.text);
        break;
      case 'delta':
        this.delta(ev.turn, ev.part, ev.text);
        break;
      case 'turn_end':
        this.closeStreams(ev.turn);
        break;
      case 'question':
        if (this.agent) this.agent.question = { id: ev.id, ref: ev.ref, text: ev.text, candidates: ev.candidates };
        this.add<QuestionItem>({ type: 'question', qid: ev.id, ref: ev.ref, text: ev.text, candidates: ev.candidates, open: true });
        break;
      case 'question_closed':
        this.closeQuestion(ev.id);
        break;
    }
  }

  /** The user answered the agent's question (null: left it). */
  answered(qid: string, text: string | null): void {
    this.closeQuestion(qid, text);
  }

  onTool(ev: ToolEvent): void {
    if (ev.kind === 'tool_queued') {
      const item = this.add<ToolItem>({ type: 'tool', callId: ev.callId, source: ev.source, name: ev.name, args: ev.args, status: 'queued', steps: [], result: '', ms: 0 });
      this.calls.set(ev.callId, item);
      return;
    }
    const item = this.calls.get(ev.callId);
    if (!item) return; // fell off the front, or the timeline was cleared
    switch (ev.kind) {
      case 'tool_running':
        Object.assign(item, { status: 'running', args: ev.args, started: this.now() });
        break;
      case 'tool_step':
        item.steps.push(ev.text);
        if (item.steps.length > MAX_STEPS) item.steps.splice(0, item.steps.length - MAX_STEPS);
        break;
      case 'tool_approval':
        Object.assign(item, { status: 'approval', approval: ev.text });
        break;
      case 'tool_approved':
        item.status = 'running';
        break;
      case 'tool_done':
        item.ms = item.started ? this.now() - item.started : 0;
        if (ev.ok) Object.assign(item, { status: 'ok', result: clipText(ev.output, MAX_RESULT) });
        else {
          const status: ToolStatus = ev.errorKind === 'denied' ? 'denied' : ev.errorKind === 'stopped' ? 'stopped' : 'error';
          Object.assign(item, { status, result: clipText(ev.error, MAX_RESULT), kind: ev.errorKind });
        }
        this.calls.delete(ev.callId);
        break;
    }
    this.touch(item);
  }

  private message(role: 'user' | 'agent' | 'note' | 'thinking', text: string): void {
    if (!text.trim()) return;
    if (role === 'user') this.add<UserItem>({ type: 'user', text });
    else if (role === 'note') this.add<NoteItem>({ type: 'note', text });
    else if (role === 'thinking') this.add<ThinkingItem>({ type: 'thinking', text: clipText(text, MAX_TEXT), streaming: false, ms: 0 });
    else {
      this.closeStreams();
      // The final answer repeats what was already streamed as the model's text.
      const since = this.items.slice(this.items.findLastIndex((i) => i.type === 'user') + 1);
      if (since.some((i) => i.type === 'text' && i.text.trim() === text.trim())) return;
      this.add<TextItem>({ type: 'text', text: clipText(text, MAX_TEXT), streaming: false });
    }
  }

  private delta(turn: string, part: 'thinking' | 'text', text: string): void {
    const last = this.items.at(-1);
    if (last && last.type === part && last.streaming && last.turn === turn) {
      if (last.text.length < MAX_TEXT) last.text += text;
      if (last.type === 'thinking') last.ms = this.now() - last.t;
      this.touch(last);
      return;
    }
    // A new part ends the one before it (thinking, then the reply; or the previous turn).
    this.closeStreams();
    if (part === 'thinking') this.add<ThinkingItem>({ type: 'thinking', text, streaming: true, ms: 0, turn });
    else this.add<TextItem>({ type: 'text', text, streaming: true, turn });
  }

  private closeStreams(turn?: string): void {
    for (const it of this.items) {
      if ((it.type === 'text' || it.type === 'thinking') && it.streaming && (turn === undefined || it.turn === turn)) {
        it.streaming = false;
        if (it.type === 'thinking') it.ms = this.now() - it.t;
        this.touch(it);
      }
    }
  }

  private closeQuestion(qid: string, answer?: string | null): void {
    if (this.agent?.question?.id === qid) this.agent.question = null;
    const q = this.items.findLast((i): i is QuestionItem => i.type === 'question' && i.qid === qid);
    if (!q) return;
    q.open = false;
    if (answer !== undefined) q.answer = answer;
    this.touch(q);
  }

  private add<T extends Item>(fields: New<T>): T {
    const item = { ...fields, id: `i${++this.seq}`, t: this.now(), rev: ++this.rev } as T;
    this.items.push(item);
    this.dirty.add(item.id);
    while (this.items.length > MAX_ITEMS) {
      const old = this.items.shift()!;
      this.dirty.delete(old.id);
      this.dropped.push(old.id);
      if (old.type === 'tool') this.calls.delete(old.callId);
    }
    return item;
  }

  private touch(item: Item): void {
    item.rev = ++this.rev;
    this.dirty.add(item.id);
  }
}
