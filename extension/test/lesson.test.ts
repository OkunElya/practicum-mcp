import { describe, expect, it } from 'vitest';
import { findBlock, interactiveBlocks, renderLesson, type LessonJson, type SavedAnswer } from '../src/shared/lesson';

// Shapes copied from real lessons (docs/platform-findings.md §4), ids shortened.
const lesson: LessonJson = {
  id: 'lesson-1',
  name: 'Работаем с Git',
  lesson_type: 'web',
  solved: false,
  course_name: 'Инструменты',
  topic_name: 'Git',
  theory: {
    id: 'root',
    type: 'RootLayout',
    content: {},
    nested: [
      { id: 'md1', type: 'Markdown', content: { type: 'theory', markdown: '# Заголовок\nТекст урока.' } },
      { id: 'ab1', type: 'ActionButton', content: { id: 'ab-c', text: 'Вперёд!', options: [], questions: [] } },
      {
        id: 'sel1',
        type: 'QuizSelect',
        content: {
          id: 'sel-c',
          type: 'radio',
          content: 'Файл на месте?',
          options: [
            { id: 'o1', content: 'Да, капитан!', correct: true, feedback: 'SECRET-FEEDBACK' },
            { id: 'o2', content: 'Нет никакого файла.', correct: false, feedback: 'SECRET-FEEDBACK' },
          ],
        },
      },
      {
        id: 'ch1',
        type: 'QuizChoice',
        content: {
          id: 'ch-c',
          content: 'Соотнесите',
          options: [{ id: 'p1', content: 'Коммитит' }, { id: 'p2', content: 'Отправляет' }],
          questions: [
            { id: 'qq1', content: 'git commit', correct_option: 'p1' },
            { id: 'qq2', content: 'git push', correct_option: 'p2' },
          ],
        },
      },
      {
        id: 'mac1',
        type: 'QuizMacaroni',
        content: {
          id: 'mac-c',
          question: 'Соотнесите команды',
          options: { left: { choices: ['git status', 'git add .'] }, right: { choices: ['Добавляет', 'Отображает'] } },
          correct_answers: [[[0, 1], [1, 0]]],
        },
      },
      {
        id: 'txt1',
        type: 'QuizText',
        content: { id: 'txt-c', content: 'Какой код?', validations: [{ type: 'strict', match: 'SECRET-404' }], result_text: 'SECRET-RESULT' },
      },
      {
        id: 'cut1',
        type: 'CutContainer',
        content: { title: 'Узнать больше' },
        nested: [{ id: 'md2', type: 'Markdown', content: { markdown: 'Скрытый текст.' } }],
      },
      {
        id: 'code1',
        type: 'QuizCoding',
        content: { id: 'code-c', language: 'python', panes: [{ content: 'print(1)', language: 'python' }], answer_panes: [{ content: 'SECRET-SOLUTION' }], test: 'SECRET-TEST' },
      },
    ],
  },
};

const answers: SavedAnswer[] = [
  { content_quiz_id: 'expander-ab-c', user_answer: true },
  { content_quiz_id: 'sel-c', user_answer: ['o2'] },
  { content_quiz_id: 'mac-c', user_answer: [[0, 1], [1, 0]] },
];

describe('renderLesson', () => {
  const text = renderLesson(lesson, answers);

  it('never shows answer keys', () => {
    expect(text).not.toMatch(/SECRET|correct/);
  });

  it('numbers interactive blocks and shows answered state', () => {
    expect(text).toContain('Interactive blocks: q1 ActionButton ✓, q2 QuizSelect ✓, q3 QuizChoice, q4 QuizMacaroni ✓, q5 QuizText, q6 QuizCoding');
    expect(text).toContain('[q1 · button «Вперёд!» · pressed]');
    expect(text).toContain('[q2 · single choice · answered]');
    expect(text).toContain('  2. Нет никакого файла.\n  your answer: 2');
    expect(text).toContain('  1. git commit\n  2. git push\n  Options:\n  A. Коммитит');
    expect(text).toContain('your answer: 1=B; 2=A');
    expect(text).toContain('[q5 · free-text answer · not answered]\nКакой код?');
  });

  it('includes collapsed and hidden content', () => {
    expect(text).toContain('▸ Узнать больше (collapsed on the page)\nСкрытый текст.');
    expect(text).toContain('```python\nprint(1)\n```');
  });

  it('pages long lessons', () => {
    const first = renderLesson(lesson, answers, { maxChars: 50 });
    const next = Number(first.match(/call again with offset=(\d+)/)?.[1]);
    expect(next).toBeGreaterThan(25);
    expect(next).toBeLessThanOrEqual(50);
    expect(first.slice(0, first.indexOf('\n\n…('))).toMatch(/\n$|[^\n]$/);
    expect(renderLesson(lesson, answers, { offset: next, maxChars: 50 })).toContain(`…(from character ${next})`);
  });
});

describe('findBlock', () => {
  const blocks = interactiveBlocks(lesson.theory, answers);
  it('accepts refs, numbers, ids and unique prefixes', () => {
    expect(findBlock(blocks, 'q3')?.nodeId).toBe('ch1');
    expect(findBlock(blocks, '3')?.nodeId).toBe('ch1');
    expect(findBlock(blocks, 'Q5')?.nodeId).toBe('txt1');
    expect(findBlock(blocks, 'mac-c')?.nodeId).toBe('mac1');
    expect(findBlock(blocks, 'nope')).toBeUndefined();
  });
});
