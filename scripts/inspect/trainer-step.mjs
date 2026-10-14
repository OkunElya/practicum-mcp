// One trainer step without touching window.fetch: optionally set the editor code,
// click a button, record browser-level network (BiDi), and diff trainer state.
// Usage: node trainer-step.mjs <check|run|hint|next|css:<selector>> [codeFile] [waitMs]
import { readFileSync } from 'node:fs';
import { withPage } from './lib.mjs';
import { FIND_STORE } from './store.mjs';

const [action = 'check', codeFile, waitMs = '8000'] = process.argv.slice(2);
const SEL = {
  check: '[data-test-id="check-task-button"]',
  run: 'button[aria-label="Выполнить код"]',
  hint: '[data-test-id="trainer-hint-button"]',
  next: '[data-test-id="next-lesson-control-button"]',
};
const selector = action.startsWith('css:') ? action.slice(4) : SEL[action];

const SNAP = `(() => {
  const s = ${FIND_STORE}.getState();
  const t = s.trainerReducer;
  const clip = (v, n = 600) => { if (v instanceof Node) return '<node>'; let j; try { j = JSON.stringify(v); } catch { j = '(unserializable)'; } return j && j.length > n ? j.slice(0, n) + '…' : j; };
  const models = window.monaco?.editor?.getModels?.() ?? [];
  return {
    url: location.pathname + location.search,
    lessonSolved: t?.lesson?.solved,
    tasks: (t?.lesson?.tasks ?? []).map((x) => (x.solved ? 'S' : '-')).join(''),
    task: t?.task ? Object.fromEntries(Object.entries(t.task).map(([k, v]) => [k, clip(v, 300)])) : null,
    attemptsInLesson: t?.attemptsInLesson, playgroundStatus: t?.playgroundStatus, openedTaskHint: clip(t?.openedTaskHint),
    isTaskHintVisible: clip(t?.isTaskHintVisible), playgroundLogs: clip(t?.playgroundLogs), isCodeChanged: t?.isCodeChanged,
    editor: models.map((m) => String(m.uri) + ' :: ' + m.getValue().slice(0, 400)),
    resultPanel: (document.querySelector('[class*=result]')?.closest('[class*=split]') ? [...document.querySelectorAll('[class*=trainer-result],[class*=result-panel],[class*=output]')].map((e) => e.innerText).join(' || ') : '').slice(0, 1500),
    buttons: [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length).map((b) => (b.dataset.testId || b.getAttribute('aria-label') || b.textContent).trim().slice(0, 40)).filter((x) => x && !/sidebar|header|users-courses|referral|Скопировать|popup|thumb|Открыть меню/.test(x)),
  };
})()`;

const out = await withPage(async (page) => {
  const net = [];
  const bodies = [];
  page.on('response', async (res) => {
    try {
      const u = new URL(res.url());
      if (/\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map|wasm|whl|zip|data)$/i.test(u.pathname)) return;
      if (/metrika|mc\.yandex|apigw|mail\.ru|tomi|messenger|avatars|uaas|event_collector|LatencyMetrics/.test(u.href)) return;
      net.push(`${res.request().method()} ${res.status()} ${u.host === 'practicum.yandex.ru' ? '' : u.host}${u.pathname}${u.search}`);
      if (((/serverless|tasks|solve|progress|lessons\/[^/]+\/$|\/api\/servers/.test(u.pathname)) || (u.pathname.startsWith('/api/') && res.request().method() !== 'GET')) && !/staticfiles|event_collector|LatencyMetrics/.test(u.pathname) && res.request().method() !== 'OPTIONS') {
        const body = await res.text().catch((e) => `(body unavailable: ${e.message})`);
        const rq = res.request();
        const reqBody = rq.postData?.() ?? (rq.hasPostData?.() ? await rq.fetchPostData?.().catch(() => null) : null);
        bodies.push({ url: u.pathname, status: res.status(), reqBody: reqBody ? String(reqBody).slice(0, 1500) : null, body: body.length > 2500 ? body.slice(0, 2500) + '…' : body });
      }
    } catch (e) {
      net.push(`(err ${e.message})`);
    }
  });

  if (codeFile) {
    const code = readFileSync(codeFile, 'utf8');
    await page.evaluate((code) => {
      const m = window.monaco.editor.getModels()[0];
      const ed = window.monaco.editor.getEditors().find((e) => e.getModel() === m);
      ed.executeEdits('probe', [{ range: m.getFullModelRange(), text: code }]);
      ed.pushUndoStop();
    }, code);
    await new Promise((r) => setTimeout(r, 500));
  }
  const before = await page.evaluate(SNAP);
  const el = await page.$(selector);
  if (!el) throw new Error(`not found: ${selector}`);
  await el.click();
  await new Promise((r) => setTimeout(r, Number(waitMs)));
  const after = await page.evaluate(SNAP).catch((e) => ({ error: String(e) }));
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  const diff = Object.fromEntries(Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, { before: before[k], after: after[k] }]));
  return { action, before: { url: before.url, tasks: before.tasks, buttons: before.buttons }, diff, net, bodies };
});
console.log(JSON.stringify(out, null, 1));
