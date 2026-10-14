// Read-only: YaGPT chat slice, RTK Query endpoints, service URLs.
import { withPage } from './lib.mjs';

const out = await withPage((page) =>
  page.evaluate(() => {
    const shape = (v, depth = 2) => {
      if (v === null || typeof v !== 'object') return typeof v === 'string' ? `str(${v.length})` : v === null ? 'null' : typeof v;
      if (Array.isArray(v)) return v.length ? [`arr(${v.length})`, shape(v[0], depth - 1)] : 'arr(0)';
      if (depth <= 0) return `{${Object.keys(v).length} keys}`;
      return Object.fromEntries(Object.keys(v).slice(0, 40).map((k) => [k, shape(v[k], depth - 1)]));
    };
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
    const s = store.getState();
    const pd = window.__preloadedData__;
    return {
      chatYaGPT: shape(s.chatYaGPT, 3),
      aiChatConfig: pd.config.aiChat,
      messengerChat: shape(pd.config.messengerChat, 2),
      rtkQueries: Object.values(s.api.queries).map((q) => ({ endpoint: q.endpointName, status: q.status, argKeys: q.originalArgs && typeof q.originalArgs === 'object' ? Object.keys(q.originalArgs) : typeof q.originalArgs })),
      rtkConfig: s.api.config,
      rtkProvidedTags: Object.keys(s.api.provided?.tags ?? s.api.provided ?? {}),
      urls: { serverhubUrl: pd.serverhubUrl, serverhubWsUrl: pd.serverhubWsUrl, serverhubApiPrefix: pd.serverhubApiPrefix, feynmanUrl: pd.feynmanUrl, passportOrigin: pd.passportOrigin, basePath: pd.basePath },
      storeExtras: Object.keys(store).filter((k) => !['dispatch', 'subscribe', 'getState', 'replaceReducer'].includes(k)),
    };
  }),
);
console.log(JSON.stringify(out, null, 1));
