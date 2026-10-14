import type { RefStore } from './refs';

/**
 * Params are deliberately flat scalars: small models are unreliable with
 * nested objects/arrays in tool arguments.
 */
export type ParamType = 'string' | 'number' | 'integer' | 'boolean';

export interface ParamSpec {
  type: ParamType;
  description: string;
  enum?: string[];
  optional?: boolean;
  default?: string | number | boolean;
}

export interface ToolContext {
  doc: Document;
  win: Window;
  refs: RefStore;
  /** How long to wait for the DOM to go quiet after an action. */
  settle: { quietMs: number; maxMs: number };
}

export interface ToolDef {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /** Marks introspection tools that are hidden unless debug tools are enabled. */
  debug?: boolean;
  run(args: Record<string, any>, ctx: ToolContext): Promise<string> | string;
}

export type ToolResult = { ok: true; output: string } | { ok: false; error: string };

/** Thrown by tools for errors the model should see and can recover from. */
export class ToolError extends Error {}
