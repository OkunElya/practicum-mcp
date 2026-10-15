import { byTestId, isVisible, pageWindow, plain, state, text } from '../page';
import { theoryOpen } from './trainer';

export type PageKind = 'profile' | 'lesson' | 'trainer' | 'other';

export interface Control {
  /** stable id used by tools: the data-test-id, or a name for controls without one */
  id: string;
  label: string;
  enabled: boolean;
}

export interface WhereInfo {
  url: string;
  kind: PageKind;
  professionSlug: string | null;
  profession: { name: string; lessonsSolved: number; lessonsTotal: number } | null;
  lesson: {
    id: string;
    name: string;
    type: string;
    solved: boolean;
    course: string;
    topic: string;
    position: number;
    topicLessons: number;
    nextLessonId: string | null;
    tasks: { id: string; solved: boolean }[];
  } | null;
  task: { id: string; index: number; solved: boolean } | null;
  modal: string | null;
  aiChatOpen: boolean;
  controls: Control[];
  storeFound: boolean;
  /** The page's main content has rendered (lesson blocks, editor, course grid). */
  contentReady: boolean;
  /** The lesson theory is shown as a window over the trainer. */
  theoryOpen: boolean;
}

/** Buttons that matter to tools, by test-id (see docs/actions.md). */
const TEST_ID_CONTROLS = [
  'next-lesson-control-button',
  'next-task-button',
  'check-task-button',
  'deploy-button',
  'trainer-hint-button',
  'sidebar-gpt-button',
  'sidebar-home-button',
];

function taskEditorReady(s: any): boolean {
  if (!document.querySelector('.monaco-editor')) return false;
  const task = s?.trainerReducer?.task;
  const taskId = location.pathname.match(/\/task\/([^/]+)/)?.[1];
  if (!task?.id || task.id !== taskId) return false;
  const panes: any[] = task.panes ? Array.from(task.panes) : [];
  if (!panes.length) return true; // single-file tasks: the editor is enough
  const models: any[] = pageWindow().monaco?.editor ? Array.from(pageWindow().monaco.editor.getModels()) : [];
  const names = new Set(panes.map((p) => String(p.name)));
  return models.some((m) => names.has(String(m.uri.path).replace(/^\//, '')));
}

export function where(): WhereInfo {
  const path = location.pathname;
  const kind: PageKind = path.startsWith('/profile/')
    ? 'profile'
    : path.startsWith('/learn/')
      ? 'lesson'
      : path.startsWith('/trainer/')
        ? 'trainer'
        : 'other';
  const s = state();

  const rawLesson = kind === 'lesson' ? s?.proficiencyReducer?.lesson : kind === 'trainer' ? s?.trainerReducer?.lesson : null;
  const tasks: { id: string; solved: boolean }[] = rawLesson?.tasks ? Array.from(rawLesson.tasks as any[], (t) => ({ id: String(t.id), solved: !!t.solved })) : [];
  const lesson = rawLesson?.id
    ? {
        id: String(rawLesson.id),
        name: String(rawLesson.name ?? ''),
        type: String(rawLesson.lesson_type ?? ''),
        solved: !!rawLesson.solved,
        course: String(rawLesson.course_name ?? ''),
        topic: String(rawLesson.topic_name ?? ''),
        position: Number(rawLesson.position ?? 0),
        topicLessons: Number(rawLesson.topic_lessons_count ?? 0),
        nextLessonId: rawLesson.next_lesson_id ? String(rawLesson.next_lesson_id) : null,
        tasks,
      }
    : null;

  const rawTask = kind === 'trainer' && path.includes('/task/') ? s?.trainerReducer?.task : null;
  const task = rawTask?.id
    ? { id: String(rawTask.id), index: tasks.findIndex((t) => t.id === String(rawTask.id)), solved: !!rawTask.solved }
    : null;

  let profession: WhereInfo['profession'] = null;
  const profile = kind === 'profile' ? plain(s?.profileReducer?.profile) : null;
  if (profile?.courses) {
    const lessons = profile.courses.flatMap((c: any) => c.topics.flatMap((t: any) => t.lessons));
    profession = { name: profile.name, lessonsSolved: lessons.filter((l: any) => l.solved).length, lessonsTotal: lessons.length };
  }

  const controls: Control[] = [];
  for (const id of TEST_ID_CONTROLS) {
    const el = byTestId(id);
    if (el) controls.push({ id, label: text(el) || el.getAttribute('aria-label') || '', enabled: !(el as HTMLButtonElement).disabled });
  }
  const run = document.querySelector('button[aria-label="Выполнить код"]');
  if (isVisible(run)) controls.push({ id: 'run-code', label: 'Выполнить код', enabled: !(run as HTMLButtonElement).disabled });

  const modal = document.querySelector('.skills-modal_visible');
  return {
    url: location.href,
    kind,
    professionSlug: path.split('/')[2] || null,
    profession,
    lesson,
    task,
    modal: modal ? text(modal.querySelector('h1, h2, h3, [class*=title]')) || 'open' : null,
    aiChatOpen: !!s?.chatYaGPT?.aiChatReducer?.isChatOpened,
    controls,
    storeFound: !!s,
    contentReady:
      kind === 'lesson'
        ? !!document.querySelector('[class*="theory-viewer__block"]')
        : kind === 'trainer'
          ? // a task is ready once its editor shows one of *this* task's files: switching tasks
            // is an in-page navigation and the previous task's editor lingers for a moment
            path.includes('/task/')
            ? taskEditorReady(s)
            : !!document.querySelector('[class*="theory-viewer__block"]')
          : kind === 'profile'
            ? !!document.querySelector('.course-card')
            : true,
    theoryOpen: theoryOpen(),
  };
}
