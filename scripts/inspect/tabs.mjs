import { connect } from './lib.mjs';

const { browser, release } = await connect();
try {
  for (const page of await browser.pages()) {
    console.log(`${page.url()}  |  ${await page.title().catch(() => '?')}`);
  }
} finally {
  await release();
}
