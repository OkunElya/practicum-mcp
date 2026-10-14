import type { BridgeIn, LinkStatus, PopupRequest, StatusReply } from '../shared/protocol';
import { BridgeLink } from './link';
import { Router } from './router';
import { loadSettings, onSettingsChanged } from './settings';
import { TOOLS } from './tools';

const VERSION = browser.runtime.getManifest().version;

const BADGE: Record<LinkStatus, { text: string; color: string }> = {
  off: { text: '', color: '#888' },
  connecting: { text: '…', color: '#888' },
  connected: { text: 'on', color: '#2a8a2a' },
  bad_token: { text: 'key', color: '#c33' },
  disconnected: { text: 'off', color: '#c33' },
};

const router = new Router(TOOLS, (msg) => link.send(msg));

const link = new BridgeLink(
  () => ({ version: VERSION, tools: router.specs() }),
  (msg: BridgeIn) => {
    if (msg.type === 'call') void router.call(msg.id, msg.tool, msg.args);
    else if (msg.type === 'cancel') router.cancel(msg.id);
  },
  (status, detail) => {
    void browser.browserAction.setBadgeText({ text: BADGE[status].text });
    void browser.browserAction.setBadgeBackgroundColor({ color: BADGE[status].color });
    void browser.browserAction.setTitle({ title: `Practicum MCP: ${status}${detail ? ` (${detail})` : ''}` });
  },
);

browser.runtime.onMessage.addListener((msg: unknown) => {
  const req = msg as PopupRequest;
  if (req?.target !== 'background') return undefined;
  if (req.type === 'reconnect') void loadSettings().then((s) => link.start(s));
  return Promise.resolve<StatusReply>({ status: link.status, detail: link.detail, tools: router.specs().length });
});

void loadSettings().then((s) => link.start(s));
onSettingsChanged((s) => link.start(s));
