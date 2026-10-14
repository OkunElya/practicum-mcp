// Install (idempotent) a pass-through fetch/XHR recorder in the page that keeps
// method, url, request body and a truncated response body for /api/ calls.
// Survives SPA navigation; a full reload removes it.
// Patches page globals; prefer BiDi response bodies (trainer-step.mjs). Skipped on /trainer/
// pages as a precaution (docs/platform-findings.md §8).
// Usage: node recorder.mjs install | dump [--clear] | clear
import { withPage } from './lib.mjs';

export const INSTALL = () => {
  if (window.__probe) return 'already installed';
  const log = [];
  window.__probe = log;
  const keep = (u) => /\/api\//.test(u) && !/event_collector|sendLatencyMetrics/.test(u);
  const clip = (s, n = 3000) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s);

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = init?.method || input?.method || 'GET';
    const res = await origFetch.apply(this, arguments);
    if (keep(url)) {
      const entry = { t: Date.now(), via: 'fetch', method, url, reqBody: clip(typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null), status: res.status };
      log.push(entry);
      const ct = res.headers.get('content-type') || '';
      entry.contentType = ct;
      if (/event-stream/.test(ct)) entry.resBody = '(stream; see streamed)';
      else res.clone().text().then((t) => (entry.resBody = clip(t))).catch(() => {});
    }
    return res;
  };

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__probe = { method, url: String(url) };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const p = this.__probe;
    if (p && keep(p.url)) {
      const entry = { t: Date.now(), via: 'xhr', method: p.method, url: p.url, reqBody: clip(typeof body === 'string' ? body : body ? String(body) : null) };
      log.push(entry);
      this.addEventListener('loadend', () => {
        entry.status = this.status;
        entry.contentType = this.getResponseHeader('content-type');
        try {
          entry.resBody = clip(typeof this.response === 'string' ? this.response : JSON.stringify(this.response));
        } catch {}
      });
    }
    return XS.apply(this, arguments);
  };
  return 'installed';
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2] ?? 'dump';
  const out = await withPage((page) =>
    cmd === 'install'
      ? page.evaluate(INSTALL)
      : page.evaluate((clear) => {
          const l = window.__probe ? [...window.__probe] : 'not installed';
          if (clear && window.__probe) window.__probe.length = 0;
          return l;
        }, cmd === 'clear' || process.argv.includes('--clear')),
  );
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
}
