// Navigate the practicum tab to a path (full load) and wait. Usage: node goto.mjs </path>
import { withPage } from './lib.mjs';
const path = process.argv[2];
const url = await withPage(async (page) => {
  await page.keyboard.press('Escape').catch(() => {});
  await page.goto(new URL(path, 'https://practicum.yandex.ru').href, { waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 5000));
  return page.url();
});
console.log('at', url);
