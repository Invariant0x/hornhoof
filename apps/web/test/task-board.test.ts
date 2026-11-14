import { describe, expect, it } from 'vitest';
import { byDepartment, byRelease, goals, humanStatus, inDepartment, inProgress, split, type Goal } from '../src/task-board';
import type { TaskLine, TurnView } from '../src/types';
import { taskRoute } from './task-route';

const DEV = { id: 'd2', name: 'Development' };
const SALES = { id: 'd3', name: 'Sales' };

const task = (over: Partial<TaskLine> & Pick<TaskLine, 'id' | 'number'>): TaskLine => ({
  echelons: taskRoute('development'), title: `Task ${over.number}`, brief: '', status: 'working', department: DEV, product: null, assignee: null,
  turn: 3, parentId: null, waitsFor: [], createdAt: '2026-11-14T08:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z', ...over,
});

const turn = (over: Partial<TurnView> & Pick<TurnView, 'id' | 'number' | 'status'>): TurnView => ({
  title: `Turn ${over.number}`, goal: '', mode: 'echelons', departmentId: 'd2', canChangeMode: false, messages: [], taskId: null, startedAt: '2026-11-14T07:00:00.000Z',
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

describe('the human state of a task', () => {
  it.each([
    ['planned', 'planned'],
    ['open', 'working'],
    ['working', 'working'],
    ['review', 'review'],
    ['waiting', 'waiting'],
    ['blocked', 'waiting'],
    ['done', 'done'],
    ['cancelled', 'cancelled'],
  ] as const)('reads %s as %s', (status, human) => {
    expect(humanStatus(task({ id: 't1', number: 1, status }))).toBe(human);
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

  it('lists open goals by what needs people first, and folds the closed ones apart, the newest first', () => {
    const tree = goals([
      task({ id: 'w', number: 1, status: 'working' }),
      task({ id: 'q', number: 2, status: 'waiting' }),
      task({ id: 'r', number: 3, status: 'review' }),
      task({ id: 'p', number: 4, status: 'planned' }),
      task({ id: 'w2', number: 5, status: 'open' }),
      task({ id: 'x', number: 6, status: 'done' }),
      task({ id: 'y', number: 7, status: 'cancelled' }),
    ]);
    const { open, closed } = split(tree);
    expect(open.map(g => g.task.id)).toEqual(['q', 'r', 'w2', 'w', 'p']);
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
    task({ id: 'f', number: 7, turn: 4, status: 'planned' }),
  ];

  it('keeps the tasks of one department, of none, or of all of them', () => {
    expect(inDepartment(work, 'all').map(t => t.id)).toEqual(['a', 'a1', 'b', 'c', 'd', 'e', 'f']);
    expect(inDepartment(work, 'd3').map(t => t.id)).toEqual(['b']);
    expect(inDepartment(work, 'none').map(t => t.id)).toEqual(['c']);
  });

  it("groups the goals in progress by every department in the order given, and the orchestrator's own work last", () => {
    const sections = byDepartment(work, ['d3', 'd2', 'd9']);
    expect(sections.map(s => [s.id, s.split.open.map(g => g.task.id), s.split.closed.map(g => g.task.id)])).toEqual([
      ['d3', ['b'], []],
      ['d2', ['a'], ['e', 'd']],
      ['d9', [], []],
      ['none', ['c'], []],
    ]);
  });

  it('leaves the work that waits for its turn out of what is in progress', () => {
    const { open, closed } = inProgress(work);
    expect(open.map(g => g.task.id)).toEqual(['c', 'b', 'a']);
    expect(closed.map(g => g.task.id)).toEqual(['e', 'd']);
  });

  it('shows what is getting ready for release, what is planned, the work outside releases and what came out, by turn', () => {
    const turns = [
      turn({ id: 'u2', number: 2, status: 'closed' }),
      turn({ id: 'u3', number: 3, status: 'open' }),
      turn({ id: 'u4', number: 4, status: 'planned' }),
      turn({ id: 'u5', number: 5, status: 'open', departmentId: 'd3' }),
      turn({ id: 'u1', number: 1, status: 'closed' }),
    ];
    const sections = byRelease(work, turns);
    expect(sections.map(s => [s.kind, s.turn?.number ?? null, s.split.open.map(g => g.task.id), s.split.closed.map(g => g.task.id)])).toEqual([
      ['preparing', 3, ['a'], []],
      ['preparing', 5, ['b'], []],
      ['planned', 4, ['f'], []],
      ['outside', null, ['c'], ['d']],
      ['released', 2, [], ['e']],
    ]);
  });

  it("keeps a running turn of the shown department with nothing in it yet, and leaves out a finished one with nothing to show", () => {
    const sections = byRelease([], [turn({ id: 'u3', number: 3, status: 'open' }), turn({ id: 'u2', number: 2, status: 'closed' })]);
    expect(sections.map(s => [s.kind, s.turn?.number ?? null])).toEqual([['preparing', 3]]);
  });
});
