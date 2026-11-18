import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { TaskLine } from '../src/types';
import { dueText, waitText } from '../src/ui/tracker-words';

/* A due date is a day of the calendar, kept as its midnight in UTC. */
const DUE = '2026-11-20T00:00:00.000Z';
const zone = process.env.TZ;
afterEach(() => {
  process.env.TZ = zone;
});

describe('a due day', () => {
  it('reads as the day it was set to, wherever the person is', () => {
    for (const where of ['America/New_York', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = where;
      expect(dueText(en, 'en', { dueAt: DUE, status: 'open' }, Date.parse('2026-11-19T12:00:00.000Z'))).toEqual({ text: '20 Nov', late: false });
      expect(dueText(ru, 'ru', { dueAt: DUE, status: 'open' }, Date.parse('2026-11-19T12:00:00.000Z'))?.text).toMatch(/^20 нояб/);
    }
  });

  it('is late only once the whole day has passed, and never for work that is over', () => {
    process.env.TZ = 'Asia/Tokyo';
    expect(dueText(en, 'en', { dueAt: DUE, status: 'working' }, Date.parse('2026-11-20T23:59:00.000Z'))).toEqual({ text: '20 Nov', late: false });
    expect(dueText(en, 'en', { dueAt: DUE, status: 'working' }, Date.parse('2026-11-21T00:00:00.000Z'))).toEqual({ text: '20 Nov, late', late: true });
    expect(dueText(en, 'en', { dueAt: DUE, status: 'done' }, Date.parse('2026-11-25T00:00:00.000Z'))).toEqual({ text: '20 Nov', late: false });
  });
});

describe('what a task is waiting for', () => {
  const since = '2026-11-17T21:45:00.000Z';
  const now = Date.parse('2026-11-17T22:05:00.000Z');
  const owner = { kind: 'agent', id: 'head', name: 'Head of development' } as const;
  const executor = { ...owner, kind: 'head', role: null } as const;
  const person = { kind: 'person', id: 'ivan', name: 'Иван Король' } as const;
  const reviewer = { kind: 'agent', id: 'hana', name: 'Hana' } as const;

  it.each([
    ['person', person, null, 'Waits for Иван Король, 20 minutes', 'Ждет Иван Король 20 минут'],
    ['after', owner, '#42', 'After #42', 'После #42'],
    ['review', reviewer, null, 'Hana is reviewing', 'Идет проверка (Hana)'],
    ['review', owner, null, 'Review in progress', 'Идет проверка'],
    ['run', owner, '108', 'Test run 108 is running', 'Идет прогон тестов 108'],
    ['run', owner, null, 'Test running', 'Идут тесты'],
    ['external', null, 'Deployment', 'Deployment', 'Deployment'],
    ['external', reviewer, 'Deployment', 'Hana is on it: Deployment', 'В работе (Hana): Deployment'],
  ] as const)('names the target of a %s wait in both languages', (kind, who, reason, english, russian) => {
    const status: TaskLine['status'] = 'working';
    const task = { status, executor, time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind, who, reason, since }] } };
    expect(waitText(en, task, now)).toBe(english);
    expect(waitText(ru, task, now)).toBe(russian);
  });
});
