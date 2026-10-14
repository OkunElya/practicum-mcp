import { byTestId, isVisible, plain, state, text } from '../page';

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
          ? !!document.querySelector('.monaco-editor, [class*="theory-viewer__block"]')
          : kind === 'profile'
            ? !!document.querySelector('.course-card')
            : true,
  };
}
