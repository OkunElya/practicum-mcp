// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import html from '../src/sidebar/sidebar.html?raw';
import type { HudState, SidebarMessage } from '../src/shared/hud';
import type { Item, ThinkingItem } from '../src/shared/transcript';

// The sidebar page with a fake background: one port the test pushes messages through.
let push: (msg: SidebarMessage) => void = () => {};
let connected = false;
const head: HudState = { connected: true, mode: 'agent', sidebar: true, current: null, queued: 0, entries: [], confirm: null, agent: { name: 'Agent', chat: true, state: 'thinking', text: '', question: null } };

beforeAll(async () => {
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
  (globalThis as any).__DEV_TOKEN__ = '';
  (globalThis as any).browser = {
    runtime: {
      connect: () => ({
        onMessage: {
          addListener: (fn: (m: SidebarMessage) => void) => {
            push = fn;
            connected = true;
          },
        },
        onDisconnect: { addListener: () => {} },
      }),
      sendMessage: async () => {},
    },
    storage: { local: { get: async () => ({ mode: 'agent' }), set: async () => {} }, onChanged: { addListener: () => {} } },
  };
  await import('../src/sidebar/sidebar');
  for (let i = 0; i < 40 && !connected; i++) await new Promise((r) => setTimeout(r, 5));
  push({ type: 'snapshot', head, models: null, items: [] });
});

const thinking = (text: string, streaming: boolean, rev: number): ThinkingItem => ({ id: 'i1', t: 0, rev, type: 'thinking', text, streaming, ms: streaming ? 0 : 3200, turn: '1' });
const patch = (items: Item[]) => push({ type: 'patch', head, models: null, items, dropped: [] });

describe('sidebar thinking block', () => {
  it('is open and updated in place while streaming, collapsed when done', async () => {
    patch([thinking('Need to', true, 1)]);
    const d = document.querySelector<HTMLDetailsElement>('details.thinking')!;
    expect(d.open).toBe(true);
    expect(d.querySelector('.sum')!.textContent).toBe('Thinking…');

    patch([thinking('Need to call where_am_i first.', true, 2)]);
    // The same element, not a redrawn one (that made the block jump), with the full text.
    expect(document.querySelector('details.thinking')).toBe(d);
    expect(d.querySelector('.body')!.textContent).toBe('Need to call where_am_i first.');
    expect(d.querySelector('.sum')!.textContent).toBe('Thinking…');

    patch([thinking('Need to call where_am_i first.', false, 3)]);
    expect(d.open).toBe(false);
    expect(d.querySelector('.sum')!.textContent).toBe('Thought for 3.2 s');
  });

  it("keeps the user's choice: a block opened by hand stays open", async () => {
    const d = document.querySelector<HTMLDetailsElement>('details.thinking')!;
    d.open = true; // a click
    d.dispatchEvent(new Event('toggle'));
    patch([thinking('Need to call where_am_i first.', false, 4)]);
    expect(d.open).toBe(true);
  });
});
