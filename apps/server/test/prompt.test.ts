import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_INSTRUCTIONS, preface } from '../src/modules/conversation/prompt.js';

describe('orchestrator instructions', () => {
  it('names the departments the way the Russian screen shows them', () => {
    for (const name of ['Операции', 'Разработка', 'Дизайн', 'Маркетинг', 'Продажи', 'Развитие бизнеса', 'Поддержка', 'Финансы']) expect(ORCHESTRATOR_INSTRUCTIONS).toContain(name);
  });

  it('staffs a department through its options and a card, by the staffing guideline', () => {
    for (const words of ['staffing_options', 'propose_staff', 'the default roster first', 'a different provider than the implementers', 'one per product', 'nothing secret goes into names or notes']) {
      expect(ORCHESTRATOR_INSTRUCTIONS).toContain(words);
    }
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toContain('Hornhoof cannot put people or agents into departments yet');
  });
});

describe('catching a new session up', () => {
  it("names Hornhoof for the messages it wrote itself, like a task's wake", () => {
    const at = new Date().toISOString();
    const text = preface(
      [
        { seq: 1, kind: 'message', data: { text: '#1 "Checkout API" is yours to do.' }, jobId: null, person: null, at },
        { seq: 2, kind: 'text', data: { text: 'On it.' }, jobId: null, person: null, at },
      ],
      'Bruno',
    );
    expect(text).toContain('Hornhoof: #1 "Checkout API" is yours to do.\nBruno: On it.');
  });
});
