// Read-only: follow next_lesson_id from the current lesson via GET /api/lessons/{id}/
// and report block types / tasks per lesson, plus one sample of each non-markdown type.
// GET does not check in or solve anything. Usage: node walk-lessons.mjs [maxLessons]
import { withPage } from './lib.mjs';
const max = Number(process.argv[2] ?? 80);
const out = await withPage((page) =>
  page.evaluate(async (max) => {
    let id = location.pathname.match(/lessons\/([0-9a-f-]{36})/)[1];
    const lessons = [];
    const samples = {};
    for (let i = 0; i < max && id; i++) {
      const res = await fetch(`/api/lessons/${id}/`, { credentials: 'include', headers: { accept: 'application/json' } });
      if (!res.ok) { lessons.push({ id, status: res.status }); break; }
      const L = await res.json();
      const types = {};
      const walk = (b) => {
        if (!b) return;
        types[b.type] = (types[b.type] || 0) + 1;
        if (!['Markdown', 'RootLayout'].includes(b.type) && !samples[b.type]) {
          const c = JSON.stringify(b.content ?? null);
          samples[b.type] = { lesson: L.name, id: b.id, content: c.length > 1500 ? c.slice(0, 1500) + `…(+${c.length - 1500})` : c };
        }
        (b.nested ?? []).forEach(walk);
      };
      walk(L.theory);
      lessons.push({ course: L.course_name, topic: L.topic_name, name: L.name, id: L.id, type: L.lesson_type, solved: L.solved, tasks: L.tasks?.length ?? 0, homework: !!L.homework, editor: L.used_editor, coderun: !!L.coderun_config, blocks: Object.entries(types).filter(([t]) => t !== 'RootLayout').map(([t, n]) => `${t}×${n}`).join(' ') });
      if (L.tasks?.length && !samples.__task) samples.__task = { lesson: L.name, task: JSON.stringify(L.tasks[0]).slice(0, 2000), coderun: JSON.stringify(L.coderun_config)?.slice(0, 600), editor_settings: JSON.stringify(L.editor_settings)?.slice(0, 600) };
      id = L.next_lesson_id;
    }
    return { lessons, samples };
  }, max),
);
console.log(JSON.stringify(out, null, 1));
