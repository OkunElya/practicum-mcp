// Bundle the extension into extension/dist/ (load that folder as a temporary add-on).
// Usage: node extension/build.mjs [--watch] [--dev-token]
//   --dev-token  bake the bridge token (~/.config/practicum-mcp/token) in as the default,
//                for test installs without the popup. Never ship such a build.
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');
const devToken = process.argv.includes('--dev-token')
  ? readFileSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'practicum-mcp/token'), 'utf8').trim()
  : '';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'manifest.json'), join(out, 'manifest.json'));
cpSync(join(root, 'src/popup/popup.html'), join(out, 'popup.html'));

const ctx = await esbuild.context({
  entryPoints: {
    background: join(root, 'src/background/main.ts'),
    content: join(root, 'src/content/main.ts'),
    popup: join(root, 'src/popup/popup.ts'),
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'firefox128',
  sourcemap: 'inline',
  define: { __DEV_TOKEN__: JSON.stringify(devToken) },
  logLevel: 'info',
});
if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
