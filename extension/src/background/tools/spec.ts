import { TOOL_SPECS, type ToolSpec } from '../../shared/specs';

/** The spec for a tool from shared/tools.json; fails at startup if it's missing. */
export function spec(name: string): ToolSpec {
  const s = TOOL_SPECS.find((t) => t.name === name);
  if (!s) throw new Error(`shared/tools.json has no tool "${name}"`);
  return s;
}
