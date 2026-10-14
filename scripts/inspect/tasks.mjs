// Read-only: trainer tasks (description, hints, solved) + trainer state summary.
import { withPage } from './lib.mjs';
import { FIND_STORE } from './store.mjs';
const out = await withPage((page) =>
  page.evaluate(`(() => {
    const s = ${FIND_STORE}.getState();
    const t = s.trainerReducer;
    const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
    return {
      url: location.pathname,
      lesson: { name: t.lesson?.name, solved: t.lesson?.solved, next_lesson_id: t.lesson?.next_lesson_id, next_lesson_has_tasks: t.lesson?.next_lesson_has_tasks },
      tasks: (t.lesson?.tasks ?? []).map((x) => ({ id: x.id, solved: x.solved, description: x.description, hints: x.hints.map((h) => h.content) })),
      state: pick(t, ['attemptsInLesson', 'currentCodePaneName', 'isCodeChanged', 'isTaskHintVisible', 'taskContentTabIndex', 'playgroundLogs', 'getTaskLoadingStatus', 'dsExecutionStatus']),
      otherKeys: Object.keys(t).filter((k) => /task|check|run|result|solution|output|log|status/i.test(k)),
    };
  })()`),
);
console.log(JSON.stringify(out, null, 1));
