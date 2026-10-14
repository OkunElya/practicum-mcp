/**
 * Theory-lesson actions: find a block's element, then click through its UI
 * like a user (selectors from docs/actions.md §C).
 */
import { ToolError } from '../../shared/protocol';
import { press, setText } from '../input';
import { isVisible, text } from '../page';
import { getFiber } from '../react';

export type QuizStep =
  | { kind: 'select'; optionId: string; label: string }
  | { kind: 'choice'; question: string; questionIndex: number; option: string }
  | { kind: 'card'; card: string; section: string }
  | { kind: 'macaroni'; left: number; right: number; leftText: string; rightText: string }
  | { kind: 'text'; text: string }
  | { kind: 'submit' }
  | { kind: 'retry' };

export interface BlockRef {
  nodeId: string;
  contentId: string;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > end) throw new ToolError(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Does this fiber's props reference the block (by node id or content id)? */
function propsMatch(props: any, ref: BlockRef): boolean {
  if (!props || typeof props !== 'object') return false;
  if (props.id === ref.nodeId || props.id === ref.contentId) return true;
  for (const k of Object.keys(props)) {
    if (k === 'children') continue;
    const v = props[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.id === ref.nodeId || v.id === ref.contentId)) return true;
  }
  return false;
}

/**
 * The rendered element of a theory block. Blocks carry no DOM id, so we look
 * for the block wrapper whose React props reference the block. Blocks after
 * an unanswered blocking quiz aren't rendered at all.
 */
export function blockElement(ref: BlockRef): HTMLElement {
  const candidates = document.querySelectorAll<HTMLElement>('[class*="theory-viewer__block"]');
  for (const el of candidates) {
    let f = getFiber(el);
    for (let depth = 0; f && depth < 12; depth++, f = f.return) {
      if (propsMatch(f.memoizedProps, ref)) return el;
    }
  }
  throw new ToolError('this block is not on the page (yet): it may be below an unanswered blocking quiz or button, or the lesson in the tab is a different one');
}

/** Debug/selfcheck: which blocks of the given list are rendered. */
export function renderedBlocks({ blocks }: { blocks: BlockRef[] }): boolean[] {
  return blocks.map((b) => {
    try {
      blockElement(b);
      return true;
    } catch {
      return false;
    }
  });
}

function button(root: ParentNode, label: RegExp): HTMLButtonElement | null {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => isVisible(b) && label.test(text(b))) ?? null;
}

