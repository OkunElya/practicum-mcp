import { hasReactClickHandler } from './react';
import type { RefStore } from './refs';

/**
 * Compact page view for small models:
 *
 *   page: Users — /admin/users
 *   heading "Users" [h1]
 *   [e1] textbox "Search" value="ali"
 *   Alice | admin | active
 *   [e2] button "Edit"
 *   dialog "Confirm"
 *     [e3] button "Delete"
 *
 * Only interactive elements get refs. Generic wrappers (div soup) add no
 * lines or indentation; subtrees with nothing interactive collapse into one
 * text line.
 */

export interface Line {
  depth: number;
  text: string;
  /** Element the line was produced from (for find / diffing). */
  el: Element;
  interactive: boolean;
}

export interface SnapshotOptions {
  root?: Element;
  maxLines?: number;
  /** When true, a visible modal dialog replaces the root. */
  focusModal?: boolean;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'svg', 'SVG', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);

const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'clickable',
]);

/** Roles that get their own line and indent their contents. */
const CONTAINER_ROLES = new Set(['dialog', 'alertdialog', 'alert', 'navigation', 'form', 'menu', 'tablist', 'tabpanel']);

const NATIVE_INTERACTIVE_SELECTOR =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[role]';

const NAME_MAX = 60;
const TEXT_MAX = 160;

export function implicitRole(el: Element): string | null {
  const explicit = el.getAttribute('role')?.split(/\s+/)[0];
  if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
  const tag = el.tagName;
  switch (tag) {
    case 'A':
      return el.hasAttribute('href') ? 'link' : null;
    case 'BUTTON':
    case 'SUMMARY':
      return 'button';
    case 'INPUT': {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'hidden') return null;
      return 'textbox';
    }
    case 'TEXTAREA':
      return 'textbox';
    case 'SELECT':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      return 'heading';
    case 'DIALOG':
      return 'dialog';
    case 'NAV':
      return 'navigation';
    case 'FORM':
      return null; // forms add noise; their fields are listed anyway
    case 'IMG':
      return el.getAttribute('alt') ? 'img' : null;
  }
  if ((el as HTMLElement).isContentEditable && el.getAttribute('contenteditable') !== null) return 'textbox';
  return null;
}

export function isInteractive(el: Element): boolean {
  const role = implicitRole(el);
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (role) return false;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && tabindex !== '-1') return true;
  return hasReactClickHandler(el);
}

function roleOf(el: Element): string | null {
  const r = implicitRole(el);
  if (r) return r;
  return isInteractive(el) ? 'clickable' : null;
}

export function isHidden(el: Element, win: Window): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return true;
  if (el.tagName === 'DIALOG' && !(el as HTMLDialogElement).open) return true;
  const style = win.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
}

function clip(s: string, max: number): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Text of a subtree with spaces between text nodes and " | " between table cells. */
export function visibleText(el: Element, win: Window): string {
  const parts: string[] = [];
  const visit = (n: Node) => {
    if (n.nodeType === 3) {
      const t = n.nodeValue?.trim();
      if (t) parts.push(t);
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    if (isHidden(e, win)) return;
    if (e.tagName === 'TD' || e.tagName === 'TH') {
      if (parts.length) parts.push('|');
    }
    for (const c of e.childNodes) visit(c);
  };
  visit(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function accessibleName(el: Element, win: Window): string {
  const doc = el.ownerDocument;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = labelledby.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' ');
    if (t.trim()) return clip(t, NAME_MAX);
  }
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return clip(aria, NAME_MAX);

  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const labels = (el as HTMLInputElement).labels;
    if (labels?.length) {
      const t = [...labels].map((l) => labelTextExcludingControl(l)).join(' ');
      if (t.trim()) return clip(t, NAME_MAX);
    }
    const input = el as HTMLInputElement;
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(input.type) && input.value) return clip(input.value, NAME_MAX);
    const fallback = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
    return clip(fallback, NAME_MAX);
  }
  if (tag === 'IMG') return clip(el.getAttribute('alt') ?? '', NAME_MAX);

  const text = visibleText(el, win);
  if (text) return clip(text, NAME_MAX);

  // Icon-only buttons: look for something descriptive inside or on the element.
  const hint =
    el.getAttribute('title') ||
    el.querySelector('[aria-label]')?.getAttribute('aria-label') ||
    el.querySelector('svg title')?.textContent ||
    el.querySelector('img[alt]')?.getAttribute('alt') ||
    el.getAttribute('data-testid') ||
    '';
  return clip(hint, NAME_MAX);
}

