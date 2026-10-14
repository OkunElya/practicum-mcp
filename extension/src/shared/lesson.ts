/**
 * Lesson JSON (`GET /api/lessons/{id}/`) → compact text for a small model.
 *
 * Interactive blocks get short refs (q1, q2, … in document order) that the
 * answering tools accept. Answer keys that the site ships to the browser
 * (correct, correct_option, correct_section, correct_answers, validations,
 * result_text, feedback, answer_panes, test) are never rendered.
 */

export interface TheoryNode {
  id: string;
  type: string;
  content: any;
  nested?: TheoryNode[];
}

export interface LessonJson {
  id: string;
  name: string;
  lesson_type: string;
  solved: boolean;
  course_name?: string;
  topic_name?: string;
  position?: number;
  topic_lessons_count?: number;
  next_lesson_id?: string | null;
  theory: TheoryNode;
  tasks?: { id: string; solved: boolean }[];
}

/** One saved submission from `GET /api/lessons/{id}/quizzes/`. */
export interface SavedAnswer {
  content_quiz_id: string;
  user_answer: unknown;
}

export const INTERACTIVE_TYPES = ['ActionButton', 'QuizSelect', 'QuizChoice', 'QuizCards', 'QuizText', 'QuizMacaroni', 'QuizCoding', 'QuizFeedback'] as const;

export interface InteractiveBlock {
  ref: string;
  nodeId: string;
  contentId: string;
  type: string;
  node: TheoryNode;
  answer: SavedAnswer | undefined;
}

const answerKey = (n: TheoryNode) => (n.type === 'ActionButton' ? `expander-${n.content?.id}` : String(n.content?.id));

export function interactiveBlocks(theory: TheoryNode, answers: SavedAnswer[] = []): InteractiveBlock[] {
  const out: InteractiveBlock[] = [];
  const walk = (n: TheoryNode) => {
    if ((INTERACTIVE_TYPES as readonly string[]).includes(n.type)) {
      const key = answerKey(n);
      out.push({
        ref: `q${out.length + 1}`,
        nodeId: n.id,
        contentId: String(n.content?.id ?? ''),
        type: n.type,
        node: n,
        answer: answers.find((a) => a.content_quiz_id === key),
      });
    }
    n.nested?.forEach(walk);
  };
  walk(theory);
  return out;
}

