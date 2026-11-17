import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { TaskLogLine } from '../src/types';
import { dueText, trackerLine } from '../src/ui/tracker-words';

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

/* What changed, as a history line says it: every name the server writes for an edit of a goal (goals.ts FIELD_NAMES) and of
   a task (edit.ts FIELDS) reads as words of the person's language, never as a name from the code. */
describe('an edit in the history', () => {
  const by = { kind: 'person' as const, id: 'p1', name: 'Ivan' };
  const edited = (fields: string[]): TaskLogLine => ({ kind: 'edited', text: '', data: { fields }, by, at: '2026-11-12T09:30:00.000Z' });
  const line = (t: typeof en, fields: string[]) => trackerLine(t, edited(fields), 'Ivan', {}, () => undefined);
  const GOAL = ['title', 'why', 'parent', 'responsible', 'target', 'current', 'unit', 'due'];
  const TASK = ['title', 'brief', 'why', 'goal', 'responsible', 'due', 'pipeline', 'stage'];

  it('names a changed due date in words', () => {
    expect(line(en, ['due'])).toBe('Ivan changed the due date');
    expect(line(ru, ['due'])).toBe('Ivan изменил срок');
  });

  it('names everything a goal can change in words, in English and in Russian', () => {
    expect(line(en, GOAL)).toBe('Ivan changed the title, the why, the bigger goal, who answers for it, the target, where it stands now, what it is counted in and the due date');
    expect(line(ru, GOAL)).toBe('Ivan изменил название, зачем, большую цель, ответственного, цель в числах, где цель сейчас, в чем считаем и срок');
  });

  it('names everything a task can change in words, in English and in Russian', () => {
    expect(line(en, TASK)).toBe('Ivan changed the title, the short text, the why, the goal, who answers for it, the due date, the pipeline and the stage');
    expect(line(ru, TASK)).toBe('Ivan изменил название, краткое описание, зачем, цель, ответственного, срок, конвейер и этап');
  });
});
