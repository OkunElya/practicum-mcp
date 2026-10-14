import specsJson from '../../../shared/tools.json';

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

/** read: no change · nav: navigation (checkin) · rev: reversible · irrev: recorded on the account */
export type Effect = 'read' | 'nav' | 'rev' | 'irrev';

export interface ToolSpec {
  name: string;
  description: string;
  effect: Effect;
  timeout_s: number;
  params: Record<string, ParamSpec>;
}

export const TOOL_SPECS = specsJson.tools as ToolSpec[];
