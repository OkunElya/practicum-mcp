// Read-only: web_server trainer — panes/file tree, monaco models, preview iframe, webserver state.
import { withPage } from './lib.mjs';
import { FIND_STORE } from './store.mjs';
const out = await withPage(async (page) => {
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return page.evaluate(`(() => {
    const s = ${FIND_STORE}.getState();
    const t = s.trainerReducer;
    const clip = (v, n = 400) => { if (v instanceof Node) return '<' + v.nodeName.toLowerCase() + ' ' + (v.src || v.className || '') + '>'; let j; try { j = JSON.stringify(v); } catch { j = '(unserializable)'; } return j && j.length > n ? j.slice(0, n) + '…' : j; };
    const task = t.task;
    return {
      panes: task.panes.map((p) => ({ name: p.name, language: p.language, opened: p.opened, readonly: p.readonly ?? p.read_only, len: p.content.length, extraKeys: Object.keys(p).filter((k) => !['name','content','language','opened'].includes(k)) })),
      answerPanes: (task.answer_panes || []).map((p) => p.name + ' ' + p.content.length + 'ch'),
      taskKeys: Object.keys(task),
      taskExtras: Object.fromEntries(['test','skip_check','mobile_view','next_button','check_button','assessment_type','is_chain','has_js_console'].map((k) => [k, task[k]])),
      monacoModels: window.monaco.editor.getModels().map((m) => String(m.uri) + ' ' + m.getValue().length + 'ch'),
      webserverState: Object.fromEntries(Object.keys(t).filter((k) => /web|playground|iframe|server|frame|render/i.test(k)).map((k) => [k, clip(t[k])])),
      lessonCoderun: t.lesson.coderun_config, fs_mode: t.lesson.fs_mode,
      iframes: [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src.slice(0, 200), cls: f.className, title: f.title, sandbox: f.getAttribute('sandbox') })),
      fileTree: [...document.querySelectorAll('[class*=file-tree] *, [class*=files] *, [class*=tree-item], [class*=file-item]')].filter((e) => e.children.length === 0 && e.textContent.trim()).map((e) => e.textContent.trim()).slice(0, 60),
      fileTreeClasses: [...new Set([...document.querySelectorAll('[class*=tree],[class*=file]')].map((e) => [...e.classList][0]))].slice(0, 30),
      tabs: [...document.querySelectorAll('[role=tab],[class*=tabs__item],[class*=pane-tab]')].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 30),
      buttons: [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => (b.dataset.testId ? 'tid=' + b.dataset.testId + ' ' : '') + '"' + (b.getAttribute('aria-label') || b.textContent).trim().slice(0, 40) + '"').filter((x) => !/sidebar|header|users-courses|referral|Скопировать|popup|thumb|Открыть меню/.test(x)),
    };
  })()`);
});
console.log(JSON.stringify(out, null, 1));
