/**
 * Code trainer (serverless and web_server): editor writes, buttons, and a
 * snapshot of the state the background polls to see when a run/check/deploy
 * has finished. Selectors and fields: docs/actions.md §D, §E.
 */
import { ToolError } from '../../shared/protocol';
import { highlight } from '../hud';
import { contextMenu, press, setText } from '../input';
import { isVisible, pageWindow, plain, state, text } from '../page';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RUN = 'button[aria-label="Выполнить код"]';

function btnState(el: Element | null): { label: string; enabled: boolean } | null {
  if (!el || !isVisible(el)) return null;
  return { label: text(el) || el.getAttribute('aria-label') || '', enabled: !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' };
}

const testId = (id: string) => [...document.querySelectorAll(`[data-test-id="${id}"]`)].find(isVisible) ?? null;
/** A button by its visible text or, for icon buttons, its aria-label. */
const byText = (re: RegExp) =>
  [...document.querySelectorAll('button')].find((b) => isVisible(b) && (re.test(text(b)) || re.test(b.getAttribute('aria-label') ?? ''))) ?? null;

export interface TrainerSnapshot {
  url: string;
  taskId: string | null;
  taskSolved: boolean;
  lessonId: string | null;
  lessonSolved: boolean;
  lessonType: string;
  run: { label: string; enabled: boolean } | null;
  check: { label: string; enabled: boolean } | null;
  deploy: { label: string; enabled: boolean } | null;
  next: { label: string; enabled: boolean } | null;
  prev: { label: string; enabled: boolean } | null;
  /** serverless run/check result (`oldPlaygroundResponse`) */
  serverless: any;
  /** web_server check result (`playgroundResponse`) */
  webCheck: any;
  webserver: { id: string; url: string; running: boolean } | null;
  webserverStatus: string | null;
  resultText: string;
  successBanner: string;
  errorText: string;
}

export function trainerState(): TrainerSnapshot {
  const t = state()?.trainerReducer;
  if (!t) throw new ToolError('this is not a code-trainer page');
  const ws = t.webserver;
  const result = document.querySelector('section.trainer-result__desktop, .trainer-result');
  const errors = [...document.querySelectorAll('.notification_type_error, [class*=notification_type_error], .trainer-result [class*=error]')].map(text).filter(Boolean);
  const body = text(document.body);
  const unknown = body.match(/Неизвестная ошибка[^.\n]{0,80}/)?.[0] ?? '';
  return {
    url: location.href,
    taskId: t.task?.id ? String(t.task.id) : null,
    taskSolved: !!t.task?.solved,
    lessonId: t.lesson?.id ? String(t.lesson.id) : null,
    lessonSolved: !!t.lesson?.solved,
    lessonType: String(t.lesson?.lesson_type ?? ''),
    run: btnState(document.querySelector(RUN)),
    check: btnState(testId('check-task-button')),
    deploy: btnState(testId('deploy-button')),
    next: btnState(testId('next-task-button')),
    prev: btnState(byText(/^Предыдущее задание$/)),
    serverless: plain(t.oldPlaygroundResponse) ?? null,
    webCheck: plain(t.playgroundResponse) ?? null,
    webserver: ws?.id ? { id: String(ws.id), url: String(ws.url ?? ''), running: !!ws.running } : null,
    webserverStatus: t.runWebserverLoadingStatus ? String(t.runWebserverLoadingStatus) : null,
    resultText: text(result).slice(0, 4000),
    successBanner: text(document.querySelector('.notification_type_success')).slice(0, 1000),
    errorText: [unknown, ...errors].filter(Boolean).join(' | ').slice(0, 500),
  };
}

const BUTTONS: Record<string, () => Element | null> = {
  run: () => document.querySelector(RUN),
  check: () => testId('check-task-button'),
  deploy: () => testId('deploy-button'),
  hint: () => testId('trainer-hint-button'),
  next: () => testId('next-task-button'),
  prev: () => byText(/^Предыдущее задание$/),
};

const THEORY = '.theory-panel__modal-overlay .theory-panel__theory_visible';

/** The lesson theory shown as a window over the trainer (when a task is opened without ?hideTheory=1). */
export function theoryOpen(): boolean {
  return isVisible(document.querySelector(THEORY));
}

/** Close the theory window: its bottom button, or the ✕ at the top. */
export async function closeTheory(): Promise<boolean> {
  if (!theoryOpen()) return false;
  const overlay = document.querySelector('.theory-panel__modal-overlay')!;
  const btn =
    [...overlay.querySelectorAll<HTMLElement>('[data-test-id="theory-panel-close-button"]')].find(isVisible) ??
    [...overlay.querySelectorAll<HTMLElement>('[data-test-id="modal-button-close"]')].find(isVisible);
  if (!btn) throw new ToolError('the theory window has no close button');
  await press(btn, 'close theory');
  for (let i = 0; i < 30 && theoryOpen(); i++) await sleep(100);
  if (theoryOpen()) throw new ToolError('the theory window did not close');
  return true;
}

export async function trainerPress({ button, label }: { button: string; label: string }): Promise<true> {
  await closeTheory(); // it covers the trainer's buttons
  const el = BUTTONS[button]?.();
  if (!el || !isVisible(el)) throw new ToolError(`the «${label}» button is not on the page`);
  if ((el as HTMLButtonElement).disabled) throw new ToolError(`the «${label}» button is disabled (something is still running?)`);
  await press(el as HTMLElement, label);
  return true;
}

// ---- files and editor ----

export const modelPath = (m: any) => String(m.uri.path).replace(/^\//, '');

export function findModel(file: string | undefined): any {
  const monaco = pageWindow().monaco;
  if (!monaco?.editor) throw new ToolError('no code editor on this page');
  const models: any[] = Array.from(monaco.editor.getModels());
  if (!file) {
    const visible = Array.from(monaco.editor.getEditors() as any[]).find((e) => e.getDomNode()?.offsetParent);
    return visible?.getModel() ?? models[0] ?? null;
  }
  const want = file.replace(/^\/+/, '');
  return models.find((m) => modelPath(m) === want) ?? models.find((m) => modelPath(m).endsWith(`/${want}`)) ?? null;
}

/** Path of a file-tree node from its nesting (`.tree-node` inside `.tree-node`). */
function treePath(nameEl: Element): string {
  const parts: string[] = [];
  for (let n = nameEl.closest('.tree-node'); n; n = n.parentElement?.closest('.tree-node') ?? null) {
    parts.unshift(text(n.querySelector(':scope > .tree-node__name, :scope > * > .tree-node__name') ?? n.querySelector('.tree-node__name')));
  }
  return parts.join('/');
}

function treeNames(): { el: HTMLElement; path: string }[] {
  return [...document.querySelectorAll<HTMLElement>('.files-tree .tree-node__name')].filter(isVisible).map((el) => ({ el, path: treePath(el) }));
}

/** Open a project file through the file tree (expanding folders), like a user. */
export async function openFile(file: string): Promise<any> {
  const want = file.replace(/^\/+/, '');
  const segments = want.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('/');
    const isFile = i === segments.length;
    if (!isFile && treeNames().some((n) => n.path.startsWith(`${prefix}/`))) continue; // folder already open
    // After switching tasks the tree re-renders a moment later, so wait for the node.
    let node = treeNames().find((n) => n.path === prefix);
    for (let i = 0; !node && i < 40; i++) {
      await sleep(200);
      node = treeNames().find((n) => n.path === prefix);
    }
    if (!node) throw new ToolError(`"${prefix}" is not in the project's file tree (to add a new file use create_file)`);
    await press(node.el, isFile ? `open ${want}` : `${prefix}/`);
    await sleep(400);
  }
  for (let i = 0; i < 30; i++) {
    const m = findModel(want);
    if (m) return m;
    await sleep(200);
  }
  throw new ToolError(`opened ${want} but its editor did not appear`);
}

const editorOf = (model: any) => Array.from(pageWindow().monaco.editor.getEditors() as any[]).find((e) => e.getModel() === model);
const shown = (editor: any) => !!editor?.getDomNode()?.offsetParent;
const norm = (s: string) => s.replace(/\r\n/g, '\n');

/** The platform's own copy of a project file (what deploy/check send). */
function storedPane(path: string): string | null {
  const panes: any[] = state()?.trainerReducer?.task?.panes ? Array.from(state().trainerReducer.task.panes) : [];
  const pane = panes.find((p) => p.name === path);
  return pane ? String(pane.content ?? '') : null;
}

export async function setCode({ file, code }: { file?: string; code: string }): Promise<{ file: string; previousLength: number }> {
  await closeTheory(); // it covers the editor and the file tree
  let model = findModel(file);
  if (!model && file) model = await openFile(file);
  if (!model) throw new ToolError('no editor model found');
  const path = modelPath(model);
  // The platform only records edits from the editor tab on screen; an edit in
  // a hidden tab changes the editor but not the files deploy/check send.
  if (!shown(editorOf(model)) && treeNames().length) await openFile(path);
  const editor = editorOf(model);
  if (!editor) throw new ToolError(`${path} is not open in an editor`);
  if (!shown(editor)) throw new ToolError(`could not bring ${path} to the front`);

  // getDomNode() hands back the raw page object; re-wrap it so calls with
  // content-script arguments (scrollIntoView options) are allowed.
  const raw = editor.getDomNode();
  const dom = raw ? (XPCNativeWrapper(raw) as HTMLElement) : null;
  if (dom) {
    dom.scrollIntoView({ block: 'center' });
    highlight(dom, `write ${path}`, 1200);
    await sleep(350);
  }
  const previousLength = String(model.getValue()).length;
  // The edit list must be a page object; the range comes from the page too.
  const edits = cloneInto([{ text: code, forceMoveMarkers: true }], window) as any;
  edits.wrappedJSObject[0].range = model.getFullModelRange();
  editor.pushUndoStop();
  editor.executeEdits('practicum-mcp', edits);
  editor.pushUndoStop(); // so the user can undo the whole replacement with Ctrl+Z
  if (norm(String(model.getValue())) !== norm(code)) throw new ToolError('the editor did not take the new code');

  // Multi-file projects keep their files in task.panes: make sure the edit landed there.
  if (storedPane(path) !== null) {
    for (let i = 0; i < 20 && norm(storedPane(path)!) !== norm(code); i++) await sleep(150);
    if (norm(storedPane(path)!) !== norm(code)) throw new ToolError(`the editor shows the new ${path}, but the platform did not record it (it would not be deployed or checked)`);
  }
  return { file: path, previousLength };
}

const storedPaths = (): string[] => {
  const panes: any[] = state()?.trainerReducer?.task?.panes ? Array.from(state().trainerReducer.task.panes) : [];
  return panes.map((p) => String(p.name));
};

/** Pick an item of the context menu that is showing (every tree node has its own, hidden menu). */
async function menuItem(text: string): Promise<HTMLElement> {
  for (let i = 0; i < 20; i++) {
    const item = [...document.querySelectorAll<HTMLElement>('.context-menu-default_visible .context-menu-default__item')].find(
      (x) => (x.textContent ?? '').trim() === text,
    );
    if (item) return item;
    await sleep(100);
  }
  throw new ToolError(`the file tree menu has no «${text}»`);
}

/** Right-click `parent` (a folder path, or '' for the project root), choose `what`, type `name`. */
async function createNode(parent: string, name: string, what: 'Новый файл' | 'Новая папка'): Promise<void> {
  let target: HTMLElement | null;
  if (parent) {
    target = treeNames().find((n) => n.path === parent)?.el ?? null;
  } else {
    target = document.querySelector<HTMLElement>('.files-tree__scrollable-wrapper');
  }
  if (!target) throw new ToolError(`folder "${parent}" is not in the file tree`);
  await contextMenu(target, parent ? `${parent}/` : 'project');
  await press(await menuItem(what), what);
  let input: HTMLInputElement | null = null;
  for (let i = 0; i < 20 && !input; i++) {
    await sleep(100);
    input = document.querySelector<HTMLInputElement>('input.files-tree__node-name-input');
  }
  if (!input) throw new ToolError('the name field did not appear');
  await setText(input, name, 'name');
  const form = input.closest('form') as HTMLFormElement | null;
  if (!form) throw new ToolError('the name field has no form');
  form.requestSubmit();
}

/**
 * Create a project file through the file tree («Новый файл»), creating missing
 * folders with «Новая папка». Some tasks require new files (e.g. about/urls.py).
 */
export async function createFile({ file }: { file: string }): Promise<{ file: string; created: boolean }> {
  await closeTheory();
  const path = file.replace(/^\/+/, '');
  if (storedPaths().includes(path)) return { file: path, created: false };
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join('/');
    const exists = storedPaths().some((p) => p.startsWith(`${folder}/`)) || treeNames().some((n) => n.path === folder);
    if (!exists) await createNode(parts.slice(0, i - 1).join('/'), parts[i - 1], 'Новая папка');
    await sleep(400);
  }
  // expand the parent folder chain so the folder node is on screen
  const parent = parts.slice(0, -1).join('/');
  for (let i = 1; parent && i <= parts.length - 1; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (treeNames().some((n) => n.path.startsWith(`${prefix}/`))) continue;
    const node = treeNames().find((n) => n.path === prefix);
    if (node) {
      await press(node.el, `${prefix}/`);
      await sleep(400);
    }
  }
  await createNode(parent, parts[parts.length - 1], 'Новый файл');
  for (let i = 0; i < 40; i++) {
    if (storedPaths().includes(path)) return { file: path, created: true };
    await sleep(150);
  }
  throw new ToolError(`created «${parts[parts.length - 1]}» but the project has no ${path}`);
}

/** Lesson tasks for opening a practice lesson at its first unsolved task. */
export function lessonTasks(): { id: string; solved: boolean }[] {
  const tasks = state()?.trainerReducer?.lesson?.tasks;
  return tasks ? Array.from(tasks as any[], (t) => ({ id: String(t.id), solved: !!t.solved })) : [];
}
