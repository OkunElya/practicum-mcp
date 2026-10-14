// Read-only: poll trainer buttons + Redux status fields and log every change,
// plus browser-level network, until the check button is enabled again (or timeout).
// Usage: node watch-state.mjs [timeoutSec] [--click <css>]   (--click: press it after the first sample)
import { withPage } from './lib.mjs';
import { FIND_STORE } from './store.mjs';

const argv = process.argv.slice(2);
const ci = argv.indexOf('--click');
const clickSel = ci >= 0 ? argv.splice(ci, 2)[1] : null;
const timeoutSec = Number(argv[0] ?? 120);

const PROBE = `(() => {
  const s = ${FIND_STORE}.getState();
  const t = s.trainerReducer || {};
  const clip = (v, n = 300) => { if (v instanceof Node) return '<node>'; let j; try { j = JSON.stringify(v); } catch { j = '?'; } return j && j.length > n ? j.slice(0, n) + '…' : j; };
  const frame = document.querySelector('iframe.trainer-result__content');
  const btn = (sel) => { const b = document.querySelector(sel); return b ? { disabled: b.disabled, ariaDisabled: b.getAttribute('aria-disabled'), cls: [...b.classList].filter((c) => /disabled|loading|progress|pending|view_/.test(c)).join(' '), text: b.textContent.trim() } : null; };
  const statusKeys = Object.keys(t).filter((k) => /Status$|status|Loading|isRendering|isWebsocket|playground|checking|isIframe/i.test(k));
  return {
    check: btn('[data-test-id="check-task-button"]'),
    deploy: btn('[data-test-id="deploy-button"]'),
    redux: Object.fromEntries(statusKeys.map((k) => [k, clip(t[k], 200)])),
    taskSolved: t.task?.solved,
    frameSrc: frame ? new URL(frame.src).pathname : null,
    spinner: !!document.querySelector('[class*=spin]:not([class*=wrapper])'),
    result: (document.querySelector('.trainer-result, [class*=trainer-result__]')?.innerText || '').slice(0, 300),
    toasts: [...document.querySelectorAll('.Toastify__toast, [class*=notification__], [class*=toast]')].map((e) => (e.innerText ?? e.textContent ?? '').trim()).filter(Boolean).slice(0, 5),
  };
})()`;

const log = await withPage(async (page) => {
  const events = [];
  const t0 = Date.now();
  const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  page.on('response', (res) => {
    try {
      const u = new URL(res.url());
      if (/metrika|clck|apigw|mail\.ru|tomi|messenger|avatars|uaas|event_collector|LatencyMetrics|\.(js|css|png|svg|woff2?)$/.test(u.href)) return;
      events.push(`${ts()} NET ${res.request().method()} ${res.status()} ${u.host === 'practicum.yandex.ru' ? '' : u.host}${u.pathname}`);
    } catch {}
  });
  let prev = {};
  let sawBusy = !clickSel;
  let clicked = !clickSel;
  while (Date.now() - t0 < timeoutSec * 1000) {
    const cur = await page.evaluate(PROBE).catch((e) => ({ error: String(e) }));
    for (const k of Object.keys({ ...prev, ...cur })) {
      const a = JSON.stringify(prev[k]);
      const b = JSON.stringify(cur[k]);
      if (a !== b) events.push(`${ts()} ${k}: ${b}`);
    }
    prev = cur;
    if (!clicked) {
      await (await page.$(clickSel)).click();
      clicked = true;
      events.push(`${ts()} CLICK ${clickSel}`);
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (cur.error) { events.push(`${ts()} probe failed, stop`); break; }
    if (cur.check?.disabled || cur.check?.ariaDisabled) sawBusy = true;
    if (sawBusy && cur.check && !cur.check.disabled && !cur.check.ariaDisabled && Date.now() - t0 > 3000) {
      events.push(`${ts()} check button enabled -> stop`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return events;
});
console.log(log.join('\n'));
