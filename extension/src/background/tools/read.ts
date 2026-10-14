import type { CodeFile, ProgressTree, TaskInfo } from '../../content/ops/read';
import { renderLesson, type LessonJson, type SavedAnswer } from '../../shared/lesson';
import { ToolError } from '../../shared/protocol';
import type { Tool, ToolContext } from '../router';
import { spec } from './spec';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITION = /^(\d+)\.(\d+)\.(\d+)$/;

const count = (lessons: { solved: boolean }[]) => `${lessons.filter((l) => l.solved).length}/${lessons.length}`;

/**
 * A lesson reference from the model: a full lesson id, or a position
 * "course.topic.lesson" as numbered by get_progress (e.g. "5.1.3").
 */
export async function resolveLesson(ref: string, ctx: ToolContext): Promise<{ id: string; name?: string }> {
  const r = ref.trim();
  if (UUID.test(r)) return { id: r.toLowerCase() };
  const m = r.match(POSITION);
  if (!m) throw new ToolError(`"${ref}" is not a lesson id or a position like 5.1.3 (see get_progress)`);
  const tree = await ctx.page.op<ProgressTree>('progress');
  const [ci, ti, li] = m.slice(1).map((x) => Number(x) - 1);
  const lesson = tree.courses[ci]?.topics[ti]?.lessons[li];
  if (!lesson) throw new ToolError(`no lesson at position ${r}; see get_progress`);
  return { id: lesson.id, name: lesson.name };
}

export const getProgress: Tool = {
  spec: spec('get_progress'),
  async run(args, ctx) {
    const tree = await ctx.page.op<ProgressTree>('progress');
    const allLessons = tree.courses.flatMap((c) => c.topics.flatMap((t) => t.lessons));
    const lines = [`Profession: ${tree.name} — ${count(allLessons)} lessons solved`];

    if (!args.course) {
      lines.push('Courses (number. name — solved lessons):');
      tree.courses.forEach((c, i) => {
        const ls = c.topics.flatMap((t) => t.lessons);
        lines.push(`${i + 1}. ${c.name} — ${count(ls)}${c.solved ? ' ✓' : ''}`);
      });
      lines.push('Call get_progress with course=<number> for its topics and lessons.');
      return lines.join('\n');
    }

    const q = String(args.course).trim().toLowerCase();
    const ci = /^\d+$/.test(q) ? Number(q) - 1 : tree.courses.findIndex((c) => c.name.toLowerCase().includes(q));
    const course = tree.courses[ci];
    if (!course) throw new ToolError(`no course "${args.course}"; call get_progress without arguments for the list`);
    lines.push(`Course ${ci + 1}. ${course.name} — ${count(course.topics.flatMap((t) => t.lessons))}${course.solved ? ' ✓' : ''}`);
    lines.push('Lessons are numbered course.topic.lesson; open_lesson and read_lesson accept that number. ✓ = solved, ↺ = topic was reset.');
    course.topics.forEach((t, ti) => {
      lines.push(`${ci + 1}.${ti + 1} ${t.name} — ${count(t.lessons)}`);
      t.lessons.forEach((l, li) => {
        const flags = [l.solved ? '✓' : ' ', l.reset ? '↺' : '', !l.hasAccess ? '(locked)' : '', l.isHomework ? '(project)' : ''].filter(Boolean).join(' ');
        lines.push(`  ${ci + 1}.${ti + 1}.${li + 1} ${flags} ${l.name} [${l.type}]`);
      });
    });
    return lines.join('\n');
  },
};

export const readLesson: Tool = {
  spec: spec('read_lesson'),
  async run(args, ctx) {
    const lessonId = args.lesson ? (await resolveLesson(args.lesson, ctx)).id : undefined;
    const { lesson, answers } = await ctx.page.op<{ lesson: LessonJson; answers: SavedAnswer[] }>('lesson', { lessonId });
    return renderLesson(lesson, answers, { offset: args.offset });
  },
};

export const readTask: Tool = {
  spec: spec('read_task'),
  async run(_args, ctx) {
    const t = await ctx.page.op<TaskInfo>('task');
    const lines = [
      `Lesson «${t.lessonName}» [${t.lessonType}], ${t.lessonSolved ? 'solved' : 'not solved'}`,
      `Task ${t.index + 1}/${t.total} id=${t.task.id}, ${t.task.solved ? 'solved' : 'not solved'}`,
      '',
      t.task.description.trim(),
      '',
    ];
    if (t.files.length > 1) lines.push(`Files (${t.files.length}): ${t.files.map((f) => f.name + (f.opened ? ' (open)' : '')).join(', ')}`);
    else if (t.files.length === 1) lines.push(`File: ${t.files[0].name}`);
    if (t.task.hints.length) lines.push(`Hints available: ${t.task.hints.length}`);
    if (t.webserver) lines.push(`Deployed preview: ${t.webserver.url} (${t.webserver.running ? 'running' : 'stopped'})`);
    if (t.task.solved && t.task.successMessage) lines.push(`Success message: ${t.task.successMessage}`);
    return lines.join('\n');
  },
};

export const getCode: Tool = {
  spec: spec('get_code'),
  async run(args, ctx) {
    const f = await ctx.page.op<CodeFile>('code', { file: args.file });
    const note = f.source === 'task' ? ' (not open in the editor; stored task version)' : '';
    return `File: ${f.name}${note}\n\`\`\`\n${f.content}\n\`\`\``;
  },
};
