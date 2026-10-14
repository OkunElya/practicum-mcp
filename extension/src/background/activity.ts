import type { HudState, LogEntry, LogLevel } from '../shared/hud';
import { ToolError } from '../shared/protocol';

const KEEP = 50;
const SHOW = 8;
const CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Everything the user should see: the action log, the running tool, the queue
 * and pending approvals. Pushes its state to the HUD in every Practicum tab.
 */
export class Activity {
  connected = false;
  current: string | null = null;
  queued = 0;
  private entries: LogEntry[] = [];
  private confirmReq: { id: string; text: string; resolve: (ok: boolean) => void } | null = null;
  private nextConfirmId = 1;

  log(level: LogLevel, text: string): void {
    this.entries.push({ t: Date.now(), level, text });
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    this.push();
  }

  set(patch: Partial<Pick<Activity, 'connected' | 'current' | 'queued'>>): void {
    Object.assign(this, patch);
    this.push();
  }

  state(): HudState {
    return {
      connected: this.connected,
      current: this.current,
      queued: this.queued,
      entries: this.entries.slice(-SHOW),
      confirm: this.confirmReq && { id: this.confirmReq.id, text: this.confirmReq.text },
    };
  }

  /**
   * Ask the user to approve an irreversible action in the HUD. Resolves when
   * they answer; throws `denied` on "Deny", timeout or abort.
   */
  async confirm(text: string, signal: AbortSignal): Promise<void> {
    const id = String(this.nextConfirmId++);
    this.log('ask', `Approve? ${text}`);
    const approved = await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.confirmReq?.id === id) this.confirmReq = null;
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), CONFIRM_TIMEOUT_MS);
      const onAbort = () => done(false);
      signal.addEventListener('abort', onAbort);
      this.confirmReq = { id, text, resolve: done };
      this.push();
    });
    this.log(approved ? 'ok' : 'error', approved ? 'approved' : 'not approved');
    if (!approved) {
      if (signal.aborted) throw new ToolError('stopped by the user', 'stopped');
      throw new ToolError(`the user did not approve: ${text}. Don't retry unless the user asks.`, 'denied');
    }
  }

  answerConfirm(id: string, approved: boolean): void {
    if (this.confirmReq?.id === id) this.confirmReq.resolve(approved);
  }

  private push(): void {
    const state = this.state();
    void browser.tabs.query({ url: '*://practicum.yandex.ru/*' }).then((tabs) => {
      for (const t of tabs) {
        // Tabs without the content script (yet) just miss this update; they ask on load.
        browser.tabs.sendMessage(t.id!, { target: 'content', op: 'hud', args: state }).catch(() => {});
      }
    });
  }
}
