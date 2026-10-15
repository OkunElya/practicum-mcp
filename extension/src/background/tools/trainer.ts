import type { TaskInfo } from '../../content/ops/read';
import type { TrainerSnapshot } from '../../content/ops/trainer';
import type { WhereInfo } from '../../content/ops/where';
import { ToolError } from '../../shared/protocol';
import { sleep } from '../page';
import type { Tool, ToolContext } from '../router';
import { waitForPage } from './nav';
import { spec } from './spec';
import { block, refOf } from './theory';
import { formatWhere } from './where';

const RETRIES = 3;
/** "Неизвестная ошибка 400.py.checkTask", "…408.previewTimeout": the platform, not the solution. */
const PLATFORM_ERROR = /Неизвестная ошибка|\b\d{3}\.[a-zA-Z]+/;

const snap = (ctx: ToolContext) => ctx.page.op<TrainerSnapshot>('trainerState');
const json = (v: unknown) => JSON.stringify(v ?? null);
const clip = (s: string, n = 3000) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Press a trainer button and wait until the action finished: the result
 * changed (`changed`), or the button went busy and came back, or a new
 * platform error appeared. Retries platform errors with backoff.
 */
async function pressAndWait(
  ctx: ToolContext,
  button: 'run' | 'check' | 'deploy',
  label: string,
  changed: (before: TrainerSnapshot, now: TrainerSnapshot) => boolean,
  timeoutMs: number,
  /** Only `changed` (or a platform error) ends the wait: no "button came back" shortcuts. */
  strict = false,
): Promise<{ before: TrainerSnapshot; after: TrainerSnapshot }> {
  for (let attempt = 1; ; attempt++) {
    const before = await snap(ctx);
    if (!before[button]) throw new ToolError(`there is no «${label}» button on this page`);
    await ctx.page.op('trainerPress', { button, label });
    const started = Date.now();
    let sawBusy = false;
    const after = await ctx.page.waitFor(
      `«${label}» to finish`,
      async () => {
        const now = await snap(ctx);
        const ready = now[button]?.enabled ?? true;
        if (!ready) sawBusy = true;
        if (now.errorText && now.errorText !== before.errorText && PLATFORM_ERROR.test(now.errorText)) return now;
        if (ready && changed(before, now)) return now;
        if (strict) return null;
        if (ready && sawBusy) return now;
        if (ready && Date.now() - started > 10_000) return now; // result identical to the previous one
        return null;
      },
      timeoutMs,
      700,
    );
    const failure = after.errorText && after.errorText !== before.errorText && PLATFORM_ERROR.test(after.errorText) ? after.errorText : '';
    if (!failure) return { before, after };
    if (attempt >= RETRIES) throw new ToolError(`platform error after ${RETRIES} tries: ${failure}. The site is unstable; try again later.`, 'platform');
    const wait = 3000 * attempt;
    ctx.step(`platform error (${failure}); retrying in ${wait / 1000} s`);
    await sleep(wait, ctx.signal);
  }
}

function runOutput(r: any): string {
  if (!r) return 'No output recorded.';
  const lines = [`exit code ${r.exit_code ?? '?'}${r.timeout ? ' (timed out)' : ''}${r.oom_killed ? ' (out of memory)' : ''}`];
  if (r.stdout) lines.push(`stdout:\n${clip(String(r.stdout))}`);
  if (r.stderr) lines.push(`stderr:\n${clip(String(r.stderr))}`);
  return lines.join('\n');
}

export const setCode: Tool = {
  spec: spec('set_code'),
  async run(args, ctx) {
    const r = await ctx.page.op<{ file: string; previousLength: number }>('setCode', { file: args.file, code: args.code });
    return `Wrote ${args.code.length} characters to ${r.file} (it had ${r.previousLength}). The user can undo this with Ctrl+Z in the editor.`;
  },
};

export const runCode: Tool = {
  spec: spec('run_code'),
  async run(_args, ctx) {
    const { after: s } = await pressAndWait(ctx, 'run', 'Выполнить код', (b, n) => json(b.serverless) !== json(n.serverless), 90_000);
    return `Run finished (not a check).\n${runOutput(s.serverless?.run_result)}`;
  },
};

