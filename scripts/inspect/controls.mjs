// Read-only: list visible clickable controls in a region (default: left 80px rail + header),
// with test-id, aria-label/title, href and React handlers.
// Usage: node controls.mjs [css-scope]
import { withPage } from './lib.mjs';
const scope = process.argv[2] ?? null;
const out = await withPage((page) =>
  page.evaluate((scope) => {
    const propsOf = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps$'))];
    const roots = scope ? [...document.querySelectorAll(scope)] : [document.body];
    const seen = new Set();
    const rows = [];
    for (const root of roots)
      for (const e of root.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=tab]')) {
        if (seen.has(e) || !e.getClientRects().length) continue;
        seen.add(e);
        const r = e.getBoundingClientRect();
        if (!scope && !(r.x < 80 || r.y < 60)) continue; // default: left rail + top header
        const h = Object.keys(propsOf(e) ?? {}).filter((k) => /^on[A-Z]/.test(k));
        rows.push(`${Math.round(r.x)},${Math.round(r.y)} ${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')}${e.dataset.testId ? ' tid=' + e.dataset.testId : ''}${e.getAttribute('href') ? ' href=' + e.getAttribute('href') : ''} "${(e.getAttribute('aria-label') || e.title || e.textContent).trim().replace(/\s+/g, ' ').slice(0, 50)}" ${h.join(',')}`);
      }
    return { url: location.pathname, rows };
  }, scope),
);
console.log(out.url);
console.log(out.rows.join('\n'));
