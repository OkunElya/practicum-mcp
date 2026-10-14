import { ToolError, type PageRequest, type PageResponse } from '../shared/protocol';
import type { HudState } from '../shared/hud';
import { highlight, initHud, renderHud } from './hud';
import { press } from './input';
import { where } from './ops/where';
import { isVisible } from './page';

/**
 * Page-level operations the background tool macros call. Keep each one short
 * (well under 20 s): long waits are polled from the background, which survives
 * page loads.
 */
const OPS: Record<string, (args: any) => unknown> = {
  where,
  hud: (state: HudState) => renderHud(state),
  // used by the dev tools (build.mjs --dev)
  highlight: ({ selector, label }: { selector: string; label: string }) => {
    const el = [...document.querySelectorAll(selector)].find(isVisible);
    if (!el) throw new ToolError(`no visible element matches ${selector}`);
    el.scrollIntoView({ block: 'center' });
    highlight(el, label, 2000);
    return true;
  },
  press: async ({ selector, label }: { selector: string; label: string }) => {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find(isVisible);
    if (!el) throw new ToolError(`no visible element matches ${selector}`);
    await press(el, label);
    return true;
  },
};

async function handle(req: PageRequest): Promise<PageResponse> {
  const op = OPS[req.op];
  if (!op) return { ok: false, kind: 'tool', error: `unknown page op "${req.op}"` };
  try {
    return { ok: true, value: await op(req.args ?? {}) };
  } catch (e) {
    if (e instanceof ToolError) return { ok: false, kind: e.kind, error: e.message };
    console.error('[practicum-mcp]', e);
    return { ok: false, kind: 'tool', error: `${req.op}: ${(e as Error)?.message ?? e}` };
  }
}

// Injected on demand as well as by the manifest, so guard against running twice.
const flag = '__practicumMcpContent';
if (!(window as any)[flag]) {
  (window as any)[flag] = true;
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if ((msg as PageRequest)?.target !== 'content') return undefined;
    return handle(msg as PageRequest);
  });
  initHud();
}
