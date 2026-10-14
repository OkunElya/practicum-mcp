// Shared in-page helper source: find the Redux store from #mount.
export const FIND_STORE = `(() => {
  const mount = document.getElementById('mount');
  const st = [mount[Object.keys(mount).find((k) => k.startsWith('__reactContainer$'))]];
  while (st.length) { const f = st.pop(); if (!f) continue; if (f.memoizedProps?.store?.getState) return f.memoizedProps.store; if (f.sibling) st.push(f.sibling); if (f.child) st.push(f.child); }
  return null;
})()`;
