import type { AgentEvent, AgentInput, HudState, Mode } from './hud';

/** Why a call failed, so the model can decide whether to retry. */
export type ErrorKind =
  | 'tool' // bad arguments, element missing, unexpected page state
  | 'platform' // the site's own errors (400 PY.*, 408.previewTimeout, 5xx)
  | 'denied' // the user rejected the confirmation
  | 'stopped' // the user pressed Stop, or the bridge cancelled the call
  | 'timeout'
  | 'no_tab'; // no practicum.yandex.ru tab open

/** Thrown by tools and page ops for errors the model should see. */
export class ToolError extends Error {
  constructor(message: string, readonly kind: ErrorKind = 'tool') {
    super(message);
  }
}

// bridge <-> background (WebSocket)
export type BridgeIn =
  | { type: 'welcome' }
  /** source: "agent" for the agent the bridge hosts, "mcp" for an outside MCP client. */
  | { type: 'call'; id: string; tool: string; args: unknown; source?: 'agent' | 'mcp' }
  | { type: 'cancel'; id: string }
  | { type: 'agent'; event: AgentEvent };

export type BridgeOut =
  | { type: 'hello'; token: string; version: string; tools: unknown[] }
  | { type: 'progress'; id: string; text: string }
  | { type: 'result'; id: string; ok: true; output: string }
  | { type: 'result'; id: string; ok: false; error: string; kind: ErrorKind }
  | { type: 'agent_input'; input: AgentInput }
  /** Which mode the user picked, and the hosted agent's model (agent mode). */
  | { type: 'mode'; mode: Mode; agent: AgentConfig };

export interface AgentConfig {
  /** "ollama" (a local model) or "platform" (Практикум ИИ drives). */
  backend: 'ollama' | 'platform';
  /** Ollama model; empty: the bridge's default (--model). */
  model: string;
  /** Reasoning effort for models that support it; empty: the model's default. */
  think: '' | 'low' | 'medium' | 'high' | 'off';
}

// background -> content script (runtime messages)
export interface PageRequest {
  target: 'content';
  op: string;
  args?: unknown;
}
export type PageResponse = { ok: true; value: unknown } | { ok: false; error: string; kind: ErrorKind };

// popup <-> background
export type LinkStatus = 'off' | 'connecting' | 'connected' | 'bad_token' | 'disconnected';
export type PopupRequest =
  | { target: 'background'; type: 'status' }
  | { target: 'background'; type: 'reconnect' };
export interface StatusReply {
  status: LinkStatus;
  detail: string;
  tools: number;
  hud: HudState;
}
