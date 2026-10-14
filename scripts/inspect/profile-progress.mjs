// Read-only: main (profile) page progress — UI elements and where the numbers come from.
import { withPage } from './lib.mjs';
import { FIND_STORE } from './store.mjs';
const out = await withPage(async (page) => {
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname, fullPage: true }).catch(() => page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname }));
  return page.evaluate(`(() => {
    const s = ${FIND_STORE}.getState();
    const shape = (v, d = 2) => v === null || typeof v !== 'object' ? (typeof v === 'string' ? JSON.stringify(v.slice(0, 60)) : String(v)) : Array.isArray(v) ? 'arr(' + v.length + ')' + (v.length && d > 0 ? ' of ' + JSON.stringify(shape(v[0], d - 1)) : '') : d <= 0 ? '{' + Object.keys(v).length + '}' : Object.fromEntries(Object.keys(v).slice(0, 30).map((k) => [k, shape(v[k], d - 1)]));
    // progress bar(s)
    const bars = [...document.querySelectorAll('[class*=progress]')].filter((e) => e.getClientRects().length).map((e) => {
      const fill = [...e.querySelectorAll('*')].find((c) => /fill|value|bar__|progress__/.test(c.className) && c.style && c.style.width);
      return [...e.classList].slice(0, 2).join('.') + (e.getAttribute('aria-valuenow') ? ' aria=' + e.getAttribute('aria-valuenow') + '/' + e.getAttribute('aria-valuemax') : '') + (fill ? ' fillWidth=' + fill.style.width : '') + ' "' + e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 60) + '"';
    });
    const cards = [...document.querySelectorAll('button.course-card')].map((c) => ({
      title: c.querySelector('[class*=title]')?.innerText.trim(),
      text: c.innerText.trim().replace(/\\s+/g, ' ').slice(0, 120),
      cls: [...c.classList].join('.'),
      statusEls: [...c.querySelectorAll('[class*=status],[class*=progress],[class*=footer]')].map((e) => [...e.classList][0] + '=' + e.innerText.trim().slice(0, 30)).slice(0, 4),
    }));
    const notif = [...document.querySelectorAll('[class*=notification]')].filter((e) => e.getClientRects().length).map((e) => [...e.classList][0]).slice(0, 8);
    const rtk = Object.values(s.api.queries).map((q) => q.endpointName + (q.originalArgs !== undefined ? '(' + JSON.stringify(q.originalArgs).slice(0, 60) + ')' : '') + ' -> ' + JSON.stringify(shape(q.data, 1)).slice(0, 300));
    return {
      url: location.pathname,
      bars, cards, notif,
      rtk,
      profileSlice: shape(s.profileReducer, 1),
      profileProfile: shape(s.profileReducer?.profile, 2),
      professionV2: shape(s.professionsV2Reducer?.profession, 1),
      notificationsSlice: shape(s.notificationsReducer, 2),
    };
  })()`);
});
console.log(JSON.stringify(out, null, 1));
