import type { HudRequest } from '../shared/hud';
import type { BridgeIn, BridgeOut, LinkStatus, PopupRequest, StatusReply } from '../shared/protocol';
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
    if (msg.type === 'call') router.call(msg.id, msg.tool, msg.args, msg.source ?? 'mcp');
    else if (msg.type === 'cancel') router.cancel(msg.id);
    else if (msg.type === 'agent') activity.onAgent(msg.event);
  },
  (status, detail) => {
    void browser.browserAction.setBadgeText({ text: BADGE[status].text });
    void browser.browserAction.setBadgeBackgroundColor({ color: BADGE[status].color });
    void browser.browserAction.setTitle({ title: `Practicum MCP: ${status}${detail ? ` (${detail})` : ''}` });
    if (status === 'connected') link.send(modeMessage()); // the bridge starts or stops its agent
    if ((status === 'connected') !== activity.connected) {
      activity.set({ connected: status === 'connected' });
      activity.log(status === 'connected' ? 'ok' : 'error', status === 'connected' ? 'bridge connected' : `bridge ${status}`);
    }
    // A dead bridge can't receive results; don't leave the user's page being driven blind.
    if (status !== 'connected' && status !== 'connecting') {
      router.stopAll();
      activity.onAgent({ kind: 'gone' }); // no bridge, no agent channel
    }
  },
);

browser.runtime.onMessage.addListener((msg: unknown) => {
  const req = msg as PopupRequest | HudRequest;
  if (req?.target !== 'background') return undefined;
  switch (req.type) {
    case 'stop':
      router.stopAll();
      // The agent's run stops too, not just the tool it was running.
      if (activity.transcript.agent) link.send({ type: 'agent_input', input: { kind: 'stop' } });
      break;
    case 'clear':
      activity.clearTimeline();
      if (activity.transcript.agent?.chat) link.send({ type: 'agent_input', input: { kind: 'clear' } });
      break;
    case 'confirm':
      activity.answerConfirm(req.id, req.approved);
      break;
    case 'hud':
      return Promise.resolve(activity.state());
    case 'reconnect':
      link.start(settings);
      break;
    case 'agent_say':
      link.send({ type: 'agent_input', input: { kind: 'say', text: req.text } });
      break;
    case 'agent_answer':
      link.send({ type: 'agent_input', input: { kind: 'answer', id: req.id, text: req.text } });
      activity.questionAnswered(req.id, req.text);
      break;
  }
  return Promise.resolve<StatusReply>({ status: link.status, detail: link.detail, tools: router.specs().length, hud: activity.state() });
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidebar') activity.addSidebar(port);
});

function modeMessage(): BridgeOut {
  return { type: 'mode', mode: settings.mode, agent: settings.agent };
}

const apply = (s: Settings) => {
  const old = settings;
  settings = s;
  activity.set({ mode: s.mode });
  // Only a new address or token needs a new connection; the mode goes over the open one.
  if (link.status === 'off' || s.bridgeUrl !== old.bridgeUrl || s.token !== old.token) link.start(s);
  else if (s.mode !== old.mode || JSON.stringify(s.agent) !== JSON.stringify(old.agent)) link.send(modeMessage());
};
void loadSettings().then(apply);
onSettingsChanged(apply);
