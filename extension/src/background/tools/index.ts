import { TOOL_SPECS } from '../../shared/specs';
import type { Tool } from '../router';
import { DEV_TOOLS } from './dev';
import { getCode, getProgress, readLesson, readTask } from './read';
import { whereAmI } from './where';

/** Set by `build.mjs --dev`. */
declare const __DEV__: boolean;

export const TOOLS: Tool[] = [whereAmI, getProgress, readLesson, readTask, getCode, ...(__DEV__ ? DEV_TOOLS : [])];

const missing = TOOL_SPECS.map((s) => s.name).filter((n) => !TOOLS.some((t) => t.spec.name === n));
if (missing.length) console.warn('[practicum-mcp] specs without an implementation:', missing);
