/**
 * The extension's own lesson code for the Python simulator (lesson_sim.py):
 * one JSON request per stdin line, one JSON reply per stdout line. Bundled
 * with esbuild on first use, so read_lesson and answer parsing in the
 * simulator are exactly what the real tools do.
 *
 *   {"op":"render","lesson":…,"answers":[…],"opts":{…}}  → {"text"}
 *   {"op":"blocks","lesson":…,"answers":[…]}             → {"blocks":[{ref,nodeId,contentId,type,answered}]}
 *   {"op":"plan","lesson":…,"answers":[…],"ref","answer"} → {"block":{…},"plan":{…}}
 *   {"op":"chat","content":…}                            → {"questions":[…]}
 * Errors come back as {"error": message} (the text a ToolError would carry).
 */
import { createInterface } from 'node:readline';
import { planAnswer } from '../../extension/src/shared/answers';
import { chatQuestions, findBlock, interactiveBlocks, renderLesson, type InteractiveBlock } from '../../extension/src/shared/lesson';

const brief = (b: InteractiveBlock) => ({ ref: b.ref, nodeId: b.nodeId, contentId: b.contentId, type: b.type, answered: !!b.answer });

function handle(req: any): unknown {
  switch (req.op) {
    case 'render':
      return { text: renderLesson(req.lesson, req.answers ?? [], req.opts ?? {}) };
    case 'blocks':
      return { blocks: interactiveBlocks(req.lesson.theory, req.answers ?? []).map(brief) };
    case 'plan': {
      const blocks = interactiveBlocks(req.lesson.theory, req.answers ?? []);
      const b = findBlock(blocks, String(req.ref ?? ''));
      // Same wording as the extension's block() helper.
      if (!b) throw new Error(`no block "${req.ref}" in «${req.lesson.name}»; blocks: ${blocks.map((x) => `${x.ref} ${x.type}`).join(', ') || 'none'}`);
      return { block: brief(b), plan: req.answer === undefined ? null : planAnswer(b, String(req.answer)) };
    }
    case 'chat':
      return { questions: chatQuestions(req.content) };
    default:
      throw new Error(`unknown op ${req.op}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let reply: unknown;
  try {
    reply = handle(JSON.parse(line));
  } catch (e) {
    reply = { error: e instanceof Error ? e.message : String(e) };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
});
