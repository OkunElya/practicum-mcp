// Read-only: structure of the lesson theory stored in Redux (proficiencyReducer.lesson.theory).
import { withPage } from './lib.mjs';

const out = await withPage((page) =>
  page.evaluate(() => {
    const mount = document.getElementById('mount');
    const stack = [mount[Object.keys(mount).find((k) => k.startsWith('__reactContainer$'))]];
    let store = null;
    while (stack.length && !store) {
      const f = stack.pop();
      if (!f) continue;
      if (f.memoizedProps?.store?.getState) store = f.memoizedProps.store;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    const th = store.getState().proficiencyReducer.lesson.theory;
    const desc = (v) => (Array.isArray(v) ? `arr(${v.length})` : v && typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : typeof v === 'string' ? `str(${v.length}) ${JSON.stringify(v.slice(0, 80))}` : String(v));
    const r = { keys: Object.fromEntries(Object.entries(th).map(([k, v]) => [k, desc(v)])) };
    const arr = Object.values(th).find((v) => Array.isArray(v) && v.length);
    if (arr) {
      r.blockTypes = [...new Set(arr.map((b) => b.type ?? b.kind ?? Object.keys(b).join(',')))];
      r.firstBlocks = arr.slice(0, 4).map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, desc(v)])));
      r.totalBlocks = arr.length;
      r.totalChars = JSON.stringify(arr).length;
    }
    return r;
  }),
);
console.log(JSON.stringify(out, null, 1));
