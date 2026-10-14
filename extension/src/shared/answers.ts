/**
 * Parse the model's flat answer string for a quiz block into concrete ids,
 * using the numbering read_lesson shows (items 1, 2, …; options A, B, …).
 */
import { ToolError } from './protocol';
import { letter, optionText, type InteractiveBlock } from './lesson';

export type QuizPlan =
  | { type: 'QuizSelect'; optionIds: string[]; labels: string[] }
  | { type: 'QuizChoice'; picks: { questionIndex: number; question: string; optionId: string; option: string }[] }
  | { type: 'QuizCards'; moves: { cardId: string; card: string; sectionId: string; section: string }[] }
  | { type: 'QuizMacaroni'; pairs: { left: number; right: number; leftText: string; rightText: string }[] }
  | { type: 'QuizText'; text: string };

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** "2", "B", or the text (or a unique start of it) → index into `items`. */
function pick(token: string, items: string[], style: 'number' | 'letter', what: string): number {
  const t = token.trim();
  if (style === 'number' && /^\d+$/.test(t)) {
    const i = Number(t) - 1;
    if (items[i] !== undefined) return i;
  }
  if (style === 'letter' && /^[a-z]$/i.test(t)) {
    const i = t.toUpperCase().charCodeAt(0) - 65;
    if (items[i] !== undefined) return i;
  }
  const n = norm(t.replace(/^["«']|["»']$/g, ''));
  const exact = items.findIndex((x) => norm(x) === n);
  if (exact >= 0) return exact;
  const starts = items.map((x, i) => [x, i] as const).filter(([x]) => n.length >= 3 && norm(x).startsWith(n));
  if (starts.length === 1) return starts[0][1];
  const range = style === 'number' ? `1–${items.length}` : `A–${letter(items.length - 1)}`;
  throw new ToolError(`"${token}" does not match any ${what}; use ${range} as shown by read_lesson`);
}

/** "1=B; 2=A" (also "1-B", "1:B", newline/comma separated) → [[left, right], …] */
function pairs(answer: string): [string, string][] {
  const parts = answer.split(/[;\n]|,(?=\s*\d+\s*[=:\-–→])/).map((p) => p.trim()).filter(Boolean);
  return parts.map((p) => {
    const m = p.match(/^(.+?)\s*(?:=|:|->|→|–| - )\s*(.+)$/);
    if (!m) throw new ToolError(`can't read "${p}": write pairs like 1=B; 2=A`);
    return [m[1], m[2]];
  });
}

export function planAnswer(block: InteractiveBlock, answer: string): QuizPlan {
  const c = block.node.content ?? {};
  switch (block.type) {
    case 'QuizSelect': {
      const opts: any[] = c.options ?? [];
      const texts = opts.map(optionText);
      // An option text may itself contain commas ("Да, капитан!"), so try the whole answer first.
      const whole = texts.findIndex((t) => norm(t) === norm(answer));
      const tokens = answer.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      const idx = whole >= 0 ? [whole] : [...new Set(tokens.map((t) => pick(t, texts, 'number', 'option')))];
      if (!idx.length) throw new ToolError('give the option number(s), e.g. "2" or "1, 3"');
      if (c.type === 'radio' && idx.length !== 1) throw new ToolError('this is a single-choice question: give exactly one option');
      return { type: 'QuizSelect', optionIds: idx.map((i) => opts[i].id), labels: idx.map((i) => texts[i]) };
    }
    case 'QuizChoice': {
      const qs: any[] = c.questions ?? [];
      const opts: any[] = c.options ?? [];
      const qTexts = qs.map(optionText);
      const oTexts = opts.map(optionText);
      const picks = pairs(answer).map(([q, o]) => {
        const qi = pick(q, qTexts, 'number', 'item');
        const oi = pick(o, oTexts, 'letter', 'option');
        return { questionIndex: qi, question: qTexts[qi], optionId: opts[oi].id, option: oTexts[oi] };
      });
      requireAll(picks.map((p) => p.questionIndex), qs.length, 'item');
      return { type: 'QuizChoice', picks: picks.sort((a, b) => a.questionIndex - b.questionIndex) };
    }
    case 'QuizCards': {
      const opts: any[] = c.options ?? [];
      const sections: any[] = c.sections ?? [];
      const cTexts = opts.map(optionText);
      const sTexts = sections.map(optionText);
      const moves = pairs(answer).map(([card, group]) => {
        const ci = pick(card, cTexts, 'number', 'card');
        const si = pick(group, sTexts, 'letter', 'group');
        return { index: ci, cardId: opts[ci].id, card: cTexts[ci], sectionId: sections[si].id, section: sTexts[si] };
      });
      requireAll(moves.map((m) => m.index), opts.length, 'card');
      return { type: 'QuizCards', moves: moves.sort((a, b) => a.index - b.index).map(({ index: _, ...m }) => m) };
    }
    case 'QuizMacaroni': {
      const left: string[] = (c.options?.left?.choices ?? []).map(optionText);
      const right: string[] = (c.options?.right?.choices ?? []).map(optionText);
      const ps = pairs(answer).map(([l, r]) => {
        const li = pick(l, left, 'number', 'left item');
        const ri = pick(r, right, 'letter', 'right item');
        return { left: li, right: ri, leftText: left[li], rightText: right[ri] };
      });
      requireAll(ps.map((p) => p.left), left.length, 'left item');
      return { type: 'QuizMacaroni', pairs: ps.sort((a, b) => a.left - b.left) };
    }
    case 'QuizText':
      if (!answer.trim()) throw new ToolError('the answer is empty');
      return { type: 'QuizText', text: answer.trim() };
    case 'QuizFeedback':
      throw new ToolError('this is the sprint feedback survey: it asks for the user\'s own opinion, so the user fills it in themselves');
    case 'QuizCoding':
      throw new ToolError('code exercises inside lessons are not supported by tools yet');
    case 'ActionButton':
      throw new ToolError(`${block.ref} is a button, not a quiz: use press_action_button`);
    default:
      throw new ToolError(`${block.ref} (${block.type}) can't be answered`);
  }
}

function requireAll(indices: number[], total: number, what: string): void {
  const dup = indices.find((x, i) => indices.indexOf(x) !== i);
  if (dup !== undefined) throw new ToolError(`${what} ${dup + 1} is given twice`);
  const missing = [...Array(total).keys()].filter((i) => !indices.includes(i));
  if (missing.length) throw new ToolError(`every ${what} needs an answer; missing: ${missing.map((i) => i + 1).join(', ')}`);
}

/** One line for the approval prompt. */
export function describePlan(plan: QuizPlan): string {
  const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
  switch (plan.type) {
    case 'QuizSelect':
      return plan.labels.map((l) => `«${clip(l)}»`).join(', ');
    case 'QuizChoice':
      return plan.picks.map((p) => `${clip(p.question)} → ${clip(p.option)}`).join('; ');
    case 'QuizCards':
      return plan.moves.map((m) => `${clip(m.card)} → ${m.section}`).join('; ');
    case 'QuizMacaroni':
      return plan.pairs.map((p) => `${clip(p.leftText)} → ${clip(p.rightText)}`).join('; ');
    case 'QuizText':
      return `«${clip(plan.text)}»`;
  }
}
