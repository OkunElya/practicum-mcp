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
  /** Goes up when a retryable quiz is submitted again (even with the same answer). */
  attempts_count?: number;
}

export const INTERACTIVE_TYPES = ['ActionButton', 'QuizSelect', 'QuizChoice', 'QuizCards', 'QuizText', 'QuizMacaroni', 'QuizCoding', 'QuizChat', 'QuizFeedback'] as const;

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
export const optionText = (o: any): string => (typeof o === 'string' ? o : String(o?.content ?? o?.text ?? '')).trim();

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function status(b: InteractiveBlock): string {
  return b.answer ? 'answered' : 'not answered';
}

export interface ChatQuestion {
  messageId: string;
  text: string;
  options: { id: string; text: string }[];
}

/**
 * The questions of a QuizChat in dialog order: walk the state machine from
 * `initial`, following the transition that leads to a new message. Only the
 * order is used; which reply leads on (the key) is never exposed.
 */
export function chatQuestions(content: any): ChatQuestion[] {
  const messages = content?.messages ?? {};
  const out: ChatQuestion[] = [];
  const seen = new Set<string>();
  let id: string | undefined = content?.initial;
  while (id && !seen.has(id) && messages[id]) {
    seen.add(id);
    const m = messages[id];
    const answers = m.answers ?? {};
    const order: string[] = Array.isArray(m.orderList) && m.orderList.length ? m.orderList : Object.keys(answers);
    if (order.length) {
      out.push({
        messageId: id,
        text: String(m.content ?? '').trim(),
        options: order.filter((a) => answers[a]).map((a) => ({ id: a, text: String(answers[a].content ?? '').trim() })),
      });
    }
    const next = Object.values(content.state?.[id]?.on ?? {}).find((x) => x !== id && !seen.has(String(x)));
    id = next ? String(next) : undefined;
  }
  return out;
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
      const lang = c.language ?? 'code';
      if (c.use_tests) {
        const st = a?.test_result?.stdout?.solved ? 'solved' : b.answer ? 'attempted, not solved' : 'not attempted';
        out.push(`[${b.ref} · graded code exercise (${lang}) · ${st}${c.hint ? ' · hint: show_hint block=' + b.ref : ''} · run_code_exercise / check_code_exercise]`);
      } else {
        out.push(`[${b.ref} · code example (${lang}) · ${b.answer ? 'was run' : 'not run'}${c.blocking ? ' · run it to unlock what follows' : ''} · run_code_exercise]`);
      }
      out.push('Starter code:');
      for (const p of panes) out.push('```' + (p.language ?? ''), String(p.content ?? '').trimEnd(), '```');
      const mine = a?.panes?.[0]?.content;
      if (typeof mine === 'string' && mine.trim() && mine.trim() !== String(panes[0]?.content ?? '').trim()) {
        out.push('Your last submitted code:', '```' + lang, mine.trimEnd(), '```');
      }
      return;
    }
    case 'QuizChat': {
      const qs = chatQuestions(c);
      out.push(`[${b.ref} · chat quiz: ${qs.length} questions in a row, a wrong reply can be retried · ${status(b)} · answer the question on screen with answer_quiz block=${b.ref} answer=<option number>]`);
      qs.forEach((q, i) => {
        out.push(`Question ${i + 1}: ${q.text}`);
        q.options.forEach((o, j) => out.push(`  ${j + 1}. ${oneLine(o.text)}`));
      });
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
  /** Only the interactive blocks (questions with their options), no theory text. */
  blocksOnly?: boolean;
  /** Extra lines per block node id from the live page (e.g. the chat question on screen). */
  live?: Record<string, string>;
}

export function renderLesson(lesson: LessonJson, answers: SavedAnswer[], opts: RenderOptions = {}): string {
  const blocks = interactiveBlocks(lesson.theory, answers);
  const byNode = new Map(blocks.map((b) => [b.nodeId, b]));
  const body: string[] = [];

  const walk = (n: TheoryNode) => {
    const ib = byNode.get(n.id);
    if (opts.blocksOnly && !ib) {
      n.nested?.forEach(walk);
      return;
    }
    if (ib) {
      body.push('');
      renderInteractive(ib, body);
      if (opts.live?.[ib.nodeId]) body.push(opts.live[ib.nodeId]);
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
