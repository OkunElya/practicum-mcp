import type { HudRequest } from '../shared/hud';
import type { BridgeIn, LinkStatus, PopupRequest, StatusReply } from '../shared/protocol';
import { Activity } from './activity';
import { BridgeLink } from './link';
import { Router } from './router';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from './settings';
import { TOOLS } from './tools';

const VERSION = browser.runtime.getManifest().version;

const BADGE: Record<LinkStatus, { text: string; color: string }> = {
  off: { text: '', color: '#888' },
  connecting: { text: '…', color: '#888' },
  connected: { text: 'on', color: '#2a8a2a' },
  bad_token: { text: 'key', color: '#c33' },
  disconnected: { text: 'off', color: '#c33' },
};

let settings: Settings = DEFAULT_SETTINGS;
const activity = new Activity();
const router = new Router(TOOLS, (msg) => link.send(msg), activity, () => settings);

const link = new BridgeLink(
  () => ({ version: VERSION, tools: router.specs() }),
  (msg: BridgeIn) => {
    if (msg.type === 'call') router.call(msg.id, msg.tool, msg.args);
    else if (msg.type === 'cancel') router.cancel(msg.id);
  },
  (status, detail) => {
    void browser.browserAction.setBadgeText({ text: BADGE[status].text });
    void browser.browserAction.setBadgeBackgroundColor({ color: BADGE[status].color });
    void browser.browserAction.setTitle({ title: `Practicum MCP: ${status}${detail ? ` (${detail})` : ''}` });
    if ((status === 'connected') !== activity.connected) {
      activity.set({ connected: status === 'connected' });
      activity.log(status === 'connected' ? 'ok' : 'error', status === 'connected' ? 'bridge connected' : `bridge ${status}`);
    }
    // A dead bridge can't receive results; don't leave the user's page being driven blind.
    if (status !== 'connected' && status !== 'connecting') router.stopAll();
  },
);

browser.runtime.onMessage.addListener((msg: unknown) => {
  const req = msg as PopupRequest | HudRequest;
  if (req?.target !== 'background') return undefined;
  switch (req.type) {
    case 'stop':
      router.stopAll();
      break;
    case 'confirm':
      activity.answerConfirm(req.id, req.approved);
      break;
    case 'hud':
      return Promise.resolve(activity.state());
    case 'reconnect':
      link.start(settings);
      break;
  }
  return Promise.resolve<StatusReply>({ status: link.status, detail: link.detail, tools: router.specs().length, hud: activity.state() });
});

const apply = (s: Settings) => {
  settings = s;
  link.start(s);
};
void loadSettings().then(apply);
onSettingsChanged(apply);
