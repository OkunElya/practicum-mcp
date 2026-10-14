import { ToolError, type PageRequest, type PageResponse } from '../shared/protocol';
import { where } from './ops/where';

/** Page-level operations the background tool macros call. */
const OPS: Record<string, (args: any) => unknown> = {
  where,
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
}
