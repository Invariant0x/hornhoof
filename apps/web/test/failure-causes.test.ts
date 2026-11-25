import type { TaskWaitFact, WaitFailure } from '@hornhoof/protocol/waits';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { humanStatus } from '../src/task-tree';
import { boardColumns, listGroups } from '../src/tracker';
import type { TaskLine } from '../src/types';
import { failureTodo, waitText } from '../src/ui/tracker-words';
import { taskRoute } from './task-route';

/* A task reaches "Failures" only for a cause that needs a person or a head and will not clear by itself. The screens read
   the facts the server keeps; these pin what each cause does to them. */
const SINCE = '2026-11-23T10:42:00.000Z';
const DEV = { id: 'd2', name: 'Development' };
const task = (over: Partial<TaskLine> = {}): TaskLine => ({
  id: 't1944', number: 1944, echelons: taskRoute('development'), title: 'Release check', brief: '', status: 'working', department: DEV, product: null,
  assignee: null, turn: 43, parentId: null, waitsFor: [], createdAt: SINCE, updatedAt: SINCE, ...over,
});
const waiting = (...waitsOn: Omit<TaskWaitFact, 'who' | 'since'>[]): Partial<TaskLine> =>
  ({ time: { inStatusSince: SINCE, workSeconds: 0, waitsOn: waitsOn.map(fact => ({ who: null, since: SINCE, ...fact })) } });
const inFailures = (line: TaskLine) => listGroups([line]).some(group => group.status === 'failure')
  || boardColumns([line], null).some(column => column.status === 'failure' && column.cards.length > 0);

describe('what puts a task in Failures', () => {
  it('keeps a task whose run Hornhoof refused out of Failures: the server gives the refused run no failure, only its work wait', () => {
    const refused = task(waiting({ kind: 'work', reason: 'Release check of #1944' }));
    expect(humanStatus(refused)).toBe('working');
    expect(inFailures(refused)).toBe(false);
  });

  it('puts a task whose started check failed in Failures, and takes it out once a green run follows', () => {
    const failed = task(waiting({ kind: 'work', reason: '587', failure: 'run' }));
    expect(humanStatus(failed)).toBe('failure');
    expect(inFailures(failed)).toBe(true);
    const green = task(waiting());
    expect(humanStatus(green)).toBe('working');
    expect(inFailures(green)).toBe(false);
  });

  it('never puts a document task without tests in Failures, at any stage of its work', () => {
    const route = { ...taskRoute('development'), resultKind: 'document' as const };
    for (const status of ['open', 'working', 'waiting', 'review'] as const) {
      const doc = task({ status, echelons: route, ...waiting() });
      expect(humanStatus(doc)).not.toBe('failure');
      expect(inFailures(doc)).toBe(false);
    }
  });

  it('puts a task whose agent is stuck and asks for help in Failures, until the request is answered', () => {
    const stuck = task({ status: 'waiting', ...waiting({ kind: 'external', reason: null, failure: 'stuck' }) });
    expect(humanStatus(stuck)).toBe('failure');
    expect(humanStatus(task({ status: 'working', ...waiting() }))).toBe('working');
  });
});

describe('the failure card', () => {
  const failures: WaitFailure[] = ['run', 'expired', 'machine', 'unavailable', 'stuck', 'turn'];

  it.each(failures)('says what to do about a %s failure, in both languages', failure => {
    const fact: TaskWaitFact = { kind: failure === 'run' ? 'run' : 'external', who: null, since: SINCE, reason: null, failure };
    for (const t of [en, ru]) {
      const todo = failureTodo(t, fact);
      expect(todo).toMatch(/^\S.{20,}[.]$/);
      expect(todo).not.toMatch(/[—ё]/);
    }
    expect(failureTodo(en, fact)).not.toBe(failureTodo(ru, fact));
  });

  it('has nothing to do for a wait that is no failure', () => {
    expect(failureTodo(en, { kind: 'work', who: null, since: SINCE, reason: '587' })).toBeNull();
  });

  it.each([
    ['stuck', 'Stuck and asks for help', 'Застрял и просит помощи'],
    ['turn', 'Its last turn failed', 'Последний ход упал'],
  ] as const)('names a %s failure in plain words in both languages', (failure, english, russian) => {
    const failed = task({ status: 'working', ...waiting({ kind: 'external', reason: null, failure }) });
    expect(humanStatus(failed)).toBe('failure');
    expect([waitText(en, failed), waitText(ru, failed)]).toEqual([english, russian]);
  });
});
