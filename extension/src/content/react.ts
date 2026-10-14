/**
 * Read-only access to React internals attached to DOM nodes.
 *
 * React (16 through 19) stores the fiber and current props on each host DOM
 * node under randomized keys: `__reactFiber$<rand>` and `__reactProps$<rand>`
 * (`__reactInternalInstance$` in React <=16). In a Firefox isolated-world
 * content script those expandos are hidden by Xray wrappers, so we go through
 * `wrappedJSObject` when it exists; in the MAIN world it is undefined and we
 * read the node directly.
 */

type Fiber = {
  type: any;
  tag: number;
  return: Fiber | null;
  memoizedProps: Record<string, any> | null;
  stateNode: any;
};

function raw(el: Element): any {
  return (el as any).wrappedJSObject ?? el;
}

function findKey(obj: any, prefixes: string[]): string | undefined {
  for (const k of Object.keys(obj)) {
    if (prefixes.some((p) => k.startsWith(p))) return k;
  }
  return undefined;
}

export function getFiber(el: Element): Fiber | null {
  const o = raw(el);
  const k = findKey(o, ['__reactFiber$', '__reactInternalInstance$']);
  return k ? o[k] : null;
}

export function getReactProps(el: Element): Record<string, any> | null {
  const o = raw(el);
  const k = findKey(o, ['__reactProps$']);
  if (k) return o[k];
  return getFiber(el)?.memoizedProps ?? null;
}

const CLICK_PROPS = ['onClick', 'onMouseDown', 'onPointerDown', 'onMouseUp', 'onPointerUp'];

/** True for elements like `<div onClick>` that look inert in the DOM. */
export function hasReactClickHandler(el: Element): boolean {
  const props = getReactProps(el);
  return !!props && CLICK_PROPS.some((p) => typeof props[p] === 'function');
}

export function isReactPage(doc: Document): boolean {
  const win = doc.defaultView as any;
  const w = win?.wrappedJSObject ?? win;
  if (w?.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers?.size) return true;
  const root = doc.querySelector('#root, #app, #__next, [data-reactroot]') ?? doc.body?.firstElementChild;
  if (!root) return false;
  const r = raw(root);
  return !!findKey(r, ['__reactContainer$', '__reactFiber$', '_reactRootContainer']);
}

function componentName(type: any): string | null {
  if (!type || typeof type === 'string') return null;
  const n =
    type.displayName ||
    type.name ||
    type.render?.displayName || // forwardRef
    type.render?.name ||
    type.type?.displayName || // memo
    type.type?.name;
  return n || null;
}

/** Nearest user components, innermost first, e.g. ["SaveButton", "Toolbar", "EditorPage"]. */
export function componentStack(el: Element, limit = 8): string[] {
  const out: string[] = [];
  for (let f = getFiber(el); f && out.length < limit; f = f.return) {
    const name = componentName(f.type);
    if (name && out[out.length - 1] !== name) out.push(name);
  }
  return out;
}

/** Props of the nearest user component above `el`, i.e. what the app author wrote. */
export function nearestComponentProps(el: Element): { name: string; props: Record<string, any> } | null {
  for (let f = getFiber(el); f; f = f.return) {
    const name = componentName(f.type);
    if (name) return { name, props: f.memoizedProps ?? {} };
  }
  return null;
}

/** JSON-ish, size-bounded rendering of props for the model. */
export function summarizeValue(v: any, depth = 2, budget = { left: 800 }): string {
  if (budget.left <= 0) return '…';
  let s: string;
  if (v === null || v === undefined) s = String(v);
  else if (typeof v === 'function') s = `ƒ ${v.name || 'fn'}`;
  else if (typeof v === 'string') s = JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v);
  else if (typeof v !== 'object') s = String(v);
  else if (v.$$typeof) s = '<ReactElement>';
  else if (typeof Node !== 'undefined' && v instanceof Node) s = `<${v.nodeName.toLowerCase()}>`;
  else if (depth <= 0) s = Array.isArray(v) ? `[…${v.length}]` : '{…}';
  else if (Array.isArray(v)) {
    const items = v.slice(0, 5).map((x) => summarizeValue(x, depth - 1, budget));
    s = `[${items.join(', ')}${v.length > 5 ? `, …+${v.length - 5}` : ''}]`;
  } else {
    const keys = Object.keys(v).filter((k) => k !== 'children');
    const parts = keys.slice(0, 12).map((k) => `${k}: ${summarizeValue(v[k], depth - 1, budget)}`);
    s = `{${parts.join(', ')}${keys.length > 12 ? ', …' : ''}}`;
  }
  budget.left -= s.length;
  return s;
}
