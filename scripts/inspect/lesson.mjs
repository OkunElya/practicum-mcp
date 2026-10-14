// Read-only: lesson page state, RTK endpoints with args, GPT chat slice, theory content structure.
import { withPage } from './lib.mjs';

const out = await withPage(async (page) => {
  await page.screenshot({ path: new URL('./shot.png', import.meta.url).pathname });
  return page.evaluate(() => {
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
    const short = (a) => (typeof a === 'string' ? a.slice(0, 60) : a && typeof a === 'object' ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 60) : typeof v])) : a);

    const r = {};
    r.sliceKeys = Object.keys(s);
    r.rtk = Object.values(s.api.queries).map((q) => ({ ep: q.endpointName, status: q.status, args: short(q.originalArgs), data: shape(q.data, 1) }));
    r.gptQueries = Object.values(s.api.queries).filter((q) => /gpt|chat|ai/i.test(q.endpointName)).map((q) => ({ ep: q.endpointName, args: q.originalArgs, data: shape(q.data, 3) }));
    r.chatYaGPT = shape(s.chatYaGPT, 2);
    r.aiChat = { ...s.chatYaGPT.aiChatReducer, messages: s.chatYaGPT.aiChatReducer.messages.length };
    // Lesson-ish slices that are new compared with the profile page
    const known = new Set(['appReducer', 'fastTrackReducer', 'referralReducer', 'router', 'api', 'pollsReducer', 'assessmentsReducer', 'orderReducer', 'profileReducer', 'squadsReducer', 'chatReducer', 'refundReducer', 'metrikaReducer', 'professionsV2Reducer', 'navigationReducer', 'searchReducer', 'favoritesReducer', 'notificationsReducer', 'skillpathSubscriptionsReducer', 'profWindowReducer', 'blackFridayReducer', 'skillpathLibraryReducer', 'educationPlanReducer', 'subscriptionsAndProfRecommendationsReducer', 'altVersionControlsReducer', 'scheduleReducer', 'npsReducer', 'programReducer', 'chatYaGPT', 'failedInstallmentBannerReducer', 'selectedCounterOfferReducer', 'selectedRefundReasonReducer', 'refundContactPhoneReducer', 'counterOffersFlowReducer', 'wizardReducer']);
    r.newSlices = Object.fromEntries(Object.keys(s).filter((k) => !known.has(k)).map((k) => [k, shape(s[k], 2)]));

    // Theory content: main column structure
    const main = document.querySelector('main, .theory, [class*=lesson__content], [class*=theory]');
    r.mainContainer = main ? `${main.tagName.toLowerCase()}.${[...main.classList].join('.')}` : null;
    const blocks = main ? [...main.querySelectorAll('[class*=block], h1, h2, h3, pre, code, table')].slice(0, 40) : [];
    r.contentBlocks = [...new Set(blocks.map((b) => `${b.tagName.toLowerCase()}.${[...b.classList].slice(0, 2).join('.')}`))];
    r.textLength = (main ?? document.body).innerText.length;
    r.headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => `${h.tagName} ${h.textContent.trim().slice(0, 60)}`).slice(0, 20);
    r.theoryButtons = [...document.querySelectorAll('[data-test-id^=theory-]')].map((e) => `${e.dataset.testId.replace(/-[0-9a-f-]{36}$/, '-<uuid>')} "${e.textContent.trim().slice(0, 50)}"`);
    r.testIds = [...new Set([...document.querySelectorAll('[data-test-id]')].map((e) => e.dataset.testId.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, '<uuid>')))];
    r.textareas = [...document.querySelectorAll('textarea,[contenteditable=true],input:not([type=hidden]):not([type=radio])')].map((e) => `${e.tagName.toLowerCase()}.${e.classList[0] ?? ''} ph="${e.placeholder ?? ''}"`);
    return r;
  });
});
console.log(JSON.stringify(out, null, 1));
