import type { HudRequest, Mode } from '../shared/hud';
import type { PopupRequest, StatusReply } from '../shared/protocol';
import { loadSettings, saveSettings } from '../background/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const url = $<HTMLInputElement>('url');
const token = $<HTMLInputElement>('token');
const confirm = $<HTMLInputElement>('confirm');
const status = $<HTMLDivElement>('status');

const STATUS_TEXT: Record<StatusReply['status'], string> = {
  off: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  bad_token: 'Token rejected',
  disconnected: 'Bridge not reachable',
};

async function refresh(): Promise<void> {
  const req: PopupRequest = { target: 'background', type: 'status' };
  const s: StatusReply = await browser.runtime.sendMessage(req);
  status.className = s.status;
  status.textContent = `${STATUS_TEXT[s.status]}${s.detail ? ` · ${s.detail}` : ''} · ${s.tools} tools`;
  $('current').textContent = s.hud.current ? `▶ ${s.hud.current}${s.hud.queued ? ` (+${s.hud.queued} queued)` : ''}` : 'Idle';
  $('log').replaceChildren(
    ...s.hud.entries.map((e) => {
      const li = document.createElement('li');
      li.className = e.level;
      li.textContent = `${new Date(e.t).toLocaleTimeString()} ${e.text}`;
      return li;
    }),
  );
}

const MODE_NOTE: Record<Mode, string> = {
  mcp: 'An MCP client drives; the overlay in the page shows its calls.',
  agent: 'Chat with the agent in the sidebar; approvals are asked there too.',
};

function showMode(mode: Mode): void {
  $('mode-mcp').setAttribute('aria-pressed', String(mode === 'mcp'));
  $('mode-agent').setAttribute('aria-pressed', String(mode === 'agent'));
  $('mode-note').textContent = MODE_NOTE[mode];
}

loadSettings().then((s) => {
  url.value = s.bridgeUrl;
  token.value = s.token;
  confirm.checked = s.confirmIrreversible;
  showMode(s.mode);
});

$('mode-mcp').addEventListener('click', async () => {
  showMode('mcp');
  await saveSettings({ mode: 'mcp' });
});
$('mode-agent').addEventListener('click', async () => {
  // Opening the sidebar needs the user's click: do it before anything is awaited.
  void browser.sidebarAction.open();
  showMode('agent');
  await saveSettings({ mode: 'agent' });
});

$('save').addEventListener('click', async () => {
  await saveSettings({ bridgeUrl: url.value.trim(), token: token.value.trim(), confirmIrreversible: confirm.checked }); // background reconnects on change
  setTimeout(refresh, 300);
});
$('stop').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ target: 'background', type: 'stop' } satisfies HudRequest);
  setTimeout(refresh, 300);
});
$('reconnect').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ target: 'background', type: 'reconnect' } satisfies PopupRequest);
  setTimeout(refresh, 300);
});

void refresh();
setInterval(refresh, 1000);
