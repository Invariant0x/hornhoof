import { describe, expect, it } from 'vitest';
import { byRelease, inDepartment, split } from '../src/releases';
import { taskTrees } from '../src/task-tree';
import type { TaskLine, TurnView } from '../src/types';
import { taskRoute } from './task-route';

const DEV = { id: 'd2', name: 'Development' };
const SALES = { id: 'd3', name: 'Sales' };

const task = (over: Partial<TaskLine> & Pick<TaskLine, 'id' | 'number'>): TaskLine => ({
  echelons: taskRoute('development'), title: `Task ${over.number}`, brief: '', status: 'working', department: DEV, product: null, assignee: null,
  turn: 3, parentId: null, waitsFor: [], createdAt: '2026-11-14T08:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z', ...over,
});

const turn = (over: Partial<TurnView> & Pick<TurnView, 'id' | 'number' | 'status'>): TurnView => ({
  title: `Turn ${over.number}`, goal: '', version: null, commit: null, baseVersion: null, departmentId: 'd2', releases: true, messages: [], taskId: null, startedAt: '2026-11-14T07:00:00.000Z',
  openedAt: null, closedAt: null, tasks: { total: 0, done: 0 }, ...over,
});

describe('the work of a release, still going and over', () => {
  it('lists open work by what needs people first, then what stopped, is checked, moves and has not started, and folds the closed apart, the newest first', () => {
    const tree = taskTrees([
      task({ id: 'w', number: 1, status: 'working' }),
      task({ id: 'q', number: 2, status: 'waiting', time: { inStatusSince: '2026-11-14T08:00:00.000Z', workSeconds: 0, waitsOn: [{ kind: 'person', who: { kind: 'person', id: 'owner', name: 'Owner' }, reason: null, since: '2026-11-14T08:00:00.000Z' }] } }),
      task({ id: 'r', number: 3, status: 'review' }),
      task({ id: 's', number: 4, status: 'blocked' }),
      task({ id: 'w2', number: 5, status: 'open' }),
      task({ id: 'x', number: 6, status: 'done' }),
      task({ id: 'y', number: 7, status: 'cancelled' }),
    ]);
    const { open, closed } = split(tree);
    expect(open.map(g => g.task.id)).toEqual(['q', 's', 'r', 'w', 'w2']);
    expect(closed.map(g => g.task.id)).toEqual(['y', 'x']);
  });

  it('puts first the work that waits for the answer of the person, a question deep under it too', () => {
    const tree = taskTrees([
      task({ id: 'q', number: 1, status: 'waiting' }),
      task({ id: 'w', number: 2, status: 'working' }),
      task({ id: 'w1', number: 3, parentId: 'w', status: 'working' }),
    ]);
    expect(split(tree, id => id === 'w1').open.map(g => g.task.id)).toEqual(['w', 'q']);
    expect(split(taskTrees([task({ id: 'q', number: 1, status: 'waiting' }), task({ id: 'w', number: 2 })]), id => id === 'w').open.map(g => g.task.id)).toEqual(['w', 'q']);
  });
});

describe('the department filter and the sections of Turns and releases', () => {
  const work = [
    task({ id: 'a', number: 1 }),
    task({ id: 'a1', number: 2, parentId: 'a' }),
    task({ id: 'b', number: 3, department: SALES, turn: 5 }),
    task({ id: 'c', number: 4, department: null, turn: null }),
    task({ id: 'd', number: 5, turn: null, status: 'done' }),
    task({ id: 'e', number: 6, turn: 2, status: 'done' }),
  ];

  it('keeps the tasks of one department, of none, or of all of them', () => {
    expect(inDepartment(work, 'all').map(t => t.id)).toEqual(['a', 'a1', 'b', 'c', 'd', 'e']);
    expect(inDepartment(work, 'd3').map(t => t.id)).toEqual(['b']);
    expect(inDepartment(work, 'none').map(t => t.id)).toEqual(['c']);
  });

  it('keeps all the work still going in progress, and folds what is over apart', () => {
    const { open, closed } = split(taskTrees(work));
    expect(open.map(g => g.task.id)).toEqual(['c', 'b', 'a']);
    expect(closed.map(g => g.task.id)).toEqual(['e', 'd']);
  });

  it("gets each releasing department's next release ready from its work still going and that in its turn, keeps the rest outside releases and lists what came out", () => {
    const turns = [
      turn({ id: 'u2', number: 2, status: 'closed', version: 'v1.2.0' }),
      turn({ id: 'u3', number: 3, status: 'open' }),
      turn({ id: 'u5', number: 5, status: 'open', departmentId: 'd3', releases: false }),
      turn({ id: 'u1', number: 1, status: 'closed' }),
    ];
    const tasks = [
      task({ id: 'a', number: 1, turn: null }),
      task({ id: 'a1', number: 2, parentId: 'a', turn: null }),
      task({ id: 'r', number: 3, turn: 3, status: 'done' }),
      task({ id: 'x', number: 4, turn: null, status: 'cancelled' }),
      task({ id: 'b', number: 5, department: SALES, turn: null }),
      task({ id: 'c', number: 6, department: null, turn: null }),
      task({ id: 'e', number: 7, turn: 2, status: 'done' }),
    ];
    const { preparing, outside, released } = byRelease(tasks, turns);
    expect(preparing.map(p => [p.turn.number, p.going.map(g => g.task.id), p.done.map(g => g.task.id)])).toEqual([[3, ['a'], ['r']]]);
    expect([outside.open.map(g => g.task.id), outside.closed.map(g => g.task.id)]).toEqual([['c', 'b'], []]);
    expect(released.map(r => [r.turn.number, r.trees.map(g => g.task.id)])).toEqual([[2, ['e']]]);
  });

  it('keeps an open turn of a releasing department with nothing in it yet, and leaves out a released one with nothing to show', () => {
    const { preparing, released } = byRelease([], [turn({ id: 'u3', number: 3, status: 'open' }), turn({ id: 'u2', number: 2, status: 'closed' })]);
    expect(preparing.map(p => [p.turn.number, p.going.length, p.done.length])).toEqual([[3, 0, 0]]);
    expect(released).toEqual([]);
  });
});