export async function quizStep({ block, step }: { block: BlockRef; step: QuizStep }): Promise<true> {
  const root = blockElement(block);
  switch (step.kind) {
    case 'select': {
      const input = root.querySelector<HTMLInputElement>(`input[value="${CSS.escape(step.optionId)}"]`);
      const label = input?.closest('label') as HTMLElement | null;
      if (!input || !label) throw new ToolError(`option «${step.label}» not found in the quiz`);
      if (!input.checked) await press(label, step.label);
      await waitFor(`option «${step.label}» to be selected`, () => input.checked);
      return true;
    }
    case 'choice': {
      const prompts = [...root.querySelectorAll<HTMLElement>('.quiz-form-matching__prompt')];
      const prompt = prompts.find((p) => norm(text(p)).includes(norm(step.question))) ?? prompts[step.questionIndex];
      const toggle = (prompt?.querySelector('button.rich-select__toggle-wrapper') ?? prompt?.parentElement?.querySelector('button.rich-select__toggle-wrapper')) as HTMLElement | null;
      if (!toggle) throw new ToolError(`no dropdown for «${step.question}»`);
      await press(toggle, step.question);
      const want = norm(step.option);
      const item = await waitFor(`option «${step.option}» in the dropdown`, () =>
        [...document.querySelectorAll<HTMLElement>('.rich-select__menu-portal button.rich-select__item[role=option]')].find((b) => isVisible(b) && norm(text(b)) === want),
      );
      await press(item, step.option);
      await waitFor('the dropdown to show the choice', () => norm(text(toggle)) === want || norm(text(toggle)).includes(want.slice(0, 20)));
      return true;
    }
    case 'card': {
      const want = norm(step.card);
      const card = [...root.querySelectorAll<HTMLElement>('.dragndrop__item')].find((c) => isVisible(c) && norm(text(c)).startsWith(want));
      if (!card) throw new ToolError(`card «${step.card}» not found`);
      const column = [...root.querySelectorAll<HTMLElement>('.quiz__section-list-wrapper')].find(
        (w) => norm(text(w.querySelector('.quiz__section-content-text'))) === norm(step.section),
      );
      if (!column) throw new ToolError(`group «${step.section}» not found`);
      if (column.contains(card)) return true;
      await press(card, step.card);
      await press((column.querySelector('.dragndrop__list-content') as HTMLElement | null) ?? column, step.section);
      await waitFor(`card «${step.card}» to move to «${step.section}»`, () =>
        [...column.querySelectorAll('.dragndrop__item')].some((c) => norm(text(c)).startsWith(want)),
      );
      return true;
    }
    case 'macaroni': {
      const lists = root.querySelectorAll('.MarkerMacaroni-List');
      if (lists.length < 2) throw new ToolError('matching columns not found');
      const opt = (list: Element, i: number) => list.querySelector(`input[value="${i}"]`)?.closest('label') as HTMLElement | null;
      const l = opt(lists[0], step.left);
      const r = opt(lists[1], step.right);
      if (!l || !r) throw new ToolError(`items «${step.leftText}» / «${step.rightText}» not found`);
      const lines = () => root.querySelectorAll('.MarkerMacaroni-Line').length;
      const before = lines();
      await press(l, step.leftText);
      await press(r, step.rightText);
      await waitFor('the connecting line', () => lines() > before);
      return true;
    }
    case 'text': {
      const area = root.querySelector<HTMLTextAreaElement>('textarea');
      if (!area) throw new ToolError('no answer field (already answered?)');
      await setText(area, step.text, 'answer');
      return true;
    }
    case 'submit': {
      const submit = button(root, /^(Проверить|Узнать ответ|Отправить|Ответить)$/i) ?? root.querySelector<HTMLButtonElement>('button[type=submit]');
      if (!submit) throw new ToolError('no submit button in the quiz');
      await waitFor('the submit button to be enabled', () => !submit.disabled, 3000).catch(() => {
        throw new ToolError('the submit button stays disabled: the answer is incomplete');
      });
      await press(submit, 'submit');
      return true;
    }
    case 'retry': {
      const reset = root.querySelector<HTMLElement>('button.quiz__reset') ?? button(root, /^(Начать заново|Ответить повторно)$/i);
      if (!reset) throw new ToolError('this quiz has no retry button');
      await press(reset, 'retry');
      // QuizCards asks inline "Начать тест заново?"; QuizChoice resets directly.
      await sleep(300);
      const again = root.querySelector('.quiz__reset-dialog') ? button(root.querySelector('.quiz__reset-dialog')!, /^Заново$/i) : null;
      if (again) await press(again, 'confirm retry');
      return true;
    }
  }
}

/**
 * What the block shows now: answered or not, how many rows/cards/pins the page
 * marked correct or incorrect (classes like `quiz-form-matching__prompt_correct`,
 * `quiz__macaroni-pin_status_correct`, `quiz__list-item_incorrect`), and its text.
 */
export function quizState({ block }: { block: BlockRef }): { answered: boolean; correct: number; incorrect: number; text: string } {
  const root = blockElement(block);
  const quiz = root.matches('.quiz') ? root : (root.querySelector('.quiz') ?? root);
  let correct = 0;
  let incorrect = 0;
  for (const el of quiz.querySelectorAll('[class*="correct"]')) {
    const classes = [...el.classList];
    if (classes.some((c) => /_(status_)?incorrect$/.test(c))) incorrect++;
    else if (classes.some((c) => /_(status_)?correct$/.test(c))) correct++;
  }
  return { answered: quiz.classList.contains('quiz_answered'), correct, incorrect, text: text(root).slice(0, 2000) };
}

export async function pressActionButton({ block, label }: { block: BlockRef; label: string }): Promise<true> {
  const btn =
    document.querySelector<HTMLElement>(`[data-test-id="theory-action-button-${CSS.escape(block.nodeId)}"]`) ??
    document.querySelector<HTMLElement>(`[data-test-id="theory-action-button-${CSS.escape(block.contentId)}"]`) ??
    (blockElement(block).querySelector('button') as HTMLElement | null);
  if (!btn || !isVisible(btn)) throw new ToolError(`button «${label}» is not on the page (yet)`);
  await press(btn, label);
  return true;
}

/** Press a control by data-test-id (next lesson, next task, check, …). */
export async function pressTestId({ testId, label }: { testId: string; label?: string }): Promise<string> {
  const el = [...document.querySelectorAll<HTMLElement>(`[data-test-id="${CSS.escape(testId)}"]`)].find(isVisible);
  if (!el) throw new ToolError(`button ${testId} is not on the page`);
  const shown = text(el);
  await press(el, label ?? shown ?? testId);
  return shown;
}
