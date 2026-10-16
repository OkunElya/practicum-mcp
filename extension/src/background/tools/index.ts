import { TOOL_SPECS } from '../../shared/specs';
import type { Tool } from '../router';
import { askPlatformAi, resetPlatformAiChat } from './ai';
import { checkCodeExercise, resetCodeExercise, runCodeExercise } from './coding';
import { devTools } from './dev';
import { completeLesson, goHome, openLesson } from './nav';
import { getCode, getProgress, readLesson, readTask } from './read';
import { answerQuiz, pressActionButton } from './theory';
import { checkTask, createFile, deploy, fetchPreview, nextTask, runCode, setCode, showHint } from './trainer';
import { whereAmI } from './where';

/** Set by `build.mjs --dev`. */
declare const __DEV__: boolean;

export const TOOLS: Tool[] = [
  // reading
  whereAmI,
  getProgress,
  readLesson,
  readTask,
  getCode,
  // navigation
  openLesson,
  goHome,
  nextTask,
  // theory lessons
  completeLesson,
  pressActionButton,
  answerQuiz,
  runCodeExercise,
  checkCodeExercise,
  resetCodeExercise,
  // code trainer
  setCode,
  createFile,
  runCode,
  checkTask,
  showHint,
  deploy,
  fetchPreview,
  // platform AI
  askPlatformAi,
  resetPlatformAiChat,
  ...(__DEV__ ? devTools() : []),
];

const missing = TOOL_SPECS.map((s) => s.name).filter((n) => !TOOLS.some((t) => t.spec.name === n));
if (missing.length) console.warn('[practicum-mcp] specs without an implementation:', missing);
