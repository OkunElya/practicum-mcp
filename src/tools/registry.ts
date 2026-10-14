import { ToolError, type ParamSpec, type ToolContext, type ToolDef, type ToolResult } from './types';

export interface RegistryOptions {
  includeDebug?: boolean;
  /** Hard cap on tool output so a single call can't blow a small context window. */
  maxOutputChars?: number;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();
  private includeDebug: boolean;
  private maxOutputChars: number;

  constructor(private ctx: ToolContext, opts: RegistryOptions = {}) {
    this.includeDebug = opts.includeDebug ?? false;
    this.maxOutputChars = opts.maxOutputChars ?? 6000;
  }

  register(tool: ToolDef): void {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`invalid tool name "${tool.name}" (use snake_case)`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  private visible(): ToolDef[] {
    return [...this.tools.values()].filter((t) => this.includeDebug || !t.debug);
  }

  /** OpenAI / Ollama / llama.cpp compatible `tools` array. */
  toFunctionSpecs() {
    return this.visible().map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.params).map(([k, p]) => [k, paramSchema(p)]),
          ),
          required: Object.entries(t.params)
            .filter(([, p]) => !p.optional)
            .map(([k]) => k),
        },
      },
    }));
  }

  /** Compact plain-text listing for models without native tool calling. */
  toPromptText(): string {
    return this.visible()
      .map((t) => {
        const args = Object.entries(t.params)
          .map(([k, p]) => `${k}${p.optional ? '?' : ''}: ${p.enum ? p.enum.join('|') : p.type}`)
          .join(', ');
        return `${t.name}(${args}) - ${t.description}`;
      })
      .join('\n');
  }

  async call(name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool || (tool.debug && !this.includeDebug)) {
      const names = this.visible().map((t) => t.name).join(', ');
      return { ok: false, error: `unknown tool "${name}". available: ${names}` };
    }
    try {
      const args = coerceArgs(tool, rawArgs);
      const output = await tool.run(args, this.ctx);
      return { ok: true, output: truncate(output, this.maxOutputChars) };
    } catch (e) {
      // Unexpected exceptions are reported too: the model may still be able to recover.
      const msg = e instanceof ToolError ? e.message : `${tool.name} failed: ${(e as Error)?.message ?? e}`;
      return { ok: false, error: msg };
    }
  }
}

function paramSchema(p: ParamSpec) {
  return {
    type: p.type,
    description: p.description,
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
  };
}

/**
 * Small models frequently send `"5"` for numbers, `"true"` for booleans, or a
 * JSON string instead of an object. Be lenient on input, strict on meaning.
 */
export function coerceArgs(tool: ToolDef, raw: unknown): Record<string, any> {
  let input: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ToolError(`${tool.name}: arguments must be a JSON object`);
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) input = raw as Record<string, unknown>;

  const out: Record<string, any> = {};
  for (const [key, spec] of Object.entries(tool.params)) {
    let v = input[key];
    if (v === undefined || v === null || v === '') {
      if (spec.default !== undefined) out[key] = spec.default;
      else if (!spec.optional) throw new ToolError(`${tool.name}: missing required argument "${key}" (${spec.description})`);
      continue;
    }
    switch (spec.type) {
      case 'string':
        v = typeof v === 'object' ? JSON.stringify(v) : String(v);
        break;
      case 'number':
      case 'integer': {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new ToolError(`${tool.name}: "${key}" must be a number, got ${JSON.stringify(v)}`);
        v = spec.type === 'integer' ? Math.round(n) : n;
        break;
      }
      case 'boolean':
        if (typeof v === 'string') {
          const s = v.trim().toLowerCase();
          if (['true', 'yes', '1', 'on'].includes(s)) v = true;
          else if (['false', 'no', '0', 'off'].includes(s)) v = false;
          else throw new ToolError(`${tool.name}: "${key}" must be true or false`);
        } else v = Boolean(v);
        break;
    }
    if (spec.enum) {
      const match = spec.enum.find((e) => e.toLowerCase() === String(v).toLowerCase());
      if (!match) throw new ToolError(`${tool.name}: "${key}" must be one of ${spec.enum.join(', ')}`);
      v = match;
    }
    out[key] = v;
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(output truncated; narrow it with find or get_page ref=…)`;
}
