import { describe, expect, it } from 'vitest';
import { coerceArgs } from '../src/shared/args';
import { ToolError } from '../src/shared/protocol';
import { TOOL_SPECS, type ToolSpec } from '../src/shared/specs';

const tool: ToolSpec = {
  name: 'demo',
  description: 'demo',
  effect: 'read',
  timeout_s: 5,
  params: {
    id: { type: 'string', description: 'id' },
    count: { type: 'integer', description: 'count', optional: true },
    mode: { type: 'string', description: 'mode', enum: ['next', 'prev'], default: 'next' },
    force: { type: 'boolean', description: 'force', optional: true },
  },
};

describe('coerceArgs', () => {
  it('accepts sloppy small-model input', () => {
    expect(coerceArgs(tool, '{"id": 5, "count": "2.6", "mode": "PREV", "force": "yes"}')).toEqual({ id: '5', count: 3, mode: 'prev', force: true });
  });
  it('fills defaults and skips missing optionals', () => {
    expect(coerceArgs(tool, { id: 'a' })).toEqual({ id: 'a', mode: 'next' });
  });
  it('explains what is wrong', () => {
    expect(() => coerceArgs(tool, {})).toThrow(/missing required argument "id"/);
    expect(() => coerceArgs(tool, { id: 'a', mode: 'up' })).toThrow(/one of next, prev/);
    expect(() => coerceArgs(tool, { id: 'a', bogus: 1 })).toThrow(/unknown argument\(s\) bogus; accepted: id, count, mode, force/);
    expect(() => coerceArgs(tool, '{oops')).toThrow(ToolError);
  });
});

describe('shared/tools.json', () => {
  it('has well-formed specs', () => {
    for (const s of TOOL_SPECS) {
      expect(s.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(['read', 'nav', 'rev', 'irrev']).toContain(s.effect);
      expect(s.timeout_s).toBeGreaterThan(0);
    }
  });
});
