// Read-only: save the raw JSON of every accessible lesson of the profession
// (GET /api/lessons/{id}/, the same read read_lesson does; nothing is written
// to the account) plus an index, for the agent simulator in bridge/evals/.
// The JSON contains the quiz answer keys, so the output stays out of git.
// Usage: node scripts/inspect/scrape-lessons.mjs [outDir]   (default bridge/evals/raw)
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { withPage } from './lib.mjs';

const out = process.argv[2] ?? fileURLToPath(new URL('../../bridge/evals/raw', import.meta.url));
mkdirSync(join(out, 'lessons'), { recursive: true });

await withPage(async (page) => {
  // The profile page embeds the course → topic → lesson tree as a JS literal.
  const literal = await page.evaluate(async () => {
    const slug = location.pathname.match(/^\/(?:profile|learn|trainer)\/([^/]+)/)?.[1];
    const html = await (await fetch(`/profile/${slug}/`, { credentials: 'include' })).text();
    const start = html.indexOf('window.__preloadedState__ = ');
    const end = html.indexOf('</script>', start);
    return start < 0 ? null : html.slice(start + 'window.__preloadedState__ = '.length, end).trim().replace(/;$/, '');
  });
  if (!literal) throw new Error('no preloaded state on the profile page (open a lesson of the profession first)');
  const profile = vm.runInNewContext(`(${literal})`).profileReducer.profile;

  const index = [];
  profile.courses.forEach((c, ci) =>
    c.topics.forEach((t, ti) =>
      t.lessons.forEach((l, li) =>
        index.push({
          pos: `${ci + 1}.${ti + 1}.${li + 1}`,
          id: l.id,
          name: l.name,
          type: l.lesson_type,
          solved: !!l.solved,
          access: l.has_access !== false,
          course: c.name,
          topic: t.name,
        }),
      ),
    ),
  );
  writeFileSync(join(out, 'index.json'), JSON.stringify({ profession: profile.name, lessons: index }, null, 1));
  console.log(`${profile.name}: ${index.length} lessons`);

  let saved = 0;
  for (const l of index) {
    const file = join(out, 'lessons', `${l.id}.json`);
    if (!l.access || existsSync(file)) continue;
    const res = await page.evaluate(async (id) => {
      const r = await fetch(`/api/lessons/${id}/`, { credentials: 'include' });
      return { status: r.status, body: r.ok ? await r.text() : '' };
    }, l.id);
    if (res.status !== 200) {
      console.log(`${l.pos} ${l.name}: HTTP ${res.status}`);
      continue;
    }
    writeFileSync(file, res.body);
    saved++;
    if (saved % 25 === 0) console.log(`… ${saved} saved (at ${l.pos})`);
    await new Promise((r) => setTimeout(r, 250)); // be gentle with the site
  }
  console.log(`saved ${saved} new lessons to ${out}`);
});
