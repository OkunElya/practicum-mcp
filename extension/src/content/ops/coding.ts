/**
 * Code exercises inside theory lessons (`QuizCoding`, docs/actions.md C11).
 * Each block has its own CodeMirror 5 editor (not Monaco). Examples
 * (`use_tests: false`) only have «Запустить код»; graded blocks also have
 * «Проверить» (`quiz-coding-check-code-button`) and «Подсказка».
 */
import { ToolError } from '../../shared/protocol';
import { highlight } from '../hud';
import { press } from '../input';
import { isVisible, state } from '../page';
import { blockElement, type BlockRef } from './theory';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** innerText keeps the line breaks that program output needs. */
const raw = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').trim();

function codeMirror(root: Element): any {
  const el = root.querySelector('.CodeMirror');
  const cm = el?.wrappedJSObject?.CodeMirror;
  if (!cm) throw new ToolError('the code editor of this block was not found');
  return cm;
}

export interface CodingState {
  code: string;
  /** theoryBlocksReducer loading statuses: null | LOADING | SUCCESS | FAILURE */
  runStatus: string | null;
  checkStatus: string | null;
  output: string;
  outputIsError: boolean;
  notice: { type: string; text: string } | null;
  /** A run result panel is shown (absent when the request itself failed). */
  hasResult: boolean;
  /** An error the site shows instead of a result, e.g. "Request took too long to execute; timeout occured". */
  error: string;
  canCheck: boolean;
}

export function codingState({ block }: { block: BlockRef }): CodingState {
  const root = blockElement(block);
  const tb = state()?.theoryBlocksReducer;
  const notice = root.querySelector('.quiz__coding-notification-container');
  const type = notice ? ([...notice.classList].find((c) => c.startsWith('notification_type_'))?.slice('notification_type_'.length) ?? '') : '';
  return {
    code: String(codeMirror(root).getValue()),
    runStatus: tb?.runCodingQuizLoadingStatus ?? null,
    checkStatus: tb?.checkCodingQuizLoadingStatus ?? null,
    output: raw(root.querySelector('.quiz__code-run-result-stdout')).slice(0, 6000),
    outputIsError: !!root.querySelector('[class*="quiz__code-run-result-stdout-content_error"]'),
    notice: notice && isVisible(notice) ? { type, text: raw(notice).slice(0, 2000) } : null,
    hasResult: !!root.querySelector('.quiz__code-run-result'),
    error: siteError(root),
    canCheck: !!root.querySelector('[data-test-id="quiz-coding-check-code-button"]'),
  };
}

/** Error boxes inside the block that aren't the program's own output (tracebacks). */
function siteError(root: Element): string {
  const boxes = [...root.querySelectorAll('[class*="error"]')].filter(
    (e) => isVisible(e) && !e.closest('.quiz__code-run-result') && !e.closest('.CodeMirror') && raw(e),
  );
  // innermost first, so a wrapper and its content aren't both reported
  const leaves = boxes.filter((e) => !boxes.some((o) => o !== e && e.contains(o)));
  return [...new Set(leaves.map(raw))].join(' | ').slice(0, 500);
}

export async function codingSetCode({ block, code }: { block: BlockRef; code: string }): Promise<{ previousLength: number }> {
  const root = blockElement(block);
  const cm = codeMirror(root);
  const wrapper = root.querySelector<HTMLElement>('.CodeMirror');
  if (wrapper) {
    wrapper.scrollIntoView({ block: 'center' });
    highlight(wrapper, 'write code', 1200);
    await sleep(350);
  }
  const previousLength = String(cm.getValue()).length;
  cm.setValue(code); // goes through react-codemirror2's change handlers, so React state follows
  await sleep(150);
  const norm = (s: string) => s.replace(/\r\n/g, '\n');
  if (norm(String(codeMirror(blockElement(block)).getValue())) !== norm(code)) throw new ToolError('the editor did not keep the new code');
  return { previousLength };
}

/** «Начать заново» and its inline confirmation «Начать заново? … Да / Отмена». */
export async function codingReset({ block }: { block: BlockRef }): Promise<true> {
  const root = blockElement(block);
  const reset = root.querySelector<HTMLElement>('[data-test-id="quiz-coding-reset-code-button"]');
  if (!reset || !isVisible(reset)) throw new ToolError('this block has no reset button');
  await press(reset, 'start over');
  let yes: HTMLElement | undefined;
  for (let i = 0; i < 20 && !yes; i++) {
    await sleep(100);
    yes = [...blockElement(block).querySelectorAll<HTMLElement>('button.quiz__reset-dialog-btn')].find((b) => isVisible(b) && raw(b) === 'Да');
  }
  if (!yes) throw new ToolError('the reset confirmation did not appear');
  await press(yes, 'confirm start over');
  return true;
}

export async function codingPress({ block, button }: { block: BlockRef; button: 'run' | 'check' | 'hint' }): Promise<true> {
  const root = blockElement(block);
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(isVisible);
  const find = {
    run: () => root.querySelector<HTMLElement>('[data-test-id="quiz-coding-run-code-button"]') ?? buttons.find((b) => /Запустить код/.test(b.textContent ?? '')),
    check: () => root.querySelector<HTMLElement>('[data-test-id="quiz-coding-check-code-button"]'),
    hint: () => buttons.find((b) => /Подсказка/.test(b.textContent ?? '')),
  }[button];
  const el = find();
  if (!el || !isVisible(el)) throw new ToolError(button === 'check' ? 'this block has no «Проверить» button (it is an example: use run_code_exercise)' : `no ${button} button in this block`);
  if ((el as HTMLButtonElement).disabled) throw new ToolError(`the ${button} button is disabled (still running?)`);
  await press(el, { run: 'run code', check: 'check', hint: 'hint' }[button]);
  return true;
}
