import type { BlockRef, QuizStep } from '../../content/ops/theory';
import { describePlan, planAnswer, type QuizPlan } from '../../shared/answers';
import { chatQuestions, findBlock, interactiveBlocks, type InteractiveBlock, type LessonJson, type SavedAnswer } from '../../shared/lesson';
import { ToolError } from '../../shared/protocol';
import { sleep } from '../page';
import type { Tool, ToolContext } from '../router';
import { spec } from './spec';

const SAVE_TIMEOUT_MS = 20_000;
/** Quiz types the platform lets you answer again. */
const RETRYABLE = new Set(['QuizCards', 'QuizChoice']);

export async function currentLesson(ctx: ToolContext) {
  const { lesson, answers } = await ctx.page.op<{ lesson: LessonJson; answers: SavedAnswer[] }>('lesson', {});
  return { lesson, answers, blocks: interactiveBlocks(lesson.theory, answers) };
}

export async function block(ctx: ToolContext, ref: string): Promise<{ lesson: LessonJson; block: InteractiveBlock }> {
  const { lesson, blocks } = await currentLesson(ctx);
  const b = findBlock(blocks, ref);
  if (!b) {
    throw new ToolError(`no block "${ref}" in «${lesson.name}»; blocks: ${blocks.map((x) => `${x.ref} ${x.type}`).join(', ') || 'none'}`);
  }
  return { lesson, block: b };
}

export const refOf = (b: InteractiveBlock): BlockRef => ({ nodeId: b.nodeId, contentId: b.contentId });

/**
 * Run a page op on a block; if the block isn't rendered yet, say which earlier
 * blocks hide it (a small model retries the same call when told only "not on the page").
 */
export async function onBlock<T>(ctx: ToolContext, b: InteractiveBlock, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ToolError) || !e.message.startsWith('this block is not on the page')) throw e;
    const { blocks } = await currentLesson(ctx);
    const i = blocks.findIndex((x) => x.nodeId === b.nodeId);
    const before = blocks.slice(0, Math.max(i, 0)).filter((x) => !x.answer && (x.type === 'ActionButton' || x.node.content?.blocking));
    if (!before.length) throw e;
    const how = (x: InteractiveBlock) => (x.type === 'ActionButton' ? `press_action_button block=${x.ref} («${x.node.content?.text ?? 'button'}»)` : `${x.ref} ${x.type}`);
    throw new ToolError(`${b.ref} is still hidden on the page: first deal with ${before.map(how).join(', ')}, then try ${b.ref} again`);
  }
}

export const fingerprint = (a: SavedAnswer | undefined) => JSON.stringify(a ? [a.user_answer, a.attempts_count ?? 0] : null);

/** Wait until the platform has stored a new submission for the block. */
async function waitSaved(ctx: ToolContext, b: InteractiveBlock): Promise<void> {
  const before = fingerprint(b.answer);
  await ctx.page.waitFor(
    'the answer to be saved',
    async () => {
      const { blocks } = await currentLesson(ctx);
      const now = blocks.find((x) => x.nodeId === b.nodeId)?.answer;
      return !!now && fingerprint(now) !== before;
    },
    SAVE_TIMEOUT_MS,
    1000,
  );
}

export const pressActionButton: Tool = {
  spec: spec('press_action_button'),
  async describe(args, ctx) {
    const { lesson, block: b } = await block(ctx, args.block);
    return `Press «${b.node.content?.text ?? 'button'}» (${b.ref}) in «${lesson.name}»`;
  },
  async run(args, ctx) {
    const { block: b } = await block(ctx, args.block);
    if (b.type !== 'ActionButton') throw new ToolError(`${b.ref} is a ${b.type}, not a button; use answer_quiz`);
    if (b.answer) return `${b.ref} was already pressed; its content is visible.`;
    const label = String(b.node.content?.text ?? 'button');
    await onBlock(ctx, b, () => ctx.page.op('pressActionButton', { block: refOf(b), label }));
    await waitSaved(ctx, b);
    return `Pressed «${label}» (${b.ref}). The content after it is now shown; read_lesson to continue.`;
  },
};

