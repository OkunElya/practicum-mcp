// Read-only survey of the current lesson: theory block tree (non-markdown blocks
// printed in full, truncated), rendered interactive elements in the theory area,
// lesson meta, quiz state. Usage: node lesson-survey.mjs [maxJsonChars]
import { withPage } from './lib.mjs';

const max = Number(process.argv[2] ?? 1500);

const out = await withPage(async (page) => {
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return page.evaluate((max) => {
    const mount = document.getElementById('mount');
    const stack = [mount[Object.keys(mount).find((k) => k.startsWith('__reactContainer$'))]];
    let store = null;
    while (stack.length && !store) {
      const f = stack.pop();
      if (!f) continue;
      if (f.memoizedProps?.store?.getState) store = f.memoizedProps.store;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    const s = store.getState();
    const L = s.proficiencyReducer?.lesson;
    if (!L) return { error: 'no lesson in state', url: location.href };
    const j = (v) => {
      const t = JSON.stringify(v);
      return t.length > max ? `${t.slice(0, max)}…(+${t.length - max})` : t;
    };
    const flat = [];
    const walk = (b, d) => {
      const entry = { d, type: b.type, id: b.id };
      if (b.type === 'Markdown') entry.md = `${(b.content?.markdown ?? '').length} chars: ${JSON.stringify((b.content?.markdown ?? '').slice(0, 100))}`;
      else if (b.content && Object.keys(b.content).length) entry.content = j(b.content);
      flat.push(entry);
      (b.nested ?? []).forEach((n) => walk(n, d + 1));
    };
    if (L.theory) walk(L.theory, 0);

    const propsOf = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps$'))];
    const area = document.querySelector('.theory-page') ?? document.body;
    const interactive = [...area.querySelectorAll('*')]
      .filter((e) => e.getClientRects().length && (e.matches('button,input,textarea,select,[role],[contenteditable=true],a[href]') || typeof propsOf(e)?.onClick === 'function'))
      .filter((e) => !/scrollbar|scrollable|downloadable-image|image_expandable|composed-progress/.test(e.className))
      .map((e) => {
        const h = Object.keys(propsOf(e) ?? {}).filter((k) => /^on[A-Z]/.test(k));
        return `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 3).join('.')}${e.getAttribute('role') ? `[${e.getAttribute('role')}]` : ''}${e.type ? ` type=${e.type}` : ''}${e.disabled ? ' disabled' : ''}${e.checked ? ' checked' : ''}${e.dataset.testId ? ` tid=${e.dataset.testId}` : ''} "${(e.getAttribute('aria-label') || e.value || e.textContent).trim().replace(/\s+/g, ' ').slice(0, 60)}" ${h.join(',')}`;
      });

    return {
      url: location.pathname,
      lesson: {
        name: L.name, id: L.id, position: L.position, topic: `${L.topic_position}. ${L.topic_name}`, lesson_type: L.lesson_type,
        solved: L.solved, next_lesson_id: L.next_lesson_id, is_last_in_topic: L.is_last_in_topic,
        tasks: j(L.tasks), homework: j(L.homework), used_editor: L.used_editor, coderun_config: j(L.coderun_config), editor_settings: j(L.editor_settings),
        lessonType: s.proficiencyReducer.lessonType,
      },
      theoryBlockTypes: [...new Set(flat.map((b) => b.type))],
      theory: flat,
      quizzesState: j(s.theoryBlocksReducer?.quizzes),
      theoryBlocksState: j({ blocks: s.theoryBlocksReducer?.blocks, problems: s.theoryBlocksReducer?.problems, webservers: s.theoryBlocksReducer?.webservers }),
      interactive,
    };
  }, max);
});
console.log(JSON.stringify(out, null, 1));
