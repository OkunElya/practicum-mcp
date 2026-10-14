import { TOOL_SPECS } from '../../shared/specs';
import type { Tool } from '../router';
import { whereAmI } from './where';

export const TOOLS: Tool[] = [whereAmI];

const missing = TOOL_SPECS.map((s) => s.name).filter((n) => !TOOLS.some((t) => t.spec.name === n));
if (missing.length) console.warn('[practicum-mcp] specs without an implementation:', missing);
