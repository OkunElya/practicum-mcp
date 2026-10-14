// Read-only: redux state shape, preloaded data, routes, test ids, react-aria pressables, resource timing.
import { withPage } from './lib.mjs';

const out = await withPage((page) =>
  page.evaluate(() => {
    const r = {};
    const shape = (v, depth = 2) => {
      if (v === null || typeof v !== 'object') return typeof v === 'string' ? `str(${v.length})` : typeof v;
      if (Array.isArray(v)) return v.length ? [`arr(${v.length})`, shape(v[0], depth - 1)] : 'arr(0)';
      if (depth <= 0) return `{${Object.keys(v).length} keys}`;
      return Object.fromEntries(Object.keys(v).slice(0, 40).map((k) => [k, shape(v[k], depth - 1)]));
    };

    // Redux store via the Provider fiber
    const mount = document.getElementById('mount');
    const ck = Object.keys(mount).find((k) => k.startsWith('__reactContainer$'));
    let store = null;
    let router = null;
    const stack = [mount[ck]];
    let visited = 0;
    while (stack.length && visited < 20000 && !(store && router)) {
      const f = stack.pop();
      visited++;
      if (!f) continue;
      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        if (!store && p.store?.getState && p.store?.dispatch) store = p.store;
        if (!router && p.history?.listen && p.history?.location) router = p.history;
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    r.storeFound = !!store;
    if (store) r.stateShape = shape(store.getState(), 2);
    r.history = router ? { location: router.location, length: router.length, keys: Object.keys(router) } : null;

    r.preloadedState = window.__preloadedState__ ? shape(window.__preloadedState__, 1) : null;
    r.preloadedData = window.__preloadedData__ ? shape(window.__preloadedData__, 2) : null;
    r.baseUrl = window.baseUrl;
    r.core = window.core ? Object.keys(window.core).slice(0, 30) : null;

    r.testIds = [...document.querySelectorAll('[data-test-id]')].map((e) => `${e.getAttribute('data-test-id')} <${e.tagName.toLowerCase()}>`);
    r.links = [...new Set([...document.querySelectorAll('a[href]')].map((a) => `${new URL(a.href).pathname} "${a.textContent.trim().slice(0, 30)}"`))];
    r.ariaPressables = [...document.querySelectorAll('[data-react-aria-pressable]')].map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute('role') ?? ''}] "${(e.getAttribute('aria-label') || e.textContent).trim().slice(0, 30)}"`);
    r.inputs = [...document.querySelectorAll('input,textarea,select')].map((e) => `${e.tagName.toLowerCase()} type=${e.type} name=${e.name} ph="${e.placeholder ?? ''}"`);
    r.buttons = [...document.querySelectorAll('button')].map((b) => `"${(b.getAttribute('aria-label') || b.textContent).trim().slice(0, 30)}" .${b.classList[0] ?? ''}`);

    // Course cards: how are they built?
    const card = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Основы Python');
    if (card) {
      const chain = [];
      for (let e = card; e && e !== document.body && chain.length < 8; e = e.parentElement) {
        const pk = Object.keys(e).find((k) => k.startsWith('__reactProps$'));
        const handlers = pk ? Object.keys(e[pk]).filter((k) => /^on[A-Z]/.test(k)) : [];
        chain.push(`${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')}${e.getAttribute('href') ? ` href=${e.getAttribute('href')}` : ''} ${handlers.join(',')}`);
      }
      r.courseCardChain = chain;
    }

    const res = performance.getEntriesByType('resource');
    r.resourceTiming = { count: res.length, byInitiator: res.reduce((a, e) => ((a[e.initiatorType] = (a[e.initiatorType] || 0) + 1), a), {}) };
    r.apiLike = [...new Set(res.map((e) => e.name.split('?')[0]).filter((n) => /\/api\/|graphql|socket/i.test(n)))].slice(0, 40);
    return r;
  }),
);
console.log(JSON.stringify(out, null, 1));
