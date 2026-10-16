/** What the on-page overlay (HUD) and the popup show. Owned by the background. */

export type LogLevel = 'run' | 'step' | 'ok' | 'error' | 'ask';

export interface LogEntry {
  t: number;
  level: LogLevel;
  text: string;
}

/** An agent driver (practicum-chat / practicum-local-agent) connected through the bridge. */
export type AgentState = 'idle' | 'thinking' | 'acting' | 'waiting_user' | 'done' | 'stopped';

export type AgentEvent =
  | { kind: 'hello'; name: string; chat: boolean }
  | { kind: 'status'; state: AgentState; text: string }
  | { kind: 'message'; role: 'user' | 'agent' | 'note'; text: string }
  | { kind: 'question'; id: string; ref: string; text: string; candidates: string[] }
  | { kind: 'question_closed'; id: string }
  | { kind: 'gone' };

/** Overlay -> agent, relayed by the bridge. */
export type AgentInput = { kind: 'say'; text: string } | { kind: 'answer'; id: string; text: string | null };

export interface AgentView {
  name: string;
  /** Takes messages from the overlay (practicum-chat); a one-task run doesn't. */
  chat: boolean;
  state: AgentState;
  text: string;
  messages: { t: number; role: 'user' | 'agent' | 'note'; text: string }[];
  question: { id: string; ref: string; text: string; candidates: string[] } | null;
}

export interface HudState {
  connected: boolean;
  /** The tool running now, e.g. "answer_quiz: block a7a7…". */
  current: string | null;
  queued: number;
  entries: LogEntry[];
  /** A pending approval request for an irreversible action. */
  confirm: { id: string; text: string } | null;
  agent: AgentView | null;
}

/** HUD/popup -> background */
export type HudRequest =
  | { target: 'background'; type: 'stop' }
  | { target: 'background'; type: 'confirm'; id: string; approved: boolean }
  | { target: 'background'; type: 'hud' } // content script (re)loaded and wants the state
  | { target: 'background'; type: 'agent_say'; text: string }
  | { target: 'background'; type: 'agent_answer'; id: string; text: string | null };
