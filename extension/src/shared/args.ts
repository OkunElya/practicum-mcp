import { ToolError } from './protocol';
import type { ToolSpec } from './specs';

/**
 * Small models frequently send `"5"` for numbers, `"true"` for booleans, or a
 * JSON string instead of an object. Be lenient on input, strict on meaning.
 */
export function coerceArgs(tool: ToolSpec, raw: unknown): Record<string, any> {
  let input: Record<string, unknown> = {};
  if (typeof raw === 'string' && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ToolError(`${tool.name}: arguments must be a JSON object`);
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) input = raw as Record<string, unknown>;

  const unknown = Object.keys(input).filter((k) => !(k in tool.params));
  if (unknown.length) {
    const known = Object.keys(tool.params).join(', ') || 'none';
    throw new ToolError(`${tool.name}: unknown argument(s) ${unknown.join(', ')}; accepted: ${known}`);
  }

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
