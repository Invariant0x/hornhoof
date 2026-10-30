import { describe, expect, it } from 'vitest';
import { ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';

describe('orchestrator instructions', () => {
  it('names the departments the way the Russian screen shows them', () => {
    for (const name of ['Операции', 'Разработка', 'Дизайн', 'Маркетинг', 'Продажи', 'Развитие бизнеса', 'Поддержка', 'Финансы']) expect(ORCHESTRATOR_INSTRUCTIONS).toContain(name);
  });

  it('does not offer to staff the departments yet', () => {
    expect(ORCHESTRATOR_INSTRUCTIONS).toContain('Hornhoof cannot put people or agents into departments yet');
  });
});