function steps(plan: QuizPlan): { step: QuizStep; text: string }[] {
  switch (plan.type) {
    case 'QuizSelect':
      return plan.optionIds.map((optionId, i) => ({ step: { kind: 'select', optionId, label: plan.labels[i] }, text: `select «${plan.labels[i]}»` }));
    case 'QuizChoice':
      return plan.picks.map((p) => ({ step: { kind: 'choice', question: p.question, questionIndex: p.questionIndex, option: p.option }, text: `${p.question} → ${p.option}` }));
    case 'QuizCards':
      return plan.moves.map((m) => ({ step: { kind: 'card', card: m.card, section: m.section }, text: `${m.card} → ${m.section}` }));
    case 'QuizMacaroni':
      return plan.pairs.map((p) => ({ step: { kind: 'macaroni', left: p.left, right: p.right, leftText: p.leftText, rightText: p.rightText }, text: `${p.leftText} → ${p.rightText}` }));
    case 'QuizText':
      return [{ step: { kind: 'text', text: plan.text }, text: `type «${plan.text}»` }];
  }
}

function checkAnswerable(b: InteractiveBlock, retry: boolean): void {
  if (!b.answer) return;
  if (!RETRYABLE.has(b.type)) throw new ToolError(`${b.ref} is already answered and this quiz type allows one attempt only`);
  if (!retry) throw new ToolError(`${b.ref} is already answered; pass retry=true to answer it again`);
}

// ---- QuizChat: one reply per call, on the question currently on screen ----

type ChatOption = { id: string; text: string; used: boolean; verdict: 'correct' | 'incorrect' | null; feedback: string };
type ChatState = { options: ChatOption[]; next: boolean; transcript: string[]; bubbles: number; answered: boolean; progress: number | null };

const norm = (x: string) => x.replace(/\s+/g, ' ').trim().toLowerCase();
const chatState = (ctx: ToolContext, b: InteractiveBlock) => ctx.page.op<ChatState>('chatQuizState', { block: refOf(b) });
const optionIds = (st: ChatState) => st.options.map((o) => o.id).join(',');

/** Press «Далее» and wait for the bot's next message (or the end of the dialog). */
async function chatAdvance(ctx: ToolContext, b: InteractiveBlock, st: ChatState): Promise<ChatState> {
  await ctx.page.op('chatQuizNext', { block: refOf(b) });
  return ctx.page.waitFor('the bot to post its next message', async () => {
    const x = await chatState(ctx, b);
    if (x.next) return null;
    const fresh = optionIds(x) !== optionIds(st) || x.options.every((o) => !o.used);
    return fresh || x.answered || !x.options.length ? x : null;
  }, 20_000, 400);
}

/** The option the model picked ("2" or the reply text), among the replies on screen. */
function chatPick(st: ChatState, answer: string): ChatOption {
  if (!st.options.length) throw new ToolError(st.answered ? 'the chat quiz is already finished' : 'the chat quiz offers no replies right now');
  const a = answer.trim();
  const i = /^\d+$/.test(a) ? Number(a) - 1 : st.options.findIndex((o) => norm(o.text) === norm(a) || norm(o.text).startsWith(norm(a)));
  const option = st.options[i];
  if (!option) throw new ToolError(`"${answer}" is not one of the replies on screen: ${st.options.map((o, j) => `${j + 1}. ${o.text}`).join('; ')}`);
  if (option.used) throw new ToolError(`reply ${i + 1} «${option.text}» was already given; pick another`);
  return option;
}

function describeChat(st: ChatState): string[] {
  const lines = [`Bot: ${(st.transcript.filter((t) => t.startsWith('bot:')).pop() ?? '').slice(5)}`];
  if (st.options.length) {
    lines.push('Replies (answer_quiz uses these numbers):');
    st.options.forEach((o, j) => lines.push(`  ${j + 1}. ${o.text}${o.used ? ' (already tried)' : ''}`));
  } else lines.push(st.answered ? 'The chat quiz is finished.' : 'No replies are offered.');
  return lines;
}

