// Firefox content-script globals (Xray vision helpers).
declare function cloneInto<T>(obj: T, target: object, options?: { cloneFunctions?: boolean; wrapReflectors?: boolean }): T;
declare function exportFunction<T extends Function>(fn: T, target: object, options?: { defineAs?: string }): T;

interface Window {
  /** The page's own view of `window`, without Xray wrappers. */
  wrappedJSObject: any;
}

interface Element {
  /** The page's view of this node (React expandos such as `__reactFiber$…` are visible here). */
  wrappedJSObject: any;
}
