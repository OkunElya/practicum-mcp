// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import html from '../src/sidebar/sidebar.html?raw';
import type { HudState, SidebarMessage } from '../src/shared/hud';
import type { Item, ThinkingItem } from '../src/shared/transcript';

// The sidebar page with a fake background: one port the test pushes messages through.
let push: (msg: SidebarMessage) => void = () => {};
let connected = false;
// Settings storage that notifies on change, like browser.storage.
const store: Record<string, unknown> = { mode: 'agent' };
const storageListeners: (() => void)[] = [];
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
    storage: {
      local: {
        get: async () => ({ ...store }),
        set: async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
          for (const l of storageListeners) l();
        },
      },
      onChanged: { addListener: (fn: (changes: unknown, area: string) => void) => storageListeners.push(() => fn({}, 'local')) },
    },
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

const settle = () => new Promise((r) => setTimeout(r, 10));
const $ = (id: string) => document.getElementById(id)!;

describe('sidebar thinking level', () => {
  it('shows only the level, in a chip next to Send that opens the slider', () => {
    expect($('think-chip').textContent).toBe('Thinking: auto');
    expect($('think-chip').closest('.controls')?.contains($('send'))).toBe(true);
    expect($('think-menu').hidden).toBe(true);
    $('think-chip').click();
    expect($('think-menu').hidden).toBe(false);
    document.body.click(); // a click elsewhere closes it
    expect($('think-menu').hidden).toBe(true);
  });

  it('is a slider with auto (the model decides) to start with', () => {
    expect($('thinkrow').hidden).toBe(false);
    expect($('think').getAttribute('type')).toBe('range');
    expect($('think-auto').getAttribute('aria-pressed')).toBe('true');
    expect($('think-slider').classList.contains('auto')).toBe(true);
  });

  it('saves the level picked on the slider, and auto again', async () => {
    ($('think-slider').querySelectorAll('.ticks span')[3] as HTMLElement).click();
    await settle();
    expect(store.agent).toMatchObject({ think: 'high' });
    expect($('think-chip').textContent).toBe('Thinking: high');
    expect($('think-menu').hidden).toBe(true); // closed once a level is picked
    expect(($('think') as HTMLInputElement).value).toBe('3');
    expect($('think-auto').getAttribute('aria-pressed')).toBe('false');

    const range = $('think') as HTMLInputElement;
    range.value = '0';
    range.dispatchEvent(new Event('change'));
    await settle();
    expect(store.agent).toMatchObject({ think: 'off' });

    $('think-auto').click();
    await settle();
    expect(store.agent).toMatchObject({ think: '' });
    expect($('think-auto').getAttribute('aria-pressed')).toBe('true');
  });

  it('is hidden for Практикум ИИ', async () => {
    const model = $('model') as HTMLSelectElement;
    model.value = 'platform';
    model.dispatchEvent(new Event('change'));
    await settle();
    expect(store.agent).toMatchObject({ backend: 'platform' });
    expect($('thinkrow').hidden).toBe(true);
  });
});
