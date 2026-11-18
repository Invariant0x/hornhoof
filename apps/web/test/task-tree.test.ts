import { describe, expect, it } from 'vitest';
import { askingTask, humanStatus, isClosed, taskTrees, taskWaits, treeStatus, type TaskTree } from '../src/task-tree';
import type { TaskLine } from '../src/types';
import { taskRoute } from './task-route';

const DEV = { id: 'd2', name: 'Development' };

const task = (over: Partial<TaskLine> & Pick<TaskLine, 'id' | 'number'>): TaskLine => ({
  echelons: taskRoute('development'), title: `Task ${over.number}`, brief: '', status: 'working', department: DEV, product: null, assignee: null,
  turn: 3, parentId: null, waitsFor: [], createdAt: '2026-11-14T08:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z', ...over,
});

/* Six tasks at the top, each with three subtasks, each of those with six of its own: 132 tasks in all. */
function bigTree(): TaskLine[] {
  const all: TaskLine[] = [];
  let n = 0;
  for (let g = 0; g < 6; g++) {
    const top = task({ id: `g${g}`, number: ++n });
    all.push(top);
    for (let c = 0; c < 3; c++) {
      const child = task({ id: `g${g}c${c}`, number: ++n, parentId: top.id, status: c === 0 ? 'done' : 'working' });
      all.push(child);
      for (let l = 0; l < 6; l++) all.push(task({ id: `g${g}c${c}l${l}`, number: ++n, parentId: child.id, status: c === 0 || l < 3 ? 'done' : 'working' }));
    }
  }
  return all.reverse();
}

const count = (nodes: TaskTree[]): number => nodes.reduce((sum, node) => sum + 1 + count(node.children), 0);

/* The table of the Design department: each state of a task in a word a person reads without effort. */
describe('the human state of a task', () => {
  it.each([
    ['open', 'notStarted'],
    ['working', 'working'],
    ['review', 'review'],
    ['waiting', 'working'],
    ['blocked', 'stopped'],
    ['done', 'done'],
    ['cancelled', 'cancelled'],
  ] as const)('reads %s as %s', (status, human) => {
    expect(humanStatus(task({ id: 't1', number: 1, status }))).toBe(human);
  });

  it('reads a task that asks the person a question as waiting for their answer, until it is closed or paused', () => {
    expect(humanStatus(task({ id: 't1', number: 1, status: 'waiting' }), true)).toBe('waitingYou');
    expect(humanStatus(task({ id: 't1', number: 1, status: 'working' }), true)).toBe('waitingYou');
    expect(humanStatus(task({ id: 't1', number: 1, status: 'done' }), true)).toBe('done');
    expect(humanStatus(task({ id: 't1', number: 1, paused: { at: '2026-11-14T10:00:00.000Z', reason: 'Not now.', root: 't1' } }), true)).toBe('paused');
  });

  it('reads a task as in progress once the work under it began, though its own task waits for the next turn of its holder', () => {
    const tree = (child: TaskLine['status']) => taskTrees([task({ id: 'g', number: 1, status: 'open' }), task({ id: 'c', number: 2, parentId: 'g', status: child })])[0]!;
    expect(treeStatus(tree('working'))).toBe('working');
    expect(treeStatus(tree('done'))).toBe('working');
    expect(treeStatus(tree('open'))).toBe('notStarted');
    expect(treeStatus(taskTrees([task({ id: 'h', number: 3, status: 'open', echelons: taskRoute('review') })])[0]!)).toBe('working');
    expect(treeStatus(taskTrees([task({ id: 'n', number: 4, status: 'open' })])[0]!)).toBe('notStarted');
    expect(treeStatus(tree('working'), true)).toBe('waitingYou');
  });

  it('reads a paused task as paused and an expired external wait as a failure', () => {
    const paused = { at: '2026-11-14T10:00:00.000Z', reason: 'Not now.', root: 't1' };
    expect(humanStatus(task({ id: 't1', number: 1, paused }))).toBe('paused');
    expect(humanStatus(task({ id: 't1', number: 1, externalWait: { since: '2026-11-14T10:00:00.000Z', until: '2026-11-14T11:00:00.000Z', reason: 'The bank answers.' } as TaskLine['externalWait'] }))).toBe('failure');
    expect(humanStatus(task({ id: 't1', number: 1, status: 'done', paused }))).toBe('done');
  });

  it('counts only done and cancelled work as over', () => {
    expect((['open', 'working', 'review', 'waiting', 'blocked', 'done', 'cancelled'] as const).filter(status => isClosed({ status }))).toEqual(['done', 'cancelled']);
  });
});