/** Accepts "q3", "3", a block/content id, or a unique id prefix (≥ 6 chars). */
export function findBlock(blocks: InteractiveBlock[], ref: string): InteractiveBlock | undefined {
  const r = ref.trim().toLowerCase();
  const byRef = blocks.find((b) => b.ref === r || b.ref === `q${r}`);
  if (byRef) return byRef;
  const exact = blocks.find((b) => b.nodeId === r || b.contentId === r);
  if (exact) return exact;
  if (r.length >= 6) {
    const hits = blocks.filter((b) => b.nodeId.startsWith(r) || b.contentId.startsWith(r));
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

export const letter = (i: number) => String.fromCharCode(65 + i); // A, B, C…

/** Text of an option/choice that may be a string or {content}. */
export const optionText = (o: any): string => (typeof o === 'string' ? o : String(o?.content ?? o?.text ?? ''));

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function status(b: InteractiveBlock): string {
  return b.answer ? 'answered' : 'not answered';
}

function renderInteractive(b: InteractiveBlock, out: string[]): void {
  const c = b.node.content ?? {};
  const a = b.answer?.user_answer as any;
  switch (b.type) {
    case 'ActionButton':
      out.push(`[${b.ref} · button «${oneLine(c.text ?? '')}» · ${b.answer ? 'pressed' : 'not pressed'}]`);
      return;
    case 'QuizSelect': {
      const opts: any[] = c.options ?? [];
      const kind = c.type === 'checkbox' ? 'multiple choice (pick all that apply)' : 'single choice';
      out.push(`[${b.ref} · ${kind} · ${status(b)}]`, c.content ?? '');
      opts.forEach((o, i) => out.push(`  ${i + 1}. ${oneLine(optionText(o))}`));
      if (Array.isArray(a)) out.push(`  your answer: ${a.map((id) => opts.findIndex((o) => o.id === id) + 1).join(', ')}`);
      return;
    }
    case 'QuizChoice': {
      const qs: any[] = c.questions ?? [];
      const opts: any[] = c.options ?? [];
      out.push(`[${b.ref} · match each item to an option · ${status(b)}]`, c.content ?? '');
      out.push('  Items:');
      qs.forEach((q, i) => out.push(`  ${i + 1}. ${oneLine(optionText(q))}`));
      out.push('  Options:');
      opts.forEach((o, i) => out.push(`  ${letter(i)}. ${oneLine(optionText(o))}`));
      if (a && typeof a === 'object') {
        const pairs = qs.map((q, i) => `${i + 1}=${letter(opts.findIndex((o) => o.id === a[q.id]))}`);
        out.push(`  your answer: ${pairs.join('; ')}`);
      }
      return;
    }
    case 'QuizCards': {
      const opts: any[] = c.options ?? [];
      const sections: any[] = c.sections ?? [];
      out.push(`[${b.ref} · sort cards into groups · ${status(b)}${c.resetable ? ' · can be retried' : ''}]`, c.content ?? '');
      out.push('  Cards:');
      opts.forEach((o, i) => out.push(`  ${i + 1}. ${oneLine(optionText(o))}`));
      out.push('  Groups:');
      sections.forEach((s, i) => out.push(`  ${letter(i)}. ${oneLine(optionText(s))}`));
      if (a && typeof a === 'object') {
        const pairs = opts.map((o, i) => {
          const si = sections.findIndex((s) => (a[s.id] ?? []).includes(o.id));
          return `${i + 1}=${si >= 0 ? letter(si) : '?'}`;
        });
        out.push(`  your answer: ${pairs.join('; ')}`);
      }
      return;
    }
    case 'QuizMacaroni': {
      const left: any[] = c.options?.left?.choices ?? [];
      const right: any[] = c.options?.right?.choices ?? [];
      out.push(`[${b.ref} · connect each left item to a right item · ${status(b)}]`, c.question ?? '');
      out.push('  Left:');
      left.forEach((o, i) => out.push(`  ${i + 1}. ${oneLine(optionText(o))}`));
      out.push('  Right:');
      right.forEach((o, i) => out.push(`  ${letter(i)}. ${oneLine(optionText(o))}`));
      if (Array.isArray(a)) out.push(`  your answer: ${a.map(([l, r]: number[]) => `${l + 1}=${letter(r)}`).join('; ')}`);
      return;
    }
    case 'QuizText':
      out.push(`[${b.ref} · free-text answer · ${status(b)}]`, [c.content, c.question].filter(Boolean).join('\n'));
      if (typeof a === 'string') out.push(`  your answer: ${a}`);
      return;
    case 'QuizCoding': {
      const panes: any[] = c.panes ?? [];
      out.push(`[${b.ref} · code exercise (${c.language ?? 'code'}) · ${a?.test_result?.stdout?.solved ? 'solved' : b.answer ? 'attempted' : 'not attempted'}]`);
      for (const p of panes) out.push('```' + (p.language ?? ''), String(p.content ?? '').trimEnd(), '```');
      if (c.hint) out.push(`  hint available`);
      return;
    }
    case 'QuizFeedback':
      out.push(`[${b.ref} · sprint feedback survey · ${status(b)} · the user's own opinion: tools never fill it in]`);
      return;
  }
}

export interface RenderOptions {
  /** Resume long lessons: skip this many characters of the rendered text. */
  offset?: number;
  maxChars?: number;
}

export function renderLesson(lesson: LessonJson, answers: SavedAnswer[], opts: RenderOptions = {}): string {
  const blocks = interactiveBlocks(lesson.theory, answers);
  const byNode = new Map(blocks.map((b) => [b.nodeId, b]));
  const body: string[] = [];

  const walk = (n: TheoryNode) => {
    const ib = byNode.get(n.id);
    if (ib) {
      body.push('');
      renderInteractive(ib, body);
      body.push('');
    } else {
      const c = n.content;
      switch (n.type) {
        case 'Markdown':
          body.push(String(c?.markdown ?? c?.text ?? '').trimEnd());
          break;
        case 'CutContainer':
          body.push(`\n▸ ${c?.title ?? 'Подробнее'} (collapsed on the page)`);
          break;
        case 'Dialog':
          for (const m of Array.isArray(c) ? c : (c?.messages ?? [])) {
            if (m?.type === 'text' || m?.message) body.push(`— ${m.character ?? m.side ?? ''}: ${oneLine(String(m.message ?? ''))}`);
          }
          break;
        case 'ActionLinkButton':
          body.push(`[link «${c?.text ?? ''}»: ${c?.link ?? ''}]`);
          break;
        case 'Gallery':
        case 'SideBySide':
          body.push('[images]');
          break;
        case 'RootLayout':
        case 'WideLayout':
          break;
        default:
          body.push(`[${n.type}]`);
      }
    }
    n.nested?.forEach(walk);
  };
  walk(lesson.theory);

  const header = [
    `Lesson «${lesson.name}» [${lesson.lesson_type}] id=${lesson.id}, ${lesson.solved ? 'solved' : 'not solved'}`,
    lesson.course_name ? `Course: ${lesson.course_name} › Topic: ${lesson.topic_name ?? ''}` : '',
    blocks.length
      ? `Interactive blocks: ${blocks.map((b) => `${b.ref} ${b.type}${b.answer ? ' ✓' : ''}`).join(', ')}`
      : 'No interactive blocks.',
  ].filter(Boolean);

  const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const offset = Math.max(0, opts.offset ?? 0);
  const max = opts.maxChars ?? 8000;
  let end = Math.min(text.length, offset + max);
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end);
    if (nl > offset + max / 2) end = nl + 1; // don't cut a line in half
  }
  const part = text.slice(offset, end);
  const more = end < text.length ? `\n\n…(${text.length - end} more characters: call again with offset=${end})` : '';
  return `${header.join('\n')}\n\n${offset ? `…(from character ${offset})\n` : ''}${part}${more}`;
}
