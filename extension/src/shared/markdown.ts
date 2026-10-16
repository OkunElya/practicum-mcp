/**
 * Just enough Markdown for model replies: ``` fences, `inline code` and **bold**.
 * Returns segments, so the renderer builds DOM nodes and never parses HTML.
 */

export type Block = { kind: 'code'; text: string } | { kind: 'para'; spans: Span[] };
export type Span = { kind: 'text' | 'code' | 'bold'; text: string };

export function blocks(src: string): Block[] {
  const out: Block[] = [];
  // An unclosed fence (a reply still streaming) runs to the end.
  const parts = src.split(/^```[^\n]*\n?/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push({ kind: 'code', text: part.replace(/\n$/, '') });
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (para.trim()) out.push({ kind: 'para', spans: spans(para.replace(/^\n+|\n+$/g, '')) });
    }
  });
  return out;
}

export function spans(text: string): Span[] {
  const out: Span[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    out.push(m[1] !== undefined ? { kind: 'code', text: m[1] } : { kind: 'bold', text: m[2] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}
