// Connect QuizMacaroni pairs by clicking left label then right label.
// Usage: node macaroni.mjs "<leftText>=<rightText>" ... [--submit]
import { withPage } from './lib.mjs';
const args = process.argv.slice(2);
const submit = args.includes('--submit');
const pairs = args.filter((a) => a.includes('=')).map((a) => a.split('='));
const out = await withPage(async (page) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = () => page.evaluate(() => {
    const q = document.querySelector('.quiz_type_macaroni');
    const lists = [...q.querySelectorAll('.MarkerMacaroni-List')];
    return { quizCls: q.className.split(' ').filter((c) => /quiz_/.test(c)).join(' '),
      cols: lists.map((l) => [...l.querySelectorAll('label')].map((lab) => [...lab.classList].filter((c) => /status|selected|active|connected|Option_/.test(c)).join('.') + ' "' + lab.innerText.trim().slice(0, 22) + '"' + (lab.querySelector('input').checked ? ' [x]' : ''))),
      lines: q.querySelectorAll('svg line, svg path, [class*=line], [class*=Line]').length,
      btn: q.querySelector('button')?.disabled ? 'disabled' : 'enabled', feedback: q.innerText.includes('Правильн') || q.innerText.includes('Неправ') ? q.innerText.slice(-300) : '' };
  });
  const log = [];
  const mark = (side, text) => page.evaluate((side, text) => {
    document.querySelectorAll('[data-probe]').forEach((e) => e.removeAttribute('data-probe'));
    const lists = [...document.querySelectorAll('.quiz_type_macaroni .MarkerMacaroni-List')];
    const lab = [...lists[side].querySelectorAll('label')].find((l) => l.innerText.includes(text));
    lab?.scrollIntoView({ block: 'center' });
    lab?.setAttribute('data-probe', 'x');
    return !!lab;
  }, side, text);
  for (const [l, r] of pairs) {
    if (!(await mark(0, l))) { log.push('missing left ' + l); break; }
    await page.click('[data-probe="x"]'); await wait(300);
    const mid = await state();
    if (!(await mark(1, r))) { log.push('missing right ' + r); break; }
    await page.click('[data-probe="x"]'); await wait(500);
    log.push({ pair: `${l} = ${r}`, afterLeft: mid.cols, after: await state() });
  }
  if (submit) {
    await page.evaluate(() => document.querySelector('.quiz_type_macaroni button').setAttribute('data-probe', 's'));
    await page.click('[data-probe="s"]'); await wait(3000);
    log.push({ submitted: await state() });
  }
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return { before: pairs.length ? undefined : await state(), log };
});
console.log(JSON.stringify(out, null, 1));
