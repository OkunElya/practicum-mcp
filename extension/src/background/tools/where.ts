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
    return formatWhere(await ctx.page.op<WhereInfo>('where'));
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
    if (l.nextLessonId) lines.push(`Next lesson id: ${l.nextLessonId}`);
  }
  if (w.task) lines.push(`Current task: ${w.task.index + 1} id=${w.task.id}, ${w.task.solved ? 'solved' : 'not solved'}`);
  if (w.modal) lines.push(`Open dialog: ${w.modal}`);
  if (w.aiChatOpen) lines.push('Platform AI chat: open');
  if (w.controls.length) {
    lines.push('Buttons on screen:');
    for (const c of w.controls) lines.push(`- ${c.label || c.id} (${c.id})${c.enabled ? '' : ' [disabled]'}`);
  }
  return lines.join('\n');
}
