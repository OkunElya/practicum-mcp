/**
 * Visible, React-compatible input. Events are built with the page's own
 * constructors (`cloneInto` for the init dicts) so page listeners see ordinary
 * page objects. They are untrusted (`isTrusted: false`); the site accepted
 * that for every control during inspection.
 */
import { ToolError } from '../shared/protocol';
import { highlight } from './hud';
import { isVisible, pageWindow } from './page';

/** Pause after highlighting, so the user can see what is about to happen. */
const SHOW_MS = 350;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fire(target: Element, type: string, ctor: 'PointerEvent' | 'MouseEvent' | 'Event' | 'KeyboardEvent' | 'FocusEvent', init: Record<string, unknown>): void {
  const win = pageWindow();
  const event = new win[ctor](type, cloneInto({ bubbles: true, cancelable: true, composed: true, ...init }, window));
  target.dispatchEvent(event);
}

async function show(target: HTMLElement, label: string): Promise<void> {
  if (!isVisible(target)) throw new ToolError(`"${label}": the element is not visible on the page`);
  target.scrollIntoView({ block: 'center', inline: 'nearest' });
  await wait(150); // let smooth scrolling settle before measuring
  highlight(target, label);
  await wait(SHOW_MS);
}

/**
 * Click like a user: pointer and mouse down/up at the element's centre, then
 * click. react-aria pressables need the pointer sequence; plain React onClick
 * handlers only need the click.
 */
export async function press(target: HTMLElement, label: string): Promise<void> {
  await show(target, label);
  if ((target as HTMLButtonElement).disabled) throw new ToolError(`"${label}" is disabled`);
  const r = target.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  fire(target, 'pointerover', 'PointerEvent', pointer);
  fire(target, 'pointerdown', 'PointerEvent', { ...pointer, buttons: 1 });
  fire(target, 'mousedown', 'MouseEvent', { ...at, buttons: 1, detail: 1 });
  target.focus?.({ preventScroll: true });
  fire(target, 'pointerup', 'PointerEvent', { ...pointer, buttons: 0 });
  fire(target, 'mouseup', 'MouseEvent', { ...at, buttons: 0, detail: 1 });
  fire(target, 'click', 'MouseEvent', { ...at, buttons: 0, detail: 1 });
}

/**
 * Replace the text of an input/textarea so React notices: the native value
 * setter (seen through Xrays, which bypasses React's instance-level value
 * tracker) followed by an `input` event.
 */
export async function setText(target: HTMLInputElement | HTMLTextAreaElement, text: string, label: string): Promise<void> {
  await show(target, label);
  target.focus({ preventScroll: true });
  target.value = text;
  fire(target, 'input', 'Event', {});
  fire(target, 'change', 'Event', {});
}

export async function pressKey(target: HTMLElement, key: string): Promise<void> {
  const init = { key, code: key, keyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0 };
  fire(target, 'keydown', 'KeyboardEvent', init);
  fire(target, 'keyup', 'KeyboardEvent', init);
}

/** Right-click like a user (React `onContextMenu`), highlighted first. */
export async function contextMenu(target: HTMLElement, label: string): Promise<void> {
  await show(target, label);
  const r = target.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2, buttons: 2 };
  fire(target, 'pointerdown', 'PointerEvent', { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true });
  fire(target, 'mousedown', 'MouseEvent', at);
  fire(target, 'contextmenu', 'MouseEvent', at);
  fire(target, 'pointerup', 'PointerEvent', { ...at, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true });
  fire(target, 'mouseup', 'MouseEvent', { ...at, buttons: 0 });
}
