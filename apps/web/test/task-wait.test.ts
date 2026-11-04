import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { segmentText } from '../src/screens/tree-state';
import type { ExternalWait, TreeSegment } from '../src/types';

const wait = { reason: 'Acceptance', since: '2026-11-04T16:00:00Z', until: '2026-11-04T16:30:00Z' };
const segment = (externalWait: ExternalWait): TreeSegment => ({ kind: 'after', from: wait.since, to: null, externalWait });

describe('named wait labels', () => {
  it.each([
    [en, 'waits for Hana: Acceptance, until 16:30'],
    [ru, 'ждет: Acceptance; сотрудник: Hana, до 16:30'],
  ] as const)('shows the named employee and reason', (t, expected) => {
    const named = { ...wait, on: { kind: 'employee', employee: 'head', name: 'Hana' } as const };
    expect(segmentText(t, segment(named), wait.since)).toBe(expected);
  });

  it.each([
    ['time', 'time', 'время'], ['ceo', 'the CEO', 'CEO'], ['machine', 'a machine', 'машина'], ['other', 'an external event', 'внешнее событие'],
  ] as const)('names the external event %s in both languages', (event, english, russian) => {
    const named = { ...wait, on: { kind: 'external', event } as const };
    expect(segmentText(en, segment(named), wait.since)).toBe(`waits for ${english}: Acceptance, until 16:30`);
    expect(segmentText(ru, segment(named), wait.since)).toBe(`ждет: Acceptance; событие: ${russian}, до 16:30`);
  });

  it.each([undefined, ''])('names an employee when its saved name is missing or empty', name => {
    const named = { ...wait, on: { kind: 'employee', employee: 'head', name } as const };
    expect(segmentText(en, segment(named), wait.since)).toBe('waits for an employee: Acceptance, until 16:30');
    expect(segmentText(ru, segment(named), wait.since)).toBe('ждет: Acceptance; сотрудник: сотрудник, до 16:30');
  });

  it('retains both legacy labels', () => {
    expect(segmentText(en, segment(wait), wait.since)).toBe('waits: Acceptance, until 16:30');
    expect(segmentText(ru, segment(wait), wait.since)).toBe('ждет: Acceptance, до 16:30');
  });
});
