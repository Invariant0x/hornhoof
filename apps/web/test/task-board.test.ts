import { describe, expect, it } from 'vitest';
import { askingTask, byRelease, goals, goalStatus, humanStatus, inDepartment, split, type Goal } from '../src/task-board';
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

/* Six goals, each with three related tasks, each of those with six of its own: 132 tasks in all. */
function bigTree(): TaskLine[] {
  const all: TaskLine[] = [];
  let n = 0;
  for (let g = 0; g < 6; g++) {
    const goal = task({ id: `g${g}`, number: ++n });
    all.push(goal);
    for (let c = 0; c < 3; c++) {
      const child = task({ id: `g${g}c${c}`, number: ++n, parentId: goal.id, status: c === 0 ? 'done' : 'working' });
      all.push(child);
      for (let l = 0; l < 6; l++) all.push(task({ id: `g${g}c${c}l${l}`, number: ++n, parentId: child.id, status: c === 0 || l < 3 ? 'done' : 'working' }));
    }
  }
  return all.reverse();
}

const count = (nodes: Goal[]): number => nodes.reduce((sum, node) => sum + 1 + count(node.children), 0);

/* The table of the Design department: each state of a task in a word a person reads without effort. */
describe('the human state of a task', () => {
  it.each([
    ['open', 'notStarted'],
    ['working', 'working'],
    ['review', 'review'],
    ['waiting', 'waiting'],
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

  it('reads a goal as in progress once its work began, though its own task waits for the next turn of its holder', () => {
    const goal = (child: TaskLine['status']) => goals([task({ id: 'g', number: 1, status: 'open' }), task({ id: 'c', number: 2, parentId: 'g', status: child })])[0]!;
    expect(goalStatus(goal('working'))).toBe('working');
    expect(goalStatus(goal('done'))).toBe('working');
    expect(goalStatus(goal('open'))).toBe('notStarted');
    expect(goalStatus(goals([task({ id: 'h', number: 3, status: 'open', echelons: taskRoute('review') })])[0]!)).toBe('working');
    expect(goalStatus(goals([task({ id: 'n', number: 4, status: 'open' })])[0]!)).toBe('notStarted');
    expect(goalStatus(goal('working'), true)).toBe('waitingYou');
  });

  it('reads a paused task as paused, and a task waiting for an event as waiting for an answer, until it is closed', () => {
    const paused = { at: '2026-11-14T10:00:00.000Z', reason: 'Not now.', root: 't1' };
    expect(humanStatus(task({ id: 't1', number: 1, paused }))).toBe('paused');
    expect(humanStatus(task({ id: 't1', number: 1, externalWait: { since: '2026-11-14T10:00:00.000Z', until: '2026-11-14T11:00:00.000Z', reason: 'The bank answers.' } as TaskLine['externalWait'] }))).toBe('waiting');
    expect(humanStatus(task({ id: 't1', number: 1, status: 'done', paused }))).toBe('done');
  });
});

describe('goals with their related tasks folded under them', () => {
  it('puts only the goals of 132 tasks at the top, with every task still under one of them', () => {
    const tree = goals(bigTree());
    expect(tree.map(g => g.task.id)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4', 'g5']);
    expect(count(tree)).toBe(132);
    expect(tree[0]!.children.map(c => c.task.id)).toEqual(['g0c0', 'g0c1', 'g0c2']);
    expect(tree[0]!.children[1]!.children).toHaveLength(6);
  });

  it('counts the related tasks done right under a goal, and its progress from all the work under it', () => {
    const [goal] = goals(bigTree());
    expect([goal!.done, goal!.total]).toEqual([1, 3]);
    expect([goal!.children[1]!.done, goal!.children[1]!.total]).toEqual([3, 6]);
    /* One related task done, two half way: (1 + 0.5 + 0.5) / 3. */
    expect(goal!.progress).toBeCloseTo(2 / 3);
  });

  it('leaves a cancelled related task out of the count, and reads a task without any by its stages', () => {
    const tree = goals([
      task({ id: 'g', number: 1 }),
      task({ id: 'a', number: 2, parentId: 'g', status: 'done' }),
      task({ id: 'b', number: 3, parentId: 'g', status: 'cancelled' }),
      task({ id: 'solo', number: 4, echelons: taskRoute('review') }),
      task({ id: 'fresh', number: 5, echelons: { ...taskRoute('development'), stages: [] } }),
    ]);
    const [goal, solo, fresh] = tree;
    expect([goal!.done, goal!.total, goal!.progress]).toEqual([1, 1, 1]);
    /* Development complete of the three stages that apply: Architecture and Security are skipped. */
    expect(solo!.progress).toBeCloseTo(1 / 3);
    expect(fresh!.progress).toBe(0);
  });

  it('puts a task at the top when its parent is not among those shown', () => {
    const tree = goals([task({ id: 'c', number: 2, parentId: 'elsewhere' }), task({ id: 'd', number: 3, parentId: 'c' })]);
    expect(tree.map(g => [g.task.id, g.children.map(c => c.task.id)])).toEqual([['c', ['d']]]);
  });

  it('lists open goals by what needs people first, then what stopped, is checked, moves and has not started, and folds the closed ones apart, the newest first', () => {
    const tree = goals([
      task({ id: 'w', number: 1, status: 'working' }),
      task({ id: 'q', number: 2, status: 'waiting' }),
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
});

describe('the department filter and the sections of the tracker', () => {
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

  it('keeps every goal still going in progress, and folds what is over apart', () => {
    const { open, closed } = split(goals(work));
    expect(open.map(g => g.task.id)).toEqual(['c', 'b', 'a']);
    expect(closed.map(g => g.task.id)).toEqual(['e', 'd']);
  });

  it("gets each releasing department's next release ready from its goals still going and those in its turn, keeps the rest outside releases and lists what came out", () => {
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
    expect(released.map(r => [r.turn.number, r.goals.map(g => g.task.id)])).toEqual([[2, ['e']]]);
  });

  it('keeps an open turn of a releasing department with nothing in it yet, and leaves out a released one with nothing to show', () => {
    const { preparing, released } = byRelease([], [turn({ id: 'u3', number: 3, status: 'open' }), turn({ id: 'u2', number: 2, status: 'closed' })]);
    expect(preparing.map(p => [p.turn.number, p.going.length, p.done.length])).toEqual([[3, 0, 0]]);
    expect(released).toEqual([]);
  });
});

/* Where the person's answer is needed: on the goal itself or on any task under it, as long as that one is not closed. */
describe("the person's part in the work", () => {
  const tree = () => goals([
    task({ id: 'g', number: 1 }),
    task({ id: 'c', number: 2, parentId: 'g' }),
    task({ id: 'l', number: 3, parentId: 'c' }),
    task({ id: 'z', number: 4, parentId: 'g', status: 'done' }),
  ])[0]!;

  it('finds the task of a goal that asks the person, the goal itself first, then deep down, never a closed one', () => {
    expect(askingTask(tree(), id => id === 'g')?.id).toBe('g');
    expect(askingTask(tree(), id => id === 'l')?.id).toBe('l');
    expect(askingTask(tree(), id => id === 'z')).toBeNull();
    expect(askingTask(tree(), () => false)).toBeNull();
    expect(askingTask(tree())).toBeNull();
  });

  it('puts first the goals whose work waits for the answer of the person, a question deep under them too', () => {
    const tree = goals([
      task({ id: 'q', number: 1, status: 'waiting' }),
      task({ id: 'w', number: 2, status: 'working' }),
      task({ id: 'w1', number: 3, parentId: 'w', status: 'working' }),
    ]);
    expect(split(tree, id => id === 'w1').open.map(g => g.task.id)).toEqual(['w', 'q']);
    expect(split(goals([task({ id: 'q', number: 1, status: 'waiting' }), task({ id: 'w', number: 2 })]), id => id === 'w').open.map(g => g.task.id)).toEqual(['w', 'q']);
  });
});
