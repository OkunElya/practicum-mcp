// Install extension/dist into the running Waterfox as a temporary add-on (via WebDriver
// BiDi, no signing needed). It stays until the browser restarts. Re-running replaces it.
// Needs Waterfox started with --remote-debugging-port 9222.
// Usage: node scripts/dev/install-ext.mjs [--uninstall]
import { fileURLToPath } from 'node:url';
import { connect } from '../inspect/lib.mjs';

const ID = 'practicum-mcp@local';
const dist = fileURLToPath(new URL('../../extension/dist', import.meta.url));

const { browser, release } = await connect();
try {
  await browser.uninstallExtension(ID).catch(() => {}); // not installed yet is fine
  if (process.argv.includes('--uninstall')) console.log(`uninstalled ${ID}`);
  else console.log(`installed ${await browser.installExtension(dist)} from ${dist}`);
} finally {
  await release();
}
