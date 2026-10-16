import { describe, expect, it } from 'vitest';
import { MAX_ITEMS, MAX_RESULT, Transcript, type ToolItem } from '../src/shared/transcript';

function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

describe('Transcript', () => {
  it('interleaves the conversation and tool calls in the order they happen', () => {
    const tr = new Transcript();
    tr.onAgent({ kind: 'hello', name: 'gpt-oss', chat: true });
    tr.onAgent({ kind: 'message', role: 'user', text: 'где я?' });
    tr.onAgent({ kind: 'delta', turn: '1', part: 'thinking', text: 'Need ' });
    tr.onAgent({ kind: 'delta', turn: '1', part: 'thinking', text: 'where_am_i.' });
    tr.onAgent({ kind: 'turn_end', turn: '1' });
    tr.onTool({ kind: 'tool_queued', callId: '7', name: 'where_am_i', args: {}, source: 'agent' });
    tr.onTool({ kind: 'tool_running', callId: '7', args: {} });
    tr.onTool({ kind: 'tool_done', callId: '7', ok: true, output: 'URL: …' });
    tr.onAgent({ kind: 'delta', turn: '2', part: 'text', text: 'Ты на уроке.' });
    tr.onAgent({ kind: 'status', state: 'done', text: '' });

    expect(tr.items.map((i) => i.type)).toEqual(['note', 'user', 'thinking', 'tool', 'text']);
    const [, , thinking, tool, text] = tr.items;
    expect(thinking).toMatchObject({ text: 'Need where_am_i.', streaming: false });
    expect(tool).toMatchObject({ name: 'where_am_i', status: 'ok', result: 'URL: …', source: 'agent' });
    expect(text).toMatchObject({ text: 'Ты на уроке.', streaming: false });
  });

  it('starts a new item when the part or the turn changes', () => {
    const tr = new Transcript();
    tr.onAgent({ kind: 'delta', turn: '1', part: 'thinking', text: 'a' });
    tr.onAgent({ kind: 'delta', turn: '1', part: 'text', text: 'b' });
    tr.onAgent({ kind: 'delta', turn: '2', part: 'text', text: 'c' });
    expect(tr.items.map((i) => [i.type, (i as any).text, (i as any).streaming])).toEqual([
      ['thinking', 'a', false],
      ['text', 'b', false],
      ['text', 'c', true],
    ]);
  });

  it("measures thinking time and doesn't repeat a streamed answer", () => {
    const c = clock();
    const tr = new Transcript(c.now);
    tr.onAgent({ kind: 'message', role: 'user', text: 'hi' });
    tr.onAgent({ kind: 'delta', turn: '1', part: 'thinking', text: 'hmm' });
    c.tick(2500);
    tr.onAgent({ kind: 'delta', turn: '1', part: 'text', text: 'Готово.' });
    tr.onAgent({ kind: 'message', role: 'agent', text: 'Готово.' });
    tr.onAgent({ kind: 'message', role: 'agent', text: '[done] итог' });
    expect(tr.items.find((i) => i.type === 'thinking')).toMatchObject({ ms: 2500 });
    expect(tr.items.filter((i) => i.type === 'text').map((i) => (i as any).text)).toEqual(['Готово.', '[done] итог']);
  });

  it('follows a call through approval to its result, and tags MCP calls', () => {
    const c = clock();
    const tr = new Transcript(c.now);
    tr.onTool({ kind: 'tool_queued', callId: '1', name: 'check_task', args: {}, source: 'mcp' });
    tr.onTool({ kind: 'tool_running', callId: '1', args: {} });
    tr.onTool({ kind: 'tool_approval', callId: '1', text: 'Submit the task' });
    expect(tr.items[0]).toMatchObject({ status: 'approval', approval: 'Submit the task', source: 'mcp' });
    tr.onTool({ kind: 'tool_approved', callId: '1' });
    tr.onTool({ kind: 'tool_step', callId: '1', text: 'checking…' });
    c.tick(1200);
    tr.onTool({ kind: 'tool_done', callId: '1', ok: false, error: 'the user did not approve', errorKind: 'denied' });
    expect(tr.items[0]).toMatchObject({ status: 'denied', steps: ['checking…'], ms: 1200, kind: 'denied' });
  });

  it('clips long results', () => {
    const tr = new Transcript();
    tr.onTool({ kind: 'tool_queued', callId: '1', name: 'read_lesson', args: {}, source: 'agent' });
    tr.onTool({ kind: 'tool_done', callId: '1', ok: true, output: 'x'.repeat(MAX_RESULT * 2) });
    expect((tr.items[0] as ToolItem).result.length).toBeLessThan(MAX_RESULT + 100);
  });

  it('reports changes once and drops the oldest items past the cap', () => {
    const tr = new Transcript();
    for (let i = 0; i < MAX_ITEMS + 5; i++) tr.onAgent({ kind: 'message', role: 'note', text: `n${i}` });
    const first = tr.takeChanges();
    expect(first.items).toHaveLength(MAX_ITEMS);
    expect(first.dropped).toHaveLength(5);
    expect(tr.takeChanges()).toEqual({ items: [], dropped: [] });
    tr.clear();
    expect(tr.takeChanges().dropped).toHaveLength(MAX_ITEMS);
  });

  it('shows the question until it is answered', () => {
    const tr = new Transcript();
    tr.onAgent({ kind: 'hello', name: 'solver', chat: false });
    tr.onAgent({ kind: 'question', id: 'q1', ref: 'q3', text: 'Какой код…', candidates: ['1', '2'] });
    expect(tr.agent?.question?.id).toBe('q1');
    tr.answered('q1', '2');
    expect(tr.agent?.question).toBeNull();
    expect(tr.items.at(-1)).toMatchObject({ type: 'question', open: false, answer: '2' });
    tr.onAgent({ kind: 'question_closed', id: 'q1' });
    expect(tr.items.at(-1)).toMatchObject({ answer: '2' });
  });
});
