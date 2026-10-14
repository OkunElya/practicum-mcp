import puppeteer from 'puppeteer-core';

/**
 * Firefox allows a single WebDriver BiDi session and does NOT end it when the
 * socket drops, so a crashed script locks us out until the browser restarts.
 * Always end the session explicitly, including on crashes and signals.
 */
export async function connect() {
  const browser = await puppeteer.connect({
    browserWSEndpoint: 'ws://127.0.0.1:9222/session',
    protocol: 'webDriverBiDi',
  });
  let done = false;
  const release = async () => {
    if (done) return;
    done = true;
    await browser.disconnect().catch(() => {});
  };
  const bail = (err) => {
    console.error(err);
    release().finally(() => process.exit(1));
  };
  process.once('uncaughtException', bail);
  process.once('unhandledRejection', bail);
  process.once('SIGINT', () => bail('SIGINT'));
  process.once('SIGTERM', () => bail('SIGTERM'));
  return { browser, release };
}

export async function withPage(fn, match = 'practicum.yandex.ru') {
  const { browser, release } = await connect();
  try {
    const page = (await browser.pages()).find((p) => p.url().includes(match));
    if (!page) throw new Error(`no tab matching ${match}`);
    return await fn(page);
  } finally {
    await release();
  }
}
