import type { ProgressTree } from '../../content/ops/read';
import type { WhereInfo } from '../../content/ops/where';
import type { Tool } from '../router';
import { spec } from './spec';

const KIND_LABEL: Record<WhereInfo['kind'], string> = {
  profile: 'profile (main page, course grid)',
  lesson: 'theory lesson',
  trainer: 'code trainer',
  other: 'other page',
};

export const whereAmI: Tool = {
  spec: spec('where_am_i'),
  async run(_args, ctx) {
    const w = await ctx.page.op<WhereInfo>('where');
    const text = formatWhere(w);
    if (!w.modal || w.kind !== 'profile') return text;
    // A course window on the main page: say which course it is and what is left in it,
    // in open_lesson's numbering (a small model doesn't connect the title to get_progress).
    const tree = await ctx.page.op<ProgressTree>('progress').catch(() => null);
    const ci = tree?.courses.findIndex((c) => c.name.trim() === w.modal!.trim()) ?? -1;
    if (!tree || ci < 0) return text;
    const course = tree.courses[ci];
    const lessons = course.topics.flatMap((t, ti) => t.lessons.map((l, li) => ({ ...l, pos: `${ci + 1}.${ti + 1}.${li + 1}` })));
    const open = lessons.filter((l) => !l.solved);
    const lines = [`The open dialog is course ${ci + 1} «${course.name}»: ${lessons.length - open.length}/${lessons.length} lessons solved.`];
    if (open.length) {
      lines.push('Unsolved lessons in it, in order (open_lesson takes these numbers):');
      for (const l of open) lines.push(`- ${l.pos} «${l.name}» [${l.type}]${l.hasAccess ? '' : ' (locked)'}`);
    }
    return `${text}\n${lines.join('\n')}`;
  },
};

export function formatWhere(w: WhereInfo): string {
  const lines = [`Page: ${KIND_LABEL[w.kind]}`, `URL: ${w.url}`];
  if (!w.storeFound) lines.push('Note: page state not available yet (still loading?)');
  if (w.profession) lines.push(`Profession: ${w.profession.name}, ${w.profession.lessonsSolved}/${w.profession.lessonsTotal} lessons solved`);
  if (w.lesson) {
    const l = w.lesson;
    lines.push(`Course: ${l.course} › Topic: ${l.topic}`);
    lines.push(`Lesson ${l.position + 1}/${l.topicLessons}: «${l.name}» [${l.type}] id=${l.id}, ${l.solved ? 'solved' : 'not solved'}`);
    if (l.tasks.length) lines.push(`Tasks: ${l.tasks.map((t, i) => `${i + 1}${t.solved ? ' ✓' : ''}`).join(', ')}`);
    // No id here: models kept open_lesson-ing it instead of finishing the lesson they were on.
    if (l.nextLessonId) lines.push("Lesson after this one: complete_lesson (or the last task's next_task) opens it");
  }
  if (w.task) lines.push(`Current task: ${w.task.index + 1} id=${w.task.id}, ${w.task.solved ? 'solved' : 'not solved'}`);
  if (w.modal) lines.push(`Open dialog: ${w.modal}`);
  if (w.theoryOpen) lines.push('The lesson theory is shown as a window over the trainer (trainer tools close it first).');
  if (w.aiChatOpen) lines.push('Platform AI chat: open');
  if (w.controls.length) {
    lines.push('Buttons on screen:');
    for (const c of w.controls) lines.push(`- ${c.label || c.id} (${c.id})${c.enabled ? '' : ' [disabled]'}`);
  }
  return lines.join('\n');
}
