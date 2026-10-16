import type { AgentEvent, HudState, LogEntry, LogLevel, Mode, SidebarMessage } from '../shared/hud';
import { ToolError } from '../shared/protocol';
import { Transcript, type ToolEvent } from '../shared/transcript';

const KEEP = 50;
const SHOW = 8;
const CONFIRM_TIMEOUT_MS = 120_000;
/** Updates are batched: a streaming reply changes the timeline many times a second. */
const PUSH_MS = 60;

/**
 * Everything the user should see: the action log, the running tool, the queue,
 * pending approvals, and the timeline of the session (agent messages, thinking,
 * tool calls). Pushes the compact state to the overlay in every Practicum tab and
 * the timeline to open sidebars.
 */
export class Activity {
  connected = false;
  current: string | null = null;
  queued = 0;
  mode: Mode = 'mcp';
  readonly transcript = new Transcript();
  private entries: LogEntry[] = [];
  private confirmReq: { id: string; text: string; callId?: string; resolve: (ok: boolean) => void } | null = null;
  private nextConfirmId = 1;
  private sidebars = new Set<browser.runtime.Port>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastHud = '';

  log(level: LogLevel, text: string): void {
    this.entries.push({ t: Date.now(), level, text });
    if (this.entries.length > KEEP) this.entries.splice(0, this.entries.length - KEEP);
    this.push();
  }

  set(patch: Partial<Pick<Activity, 'connected' | 'current' | 'queued' | 'mode'>>): void {
    Object.assign(this, patch);
    this.push();
  }

  state(): HudState {
    return {
      connected: this.connected,
      mode: this.mode,
      sidebar: this.sidebars.size > 0,
      current: this.current,
      queued: this.queued,
      entries: this.entries.slice(-SHOW),
      confirm: this.confirmReq && { id: this.confirmReq.id, text: this.confirmReq.text },
      agent: this.transcript.agent,
    };
  }

  /** What the agent driver reports through the bridge. */
  onAgent(ev: AgentEvent): void {
    this.transcript.onAgent(ev);
    this.push();
  }

  /** A tool call's progress, from the router. */
  tool(ev: ToolEvent): void {
    this.transcript.onTool(ev);
    this.push();
  }

  /** The user answered the agent's question in some tab or sidebar: hide it everywhere right away. */
  questionAnswered(id: string, text: string | null): void {
    this.transcript.answered(id, text);
    this.push();
  }

  clearTimeline(): void {
    this.transcript.clear();
    this.entries = [];
    this.push();
  }

  /** A sidebar connected: it gets the whole timeline now and changes from then on. */
  addSidebar(port: browser.runtime.Port): void {
    this.sidebars.add(port);
    port.onDisconnect.addListener(() => {
      this.sidebars.delete(port);
      this.push();
    });
    const msg: SidebarMessage = { type: 'snapshot', head: this.state(), models: this.transcript.models, items: this.transcript.items };
    port.postMessage(msg);
    this.push(); // the overlays learn that a sidebar is open
  }

  /**
   * Ask the user to approve an irreversible action (sidebar or overlay). Resolves
   * when they answer; throws `denied` on "Deny", `timeout` when nobody answered
   * (not a refusal: the caller may ask again), `stopped` on abort.
   */
  async confirm(text: string, signal: AbortSignal, callId?: string): Promise<void> {
    const id = String(this.nextConfirmId++);
    this.log('ask', `Approve? ${text}`);
    if (callId) this.tool({ kind: 'tool_approval', callId, text });
    let timedOut = false;
    const approved = await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (this.confirmReq?.id === id) this.confirmReq = null;
        resolve(ok);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        done(false);
      }, CONFIRM_TIMEOUT_MS);
      const onAbort = () => done(false);
      signal.addEventListener('abort', onAbort);
      this.confirmReq = { id, text, callId, resolve: done };
      this.push();
    });
    this.log(approved ? 'ok' : 'error', approved ? 'approved' : timedOut ? 'no answer in time' : 'not approved');
    if (approved && callId) this.tool({ kind: 'tool_approved', callId });
    if (!approved) {
      if (signal.aborted) throw new ToolError('stopped by the user', 'stopped');
      if (timedOut) {
        throw new ToolError(`no answer to the approval within ${CONFIRM_TIMEOUT_MS / 60_000} min (the user may be away): ${text}. Nothing was done; it can be asked again.`, 'timeout');
      }
      throw new ToolError(`the user did not approve: ${text}. Don't retry unless the user asks.`, 'denied');
    }
  }

  answerConfirm(id: string, approved: boolean): void {
    if (this.confirmReq?.id === id) this.confirmReq.resolve(approved);
  }

  private push(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, PUSH_MS);
  }

  private flush(): void {
    const head = this.state();
    const { items, dropped } = this.transcript.takeChanges();
    if (this.sidebars.size) {
      const msg: SidebarMessage = { type: 'patch', head, models: this.transcript.models, items, dropped };
      for (const p of this.sidebars) p.postMessage(msg);
    }
    // The overlay doesn't show the timeline: only send it what it shows, when that changed.
    const hud = JSON.stringify(head);
    if (hud === this.lastHud) return;
    this.lastHud = hud;
    void browser.tabs.query({ url: '*://practicum.yandex.ru/*' }).then((tabs) => {
      for (const t of tabs) {
        // Tabs without the content script (yet) just miss this update; they ask on load.
        browser.tabs.sendMessage(t.id!, { target: 'content', op: 'hud', args: head }).catch(() => {});
      }
    });
  }
}
