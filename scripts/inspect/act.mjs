// Click a sequence of CSS selectors (real pointer clicks), then report API traffic
// and the text/state of a watched container.
// Usage: node act.mjs --watch "<css>" [--wait ms] "<css1>" "<css2>" ...
//   `:has()` works (Gecko 121+), e.g. 'label:has(input[value="<option id>"])'
import { withPage } from './lib.mjs';
import { INSTALL } from './recorder.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  if (i === -1) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const watch = opt('--watch', null);
const wait = Number(opt('--wait', '2500'));
const steps = args;

const out = await withPage(async (page) => {
  // Don't patch page globals on /trainer/ pages (precaution, docs/platform-findings.md §8).
  if (!page.url().includes('/trainer/')) await page.evaluate(INSTALL);
  await page.evaluate(() => window.__probe && (window.__probe.length = 0));
  const done = [];
  for (const sel of steps) {
    const found = await page.$(sel);
    if (!found) {
      done.push(`MISSING ${sel}`);
      break;
    }
    await found.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await found.click();
    done.push(`clicked ${sel}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, wait));
  const api = await page.evaluate(() => window.__probe?.splice(0) ?? []);
  const watched = watch
    ? await page.evaluate((w) => {
        const el = document.querySelector(w);
        if (!el) return `watch target ${w} not found`;
        const inputs = [...el.querySelectorAll('input,button')].map((i) => `${i.tagName.toLowerCase()} ${i.type}${i.checked ? ' checked' : ''}${i.disabled ? ' disabled' : ''} ${i.value || i.textContent.trim().slice(0, 30)} .${[...(i.closest('label,div') ?? i).classList].join('.')}`);
        return { classes: el.className, text: el.innerText.slice(0, 2500), inputs };
      }, watch)
    : null;
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return { done, url: page.url(), api, watched };
});
console.log(JSON.stringify(out, null, 1));
