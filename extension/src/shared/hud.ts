/** What the on-page overlay (HUD), the sidebar and the popup show. Owned by the background. */

import type { Item } from './transcript';

export type LogLevel = 'run' | 'step' | 'ok' | 'error' | 'ask';

export interface LogEntry {
  t: number;
  level: LogLevel;
  text: string;
}

/**
 * MCP: an outside MCP client drives; the small overlay in the page shows its calls.
 * Agent: the bridge hosts the agent; you talk to it in the sidebar, which shows everything.
 */
export type Mode = 'mcp' | 'agent';

/** An agent driver connected through the bridge: hosted by it (agent mode) or practicum-chat. */
export type AgentState = 'idle' | 'thinking' | 'acting' | 'waiting_user' | 'done' | 'stopped';

export type AgentEvent =
  | { kind: 'hello'; name: string; chat: boolean }
  | { kind: 'status'; state: AgentState; text: string }
  /** thinking: a model's reasoning that wasn't streamed. */
  | { kind: 'message'; role: 'user' | 'agent' | 'note' | 'thinking'; text: string }
  /** A streamed chunk of the model's reply; `turn` groups the chunks of one reply. */
  | { kind: 'delta'; turn: string; part: 'thinking' | 'text'; text: string }
  | { kind: 'turn_end'; turn: string }
  | { kind: 'question'; id: string; ref: string; text: string; candidates: string[] }
  | { kind: 'question_closed'; id: string }
  /** What the model picker offers (agent mode). */
  | { kind: 'models'; models: string[]; platform: boolean; current: string }
  | { kind: 'gone' };

/** Overlay/sidebar -> agent, relayed by the bridge. */
export type AgentInput =
  | { kind: 'say'; text: string }
  | { kind: 'answer'; id: string; text: string | null }
  | { kind: 'stop' }
  | { kind: 'clear' };

export interface AgentView {
  name: string;
  /** Takes messages (the hosted agent, practicum-chat); a one-task run doesn't. */
  chat: boolean;
  state: AgentState;
  text: string;
  question: { id: string; ref: string; text: string; candidates: string[] } | null;
}

export interface HudState {
  connected: boolean;
  mode: Mode;
  /** A sidebar is open somewhere: in agent mode it shows everything and the overlay stays out of the way. */
  sidebar: boolean;
  /** The tool running now, e.g. "answer_quiz: block a7a7…". */
  current: string | null;
  queued: number;
  entries: LogEntry[];
  /** A pending approval request for an irreversible action. */
  confirm: { id: string; text: string } | null;
  agent: AgentView | null;
}

export interface ModelList {
  models: string[];
  platform: boolean;
  current: string;
}

/** Background -> sidebar (runtime port "sidebar"). */
export type SidebarMessage =
  | { type: 'snapshot'; head: HudState; models: ModelList | null; items: Item[] }
  /** Changed or new items in timeline order, and ids dropped from the front. */
  | { type: 'patch'; head: HudState; models: ModelList | null; items: Item[]; dropped: string[] };

/** HUD/sidebar/popup -> background */
export type HudRequest =
  | { target: 'background'; type: 'stop' }
  | { target: 'background'; type: 'confirm'; id: string; approved: boolean }
  | { target: 'background'; type: 'hud' } // content script (re)loaded and wants the state
  | { target: 'background'; type: 'agent_say'; text: string }
  | { target: 'background'; type: 'agent_answer'; id: string; text: string | null }
  | { target: 'background'; type: 'clear' };