/* What a task waits for: the facts the server keeps, the external wait the task records and the tasks it waits for, a failure
   first, then a wait for a person, then the oldest. */
describe('what a task waits for', () => {
  const NOW = Date.parse('2026-11-14T12:00:00.000Z');
  const person = { kind: 'person', id: 'p1', name: 'Ivan' } as const;
  const head = { kind: 'agent', id: 'h1', name: 'Hana' } as const;
  const external = (until: string) => ({ since: '2026-11-14T09:30:00.000Z', until, reason: 'The bank answers.' }) as TaskLine['externalWait'];

  it('puts a failure first, then a wait for a person, then the oldest, with the tasks it waits for that no fact names', () => {
    const waiting = task({
      id: 't', number: 1, status: 'waiting', waitsFor: [7, 8], externalWait: external('2026-11-14T11:00:00.000Z'),
      time: { inStatusSince: '2026-11-14T08:00:00.000Z', workSeconds: 0, waitsOn: [
        { kind: 'review', who: head, reason: null, since: '2026-11-14T09:00:00.000Z' },
        { kind: 'after', who: null, reason: '#7', since: '2026-11-14T07:00:00.000Z' },
        { kind: 'person', who: person, reason: null, since: '2026-11-14T10:00:00.000Z' },
      ] },
    });
    expect(taskWaits(waiting, NOW).map(w => [w.kind, w.reason, w.since, w.failure ?? null])).toEqual([
      ['external', 'The bank answers.', '2026-11-14T09:30:00.000Z', 'expired'],
      ['person', null, '2026-11-14T10:00:00.000Z', null],
      ['after', '#7', '2026-11-14T07:00:00.000Z', null],
      ['after', '#8', '2026-11-14T08:00:00.000Z', null],
      ['review', null, '2026-11-14T09:00:00.000Z', null],
    ]);
  });

  it('puts the external wait the task records in place of the fact the server keeps of it, and has none once the task is over', () => {
    const kept = { kind: 'external' as const, who: head, reason: 'Old words', since: '2026-11-14T09:30:00.000Z', until: '2026-11-14T13:00:00.000Z' };
    const open = task({ id: 't', number: 1, status: 'waiting', externalWait: external('2026-11-14T13:00:00.000Z'), time: { inStatusSince: '2026-11-14T08:00:00.000Z', workSeconds: 0, waitsOn: [kept] } });
    expect(taskWaits(open, NOW)).toEqual([{ kind: 'external', who: head, reason: 'The bank answers.', since: '2026-11-14T09:30:00.000Z', until: '2026-11-14T13:00:00.000Z' }]);
    expect(taskWaits({ ...open, status: 'done' }, NOW)).toEqual([]);
  });
});

