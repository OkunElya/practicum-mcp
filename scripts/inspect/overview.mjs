// Read-only overview of the page: framework, React internals, state stores, DOM shape, network.
import { withPage } from './lib.mjs';

const out = await withPage(async (page) => {
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return page.evaluate(() => {
    const r = {};
    r.url = location.href;
    r.title = document.title;

    // Non-standard globals: diff against a pristine iframe window.
    const ifr = document.createElement('iframe');
    ifr.style.display = 'none';
    document.body.appendChild(ifr);
    const std = new Set(Object.getOwnPropertyNames(ifr.contentWindow));
    ifr.remove();
    r.globals = Object.getOwnPropertyNames(window).filter((k) => !std.has(k) && !/^on/.test(k)).slice(0, 150);

    // React root + fiber keys
    const all = [...document.querySelectorAll('*')];
    r.elementCount = all.length;
    const rootEls = all.filter((e) => Object.keys(e).some((k) => k.startsWith('__reactContainer$') || k === '_reactRootContainer'));
    r.reactRoots = rootEls.map((e) => `${e.tagName.toLowerCase()}#${e.id}.${[...e.classList].join('.')}`);
    const withFiber = all.filter((e) => Object.keys(e).some((k) => k.startsWith('__reactFiber$')));
    r.elementsWithFiber = withFiber.length;
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    r.devtoolsHook = hook ? { renderers: [...(hook.renderers?.values?.() ?? [])].map((x) => ({ version: x.version, bundleType: x.bundleType, pkg: x.rendererPackageName })) } : null;

    // Component names along fibers
    const fiberOf = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactFiber$'))];
    const names = new Map();
    const providers = [];
    const seen = new Set();
    for (const e of withFiber) {
      for (let f = fiberOf(e); f && !seen.has(f); f = f.return) {
        seen.add(f);
        const t = f.type;
        if (t && typeof t !== 'string') {
          const n = t.displayName || t.name || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || (t._context ? `Provider(${t._context.displayName || '?'})` : null);
          if (n) names.set(n, (names.get(n) || 0) + 1);
          const p = f.memoizedProps;
          if (p && typeof p === 'object') {
            for (const k of ['store', 'client', 'queryClient', 'router', 'history', 'i18n', 'value']) {
              const v = p[k];
              if (v && typeof v === 'object' && !providers.some((x) => x.v === v)) {
                providers.push({ v, comp: n, prop: k, keys: Object.keys(v).slice(0, 15) });
              }
            }
          }
        }
      }
    }
    r.componentNamesTop = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80);
    r.componentNameCount = names.size;
    r.providerish = providers.filter((p) => p.prop !== 'value' || p.keys.some((k) => /dispatch|getState|subscribe|query|navigate/i.test(k))).slice(0, 25).map(({ comp, prop, keys }) => ({ comp, prop, keys }));

    // Clickables: React onClick on non-interactive tags
    const propsOf = (e) => e[Object.keys(e).find((k) => k.startsWith('__reactProps$'))];
    const nativeSel = 'a[href],button,input,select,textarea,summary,[role]';
    let divClick = 0;
    const divClickSamples = [];
    for (const e of all) {
      const p = propsOf(e);
      if (p && typeof p.onClick === 'function' && !e.matches(nativeSel)) {
        divClick++;
        if (divClickSamples.length < 10) divClickSamples.push(`${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')} "${(e.textContent || '').trim().slice(0, 40)}"`);
      }
    }
    r.native = {
      a: document.querySelectorAll('a[href]').length,
      button: document.querySelectorAll('button').length,
      input: document.querySelectorAll('input:not([type=hidden]),textarea,select').length,
      role: [...new Set([...document.querySelectorAll('[role]')].map((e) => e.getAttribute('role')))],
      ariaLabel: document.querySelectorAll('[aria-label]').length,
    };
    r.reactOnClickNonInteractive = { count: divClick, samples: divClickSamples };

    // Test / QA attributes
    const attrCounts = {};
    for (const e of all) for (const a of e.attributes) if (/^data-/.test(a.name)) attrCounts[a.name] = (attrCounts[a.name] || 0) + 1;
    r.dataAttrs = Object.entries(attrCounts).sort((a, b) => b[1] - a[1]).slice(0, 25);
    r.classSamples = [...new Set(all.slice(0, 400).flatMap((e) => [...e.classList]))].slice(0, 40);
    r.iframes = [...document.querySelectorAll('iframe')].map((f) => f.src.slice(0, 100));
    r.shadowRoots = all.filter((e) => e.shadowRoot).length;

    // Scripts and network
    r.scripts = [...document.scripts].map((s) => s.src || `inline:${s.textContent.length}`).filter((s) => !s.startsWith('inline:0')).slice(0, 40);
    r.apiCalls = [...new Set(performance.getEntriesByType('resource')
      .filter((e) => ['fetch', 'xmlhttprequest', 'beacon'].includes(e.initiatorType))
      .map((e) => `${e.initiatorType} ${e.name.split('?')[0]}`))].slice(0, 80);
    return r;
  });
});
console.log(JSON.stringify(out, null, 1));