export const checkTask: Tool = {
  spec: spec('check_task'),
  async describe(_args, ctx) {
    const t = await ctx.page.op<TaskInfo>('task');
    return `Check task ${t.index + 1}/${t.total} of «${t.lessonName}» (counts as an attempt)`;
  },
  async run(_args, ctx) {
    // A web_server check redeploys first and the buttons re-enable in between,
    // so the only reliable end signal is a new attempt id (or solved flipping).
    const attemptOf = (x: TrainerSnapshot) => x.webCheck?.attempt_id ?? x.serverless?.attempt_id ?? null;
    let { after: s } = await pressAndWait(
      ctx,
      'check',
      'Проверить',
      (b, n) => n.taskSolved !== b.taskSolved || (attemptOf(n) !== null && attemptOf(n) !== attemptOf(b)),
      180_000,
      true,
    );
    if (s.taskSolved && !s.next) {
      // The success banner and «Далее» render a moment after the verdict.
      s = await ctx.page.waitFor('the success banner', async () => {
        const now = await snap(ctx);
        return now.next ? now : null;
      }, 4000).catch(() => s);
    }
    const web = s.webCheck?.test_result;
    const srv = s.serverless?.test_result;
    const solved = s.taskSolved || web?.solved === true || srv?.stdout?.solved === true;
    const message = String(web?.message || srv?.stdout?.error || (!s.taskSolved ? s.errorText : '') || '').trim();
    const attempt = s.webCheck?.attempt_id ?? s.serverless?.attempt_id;
    const lines = [`${solved ? 'Solved ✓' : 'Not solved.'}${attempt ? ` (attempt ${attempt})` : ''}`];
    if (message) lines.push(`Checker: ${clip(message, 2000)}`);
    if (s.successBanner) lines.push(`Page: ${s.successBanner}`);
    else if (s.resultText) lines.push(`Result panel:\n${clip(s.resultText)}`);
    if (s.serverless?.run_result && !solved) lines.push(runOutput(s.serverless.run_result));
    if (s.next) lines.push(`Next: «${s.next.label}» (next_task)`);
    if (s.lessonSolved) lines.push('The lesson is solved.');
    return lines.join('\n');
  },
};

/** How many hints were shown per task (hints are revealed one at a time). */
const hintsShown = new Map<string, number>();

export const showHint: Tool = {
  spec: spec('show_hint'),
  async run(args, ctx) {
    if (args.block) {
      const { block: b } = await block(ctx, args.block);
      const hint = b.type === 'QuizCoding' ? String(b.node.content?.hint ?? '').trim() : '';
      if (!hint) throw new ToolError(`${b.ref} has no hint`);
      await ctx.page.op('codingPress', { block: refOf(b), button: 'hint' }).catch(() => {}); // show it on the page too
      return `Hint for ${b.ref}:\n${hint}`;
    }
    const t = await ctx.page.op<TaskInfo>('task');
    if (!t.task.hints.length) return 'This task has no hints.';
    const n = args.number ?? Math.min((hintsShown.get(t.task.id) ?? 0) + 1, t.task.hints.length);
    if (n < 1 || n > t.task.hints.length) throw new ToolError(`hint ${n} doesn't exist; this task has ${t.task.hints.length}`);
    await ctx.page.op('trainerPress', { button: 'hint', label: 'Подсказка' }).catch(() => {}); // show it to the user too
    hintsShown.set(t.task.id, Math.max(n, hintsShown.get(t.task.id) ?? 0));
    return `Hint ${n}/${t.task.hints.length}:\n${t.task.hints[n - 1]}`;
  },
};

export const nextTask: Tool = {
  spec: spec('next_task'),
  async run(args, ctx) {
    const before = await snap(ctx);
    const prev = args.direction === 'prev';
    const btn = prev ? before.prev : before.next;
    if (!btn) throw new ToolError(prev ? 'there is no previous task' : 'the «Далее» button appears only after the task is solved (check_task)');
    await ctx.page.op('trainerPress', { button: prev ? 'prev' : 'next', label: btn.label });
    ctx.step(`pressed «${btn.label}»`);
    const w = await waitForPage(ctx, 'the next task to load', (w: WhereInfo) => w.url !== before.url && (w.task?.id !== before.taskId || w.lesson?.id !== before.lessonId));
    return formatWhere(w);
  },
};

export const deploy: Tool = {
  spec: spec('deploy'),
  async run(_args, ctx) {
    const { after: s } = await pressAndWait(ctx, 'deploy', 'Задеплоить', (b, n) => !!n.webserver?.running && n.webserver.id !== b.webserver?.id, 120_000);
    if (!s.webserver?.running) throw new ToolError(`deploy did not start a server (status ${s.webserverStatus ?? 'unknown'})`, 'platform');
    return `Deployed. Preview: ${s.webserver.url} (fetch_preview reads it).`;
  },
};

export const fetchPreview: Tool = {
  spec: spec('fetch_preview'),
  async run(args, ctx) {
    const s = await snap(ctx);
    if (!s.webserver?.url) throw new ToolError('nothing is deployed; call deploy first');
    const url = new URL(String(args.path || '/'), s.webserver.url).href;
    if (!url.startsWith(s.webserver.url.replace(/\/$/, ''))) throw new ToolError('path must stay on the preview site');
    ctx.step(`GET ${url}`);
    const res = await fetch(url, { credentials: 'omit', signal: ctx.signal });
    const body = await res.text();
    if (res.status >= 500) return `HTTP ${res.status} (server error; the Django traceback may be in the page):\n${clip(body, 8000)}`;
    return `HTTP ${res.status}\n${clip(body, 8000)}`;
  },
};
