// Screenshot one element. Usage: node shot-el.mjs "<css>" [out.png]
import { withPage } from './lib.mjs';
const [sel, file = 'shot-el.png'] = process.argv.slice(2);
await withPage(async (page) => {
  const el = await page.$(sel);
  if (!el) throw new Error(`not found: ${sel}`);
  await el.evaluate((e) => e.scrollIntoView({ block: 'start' }));
  await el.screenshot({ path: new URL(`./${file}`, import.meta.url).pathname });
});
console.log('ok');
