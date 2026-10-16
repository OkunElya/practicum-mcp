import { describe, expect, it } from 'vitest';
import { blocks, spans } from '../src/shared/markdown';

describe('markdown', () => {
  it('splits fences and paragraphs', () => {
    expect(blocks('Готово.\n\n```python\nprint(1)\n```\nДальше')).toEqual([
      { kind: 'para', spans: [{ kind: 'text', text: 'Готово.' }] },
      { kind: 'code', text: 'print(1)' },
      { kind: 'para', spans: [{ kind: 'text', text: 'Дальше' }] },
    ]);
  });

  it('keeps an unclosed fence (still streaming) as code', () => {
    expect(blocks('a\n```\nx = 1')).toEqual([
      { kind: 'para', spans: [{ kind: 'text', text: 'a' }] },
      { kind: 'code', text: 'x = 1' },
    ]);
  });

  it('marks inline code and bold, and nothing else', () => {
    expect(spans('call `read_task` **first** <b>x</b>')).toEqual([
      { kind: 'text', text: 'call ' },
      { kind: 'code', text: 'read_task' },
      { kind: 'text', text: ' ' },
      { kind: 'bold', text: 'first' },
      { kind: 'text', text: ' <b>x</b>' },
    ]);
  });
});
