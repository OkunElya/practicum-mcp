import type { CodingState } from '../../content/ops/coding';
import type { InteractiveBlock } from '../../shared/lesson';
import { ToolError } from '../../shared/protocol';
import { sleep } from '../page';
import type { Tool, ToolContext } from '../router';
import { spec } from './spec';
import { block, currentLesson, fingerprint, refOf } from './theory';

const RETRIES = 3;
const PLATFORM_ERROR = /Неизвестная ошибка|\b\d{3}\.[a-zA-Z]+|took too long|timeout occur/i;

async function codingBlock(ctx: ToolContext, ref: string): Promise<{ lessonName: string; b: InteractiveBlock }> {
  const { lesson, block: b } = await block(ctx, ref);
  if (b.type !== 'QuizCoding') throw new ToolError(`${b.ref} is a ${b.type}, not a code exercise`);
  return { lessonName: lesson.name, b };
}

const graded = (b: InteractiveBlock) => !!b.node.content?.use_tests;

/**
 * Press run/check and wait for its loading status to go LOADING → done (the
 * status is shared by all blocks, but tools run one at a time). Retries the
 * platform's own failures.
 */
async function pressAndWait(ctx: ToolContext, b: InteractiveBlock, button: 'run' | 'check'): Promise<CodingState> {
  const key = button === 'run' ? 'runStatus' : 'checkStatus';
  const st = () => ctx.page.op<CodingState>('codingState', { block: refOf(b) });
  for (let attempt = 1; ; attempt++) {
    const before = await st();
    await ctx.page.op('codingPress', { block: refOf(b), button });
    let sawLoading = false;
    const after = await ctx.page.waitFor(
      button === 'run' ? 'the run to finish' : 'the check to finish',
      async () => {
        const now = await st();
        if (now[key] === 'LOADING') sawLoading = true;
        const changed = now.output !== before.output || now.notice?.text !== before.notice?.text || now.error !== before.error;
        const settled = now[key] !== 'LOADING' && (sawLoading || (changed && (now.hasResult || !!now.error || !!now.notice)));
        return settled ? now : null;
      },
      120_000,
      400,
    );
    // The site failed (e.g. a dead backend behind the balancer timed out) rather than the program.
    const siteMessage = after.error || (after.notice && PLATFORM_ERROR.test(after.notice.text) ? after.notice.text : '');
    const noResult = button === 'run' && !after.hasResult;
    const failed = after[key] === 'FAILURE' || !!siteMessage || noResult;
    if (!failed) return after;
    const why = siteMessage || (noResult ? 'the run showed no result' : `${button} request failed`);
    if (attempt >= RETRIES) throw new ToolError(`platform error after ${RETRIES} tries: ${why}. The site is unstable; try again later.`, 'platform');
    ctx.step(`platform error (${why}); retrying in ${3 * attempt} s`);
    await sleep(3000 * attempt, ctx.signal);
  }
}

function output(s: CodingState): string {
  if (!s.output) return 'The program printed nothing.';
  return `${s.outputIsError ? 'Output (error)' : 'Output'}:\n${s.output}`;
}

export const runCodeExercise: Tool = {
  spec: spec('run_code_exercise'),
  async run(args, ctx) {
    const { b } = await codingBlock(ctx, args.block);
    if (args.code) {
      ctx.step('writing the code');
      await ctx.page.op('codingSetCode', { block: refOf(b), code: args.code });
    }
    ctx.step('running');
    const s = await pressAndWait(ctx, b, 'run');
    const note = graded(b) ? ' This was a run, not a check: use check_code_exercise to submit.' : '';
    return `${output(s)}${note}`;
  },
};

export const checkCodeExercise: Tool = {
  spec: spec('check_code_exercise'),
  async describe(args, ctx) {
    const { lessonName, b } = await codingBlock(ctx, args.block);
    if (!graded(b)) throw new ToolError(`${b.ref} is a runnable example without tests; use run_code_exercise`);
    return `Check code exercise ${b.ref} in «${lessonName}»${args.code ? ' with new code' : ''} (counts as an attempt)`;
  },
  async run(args, ctx) {
    const { b } = await codingBlock(ctx, args.block);
    if (!graded(b)) throw new ToolError(`${b.ref} is a runnable example without tests; use run_code_exercise`);
    if (args.code) {
      ctx.step('writing the code');
      await ctx.page.op('codingSetCode', { block: refOf(b), code: args.code });
    }
    ctx.step('checking');
    const s = await pressAndWait(ctx, b, 'check');
    // The verdict is the saved attempt; wait until the new one is stored.
    const before = fingerprint(b.answer);
    const saved = await ctx.page.waitFor('the attempt to be saved', async () => {
      const { blocks } = await currentLesson(ctx);
      const now = blocks.find((x) => x.nodeId === b.nodeId)?.answer;
      return now && fingerprint(now) !== before ? now : null;
    }, 20_000, 1000);
    const result = (saved.user_answer as any)?.test_result?.stdout ?? {};
    const lines = [result.solved ? 'Solved ✓' : 'Not solved.'];
    const message = String(result.error ?? '').trim() || (s.notice?.type !== 'success' ? s.notice?.text : '') || '';
    if (message) lines.push(`Checker: ${message}`);
    if (s.notice?.type === 'success') lines.push(`Page: ${s.notice.text}`);
    if (s.output) lines.push(output(s));
    return lines.join('\n');
  },
};

export const resetCodeExercise: Tool = {
  spec: spec('reset_code_exercise'),
  async describe(args, ctx) {
    const { lessonName, b } = await codingBlock(ctx, args.block);
    return `Start code block ${b.ref} in «${lessonName}» over: its code goes back to the starter version`;
  },
  async run(args, ctx) {
    const { b } = await codingBlock(ctx, args.block);
    const starter = String(b.node.content?.panes?.[0]?.content ?? '');
    const norm = (x: string) => x.replace(/\r\n/g, '\n').trim();
    const st = () => ctx.page.op<CodingState>('codingState', { block: refOf(b) });
    const before = (await st()).code;
    await ctx.page.op('codingReset', { block: refOf(b) });
    const after = await ctx.page
      .waitFor('the editor to reset', async () => {
        const now = await st();
        return norm(now.code) === norm(starter) || norm(now.code) !== norm(before) ? now : null;
      }, 8000)
      .catch(st);
    const isStarter = norm(after.code) === norm(starter);
    const { blocks } = await currentLesson(ctx);
    const solved = (blocks.find((x) => x.nodeId === b.nodeId)?.answer?.user_answer as any)?.test_result?.stdout?.solved;
    return [
      isStarter ? `${b.ref} starts over with its starter code.` : `${b.ref} was reset, but the editor shows code that differs from the starter version:`,
      ...(isStarter ? [] : ['```', after.code, '```']),
      solved ? 'The earlier solved attempt is still recorded.' : '',
    ].filter(Boolean).join('\n');
  },
};
