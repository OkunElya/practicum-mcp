// Bundle the extension into extension/dist/ (load that folder as a temporary add-on).
// Usage: node extension/build.mjs [--watch] [--dev] [--package]
//   --package  also zip dist/ into extension/practicum-mcp-<version>.xpi (refused with --dev)
//   --dev  test build: adds the dev_* tools and bakes the bridge token
//          (~/.config/practicum-mcp/token) in as the default, so a temporary install
//          connects without the popup. Never ship such a build.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');
const pack = process.argv.includes('--package');
if (pack && dev) throw new Error('--package with --dev would ship your bridge token; build without --dev');
const devToken = dev
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
  sourcemap: dev ? 'inline' : false,
  define: { __DEV_TOKEN__: JSON.stringify(devToken), __DEV__: String(dev) },
  logLevel: 'info',
});
if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
  if (pack) {
    const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    const xpi = join(root, `practicum-mcp-${version}.xpi`);
    rmSync(xpi, { force: true });
    execFileSync('zip', ['-q', '-r', '-X', xpi, '.'], { cwd: out });
    console.log(`packaged ${xpi}`);
  }
}
