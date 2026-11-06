import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { partyName } from '../src/ui/AgentMessage';

describe('a hidden message party', () => {
  it('uses the localized generic employee name without exposing the agent', () => {
    const hidden = { kind: 'agent' as const, id: null, name: 'Employee', role: null, department: null };
    expect(partyName(en, 'en', hidden)).toBe('Employee');
    expect(partyName(ru, 'ru', hidden)).toBe('Сотрудник');
  });
});
