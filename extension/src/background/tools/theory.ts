import type { BlockRef, QuizStep } from '../../content/ops/theory';
import { describePlan, planAnswer, type QuizPlan } from '../../shared/answers';
import { findBlock, interactiveBlocks, type InteractiveBlock, type LessonJson, type SavedAnswer } from '../../shared/lesson';
import { ToolError } from '../../shared/protocol';
import type { Tool, ToolContext } from '../router';
import { spec } from './spec';

const SAVE_TIMEOUT_MS = 20_000;
/** Quiz types the platform lets you answer again. */
const RETRYABLE = new Set(['QuizCards', 'QuizChoice']);

async function currentLesson(ctx: ToolContext) {
  const { lesson, answers } = await ctx.page.op<{ lesson: LessonJson; answers: SavedAnswer[] }>('lesson', {});
  return { lesson, answers, blocks: interactiveBlocks(lesson.theory, answers) };
}

async function block(ctx: ToolContext, ref: string): Promise<{ lesson: LessonJson; block: InteractiveBlock }> {
  const { lesson, blocks } = await currentLesson(ctx);
  const b = findBlock(blocks, ref);
  if (!b) {
    throw new ToolError(`no block "${ref}" in «${lesson.name}»; blocks: ${blocks.map((x) => `${x.ref} ${x.type}`).join(', ') || 'none'}`);
  }
  return { lesson, block: b };
}

const refOf = (b: InteractiveBlock): BlockRef => ({ nodeId: b.nodeId, contentId: b.contentId });

const fingerprint = (a: SavedAnswer | undefined) => JSON.stringify(a ? [a.user_answer, a.attempts_count ?? 0] : null);

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
    await ctx.page.op('pressActionButton', { block: refOf(b), label });
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

export const answerQuiz: Tool = {
  spec: spec('answer_quiz'),
  async describe(args, ctx) {
    const { lesson, block: b } = await block(ctx, args.block);
    checkAnswerable(b, args.retry);
    const once = RETRYABLE.has(b.type) ? '' : ' (one attempt only)';
    return `Answer ${b.ref} in «${lesson.name}»${once}: ${describePlan(planAnswer(b, args.answer))}`;
  },
  async run(args, ctx) {
    const { block: b } = await block(ctx, args.block);
    checkAnswerable(b, args.retry);
    const plan = planAnswer(b, args.answer);
    const ref = refOf(b);
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
    const shown = await ctx.page.op<{ answered: boolean; correct: number; incorrect: number; text: string }>('quizState', { block: ref });
    const marks = shown.correct + shown.incorrect ? `\nThe page marks ${shown.correct} correct, ${shown.incorrect} incorrect.` : '';
    return `Answer to ${b.ref} submitted.${marks}\nThe quiz now shows:\n${shown.text}`;
  },
};
