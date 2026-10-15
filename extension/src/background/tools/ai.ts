import type { AiState } from '../../content/ops/ai';
import { ToolError } from '../../shared/protocol';
import { sleep } from '../page';
import type { Tool, ToolContext } from '../router';
import { spec } from './spec';

const ANSWER_TIMEOUT_MS = 150_000;

export const askPlatformAi: Tool = {
  spec: spec('ask_platform_ai'),
  async describe(args) {
    const q = String(args.question);
    return `Ask Практикум ИИ: «${q.length > 120 ? `${q.slice(0, 120)}…` : q}»`;
  },
  async run(args, ctx) {
    const s = await ctx.page.op<AiState>('aiState');
    if (!s.available) throw new ToolError('Практикум ИИ is not available on this page; open a lesson or a task');
    if (s.loading) throw new ToolError('the chat is still answering a previous question; try again shortly');

    const wasOpen = s.open;
    try {
      return await ask(args.question, s, ctx);
    } finally {
      // Don't leave a panel the tool opened covering the page; the user's own stays.
      if (!wasOpen) {
        await ctx.page.op('aiClose').catch(() => {});
        await ctx.page.waitFor('the chat to close', async () => !(await ctx.page.op<AiState>('aiState')).open, 4000).catch(() => {});
      }
    }
  },
};

async function ask(question: string, initial: AiState, ctx: ToolContext): Promise<string> {
  const st = () => ctx.page.op<AiState>('aiState');
  let s = initial;
  // The first click sometimes only loads the onboarding, so retry until the panel is open.
  for (let i = 0; !s.open && i < 3; i++) {
    await ctx.page.op('aiOpen');
    s = await ctx.page.waitFor('the chat to open', async () => ((await st()).open ? st() : null), 5000).catch(st);
  }
  if (!s.open) throw new ToolError('could not open the AI chat');
  await sleep(500, ctx.signal);

  const start = await st();
  const before = start.count;
  await ctx.page.op('aiSend', { question });
  ctx.step('sent; waiting for the answer');

  let reported = 0;
  const done = await ctx.page.waitFor(
    'the AI answer',
    async () => {
      const now = await st();
      // The site refuses now and then («Сервис временно недоступен…»): stop waiting and report it.
      if (now.error && now.error !== start.error) return now;
      const answer = now.count > before && now.last?.type === 'ai' ? now.last : null;
      if (answer?.streaming && answer.text.length - reported > 400) {
        reported = answer.text.length;
        ctx.step(`receiving… ${reported} characters`);
      }
      return answer && !answer.streaming && !now.loading ? now : null;
    },
    ANSWER_TIMEOUT_MS,
    800,
  );
  if (done.error && done.error !== start.error && !(done.count > before && done.last?.type === 'ai')) {
    throw new ToolError(`Практикум ИИ refused: ${done.error}`, 'platform');
  }
  // Suggestions arrive a few seconds after the answer; wait briefly for them.
  const withSuggestions = await ctx.page.waitFor('suggestions', async () => {
    const now = await st();
    return now.suggestions.length ? now : null;
  }, 12_000).catch(() => done);

  const lines = [done.last!.text.trim()];
  const suggestions = withSuggestions.suggestions.filter(Boolean);
  if (suggestions.length) lines.push('', 'Suggested follow-up questions:', ...suggestions.map((q) => `- ${q}`));
  return lines.join('\n');
}

export const resetPlatformAiChat: Tool = {
  spec: spec('reset_platform_ai_chat'),
  async describe() {
    return 'Start a new Практикум ИИ chat in this lesson (the current chat is deleted)';
  },
  async run(_args, ctx) {
    const st = () => ctx.page.op<AiState>('aiState');
    let s = await st();
    if (!s.available) throw new ToolError('Практикум ИИ is not available on this page');
    const wasOpen = s.open;
    try {
      for (let i = 0; !s.open && i < 3; i++) {
        await ctx.page.op('aiOpen');
        s = await ctx.page.waitFor('the chat to open', async () => ((await st()).open ? st() : null), 5000).catch(st);
      }
      if (!s.open) throw new ToolError('could not open the AI chat');
      if (!s.chatId) return 'The chat is already empty.';
      await ctx.page.op('aiNewChat');
      await ctx.page.waitFor('the chat to be cleared', async () => !(await st()).chatId, 15_000);
      return 'Started a new, empty chat.';
    } finally {
      if (!wasOpen) await ctx.page.op('aiClose').catch(() => {});
    }
  },
};
