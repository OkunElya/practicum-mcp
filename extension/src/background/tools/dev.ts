import type { ToolSpec } from '../../shared/specs';
import { interactiveBlocks, type LessonJson, type SavedAnswer } from '../../shared/lesson';
import { sleep } from '../page';
import type { Tool } from '../router';

/**
 * Tools for exercising the framework in a live browser (approval prompt,
 * queue/Stop, highlight). Only included in `build.mjs --dev` builds.
 */
const devSpec = (s: Omit<ToolSpec, 'timeout_s'> & { timeout_s?: number }): ToolSpec => ({ timeout_s: 60, ...s });

export const DEV_TOOLS: Tool[] = [
  {
    spec: devSpec({
      name: 'dev_open_sidebar_tab',
      description: '[dev] Open the sidebar page in a tab (WebDriver can only drive tabs, and cannot navigate to moz-extension: URLs).',
      effect: 'read',
      params: {},
    }),
    async run() {
      const url = browser.runtime.getURL('sidebar.html');
      await browser.tabs.create({ url, active: false });
      return url;
    },
  },
  {
    spec: devSpec({
      name: 'dev_confirm',
      description: '[dev] Ask the user to approve a fake irreversible action; does nothing else.',
      effect: 'irrev',
      timeout_s: 150,
      params: { text: { type: 'string', description: 'what to show', default: 'Test approval (nothing will happen)' } },
    }),
    describe: async (args) => args.text,
    run: async () => 'approved (nothing was done)',
  },
  {
    spec: devSpec({
      name: 'dev_wait',
      description: '[dev] Wait N seconds, logging each second (for testing the queue and Stop).',
      effect: 'read',
      params: { seconds: { type: 'integer', description: 'seconds', default: 5 } },
    }),
    async run(args, ctx) {
      for (let i = 1; i <= args.seconds; i++) {
        await sleep(1000, ctx.signal);
        ctx.step(`waited ${i}/${args.seconds} s`);
      }
      return `waited ${args.seconds} s`;
    },
  },
  {
    spec: devSpec({
      name: 'dev_highlight',
      description: '[dev] Highlight the first visible element matching a CSS selector.',
      effect: 'read',
      params: { selector: { type: 'string', description: 'CSS selector' } },
    }),
    async run(args, ctx) {
      await ctx.page.op('highlight', { selector: args.selector, label: args.selector });
      return 'highlighted';
    },
  },
  {
    spec: devSpec({
      name: 'dev_blocks',
      description: '[dev] For each interactive block of the open lesson: is its element found on the page (read-only).',
      effect: 'read',
      params: {},
    }),
    async run(_args, ctx) {
      const { lesson, answers } = await ctx.page.op<{ lesson: LessonJson; answers: SavedAnswer[] }>('lesson', {});
      const blocks = interactiveBlocks(lesson.theory, answers);
      const found = await ctx.page.op<boolean[]>('renderedBlocks', { blocks: blocks.map((b) => ({ nodeId: b.nodeId, contentId: b.contentId })) });
      for (const [i, b] of blocks.entries()) if (found[i]) await ctx.page.op('highlightBlock', { block: { nodeId: b.nodeId, contentId: b.contentId }, label: b.ref });
      return blocks.map((b, i) => `${b.ref} ${b.type} ${b.answer ? 'answered' : 'open'}: ${found[i] ? 'found' : 'NOT found'}`).join('\n') || 'no interactive blocks';
    },
  },
];
