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
  | { type: 'call'; id: string; tool: string; args: unknown }
  | { type: 'cancel'; id: string };

export type BridgeOut =
  | { type: 'hello'; token: string; version: string; tools: unknown[] }
  | { type: 'progress'; id: string; text: string }
  | { type: 'result'; id: string; ok: true; output: string }
  | { type: 'result'; id: string; ok: false; error: string; kind: ErrorKind };

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
}
