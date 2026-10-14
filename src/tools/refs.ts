import { ToolError } from './types';

/**
 * Short element handles ("e12") handed to the model instead of CSS selectors.
 * An element keeps its ref across snapshots, so the model's earlier references
 * stay valid as long as React reuses the DOM node.
 */
export class RefStore {
  private byRef = new Map<string, WeakRef<Element>>();
  private byEl = new WeakMap<Element, string>();
  private next = 1;

  refFor(el: Element): string {
    let ref = this.byEl.get(el);
    if (!ref) {
      ref = `e${this.next++}`;
      this.byEl.set(el, ref);
      this.byRef.set(ref, new WeakRef(el));
    }
    return ref;
  }

  peek(el: Element): string | undefined {
    return this.byEl.get(el);
  }

  resolve(ref: string): Element {
    const id = normalizeRef(ref);
    const el = this.byRef.get(id)?.deref();
    if (!el || !el.isConnected) {
      this.byRef.delete(id);
      throw new ToolError(`element ${id} is no longer on the page. call get_page to see current elements`);
    }
    return el;
  }
}

/** Accepts "e12", "[e12]", "ref=e12", "12". */
export function normalizeRef(ref: string): string {
  const m = String(ref).match(/e?(\d+)/i);
  if (!m) throw new ToolError(`"${ref}" is not an element ref. refs look like e12`);
  return `e${m[1]}`;
}
