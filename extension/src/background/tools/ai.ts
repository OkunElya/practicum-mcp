import type { AiState } from '../../content/ops/ai';
import { ToolError } from '../../shared/protocol';
import { sleep } from '../page';
import type { Tool } from '../router';
import { spec } from './spec';

const ANSWER_TIMEOUT_MS = 150_000;

export const askPlatformAi: Tool = {
  spec: spec('ask_platform_ai'),
  async describe(args) {
    const q = String(args.question);
    return `Ask Практикум ИИ: «${q.length > 120 ? `${q.slice(0, 120)}…` : q}»`;
  },
  async run(args, ctx) {
    const st = () => ctx.page.op<AiState>('aiState');
    let s = await st();
    if (!s.available) throw new ToolError('Практикум ИИ is not available on this page; open a lesson or a task');
    if (s.loading) throw new ToolError('the chat is still answering a previous question; try again shortly');

    // The first click sometimes only loads the onboarding, so retry until the panel is open.
    for (let i = 0; !s.open && i < 3; i++) {
      await ctx.page.op('aiOpen');
      s = await ctx.page.waitFor('the chat to open', async () => ((await st()).open ? st() : null), 5000).catch(st);
    }
    if (!s.open) throw new ToolError('could not open the AI chat');
    await sleep(500, ctx.signal);

    const before = (await st()).count;
    await ctx.page.op('aiSend', { question: args.question });
    ctx.step('sent; waiting for the answer');

    let reported = 0;
    const done = await ctx.page.waitFor(
      'the AI answer',
      async () => {
        const now = await st();
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
    // Suggestions arrive a few seconds after the answer; wait briefly for them.
    const withSuggestions = await ctx.page.waitFor('suggestions', async () => {
      const now = await st();
      return now.suggestions.length ? now : null;
    }, 12_000).catch(() => done);

    const lines = [done.last!.text.trim()];
    const suggestions = withSuggestions.suggestions.filter(Boolean);
    if (suggestions.length) lines.push('', 'Suggested follow-up questions:', ...suggestions.map((q) => `- ${q}`));
    return lines.join('\n');
  },
};
