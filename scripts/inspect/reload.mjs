// Reload the practicum tab and wait for it to settle.
import { withPage } from './lib.mjs';
const url = await withPage(async (page) => {
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));
  return page.url();
});
console.log('reloaded', url);
