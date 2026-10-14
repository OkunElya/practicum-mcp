import type { BridgeIn, BridgeOut, LinkStatus } from '../shared/protocol';
import type { Settings } from './settings';

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/**
 * Outbound WebSocket to the Python bridge (extensions can't listen on ports).
 * Reconnects with backoff, except after a bad token: that needs new settings.
 */
export class BridgeLink {
  status: LinkStatus = 'off';
  detail = '';
  private ws: WebSocket | null = null;
  private settings: Settings | null = null;
  private delay = MIN_DELAY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly hello: () => { version: string; tools: unknown[] },
    private readonly onMessage: (msg: BridgeIn) => void,
    private readonly onStatus: (status: LinkStatus, detail: string) => void,
  ) {}

  start(settings: Settings): void {
    this.settings = settings;
    this.delay = MIN_DELAY_MS;
    this.close();
    if (!settings.token) {
      this.setStatus('off', 'set the token from the bridge output in this popup');
      return;
    }
    this.connect();
  }

  send(msg: BridgeOut): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    const s = this.settings!;
    this.setStatus('connecting', s.bridgeUrl);
    let ws: WebSocket;
    try {
      ws = new WebSocket(s.bridgeUrl);
    } catch (e) {
      this.setStatus('off', `bad bridge URL: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const { version, tools } = this.hello();
      ws.send(JSON.stringify({ type: 'hello', token: s.token, version, tools } satisfies BridgeOut));
    };
    ws.onmessage = (ev) => {
      let msg: BridgeIn;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.delay = MIN_DELAY_MS;
        this.setStatus('connected', s.bridgeUrl);
      } else this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return; // replaced by start()
      this.ws = null;
      if (ev.code === 4401) {
        this.setStatus('bad_token', 'the bridge rejected the token');
        return;
      }
      this.setStatus('disconnected', `retrying in ${Math.round(this.delay / 1000)} s`);
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    };
  }

  private close(): void {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private setStatus(status: LinkStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    this.onStatus(status, detail);
  }
}
