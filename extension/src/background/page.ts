import { ToolError, type PageRequest, type PageResponse } from '../shared/protocol';

const PRACTICUM_TABS = '*://practicum.yandex.ru/*';
/** A single page op must answer within this; long waits poll from the background instead. */
const OP_TIMEOUT_MS = 20_000;

/** The Practicum tab tools act on: the active one if possible, else the most recently used. */
export async function targetTab(): Promise<browser.tabs.Tab> {
  const tabs = await browser.tabs.query({ url: PRACTICUM_TABS });
  if (!tabs.length) {
    throw new ToolError('no practicum.yandex.ru tab is open; ask the user to open one', 'no_tab');
  }
  const [focused] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs.find((t) => t.id === focused?.id) ?? tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

/**
 * Run a content-script op in the tab. Tabs opened before the extension was
 * (re)loaded have no content script, so it's injected on demand.
 */
export async function pageOp<T>(tabId: number, op: string, args?: unknown): Promise<T> {
  const req: PageRequest = { target: 'content', op, args };
  const send = () => withTimeout(browser.tabs.sendMessage(tabId, req) as Promise<PageResponse | undefined>, OP_TIMEOUT_MS, `page op "${op}"`);
  let res: PageResponse | undefined;
  try {
    res = await send();
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/Invalid tab ID/i.test(msg)) throw new ToolError('the Practicum tab was closed', 'no_tab');
    if (!/Receiving end does not exist/i.test(msg)) throw e;
    // document_idle: during a page load this waits until the new page is ready.
    await browser.tabs.executeScript(tabId, { file: '/content.js', runAt: 'document_idle' });
    res = await send();
  }
  if (!res) throw new ToolError(`page op "${op}" got no answer from the tab`);
  if (!res.ok) throw new ToolError(res.error, res.kind);
  return res.value as T;
}

/** Page access for one tool call, pinned to one tab so it follows full page loads. */
export class PageSession {
  constructor(
    readonly tabId: number,
    private readonly signal: AbortSignal,
  ) {}

  op<T>(op: string, args?: unknown): Promise<T> {
    this.checkStop();
    return pageOp<T>(this.tabId, op, args);
  }

  /**
   * Poll `probe` until it returns something truthy. Errors while polling are
   * expected during page loads and only reported if the wait times out.
   */
  async waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 400): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    for (;;) {
      this.checkStop();
      try {
        const v = await probe();
        if (v) return v;
      } catch (e) {
        if (e instanceof ToolError && (e.kind === 'no_tab' || e.kind === 'stopped')) throw e;
        lastError = String((e as Error)?.message ?? e);
      }
      if (Date.now() >= deadline) {
        throw new ToolError(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}${lastError ? ` (last error: ${lastError})` : ''}`, 'timeout');
      }
      await sleep(intervalMs, this.signal);
    }
  }

  private checkStop(): void {
    if (this.signal.aborted) throw new ToolError('stopped by the user', 'stopped');
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new ToolError('stopped by the user', 'stopped'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(`${what} did not answer within ${ms / 1000} s`, 'timeout')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