function labelTextExcludingControl(label: HTMLLabelElement): string {
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('input,select,textarea').forEach((c) => c.remove());
  return clone.textContent ?? '';
}

function stateOf(el: Element, role: string): string[] {
  const s: string[] = [];
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const input = el as HTMLInputElement;
    if (role === 'checkbox' || role === 'radio') {
      if (input.checked) s.push('checked');
    } else if (role === 'textbox' || role === 'slider') {
      const type = input.type?.toLowerCase();
      if (type && !['text', 'textarea', 'range'].includes(type)) s.push(`type=${type}`);
      if (input.value) s.push(`value=${JSON.stringify(type === 'password' ? '•••' : clip(input.value, 80))}`);
      if (tag === 'TEXTAREA') s.push('multiline');
    }
    if (input.readOnly) s.push('readonly');
    if (input.required) s.push('required');
  } else if (tag === 'SELECT') {
    const sel = el as HTMLSelectElement;
    const chosen = [...sel.selectedOptions].map((o) => o.text.trim());
    if (chosen.length) s.push(`value=${JSON.stringify(chosen.join(', '))}`);
    const opts = [...sel.options].map((o) => o.text.trim()).filter(Boolean);
    s.push(`options: ${opts.slice(0, 8).join(', ')}${opts.length > 8 ? `, …+${opts.length - 8}` : ''}`);
  } else if (role === 'textbox') {
    const t = clip(el.textContent ?? '', 80);
    if (t) s.push(`value=${JSON.stringify(t)}`);
  } else if (role === 'heading') {
    s.push(`[${tag.startsWith('H') && tag.length === 2 ? tag.toLowerCase() : `h${el.getAttribute('aria-level') ?? '?'}`}]`);
  }
  const aria = (a: string) => el.getAttribute(a);
  if (aria('aria-checked') === 'true') s.push('checked');
  if (aria('aria-pressed') === 'true') s.push('pressed');
  if (aria('aria-selected') === 'true') s.push('selected');
  if (aria('aria-current') && aria('aria-current') !== 'false') s.push('current');
  if (aria('aria-expanded') === 'true') s.push('expanded');
  if (aria('aria-expanded') === 'false') s.push('collapsed');
  if (aria('aria-invalid') === 'true') s.push('invalid');
  if ((el as HTMLButtonElement).disabled || aria('aria-disabled') === 'true') s.push('disabled');
  return s;
}

export function describeInteractive(el: Element, refs: RefStore, win: Window): string {
  const role = roleOf(el) ?? 'clickable';
  const name = accessibleName(el, win);
  const parts = [`[${refs.refFor(el)}]`, role];
  if (name) parts.push(JSON.stringify(name));
  parts.push(...stateOf(el, role));
  return parts.join(' ');
}

function findModalRoot(doc: Document, win: Window): Element | null {
  const candidates = [...doc.querySelectorAll('[aria-modal="true"], dialog[open]')].filter((d) => {
    if (d.tagName === 'DIALOG') {
      try {
        if (!d.matches(':modal')) return false;
      } catch {
        return false;
      }
    }
    for (let e: Element | null = d; e; e = e.parentElement) if (isHidden(e, win)) return false;
    return true;
  });
  return candidates[candidates.length - 1] ?? null;
}

