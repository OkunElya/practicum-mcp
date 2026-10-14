import { ToolError } from '../../shared/protocol';
import type { LessonJson, SavedAnswer } from '../../shared/lesson';
import { api, pageWindow, plain, professionSlug, request, state } from '../page';

/** Id of the lesson shown in this tab (theory page or trainer). */
export function currentLessonId(): string | null {
  const s = state();
  return s?.proficiencyReducer?.lesson?.id ?? s?.trainerReducer?.lesson?.id ?? null;
}

/** Lesson + saved answers straight from the API (a GET: no checkin, nothing marked as visited). */
export async function lesson({ lessonId }: { lessonId?: string }): Promise<{ lesson: LessonJson; answers: SavedAnswer[] }> {
  const id = lessonId || currentLessonId();
  if (!id) throw new ToolError('this page shows no lesson; pass lesson_id (see get_progress)');
  const [l, answers] = await Promise.all([api<LessonJson>(`/api/lessons/${id}/`), api<SavedAnswer[]>(`/api/lessons/${id}/quizzes/`)]);
  return { lesson: l, answers: answers.map((a) => ({ content_quiz_id: a.content_quiz_id, user_answer: a.user_answer })) };
}

export interface ProgressTree {
  name: string;
  slug: string;
  courses: {
    id: string;
    name: string;
    solved: boolean;
    topics: { id: string; name: string; solved: boolean; lessons: { id: string; name: string; type: string; solved: boolean; hasAccess: boolean; isHomework: boolean; reset: boolean }[] }[];
  }[];
}

/**
 * The profession tree with solved flags. The profile page renders it from
 * server-side state (no API call), so elsewhere we fetch that page's HTML and
 * read `window.__preloadedState__` from it.
 */
export async function progress(): Promise<ProgressTree> {
  let profile: any = location.pathname.startsWith('/profile/') ? plain(state()?.profileReducer?.profile) : null;
  if (!profile?.courses) {
    const slug = professionSlug();
    if (!slug) throw new ToolError('cannot tell which profession to read; open its profile page');
    const html = await request(`/profile/${slug}/`);
    const start = html.indexOf('window.__preloadedState__ = ');
    const end = html.indexOf('</script>', start);
    if (start < 0 || end < 0) throw new ToolError('profile page has no preloaded state (site changed?)');
    const json = html.slice(start + 'window.__preloadedState__ = '.length, end).trim().replace(/;$/, '');
    profile = JSON.parse(json)?.profileReducer?.profile;
    if (!profile?.courses) throw new ToolError('profile state has no courses (site changed?)');
  }
  return {
    name: profile.name,
    slug: profile.slug,
    courses: profile.courses.map((c: any) => ({
      id: c.id,
      name: c.name,
      solved: !!c.solved,
      topics: c.topics.map((t: any) => ({
        id: t.id,
        name: t.name,
        solved: !!t.solved,
        lessons: t.lessons.map((l: any) => ({
          id: l.id,
          name: l.name,
          type: l.lesson_type,
          solved: !!l.solved,
          hasAccess: l.has_access !== false,
          isHomework: !!l.is_homework,
          reset: !!l.has_been_reset,
        })),
      })),
    })),
  };
}

export interface TaskInfo {
  lessonName: string;
  lessonType: string;
  lessonSolved: boolean;
  index: number;
  total: number;
  task: { id: string; description: string; solved: boolean; hints: string[]; successMessage: string | null };
  files: { name: string; opened: boolean }[];
  webserver: { url: string; running: boolean } | null;
}

/** The trainer task in this tab, without the reference solution (`answer_panes`). */
export function task(): TaskInfo {
  const t = state()?.trainerReducer;
  if (!t?.task?.id) throw new ToolError('no trainer task on this page; open a practice lesson task first');
  const tk = t.task;
  const tasks: any[] = t.lesson?.tasks ? Array.from(t.lesson.tasks) : [];
  const ws = t.webserver;
  return {
    lessonName: String(t.lesson?.name ?? ''),
    lessonType: String(t.lesson?.lesson_type ?? ''),
    lessonSolved: !!t.lesson?.solved,
    index: tasks.findIndex((x) => x.id === tk.id),
    total: tasks.length,
    task: {
      id: String(tk.id),
      description: String(tk.description ?? ''),
      solved: !!tk.solved,
      hints: tk.hints ? Array.from(tk.hints as any[], (h) => String(h.content ?? '')) : [],
      successMessage: tk.success_message ? String(tk.success_message) : null,
    },
    files: tk.panes ? Array.from(tk.panes as any[], (p) => ({ name: String(p.name ?? ''), opened: !!p.opened })) : [],
    webserver: ws?.url ? { url: String(ws.url), running: !!ws.running } : null,
  };
}

export interface CodeFile {
  name: string;
  content: string;
  /** "editor": live editor text (includes unsaved edits); "task": the task's stored file */
  source: 'editor' | 'task';
}

/** Editor content. `file` picks one file of a multi-file project; default = the file in the editor. */
export function code({ file }: { file?: string }): CodeFile {
  const monaco = pageWindow().monaco;
  const models: any[] = monaco?.editor ? Array.from(monaco.editor.getModels()) : [];
  const path = (m: any) => String(m.uri.path).replace(/^\//, '');
  const t = state()?.trainerReducer?.task;
  const panes: any[] = t?.panes ? Array.from(t.panes) : [];
  if (!models.length && !panes.length) throw new ToolError('no code editor on this page');

  if (file) {
    const want = file.replace(/^\/+/, '');
    const model = models.find((m) => path(m) === want) ?? models.find((m) => path(m).endsWith(`/${want}`));
    if (model) return { name: path(model), content: String(model.getValue()), source: 'editor' };
    const pane = panes.find((p) => p.name === want) ?? panes.find((p) => String(p.name).endsWith(`/${want}`));
    if (pane) return { name: String(pane.name), content: String(pane.content ?? ''), source: 'task' };
    const names = (panes.length ? panes.map((p) => p.name) : models.map(path)).join(', ');
    throw new ToolError(`no file "${file}". Files: ${names}`);
  }
  const visible = monaco?.editor ? Array.from(monaco.editor.getEditors() as any[]).find((e) => e.getDomNode()?.offsetParent) : null;
  const model = visible?.getModel() ?? models[0];
  if (model) return { name: path(model), content: String(model.getValue()), source: 'editor' };
  const pane = panes.find((p) => p.opened) ?? panes[0];
  return { name: String(pane.name), content: String(pane.content ?? ''), source: 'task' };
}
