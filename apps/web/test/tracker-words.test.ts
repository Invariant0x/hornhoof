import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { dueText } from '../src/ui/tracker-words';

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