describe('tasks with the work under them', () => {
  it('puts only the tasks at the top of 132 at the top, with every task still under one of them', () => {
    const tree = taskTrees(bigTree());
    expect(tree.map(g => g.task.id)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4', 'g5']);
    expect(count(tree)).toBe(132);
    expect(tree[0]!.children.map(c => c.task.id)).toEqual(['g0c0', 'g0c1', 'g0c2']);
    expect(tree[0]!.children[1]!.children).toHaveLength(6);
  });

  it('counts the subtasks done right under a task, and its progress from all the work under it', () => {
    const [top] = taskTrees(bigTree());
    expect([top!.done, top!.total]).toEqual([1, 3]);
    expect([top!.children[1]!.done, top!.children[1]!.total]).toEqual([3, 6]);
    /* One subtask done, two half way: (1 + 0.5 + 0.5) / 3. */
    expect(top!.progress).toBeCloseTo(2 / 3);
  });

  it('leaves a cancelled subtask out of the count, and reads a task without any by its stages', () => {
    const tree = taskTrees([
      task({ id: 'g', number: 1 }),
      task({ id: 'a', number: 2, parentId: 'g', status: 'done' }),
      task({ id: 'b', number: 3, parentId: 'g', status: 'cancelled' }),
      task({ id: 'solo', number: 4, echelons: taskRoute('review') }),
      task({ id: 'fresh', number: 5, echelons: { ...taskRoute('development'), stages: [] } }),
    ]);
    const [top, solo, fresh] = tree;
    expect([top!.done, top!.total, top!.progress]).toEqual([1, 1, 1]);
    /* Development complete of the three stages that apply: Architecture and Security are skipped. */
    expect(solo!.progress).toBeCloseTo(1 / 3);
    expect(fresh!.progress).toBe(0);
  });

  it('puts a task at the top when its parent is not among those shown', () => {
    const tree = taskTrees([task({ id: 'c', number: 2, parentId: 'elsewhere' }), task({ id: 'd', number: 3, parentId: 'c' })]);
    expect(tree.map(g => [g.task.id, g.children.map(c => c.task.id)])).toEqual([['c', ['d']]]);
  });

  /* A view that shows only part of the work, a person's own tasks or one status, still counts every subtask: what it leaves
     out of sight counts too, at every depth, cancelled ones aside; the progress stays that of the work shown. */
  it('counts the subtasks over all the work when those shown are only part of it', () => {
    const all = [
      task({ id: 'g', number: 1 }),
      task({ id: 'a', number: 2, parentId: 'g' }),
      task({ id: 'a1', number: 3, parentId: 'a', status: 'done' }),
      task({ id: 'a2', number: 4, parentId: 'a', status: 'cancelled' }),
      task({ id: 'b', number: 5, parentId: 'g', status: 'done' }),
    ];
    /* The work still going: what is done is out of sight, the cancelled subtask in sight but never counted. */
    const shown = all.filter(t => t.status !== 'done');
    const [top] = taskTrees(shown, all);
    expect([top!.task.id, top!.done, top!.total]).toEqual(['g', 1, 2]);
    expect([top!.children[0]!.task.id, top!.children[0]!.done, top!.children[0]!.total, top!.children[0]!.children.map(c => c.task.id)]).toEqual(['a', 1, 1, ['a2']]);
    expect(taskTrees(shown)[0]).toMatchObject({ done: 0, total: 1 });
  });
});

/* Where the person's answer is needed: on the task itself or on any task under it, as long as that one is not closed. */
describe("the person's part in the work", () => {
  const tree = () => taskTrees([
    task({ id: 'g', number: 1 }),
    task({ id: 'c', number: 2, parentId: 'g' }),
    task({ id: 'l', number: 3, parentId: 'c' }),
    task({ id: 'z', number: 4, parentId: 'g', status: 'done' }),
  ])[0]!;

  it('finds the task that asks the person, the one at the top first, then deep down, never a closed one', () => {
    expect(askingTask(tree(), id => id === 'g')?.id).toBe('g');
    expect(askingTask(tree(), id => id === 'l')?.id).toBe('l');
    expect(askingTask(tree(), id => id === 'z')).toBeNull();
    expect(askingTask(tree(), () => false)).toBeNull();
    expect(askingTask(tree())).toBeNull();
  });
});
