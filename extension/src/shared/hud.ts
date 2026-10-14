/** What the on-page overlay (HUD) and the popup show. Owned by the background. */

export type LogLevel = 'run' | 'step' | 'ok' | 'error' | 'ask';

export interface LogEntry {
  t: number;
  level: LogLevel;
  text: string;
}

export interface HudState {
  connected: boolean;
  /** The tool running now, e.g. "answer_quiz: block a7a7…". */
  current: string | null;
  queued: number;
  entries: LogEntry[];
  /** A pending approval request for an irreversible action. */
  confirm: { id: string; text: string } | null;
}

/** HUD/popup -> background */
export type HudRequest =
  | { target: 'background'; type: 'stop' }
  | { target: 'background'; type: 'confirm'; id: string; approved: boolean }
  | { target: 'background'; type: 'hud' }; // content script (re)loaded and wants the state
