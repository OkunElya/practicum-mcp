// Read-only: code-trainer page — editor engine, buttons, task state in Redux.
import { withPage } from './lib.mjs';
const out = await withPage(async (page) => {
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return page.evaluate(() => {
    const r = {};
    r.editors = {
      monaco: !!window.monaco, monacoModels: window.monaco?.editor?.getModels?.().map((m) => `${m.uri} ${m.getLanguageId?.()} ${m.getValue().length}ch`),
      ace: !!window.ace, codemirror5: document.querySelectorAll('.CodeMirror').length, codemirror6: document.querySelectorAll('.cm-editor').length,
      textareas: [...document.querySelectorAll('textarea')].map((t) => `${t.className} ${t.value.length}ch`),
      editorLikeClasses: [...new Set([...document.querySelectorAll('[class*=editor],[class*=Editor],[class*=trainer]')].map((e) => [...e.classList][0]).filter(Boolean))].slice(0, 40),
    };
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5?.CodeMirror) r.cm5Value = cm5.CodeMirror.getValue().slice(0, 600);
    const cm6 = document.querySelector('.cm-content');
    if (cm6) r.cm6Text = cm6.innerText.slice(0, 600);
    const propsOf = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps$'))];
    r.buttons = [...document.querySelectorAll('button,[role=button],[role=tab]')].filter((b) => b.getClientRects().length).map((b) => `${b.tagName.toLowerCase()}.${[...b.classList].slice(0, 2).join('.')}${b.disabled ? ' disabled' : ''}${b.dataset.testId ? ' tid=' + b.dataset.testId : ''} "${(b.getAttribute('aria-label') || b.textContent).trim().replace(/\s+/g, ' ').slice(0, 40)}"`).filter((s) => !/sidebar|header|users-courses|referral|feedback-button|element-hint/.test(s));
    r.taskArea = (document.querySelector('[class*=task-description],[class*=task__],[class*=task]')?.innerText ?? '').slice(0, 800);
    r.bodyText = document.body.innerText.replace(/\n+/g, ' | ').slice(0, 1500);
    // Redux
    const mount = document.getElementById('mount');
    const st = [mount[Object.keys(mount).find((k) => k.startsWith('__reactContainer$'))]];
    let store = null;
    while (st.length && !store) { const f = st.pop(); if (!f) continue; if (f.memoizedProps?.store?.getState) store = f.memoizedProps.store; if (f.sibling) st.push(f.sibling); if (f.child) st.push(f.child); }
    const s = store.getState();
    r.slices = Object.keys(s);
    const shape = (v, d = 2) => v === null || typeof v !== 'object' ? (typeof v === 'string' ? `str(${v.length})` : String(v)) : Array.isArray(v) ? `arr(${v.length})` : d <= 0 ? `{${Object.keys(v).length}}` : Object.fromEntries(Object.keys(v).slice(0, 40).map((k) => [k, shape(v[k], d - 1)]));
    r.trainerSlices = Object.fromEntries(Object.keys(s).filter((k) => /trainer|task|code|editor|solution|run|serverless|terminal|ide|lesson|proficiency/i.test(k)).map((k) => [k, shape(s[k], 2)]));
    r.testIds = [...new Set([...document.querySelectorAll('[data-test-id]')].map((e) => e.dataset.testId.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, '<uuid>')))].filter((t) => !/sidebar|header|users-courses|referral|popup-help|messenger|icon$|-content$|hint/.test(t));
    const L = s.proficiencyReducer?.lesson;
    if (L) r.lessonKeys = { trainer_lib_url: L.trainer_lib_url, coderun_config: L.coderun_config, editor_settings: L.editor_settings, fs_mode: L.fs_mode, used_editor: L.used_editor, solve_locally: L.solve_locally, has_trainer_access: L.has_trainer_access, tasks: L.tasks.map((t) => ({ id: t.id, solved: t.solved, keys: Object.keys(t), desc: t.description.slice(0, 120) })) };
    return r;
  });
});
console.log(JSON.stringify(out, null, 1));
