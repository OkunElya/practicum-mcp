import { ToolError } from '../shared/protocol';

/**
 * Access to the page's own objects from the isolated content script.
 *
 * Firefox hides page-set expandos (React fibers, `window.monaco`, the Redux
 * store) behind Xray wrappers; `wrappedJSObject` waives them. Values read
 * through a waived wrapper stay page objects, so `plain()` copies whatever a
 * tool returns into ordinary content-script data.
 */

/** The page's `window` without Xrays. */
export const pageWindow = (): any => window.wrappedJSObject;

let cachedStore: any = null;

/** The app's Redux store, found by walking React fibers down from `#mount`. */
export function store(): any {
  if (cachedStore) return cachedStore;
  const mount = document.getElementById('mount')?.wrappedJSObject;
  if (!mount) return null;
  const key = Object.keys(mount).find((k) => k.startsWith('__reactContainer$'));
  const stack = [key ? mount[key] : null];
  while (stack.length) {
    const f = stack.pop();
    if (!f) continue;
    if (typeof f.memoizedProps?.store?.getState === 'function') return (cachedStore = f.memoizedProps.store);
    if (f.sibling) stack.push(f.sibling);
    if (f.child) stack.push(f.child);
  }
  return null;
}

/** Current Redux state (a waived page object; read fields, then `plain()` them). */
export function state(): any {
  return store()?.getState() ?? null;
}

/**
 * Copy page data into content-script data. Uses the page's JSON (fast, and
 * the lesson/task objects are plain API JSON); falls back to a bounded walk
 * that skips DOM nodes and functions when the value has cycles.
 */
export function plain<T = any>(v: any): T {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  try {
    return JSON.parse(pageWindow().JSON.stringify(v));
  } catch {
    return walk(v, 8) as T;
  }
}

function walk(v: any, depth: number): unknown {
  if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
  if (depth <= 0 || typeof v.nodeType === 'number') return undefined;
  if (Array.isArray(v)) return Array.from(v as any[], (x) => walk(x, depth - 1));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) out[k] = walk(v[k], depth - 1);
  return out;
}

/** Rendered and not hidden by layout (0×0, display:none, inside a closed modal). */
export function isVisible(el: Element | null): el is HTMLElement {
  if (!el || !el.getClientRects().length) return false;
  const modal = el.closest('.skills-modal');
  return !modal || modal.classList.contains('skills-modal_visible');
}

export function byTestId(id: string): HTMLElement | null {
  const el = document.querySelector(`[data-test-id="${CSS.escape(id)}"]`);
  return isVisible(el) ? el : null;
}

export function text(el: Element | null | undefined): string {
  return ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Same-origin request as the page makes it (Firefox `content.fetch`: page
 * origin and cookies). Returns the body text; throws `platform` for the site's
 * own failures (5xx, 408, 429, network) and `tool` for the rest.
 */
export async function request(path: string, init: RequestInit = {}): Promise<string> {
  const content = (globalThis as any).content;
  const doFetch: typeof fetch = content?.fetch ? content.fetch.bind(content) : fetch;
  const what = `${init.method ?? 'GET'} ${path}`;
  let res: Response;
  try {
    res = await doFetch(new URL(path, location.origin).href, { credentials: 'include', ...init });
  } catch (e) {
    throw new ToolError(`network error for ${what}: ${(e as Error)?.message ?? e}`, 'platform');
  }
  const body = await res.text();
  if (!res.ok) {
    const kind = res.status >= 500 || res.status === 408 || res.status === 429 ? 'platform' : 'tool';
    throw new ToolError(`${what} → ${res.status} ${body.slice(0, 200)}`, kind);
  }
  return body;
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const body = await request(path, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  return (body ? JSON.parse(body) : null) as T;
}

/** Profession slug from the URL (/profile|learn|trainer/{slug}/…), else the user's latest one. */
export function professionSlug(): string | null {
  const m = location.pathname.match(/^\/(?:profile|learn|trainer)\/([^/]+)/);
  return m?.[1] ?? pageWindow().__preloadedData__?.me?.latestProfessionSlug ?? null;
}
