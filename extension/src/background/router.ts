import { coerceArgs } from '../shared/args';
import { ToolError, type BridgeOut } from '../shared/protocol';
import type { ToolSpec } from '../shared/specs';

export interface ToolContext {
  signal: AbortSignal;
  /** Short status line, forwarded to the MCP client as progress. */
  progress(text: string): void;
}

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

/** Hard cap on tool output so one call can't flood a small model's context. */
const MAX_OUTPUT_CHARS = 12_000;

export class Router {
  private readonly tools = new Map<string, Tool>();
  private readonly running = new Map<string, AbortController>();

  constructor(tools: Tool[], private readonly send: (msg: BridgeOut) => void) {
    for (const t of tools) this.tools.set(t.spec.name, t);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  async call(id: string, name: string, rawArgs: unknown): Promise<void> {
    const tool = this.tools.get(name);
    if (!tool) {
      this.send({ type: 'result', id, ok: false, kind: 'tool', error: `unknown tool "${name}". Available: ${[...this.tools.keys()].join(', ')}` });
      return;
    }
    const abort = new AbortController();
    this.running.set(id, abort);
    const ctx: ToolContext = {
      signal: abort.signal,
      progress: (text) => this.send({ type: 'progress', id, text }),
    };
    try {
      const output = await tool.run(coerceArgs(tool.spec, rawArgs), ctx);
      this.send({ type: 'result', id, ok: true, output: truncate(output) });
    } catch (e) {
      if (abort.signal.aborted) {
        this.send({ type: 'result', id, ok: false, kind: 'stopped', error: `${name} was stopped` });
      } else if (e instanceof ToolError) {
        this.send({ type: 'result', id, ok: false, kind: e.kind, error: e.message });
      } else {
        console.error(e);
        this.send({ type: 'result', id, ok: false, kind: 'tool', error: `${name} failed: ${(e as Error)?.message ?? e}` });
      }
    } finally {
      this.running.delete(id);
    }
  }

  cancel(id: string): void {
    this.running.get(id)?.abort();
  }
}

function truncate(s: string): string {
  return s.length <= MAX_OUTPUT_CHARS ? s : `${s.slice(0, MAX_OUTPUT_CHARS)}\n…(output truncated)`;
}
