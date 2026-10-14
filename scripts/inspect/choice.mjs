// Fill a QuizChoice (matching with rich-select dropdowns): one option text per prompt, in prompt order.
// Usage: node choice.mjs "<option text for prompt 1>" "<…prompt 2>" ...
import { withPage } from './lib.mjs';
const picks = process.argv.slice(2);
const out = await withPage(async (page) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  for (let i = 0; i < picks.length; i++) {
    const open = await page.evaluate(() => !!document.querySelector('.rich-select__menu-portal [role=listbox]')?.getClientRects().length);
    if (!open) {
      await page.evaluate((i) => { document.querySelectorAll('[data-probe]').forEach((e) => e.removeAttribute('data-probe')); const t = document.querySelectorAll('.quiz_type_choice button.rich-select__toggle-wrapper')[i]; t.scrollIntoView({ block: 'center' }); t.setAttribute('data-probe', 't'); }, i);
      await page.click('[data-probe="t"]'); await wait(600);
    }
    const ok = await page.evaluate((text) => { document.querySelectorAll('[data-probe]').forEach((e) => e.removeAttribute('data-probe')); const o = [...document.querySelectorAll('.rich-select__menu-portal button.rich-select__item[role=option]')].find((b) => b.getClientRects().length && b.innerText.includes(text)); o?.setAttribute('data-probe', 'o'); return !!o; }, picks[i]);
    if (!ok) { log.push(`option not found for prompt ${i + 1}: ${picks[i]}`); break; }
    await page.click('[data-probe="o"]'); await wait(600);
    log.push(await page.evaluate((i) => { const p = document.querySelectorAll('.quiz_type_choice .quiz-form-matching__prompt')[i]; return p.innerText.trim().replace(/\s+/g, ' '); }, i));
  }
  const btn = await page.evaluate(() => { const b = [...document.querySelectorAll('.quiz_type_choice button.button2')].pop(); return b ? (b.disabled || b.className.includes('disabled') ? 'disabled' : 'enabled') : 'none'; });
  return { log, submit: btn };
});
console.log(JSON.stringify(out, null, 1));
