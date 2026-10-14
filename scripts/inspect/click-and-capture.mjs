// Click an element by visible text, record the non-static network traffic it
// triggers, then summarize what is on screen (topmost overlay if any) and screenshot.
// Usage: node click-and-capture.mjs "<text>" [waitMs]
import { withPage } from './lib.mjs';
import { INSTALL } from './recorder.mjs';

const [text, waitMs = '4000'] = process.argv.slice(2);
if (!text) throw new Error('usage: click-and-capture.mjs "<text>" [waitMs]');

const out = await withPage(async (page) => {
  const reqs = [];
  const onResponse = (res) => {
    try {
      const req = res.request();
      const u = new URL(res.url());
      // resourceType() is unsupported over BiDi; drop static assets by extension instead.
      if (/\.(js|mjs|css|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|ico|mp4|webm|html)$/i.test(u.pathname)) return;
      if (/metrika|mc\.yandex|pixels|tomi|analytics|rum|yandex\.ru\/clck|abt\./.test(u.host + u.pathname)) return;
      reqs.push(`${req.method()} ${res.status()} ${u.host}${u.pathname}${u.search ? ' ?' + [...u.searchParams.keys()].join('&') : ''}`);
    } catch (e) {
      reqs.push(`(unreadable response: ${e.message})`);
    }
  };
  page.on('response', onResponse);

  // Don't patch page globals on /trainer/ pages (precaution, docs/platform-findings.md §8).
  if (!page.url().includes('/trainer/')) await page.evaluate(INSTALL);
  await page.evaluate(() => window.__probe && (window.__probe.length = 0));
  const before = page.url();
  const clicked = await page.evaluate((t) => {
    const propsOf = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps$'))];
    const clickable = (e) =>
      e.matches('a[href],button,[role=button],[role=menuitem],[role=link],[role=option],[role=tab]') ||
      typeof propsOf(e)?.onClick === 'function';
    const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    // Innermost clickable whose text contains t; later in DOM wins (portals/modals render last).
    const cands = [...document.querySelectorAll('*')].filter((e) => clickable(e) && visible(e) && e.textContent.includes(t));
    const innermost = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
    const el = innermost[innermost.length - 1];
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.setAttribute('data-inspect-target', '1');
    const handlers = Object.keys(propsOf(el) ?? {}).filter((k) => /^on[A-Z]/.test(k));
    return `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')} role=${el.getAttribute('role') ?? ''} href=${el.getAttribute('href') ?? ''} handlers=${handlers.join(',')} (${innermost.length} matches)`;
  }, text);
  if (!clicked) throw new Error(`nothing clickable contains "${text}"`);
  await page.click('[data-inspect-target="1"]');
  await new Promise((r) => setTimeout(r, Number(waitMs)));
  page.off('response', onResponse);

  const screen = await page.evaluate(() => {
    document.querySelector('[data-inspect-target]')?.removeAttribute('data-inspect-target');
    const propsOf = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps$'))];
    const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    // Topmost fixed layer covering most of the viewport = the open modal/drawer.
    const overlays = [...document.querySelectorAll('body *')].filter((e) => {
      const s = getComputedStyle(e);
      if (s.position !== 'fixed' || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
      const r = e.getBoundingClientRect();
      return r.width * r.height > 0.5 * innerWidth * innerHeight;
    });
    const z = (e) => Number(getComputedStyle(e).zIndex) || 0;
    overlays.sort((a, b) => z(a) - z(b) || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const root = overlays[overlays.length - 1] ?? document.body;
    const items = [...root.querySelectorAll('*')]
      .filter((e) => visible(e) && (e.matches('a[href],button,[role],input,textarea,select') || typeof propsOf(e)?.onClick === 'function'))
      .slice(0, 40)
      .map((e) => {
        const h = Object.keys(propsOf(e) ?? {}).filter((k) => /^on[A-Z]/.test(k));
        return `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')}${e.getAttribute('role') ? `[${e.getAttribute('role')}]` : ''}${e.getAttribute('href') ? ` href=${e.getAttribute('href')}` : ''}${e.dataset.testId ? ` tid=${e.dataset.testId}` : ''} "${(e.getAttribute('aria-label') || e.textContent).trim().replace(/\s+/g, ' ').slice(0, 50)}" ${h.join(',')}`;
      });
    return {
      overlay: root === document.body ? null : `${root.tagName.toLowerCase()}.${[...root.classList].slice(0, 3).join('.')} role=${root.getAttribute('role')} aria-modal=${root.getAttribute('aria-modal')}`,
      items,
    };
  });
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  const api = await page.evaluate(() => window.__probe?.splice(0) ?? []);
  return { clicked, before, after: page.url(), title: await page.title(), requests: [...new Set(reqs)], api, screen };
});
console.log(JSON.stringify(out, null, 1));
