// Perform optional UI steps, then record ALL browser-level network for N seconds
// (bodies via BiDi where available) plus diffs of the chatYaGPT Redux slice.
// Usage: node net-watch.mjs [--seconds N] [--click <css>]... [--type <css> <text>] [--enter] [--all]
//   Steps run in the order given. --all keeps analytics/static requests too.
import { writeFileSync } from 'node:fs';
import { withPage } from './lib.mjs';
import { FIND_STORE } from './store.mjs';

const argv = process.argv.slice(2);
const steps = [];
let seconds = 30;
let all = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--seconds') seconds = Number(argv[++i]);
  else if (a === '--click') steps.push({ click: argv[++i] });
  else if (a === '--type') steps.push({ type: argv[++i], text: argv[++i] });
  else if (a === '--enter') steps.push({ enter: true });
  else if (a === '--all') all = true;
}

const SLICE = `(() => {
  const s = ${FIND_STORE}.getState().chatYaGPT;
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Node ? '<node>' : v)));
  return s ? strip(s) : null;
})()`;

const out = await withPage(async (page) => {
  const t0 = Date.now();
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
  const net = [];
  const pending = [];
  const NOISE = /metrika|mc\.yandex|clck|apigw\.yandexcloud|mail\.ru|tomi|pixels|uaas|event_collector|LatencyMetrics|avatars\.mds/;
  const STATIC = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map)$/i;
  page.on('request', (req) => {
    const u = req.url();
    if (!all && (NOISE.test(u) || STATIC.test(new URL(u).pathname))) return;
    net.push({ t: ts(), ev: 'request', method: req.method(), url: u, headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => /content-type|accept|x-|authorization/i.test(k)).map(([k, v]) => [k, /auth|token|cookie/i.test(k) ? `<redacted ${v.length}ch>` : v])), postData: (() => { try { return req.postData?.() ?? null; } catch { return '(n/a over BiDi)'; } })() });
  });
  page.on('response', (res) => {
    const u = res.url();
    if (!all && (NOISE.test(u) || STATIC.test(new URL(u).pathname))) return;
    const entry = { t: ts(), ev: 'response', method: res.request().method(), status: res.status(), url: u, contentType: res.headers()['content-type'] };
    net.push(entry);
    if (/practicum\.yandex\.ru\/api\/|gpt|chat|stream|serverhub/i.test(u) && res.status() !== 101) {
      pending.push(res.text().then((b) => (entry.body = b.length > 6000 ? b.slice(0, 6000) + `…(+${b.length - 6000})` : b)).catch((e) => (entry.body = `(unavailable: ${e.message})`)));
    }
  });
  page.on('requestfailed', (req) => net.push({ t: ts(), ev: 'failed', method: req.method(), url: req.url(), err: req.failure()?.errorText }));

  const slices = [];
  let prev = JSON.stringify(await page.evaluate(SLICE).catch(() => null));
  slices.push({ t: ts(), state: JSON.parse(prev) });
  const done = [];
  for (const st of steps) {
    if (st.click) {
      // first visible match, scrolled into view (panels with their own scroll areas)
      const el = await page.evaluateHandle((sel) => {
        const e = [...document.querySelectorAll(sel)].find((x) => x.getClientRects().length) ?? null;
        e?.scrollIntoView({ block: 'center' });
        return e;
      }, st.click);
      if (!el.asElement()) { done.push(`MISSING ${st.click}`); break; }
      await new Promise((r) => setTimeout(r, 300));
      await el.asElement().click();
      done.push(`${ts()} click ${st.click}`);
    } else if (st.type) {
      const el = await page.$(st.type);
      if (!el) { done.push(`MISSING ${st.type}`); break; }
      await el.click();
      await page.keyboard.type(st.text, { delay: 15 });
      done.push(`${ts()} type into ${st.type}: ${st.text}`);
    } else if (st.enter) {
      await page.keyboard.press('Enter');
      done.push(`${ts()} Enter`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  while (Date.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 1000));
    const cur = JSON.stringify(await page.evaluate(SLICE).catch(() => null));
    if (cur !== prev) {
      slices.push({ t: ts(), state: JSON.parse(cur) });
      prev = cur;
    }
  }
  await Promise.allSettled(pending);
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return { done, net, slices };
});
const file = new URL('./net-watch-last.json', import.meta.url).pathname;
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`steps: ${out.done.join(' | ')}\nnet entries: ${out.net.length}, state changes: ${out.slices.length - 1}\nfull log: ${file}`);
