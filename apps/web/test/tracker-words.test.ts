import type { TaskWaitFact, WaitRunError } from '@hornhoof/protocol/waits';
import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { TaskLine, TaskLogLine } from '../src/types';
import { dueText, trackerLine, waitText } from '../src/ui/tracker-words';

/* A due date is a day of the calendar, kept as its midnight in UTC. */
const DUE = '2026-11-20T00:00:00.000Z';
const zone = process.env.TZ;
afterEach(() => {
  process.env.TZ = zone;
});

describe('why a task failed', () => {
  const since = '2026-11-17T21:45:00.000Z';
  const wordsOf = (fact: Pick<TaskWaitFact, 'kind' | 'failure' | 'reason' | 'runError'>) => {
    const task = { status: 'working' as const, time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ ...fact, who: null, since }] } };
    return [waitText(en, task), waitText(ru, task)];
  };

  it.each([
    ['run', '17', 'Test run\u00a0#17 failed', 'Упал прогон тестов\u00a0№17'],
    ['run', null, 'Test run failed', 'Упал прогон тестов'],
    ['work', '17', 'Work run\u00a0#17 failed', 'Упал прогон работы\u00a0№17'],
    ['work', null, 'Work run failed', 'Упал прогон работы'],
  ] as const)('keeps the number with its word in a %s failure (%s)', (kind, reason, english, russian) => {
    expect(wordsOf({ kind, reason, failure: 'run' })).toEqual([english, russian]);
  });

  const causes = {
    timeout: ['Time ran out', 'Время вышло'],
    machine: ['Machine unavailable', 'Машина недоступна'],
    repository: ['Could not open the repository', 'Не удалось открыть репозиторий'],
    files: ['Could not load the task files', 'Не удалось загрузить файлы задачи'],
    revision: ['Checked the wrong version', 'Проверили не ту версию'],
    stopped: ['Stopped on the machine', 'Остановлено на машине'],
  } satisfies Record<WaitRunError, string[]>;

  it.each(Object.keys(causes) as WaitRunError[])('names the %s cause after the failed run in both languages', runError => {
    const [english, russian] = causes[runError];
    expect(wordsOf({ kind: 'run', reason: '17', failure: 'run', runError }))
      .toEqual([`Test run\u00a0#17 failed: ${english}`, `Упал прогон тестов\u00a0№17: ${russian}`]);
  });

  it.each([
    ['machine', 'Machine unavailable', 'Машина недоступна'],
    ['expired', 'Time ran out', 'Время вышло'],
    ['unavailable', 'Employee unavailable', 'Сотрудник недоступен'],
  ] as const)('names the %s wait failure in both languages', (failure, english, russian) => {
    expect(wordsOf({ kind: 'external', reason: null, failure })).toEqual([english, russian]);
  });
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
  const line = (t: typeof en, fields: string[], whole: 'goal' | 'task' = 'goal') => trackerLine(t, edited(fields), 'Ivan', {}, () => undefined, whole);
  const GOAL = ['title', 'why', 'parent', 'responsible', 'target', 'current', 'unit', 'due'];
  const TASK = ['title', 'brief', 'why', 'goal', 'responsible', 'due', 'priority', 'pipeline', 'stage'];

  it('names a changed due date in words', () => {
    expect(line(en, ['due'])).toBe('Ivan changed the due date');
    expect(line(ru, ['due'])).toBe('Ivan изменил срок');
  });

  it('names everything a goal can change in words, in English and in Russian', () => {
    expect(line(en, GOAL)).toBe('Ivan changed the title, the why, the bigger goal, who answers for it, the target, where it stands now, what it is counted in and the due date');
    expect(line(ru, GOAL)).toBe('Ivan изменил название, зачем, большую цель, ответственного, цель в числах, где цель сейчас, в чем считаем и срок');
  });

  it('names everything a task can change in words, in English and in Russian', () => {
    expect(line(en, TASK, 'task')).toBe('Ivan changed the title, the short text, the why, the goal, who answers for it, the due date, the priority, the pipeline and the stage');
    expect(line(ru, TASK, 'task')).toBe('Ivan изменил название, краткое описание, зачем, цель, ответственного, срок, приоритет, конвейер и этап');
  });

  /* A name the tracker has no words for, one from the code or one a later server writes, never shows: the line says the
     goal or the task changed. So does an edit that names nothing, and a name that is no own word of the tracker. */
  it('says the goal changed for a name it has no words for, never the name itself', () => {
    expect(line(en, ['dueAt'])).toBe('Ivan changed the goal');
    expect(line(ru, ['dueAt'])).toBe('Ivan изменил цель');
    expect(line(en, ['toString'])).toBe('Ivan changed the goal');
    expect(line(en, [])).toBe('Ivan changed the goal');
    expect(line(ru, [])).toBe('Ivan изменил цель');
  });

  it('says the task changed for a name it has no words for in a task\'s history', () => {
    expect(line(en, ['reviewCadence'], 'task')).toBe('Ivan changed the task');
    expect(line(ru, ['reviewCadence'], 'task')).toBe('Ivan изменил задачу');
  });

  it('keeps the names it knows beside one word for the rest', () => {
    expect(line(en, ['due', 'dueAt', 'owner'])).toBe('Ivan changed the due date and the goal');
    expect(line(ru, ['due', 'dueAt', 'owner'])).toBe('Ivan изменил срок и цель');
  });
});

describe('what a task is waiting for', () => {
  const since = '2026-11-17T21:45:00.000Z';
  const now = Date.parse('2026-11-17T22:05:00.000Z');
  const owner = { kind: 'agent', id: 'head', name: 'Head of development' } as const;
  const executor = { ...owner, kind: 'head', role: null } as const;
  const person = { kind: 'person', id: 'ivan', name: 'Иван Король' } as const;
  const reviewer = { kind: 'agent', id: 'hana', name: 'Hana' } as const;

  it('shows a progress check as running work in both languages', () => {
    const nextCheck = '2026-11-20T15:00:00.000Z';
    const task = { status: 'working' as const, executor, time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'work' as const, who: owner, reason: 'CI', since, nextCheck }] } };
    expect(waitText(en, task, now)).toMatch(/^CI is in progress\. Next check:/);
    expect(waitText(ru, task, now)).toMatch(/^В работе: CI\. Следующая проверка:/);
  });

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
