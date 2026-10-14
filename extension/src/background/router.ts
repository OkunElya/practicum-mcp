import { coerceArgs } from '../shared/args';
import { ToolError, type BridgeOut } from '../shared/protocol';
import type { ToolSpec } from '../shared/specs';
import type { Activity } from './activity';
import { PageSession, targetTab } from './page';
import type { Settings } from './settings';

export interface ToolContext {
  signal: AbortSignal;
  /** The Practicum tab this call works on (pinned for the whole call). */
  page: PageSession;
  /** Log a step in the HUD and forward it to the MCP client as progress. */
  step(text: string): void;
}

export interface Tool {
  spec: ToolSpec;
  /**
   * One line for the approval prompt of an irreversible tool, e.g. «Submit "404"
   * to the quiz "Какой код…"». Called before `run`; may read the page.
   */
  describe?(args: Record<string, any>, ctx: ToolContext): Promise<string>;
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

/** Hard cap on tool output so one call can't flood a small model's context. */
const MAX_OUTPUT_CHARS = 12_000;

/**
 * Runs tool calls one at a time, in arrival order. Stop aborts the running call
 * and everything queued. Irreversible tools ask the user first.
 */
export class Router {
  private readonly tools = new Map<string, Tool>();
  private readonly calls = new Map<string, AbortController>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    tools: Tool[],
    private readonly send: (msg: BridgeOut) => void,
    private readonly activity: Activity,
    private readonly settings: () => Settings,
  ) {
    for (const t of tools) this.tools.set(t.spec.name, t);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  call(id: string, name: string, rawArgs: unknown): void {
    const abort = new AbortController();
    this.calls.set(id, abort);
    this.activity.set({ queued: this.calls.size - 1 });
    this.tail = this.tail.then(() => this.run(id, name, rawArgs, abort));
  }

  /** Bridge cancelled one call (MCP cancel or timeout). */
  cancel(id: string): void {
    this.calls.get(id)?.abort();
  }

  /** The user pressed Stop: abort the running call and drop the queue. */
  stopAll(): void {
    if (!this.calls.size) return;
    this.activity.log('error', `Stop: ${this.calls.size} call(s) cancelled`);
    for (const c of this.calls.values()) c.abort();
  }

  private async run(id: string, name: string, rawArgs: unknown, abort: AbortController): Promise<void> {
    const fail = (kind: ToolError['kind'], error: string) => {
      this.activity.log('error', `${name}: ${error}`);
      this.send({ type: 'result', id, ok: false, kind, error });
    };
    try {
      const tool = this.tools.get(name);
      if (!tool) return fail('tool', `unknown tool "${name}". Available: ${[...this.tools.keys()].join(', ')}`);
      if (abort.signal.aborted) return fail('stopped', 'stopped by the user before it started');

      const args = coerceArgs(tool.spec, rawArgs);
      const shownArgs = Object.values(args).map((v) => clip(String(v), 40)).join(', ');
      this.activity.set({ current: `${name}(${shownArgs})` });
      this.activity.log('run', `${name}(${shownArgs})`);

      const tab = await targetTab();
      const ctx: ToolContext = {
        signal: abort.signal,
        page: new PageSession(tab.id!, abort.signal),
        step: (text) => {
          this.activity.log('step', text);
          this.send({ type: 'progress', id, text });
        },
      };
      if (tool.spec.effect === 'irrev' && this.settings().confirmIrreversible) {
        const what = tool.describe ? await tool.describe(args, ctx) : `${name}(${shownArgs})`;
        await this.activity.confirm(what, abort.signal);
      }
      const output = await tool.run(args, ctx);
      this.activity.log('ok', `${name}: done`);
      this.send({ type: 'result', id, ok: true, output: truncate(output) });
    } catch (e) {
      if (abort.signal.aborted) fail('stopped', `${name} was stopped by the user`);
      else if (e instanceof ToolError) fail(e.kind, e.message);
      else {
        console.error(e);
        fail('tool', `${name} failed: ${(e as Error)?.message ?? e}`);
      }
    } finally {
      this.calls.delete(id);
      this.activity.set({ current: null, queued: Math.max(0, this.calls.size - 1) });
    }
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function truncate(s: string): string {
  return s.length <= MAX_OUTPUT_CHARS ? s : `${s.slice(0, MAX_OUTPUT_CHARS)}\n…(output truncated)`;
}
