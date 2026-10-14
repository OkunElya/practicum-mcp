import { describe, expect, it } from 'vitest';
import { planAnswer } from '../src/shared/answers';
import type { InteractiveBlock, TheoryNode } from '../src/shared/lesson';

const block = (type: string, content: any): InteractiveBlock => {
  const node: TheoryNode = { id: `${type}-node`, type, content: { id: `${type}-c`, ...content } };
  return { ref: 'q1', nodeId: node.id, contentId: `${type}-c`, type, node, answer: undefined };
};

const radio = block('QuizSelect', { type: 'radio', options: [{ id: 'o1', content: 'Да, капитан!' }, { id: 'o2', content: 'Нет никакого файла.' }] });
const checkbox = block('QuizSelect', { type: 'checkbox', options: [{ id: 'a', content: 'GET' }, { id: 'b', content: 'POST' }, { id: 'c', content: 'FETCH' }] });
const choice = block('QuizChoice', {
  options: [{ id: 'p1', content: 'Коммитит' }, { id: 'p2', content: 'Отправляет' }],
  questions: [{ id: 'q1', content: 'git commit' }, { id: 'q2', content: 'git push' }],
});
const cards = block('QuizCards', {
  options: [{ id: 'c1', content: 'Ты работаешь в стартапе' }, { id: 'c2', content: 'Верни код' }],
  sections: [{ id: 's1', content: 'Контекст' }, { id: 's2', content: 'Формат' }],
});
const macaroni = block('QuizMacaroni', { options: { left: { choices: ['git status', 'git add .'] }, right: { choices: ['Добавляет', 'Отображает'] } } });

describe('planAnswer', () => {
  it('select: numbers, texts, prefixes', () => {
    expect(planAnswer(radio, '2')).toMatchObject({ optionIds: ['o2'] });
    expect(planAnswer(radio, 'Да, капитан!')).toMatchObject({ optionIds: ['o1'] });
    expect(planAnswer(checkbox, '1, 2')).toMatchObject({ optionIds: ['a', 'b'] });
    expect(planAnswer(checkbox, 'GET; post')).toMatchObject({ optionIds: ['a', 'b'] });
  });
  it('select: rejects bad input', () => {
    expect(() => planAnswer(radio, '1, 2')).toThrow(/exactly one/);
    expect(() => planAnswer(radio, '5')).toThrow(/use 1–2/);
  });
  it('choice / cards / macaroni pairs', () => {
    expect(planAnswer(choice, '1=A; 2=B')).toMatchObject({ picks: [{ optionId: 'p1' }, { optionId: 'p2' }] });
    expect(planAnswer(choice, '2 - Коммитит\n1: Отправляет')).toMatchObject({ picks: [{ questionIndex: 0, optionId: 'p2' }, { questionIndex: 1, optionId: 'p1' }] });
    expect(planAnswer(cards, '1=A, 2=B')).toMatchObject({ moves: [{ cardId: 'c1', sectionId: 's1' }, { cardId: 'c2', sectionId: 's2' }] });
    expect(planAnswer(macaroni, '1=B; 2=A')).toMatchObject({ pairs: [{ left: 0, right: 1 }, { left: 1, right: 0 }] });
  });
  it('requires every item exactly once', () => {
    expect(() => planAnswer(choice, '1=A')).toThrow(/missing: 2/);
    expect(() => planAnswer(macaroni, '1=A; 1=B')).toThrow(/given twice/);
    expect(() => planAnswer(cards, '1 A; 2 B')).toThrow(/pairs like 1=B/);
  });
  it('refuses the survey and buttons', () => {
    expect(() => planAnswer(block('QuizFeedback', {}), 'x')).toThrow(/user's own opinion/);
    expect(() => planAnswer(block('ActionButton', {}), 'x')).toThrow(/press_action_button/);
  });
});
