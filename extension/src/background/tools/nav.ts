import type { WhereInfo } from '../../content/ops/where';
import type { LessonJson, SavedAnswer } from '../../shared/lesson';
import { interactiveBlocks } from '../../shared/lesson';
import { ToolError } from '../../shared/protocol';
import type { Tool, ToolContext } from '../router';
import { sleep } from '../page';
import { resolveLesson } from './read';
import { spec } from './spec';
import { formatWhere } from './where';

const LOAD_TIMEOUT_MS = 45_000;
const NEXT_BUTTON = 'next-lesson-control-button';

async function navigate(ctx: ToolContext, url: string): Promise<void> {
  await browser.tabs.update(ctx.page.tabId, { url });
}

/** Controls like the bottom "next" button render a moment after the content. */
const SETTLE_MS = 1200;

/** Wait until the tab shows what `ok` wants, with state loaded and content rendered. */
export async function waitForPage(ctx: ToolContext, what: string, ok: (w: WhereInfo) => boolean, timeoutMs = LOAD_TIMEOUT_MS): Promise<WhereInfo> {
  await ctx.page.waitFor(what, async () => {
    const w = await ctx.page.op<WhereInfo>('where');
    return w.storeFound && w.contentReady && ok(w);
  }, timeoutMs);
  await sleep(SETTLE_MS, ctx.signal);
  let w = await ctx.page.op<WhereInfo>('where');
  if (w.kind === 'trainer' && w.theoryOpen) {
    // Opening a task can show the lesson theory as a window over the trainer; it hides the editor.
    await ctx.page.op('closeTheory');
    ctx.step('closed the theory window over the trainer');
    w = await ctx.page.op<WhereInfo>('where');
  }
  if (w.kind !== 'lesson') return w;
  // The bottom button and its label render last; lessons with an unanswered
  // blocking quiz have none, so this is a short best-effort wait.
  return ctx.page
    .waitFor('the lesson controls', async () => {
      const x = await ctx.page.op<WhereInfo>('where');
      return x.controls.some((c) => c.id === NEXT_BUTTON && c.label && c.label !== NEXT_BUTTON) ? x : null;
    }, 3000)
    .catch(() => ctx.page.op<WhereInfo>('where'));
}

export const openLesson: Tool = {
  spec: spec('open_lesson'),
  async run(args, ctx) {
    const { id } = await resolveLesson(args.lesson, ctx);
    const here = await ctx.page.op<WhereInfo>('where');
    const { lesson } = await ctx.page.op<{ lesson: LessonJson & { course_id: string; sprint_id: number; topic_id: string; profession_slug: string } }>('lesson', { lessonId: id });
    const slug = lesson.profession_slug || here.professionSlug;
    // Practice lessons open straight at their first unsolved task in the trainer.
    const tasks = lesson.tasks ?? [];
    const task = tasks.find((t) => !t.solved) ?? tasks[0];
    // "Already open" only counts for the right view: a practice lesson's theory page isn't its trainer.
    if (here.lesson?.id === id && (!task || here.kind === 'trainer')) {
      if (here.theoryOpen) {
        await ctx.page.op('closeTheory');
        ctx.step('closed the theory window over the trainer');
      }
      return `Already open.\n${formatWhere(await ctx.page.op<WhereInfo>('where'))}`;
    }
    const url = task
      ? `https://practicum.yandex.ru/trainer/${slug}/lesson/${id}/task/${task.id}/?hideTheory=1`
      : `https://practicum.yandex.ru/learn/${slug}/courses/${lesson.course_id}/sprints/${lesson.sprint_id}/topics/${lesson.topic_id}/lessons/${id}/`;
    ctx.step(`opening «${lesson.name}»${task ? ` at task ${tasks.indexOf(task) + 1}/${tasks.length}` : ''}`);
    await navigate(ctx, url);
    const w = await waitForPage(ctx, `lesson «${lesson.name}» to load`, (w) => w.lesson?.id === id && (!task || w.task?.id === task.id));
    return formatWhere(w);
  },
};

export const goHome: Tool = {
  spec: spec('go_home'),
  async run(_args, ctx) {
    const here = await ctx.page.op<WhereInfo>('where');
    if (here.kind === 'profile') return formatWhere(here);
    const slug = here.professionSlug ?? here.url.split('/')[4];
    ctx.step('opening the profile page');
    await navigate(ctx, `https://practicum.yandex.ru/profile/${slug}/`);
    return formatWhere(await waitForPage(ctx, 'the profile page to load', (w) => w.kind === 'profile' && !!w.profession));
  },
};

export const completeLesson: Tool = {
  spec: spec('complete_lesson'),
  async describe(_args, ctx) {
    const w = await ctx.page.op<WhereInfo>('where');
    const btn = w.controls.find((c) => c.id === NEXT_BUTTON);
    return `Finish «${w.lesson?.name ?? 'this lesson'}» and press «${btn?.label ?? 'next'}»`;
  },
  async run(_args, ctx) {
    const before = await ctx.page.op<WhereInfo>('where');
    if (before.kind !== 'lesson' || !before.lesson) {
      throw new ToolError(before.kind === 'trainer' ? 'on the trainer use next_task instead' : 'no theory lesson is open');
    }
    const btn = before.controls.find((c) => c.id === NEXT_BUTTON);
    if (!btn || !btn.enabled) {
      const { lesson, answers } = await ctx.page.op<{ lesson: LessonJson; answers: SavedAnswer[] }>('lesson', {});
      const open = interactiveBlocks(lesson.theory, answers).filter((b) => !b.answer && (b.type !== 'QuizCoding' || b.node.content?.blocking));
      throw new ToolError(`the «next» button is not available${open.length ? `; unanswered blocks: ${open.map((b) => `${b.ref} ${b.type}`).join(', ')}` : ''}`);
    }
    const lessonId = before.lesson.id;
    await ctx.page.op('pressTestId', { testId: NEXT_BUTTON });
    ctx.step(`pressed «${btn.label}», waiting for the next page`);
    const after = await waitForPage(ctx, 'the next page to load', (w) => w.url !== before.url && (w.lesson?.id !== lessonId || w.kind !== before.kind));
    const { lesson: old } = await ctx.page.op<{ lesson: LessonJson }>('lesson', { lessonId });
    return `«${old.name}»: ${old.solved ? 'marked solved' : 'not marked solved (practice lessons are solved by their tasks)'}.\nNow:\n${formatWhere(after)}`;
  },
};
