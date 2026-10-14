import type { PopupRequest, StatusReply } from '../shared/protocol';
import { loadSettings, type Settings } from '../background/settings';

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
}

loadSettings().then((s) => {
  url.value = s.bridgeUrl;
  token.value = s.token;
  confirm.checked = s.confirmIrreversible;
});

$('save').addEventListener('click', async () => {
  const s: Settings = { bridgeUrl: url.value.trim(), token: token.value.trim(), confirmIrreversible: confirm.checked };
  await browser.storage.local.set(s as any); // background reconnects on change
  setTimeout(refresh, 300);
});
$('reconnect').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ target: 'background', type: 'reconnect' } satisfies PopupRequest);
  setTimeout(refresh, 300);
});

void refresh();
setInterval(refresh, 1000);
