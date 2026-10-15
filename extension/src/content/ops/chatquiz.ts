/**
 * Dialog quizzes (`QuizChat`), docs/actions.md C12. The bot asks, the student
 * clicks a reply `[data-test-id="quiz-chat-answer-button-{answerId}"]`; the
 * reply gets `quiz__chat-answer_used`, a verdict class (`quiz__item_correct` /
 * `_incorrect`) and inline feedback `.quiz__chat-answer-feedback`, and a
 * «Далее» button `[data-test-id="quiz-chat-next-button"]` appears. Only «Далее»
 * makes the bot post its next message (next question, or the same one again
 * after a wrong reply). Until then the other replies stay clickable.
 */
import { ToolError } from '../../shared/protocol';
import { press } from '../input';
import { isVisible } from '../page';
import { blockElement, type BlockRef } from './theory';

const PREFIX = 'quiz-chat-answer-button-';
const NEXT = '[data-test-id="quiz-chat-next-button"]';
const raw = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').trim();
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface ChatOption {
  id: string;
  text: string;
  used: boolean;
  verdict: 'correct' | 'incorrect' | null;
  feedback: string;
}

export interface ChatQuizState {
  options: ChatOption[];
  /** «Далее» is waiting: the last reply was given, the bot hasn't moved on. */
  next: boolean;
  /** Recent bubbles, oldest first: "bot: …" / "you: …". */
  transcript: string[];
  bubbles: number;
  answered: boolean;
  progress: number | null;
}

export function chatQuizState({ block }: { block: BlockRef }): ChatQuizState {
  const root = blockElement(block);
  const options = [...root.querySelectorAll<HTMLElement>(`[data-test-id^="${PREFIX}"]`)].filter(isVisible).map((b) => {
    const cls = b.classList;
    return {
      id: b.dataset.testId!.slice(PREFIX.length),
      text: flat(raw(b.querySelector('.quiz__chat-answer-content') ?? b)),
      used: cls.contains('quiz__chat-answer_used') || b.getAttribute('aria-disabled') === 'true',
      verdict: cls.contains('quiz__item_correct') ? ('correct' as const) : cls.contains('quiz__item_incorrect') ? ('incorrect' as const) : null,
      feedback: flat(raw(b.querySelector('.quiz__chat-answer-feedback'))),
    };
  });
  const bubbles = [...root.querySelectorAll('.chat__message')];
  const transcript = bubbles.slice(-6).map((m) => {
    const who = m.classList.contains('chat__message_side_right') ? 'you' : 'bot';
    const author = raw(m.querySelector('.chat__message-author'));
    let text = raw(m);
    if (author && text.startsWith(author)) text = text.slice(author.length).trim();
    return `${who}: ${flat(text).slice(0, 600)}`;
  });
  const quiz = root.matches('.quiz') ? root : (root.querySelector('.quiz') ?? root);
  const bar = root.querySelector<HTMLElement>('.quiz__progress-bar')?.style.getPropertyValue('--progress');
  return {
    options,
    next: isVisible(root.querySelector(NEXT)),
    transcript,
    bubbles: bubbles.length,
    answered: quiz.classList.contains('quiz_answered'),
    progress: bar ? Number(bar) : null,
  };
}

export async function chatQuizAnswer({ block, answerId, label }: { block: BlockRef; answerId: string; label: string }): Promise<true> {
  const root = blockElement(block);
  const btn = root.querySelector<HTMLElement>(`[data-test-id="${PREFIX}${CSS.escape(answerId)}"]`);
  if (!btn || !isVisible(btn)) throw new ToolError(`the reply «${label}» is not offered right now`);
  if (btn.getAttribute('aria-disabled') === 'true') throw new ToolError(`the reply «${label}» was already used`);
  await press(btn, label);
  return true;
}

export async function chatQuizNext({ block }: { block: BlockRef }): Promise<true> {
  const btn = blockElement(block).querySelector<HTMLElement>(NEXT);
  if (!btn || !isVisible(btn)) throw new ToolError('no «Далее» button in the chat quiz');
  await press(btn, 'Далее');
  return true;
}
