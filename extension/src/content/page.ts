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
