import { ToolError, type PageRequest, type PageResponse } from '../shared/protocol';

const PRACTICUM_TABS = '*://practicum.yandex.ru/*';

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
 * (re)loaded have no content script, so it's injected on demand once.
 */
export async function pageOp<T>(tabId: number, op: string, args?: unknown): Promise<T> {
  const req: PageRequest = { target: 'content', op, args };
  let res: PageResponse | undefined;
  try {
    res = await browser.tabs.sendMessage(tabId, req);
  } catch (e) {
    if (!/Receiving end does not exist/i.test(String(e))) throw e;
    await browser.tabs.executeScript(tabId, { file: '/content.js', runAt: 'document_idle' });
    res = await browser.tabs.sendMessage(tabId, req);
  }
  if (!res) throw new ToolError(`page op "${op}" got no answer from the tab`);
  if (!res.ok) throw new ToolError(res.error, res.kind);
  return res.value as T;
}
