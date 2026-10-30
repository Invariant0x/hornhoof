import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';

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
