// QuizCards probe: print pool/columns; optionally press retry, click a card, click a column.
// Usage: node cards.mjs [--retry] [--move "<card text>=<column title>"]... [--submit]
import { withPage } from './lib.mjs';
import { INSTALL } from './recorder.mjs';
const argv = process.argv.slice(2);
const moves = [];
for (let i = 0; i < argv.length; i++) if (argv[i] === '--move') moves.push(argv[++i].split('='));
const out = await withPage(async (page) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await page.evaluate(INSTALL); await page.evaluate(() => (window.__probe.length = 0));
  const state = () => page.evaluate(() => {
    const q = document.querySelector('.quiz_type_cards');
    const lists = [...q.querySelectorAll('.dragndrop__list')].filter((l) => !l.closest('.dragndrop__list-content'));
    const titleOf = (l) => l.closest('.quiz__section-list-wrapper')?.querySelector('.quiz__section-content-text')?.innerText.trim() || (l.className.includes('horizontal') ? 'POOL' : '?');
    return { quizCls: q.className.split(' ').filter((c) => /quiz_/.test(c)).join(' '),
      lists: lists.map((l) => ({ t: titleOf(l), cls: [...l.classList].filter((c) => /active|selected|hover|droppable|highlight/.test(c)).join('.'), items: [...l.querySelectorAll('.dragndrop__item')].map((i) => ([...i.classList].filter((c) => /selected|active|picked|correct|incorrect/.test(c)).join('.') + ' ' + i.innerText.replace(/Подсказка|\?/g, '').trim().slice(0, 30)).trim()) })),
      buttons: [...q.querySelectorAll('button.button2')].filter((b) => b.getClientRects().length).map((b) => (b.getAttribute('aria-label') || b.title || b.textContent).trim() + (b.disabled ? '(disabled)' : '')),
      status: q.querySelector('[role=status]')?.innerText.trim().slice(0, 120) };
  });
  const log = [{ start: await state() }];
  const clickMarked = async (fn, arg) => { const ok = await page.evaluate(fn, arg); if (!ok) return false; await page.click('[data-probe="c"]'); await wait(500); return true; };
  const mark = `(e) => { document.querySelectorAll('[data-probe]').forEach((x) => x.removeAttribute('data-probe')); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.setAttribute('data-probe', 'c'); return true; }`;
  if (argv.includes('--retry')) {
    await clickMarked(new Function('m', `const b = [...document.querySelectorAll('.quiz_type_cards button.button2')].find((b) => /Ответить повторно/.test(b.getAttribute('aria-label') || b.title || b.textContent)); return (${mark})(b);`), null);
    await clickMarked(new Function('m', `const b = [...document.querySelectorAll('.quiz_type_cards .quiz__reset-dialog button')].find((b) => b.textContent.trim() === 'Заново'); return (${mark})(b);`), null);
    await wait(800);
    log.push({ afterRetry: await state(), api: await page.evaluate(() => window.__probe.splice(0).filter((a) => !/unread|feedback/.test(a.url)).map((a) => a.method + ' ' + a.status + ' ' + a.url)) });
  }
  for (const [card, col] of moves) {
    await clickMarked(new Function('t', `const e = [...document.querySelectorAll('.quiz_type_cards .dragndrop__item')].find((i) => i.innerText.includes(t)); return (${mark})(e);`), card);
    const mid = await state();
    await clickMarked(new Function('t', `const q = document.querySelector('.quiz_type_cards'); const l = [...q.querySelectorAll('.dragndrop__list')].filter((l) => !l.closest('.dragndrop__list-content')).find((l) => (l.closest('.quiz__section-list-wrapper')?.querySelector('.quiz__section-content-text')?.innerText.trim() || '') === t); return (${mark})(l?.querySelector('.dragndrop__list-content') || l);`), col);
    log.push({ move: `${card} -> ${col}`, afterCardClick: mid.lists.map((l) => l.t + ':' + l.items.filter((i) => /selected|active|picked/.test(i)).join('|')).join(' ; '), after: (await state()).lists.map((l) => l.t + '[' + l.items.length + ']').join(' ') });
  }
  if (argv.includes('--submit')) {
    await clickMarked(new Function('m', `const b = [...document.querySelectorAll('.quiz_type_cards button.button2')].find((b) => b.textContent.trim() === 'Проверить'); return (${mark})(b);`), null);
    await wait(2500);
    log.push({ submitted: await state(), api: await page.evaluate(() => window.__probe.splice(0).filter((a) => !/unread|feedback/.test(a.url)).map((a) => ({ m: a.method, u: a.url, s: a.status, req: (a.reqBody || '').replace(/,"markup":.*$/, '…'), })) ) });
  }
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return log;
});
console.log(JSON.stringify(out, null, 1));