interface WalkResult {
  lines: Line[];
  /** true if every line is a plain text line, so the subtree can be collapsed. */
  onlyText: boolean;
}

export function collectLines(ctx: { doc: Document; win: Window; refs: RefStore }, opts: SnapshotOptions = {}): {
  lines: Line[];
  root: Element;
  modal: boolean;
} {
  const { doc, win, refs } = ctx;
  let root = opts.root ?? doc.body;
  let modal = false;
  if (!opts.root && opts.focusModal !== false) {
    const m = findModalRoot(doc, win);
    if (m) {
      root = m;
      modal = true;
    }
  }

  const walkChildren = (el: Element, depth: number): WalkResult => {
    const lines: Line[] = [];
    let onlyText = true;
    const skipText = el.tagName === 'LABEL' && !!(el as HTMLLabelElement).control;
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (skipText) continue;
        const t = clip(child.nodeValue ?? '', TEXT_MAX);
        if (t) lines.push({ depth, text: t, el, interactive: false });
      } else if (child.nodeType === 1) {
        const r = walk(child as Element, depth);
        lines.push(...r.lines);
        onlyText &&= r.onlyText;
      }
    }
    return { lines, onlyText };
  };

  const walk = (el: Element, depth: number): WalkResult => {
    if (isHidden(el, win)) return { lines: [], onlyText: true };
    const role = roleOf(el);

    if (isInteractive(el)) {
      const line: Line = { depth, text: describeInteractive(el, refs, win), el, interactive: true };
      // Clickable cards / rows can contain their own buttons; list those too.
      const nested = el.querySelector(NATIVE_INTERACTIVE_SELECTOR) ? walkChildren(el, depth + 1).lines.filter((l) => l.interactive) : [];
      return { lines: [line, ...nested], onlyText: false };
    }

    if (role === 'heading') {
      const name = accessibleName(el, win);
      const head: Line = { depth, text: `heading ${JSON.stringify(name)} ${stateOf(el, role).join(' ')}`.trim(), el, interactive: false };
      const nested = walkChildren(el, depth + 1).lines.filter((l) => l.interactive);
      return { lines: [head, ...nested], onlyText: false };
    }

    if (role === 'img') {
      return { lines: [{ depth, text: `img ${JSON.stringify(accessibleName(el, win))}`, el, interactive: false }], onlyText: false };
    }

    if (role && CONTAINER_ROLES.has(role)) {
      const name = accessibleName(el, win);
      const header = role === 'alert' ? `alert` : `${role}${name && name.length < 40 ? ` ${JSON.stringify(name)}` : ''}`;
      const inner = walkChildren(el, depth + 1);
      return { lines: [{ depth, text: header, el, interactive: false }, ...inner.lines], onlyText: false };
    }

    const inner = walkChildren(el, depth);
    if (inner.onlyText && inner.lines.length > 1) {
      const t = clip(visibleText(el, win), TEXT_MAX);
      return { lines: t ? [{ depth, text: t, el, interactive: false }] : [], onlyText: true };
    }
    return inner;
  };

  const { lines } = walk(root, 0);
  if (opts.maxLines !== undefined && lines.length > opts.maxLines) {
    const extra = lines.length - opts.maxLines;
    const kept = lines.slice(0, opts.maxLines);
    kept.push({ depth: 0, text: `…(${extra} more lines; use find or scroll to a section and call get_page ref=…)`, el: root, interactive: false });
    return { lines: kept, root, modal };
  }
  return { lines, root, modal };
}

export function renderLines(lines: Line[]): string {
  return lines.map((l) => `${'  '.repeat(l.depth)}${l.text}`).join('\n');
}

export function pageHeader(doc: Document, win: Window): string {
  const title = clip(doc.title || '(untitled)', 80);
  return `page: ${title} — ${win.location.pathname}${win.location.search}${win.location.hash}`;
}