async function answerChat(ctx: ToolContext, b: InteractiveBlock, answer: string): Promise<string> {
  let st = await chatState(ctx, b);
  // A previous reply was left without «Далее»: move on first, so the reply goes to the question on screen.
  if (st.next) {
    ctx.step('«Далее» (previous reply was not followed through)');
    st = await chatAdvance(ctx, b, st);
  }
  const option = chatPick(st, answer);
  ctx.step(`reply «${option.text}»`);
  await ctx.page.op('chatQuizAnswer', { block: refOf(b), answerId: option.id, label: option.text });
  const after = await ctx.page.waitFor('the verdict', async () => {
    const x = await chatState(ctx, b);
    const o = x.options.find((y) => y.id === option.id);
    return o?.used || x.next ? x : null;
  }, 15_000, 300);
  const mine = after.options.find((o) => o.id === option.id);
  const verdict = mine?.verdict === 'correct' ? 'Correct.' : mine?.verdict === 'incorrect' ? 'Not correct.' : 'Reply given.';
  const lines = [`${verdict}${mine?.feedback ? ` ${mine.feedback}` : ''}`];

  let next = after;
  if (after.next) next = await chatAdvance(ctx, b, after);
  await sleep(600, ctx.signal);
  next = await chatState(ctx, b);
  if (next.options.length && optionIds(next) === optionIds(st)) lines.push('The bot asks the same question again.');
  else if (next.options.length) lines.push('Next question:');
  lines.push(...describeChat(next));
  return lines.join('\n');
}

export const answerQuiz: Tool = {
  spec: spec('answer_quiz'),
  async describe(args, ctx) {
    const { lesson, block: b } = await block(ctx, args.block);
    if (b.type === 'QuizChat') {
      const st = await chatState(ctx, b);
      if (st.next) return `Chat quiz ${b.ref} of «${lesson.name}»: press «Далее», then reply «${args.answer}» to the next question`;
      const option = chatPick(st, args.answer);
      const q = chatQuestions(b.node.content).find((x) => x.options.some((o) => o.id === option.id));
      return `Reply in chat quiz ${b.ref} of «${lesson.name}»: ${q ? `«${q.text.replace(/\s+/g, ' ').slice(-80)}» → ` : ''}«${option.text}»`;
    }
    checkAnswerable(b, args.retry);
    const once = RETRYABLE.has(b.type) ? '' : ' (one attempt only)';
    return `Answer ${b.ref} in «${lesson.name}»${once}: ${describePlan(planAnswer(b, args.answer))}`;
  },
  async run(args, ctx) {
    const { block: b } = await block(ctx, args.block);
    if (b.type === 'QuizChat') return onBlock(ctx, b, () => answerChat(ctx, b, args.answer));
    checkAnswerable(b, args.retry);
    const plan = planAnswer(b, args.answer);
    const ref = refOf(b);
    // The first step finds the block on the page: a hidden one fails here, before anything is clicked.
    await onBlock(ctx, b, () => ctx.page.op('quizState', { block: ref }));
    if (b.answer) {
      ctx.step('starting the quiz again');
      await ctx.page.op('quizStep', { block: ref, step: { kind: 'retry' } });
    }
    for (const s of steps(plan)) {
      ctx.step(s.text);
      await ctx.page.op('quizStep', { block: ref, step: s.step });
    }
    ctx.step('submitting');
    await ctx.page.op('quizStep', { block: ref, step: { kind: 'submit' } });
    await waitSaved(ctx, b);
    // Result marks (green/red rows, pins) render a moment after the save.
    type Shown = { answered: boolean; correct: number; incorrect: number; text: string };
    const shown = await ctx.page
      .waitFor('the result marks', async () => {
        const st = await ctx.page.op<Shown>('quizState', { block: ref });
        return st.answered && st.correct + st.incorrect > 0 ? st : null;
      }, 3000, 300)
      .catch(() => ctx.page.op<Shown>('quizState', { block: ref }));
    const marks = shown.correct + shown.incorrect ? `\nThe page marks ${shown.correct} correct, ${shown.incorrect} incorrect.` : '';
    return `Answer to ${b.ref} submitted.${marks}\nThe quiz now shows:\n${shown.text}`;
  },
};
