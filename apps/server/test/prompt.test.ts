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

  it('lays the work out in turns he plans and fills himself', () => {
    for (const words of ['"plan_turn"', '"add_tasks"', '"turns"', 'starts by itself', 'never tell people to start or close a turn', 'Turn 2, task #14', 'head']) {
      expect(ORCHESTRATOR_INSTRUCTIONS).toContain(words);
    }
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toContain('"create_task"');
    expect(ORCHESTRATOR_INSTRUCTIONS).not.toContain('later version');
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

  it('keeps the newest lines within one command-line argument', () => {
    const at = new Date().toISOString();
    const long = 'Отчет '.repeat(1300);
    const events = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, kind: 'text' as const, data: { text: `${i + 1}. ${long}` }, jobId: null, person: null, at }));
    const text = preface(events, 'Hana');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024);
    expect(text).toContain('Hana: 20. ');
    expect(text).not.toContain('Hana: 1. ');
  });
});
