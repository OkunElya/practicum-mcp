import type { ToolSpec } from '../../shared/specs';
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
];
