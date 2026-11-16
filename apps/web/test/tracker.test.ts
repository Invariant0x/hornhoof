import { describe, expect, it } from 'vitest';
import { boardColumns, filterTasks, graphPath, graphTree, layoutTree, listGroups, mine, NODE, pipelineTree, responsibles, shownEmployees, workingNow, type GraphNode } from '../src/tracker';
import type { Employee, GoalView, Org, Pipeline, TaskLine } from '../src/types';
import { taskRoute } from './task-route';

const DEV = { id: 'd2', name: 'Development' };
const MAX = { id: 'p2', name: 'Max' };
const LUISA = { id: 'p3', name: 'Luisa' };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: null };
const RITA = { id: 'b2', name: 'Rita', kind: 'worker' as const, role: null };

const task = (over: Partial<TaskLine> & { id: string; number: number }): TaskLine => ({
  echelons: taskRoute(), title: `Task ${over.number}`, brief: '', status: 'working', department: DEV, product: null, assignee: BRUNO, turn: null, parentId: null, waitsFor: [],
  createdAt: '2026-11-16T08:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z', goal: null, responsible: MAX, why: '', dueAt: null, pipelineId: null, pipelineStageId: null, ...over,
});
const goal = (over: Partial<GoalView> & { id: string; number: number }): GoalView => ({
  title: `Goal ${over.number}`, why: '', department: DEV, parentId: null, responsible: MAX, target: null, current: null, unit: '', dueAt: null, status: 'active', progress: null, done: 0, total: 0, version: 0, ...over,
});

/* A company goal, a smaller goal of Development under it, two tasks under the smaller goal and two subtasks of the first;
   the second task waits for the first; one task serves no goal. */
const BIG = goal({ id: 'g1', number: 1, title: '500 subscribers', department: null, responsible: LUISA });
const SMALL = goal({ id: 'g2', number: 2, title: 'Mailing from kate@', parentId: 'g1' });
const OTHER = goal({ id: 'g3', number: 3, title: 'Accounts', status: 'dropped' });
const GOALS = [BIG, SMALL, OTHER];
const SERVES = { id: 'g2', number: 2, title: 'Mailing from kate@' };
const T412 = task({ id: 't412', number: 412, title: 'Find 3D artists', goal: SERVES, pipelineId: 'pl1', pipelineStageId: 's1' });
const S1 = task({ id: 's1t', number: 413, title: 'List from Behance', status: 'done', parentId: 't412', goal: SERVES });
const S2 = task({ id: 's2t', number: 414, title: 'List from ArtStation', status: 'waiting', parentId: 't412', goal: SERVES, assignee: RITA, responsible: LUISA });
const T419 = task({ id: 't419', number: 419, title: 'First wave of letters', status: 'review', goal: SERVES, waitsFor: [412], pipelineId: 'pl1', pipelineStageId: 's3' });
const LOOSE = task({ id: 't500', number: 500, title: 'Tidy the inbox', status: 'open', assignee: null, pipelineId: 'pl1' });
const GONE = task({ id: 't501', number: 501, title: 'Old idea', status: 'cancelled' });
const SHIPPED = task({ id: 't502', number: 502, title: 'Box ready', status: 'done', goal: SERVES, pipelineId: 'pl1', pipelineStageId: 's3' });
const TASKS = [T412, S1, S2, T419, LOOSE, GONE, SHIPPED];

/* A pipeline with a fork: Search, then Segments and Check side by side. */
const PIPELINE: Pipeline = {
  id: 'pl1', department: DEV, name: 'Mailing', why: '', archived: false, version: 0,
  stages: [
    { id: 's1', parentId: null, name: 'Search', ownerRole: 'MKT-RES', owner: null, position: 0 },
    { id: 's2', parentId: 's1', name: 'Segments', ownerRole: 'MKT-SEG', owner: null, position: 0 },
    { id: 's3', parentId: 's1', name: 'Check', ownerRole: 'MKT-BRAND', owner: null, position: 1 },
  ],
};

const ids = (tasks: { id: string }[]) => tasks.map(t => t.id);
const titles = (nodes: GraphNode[]): unknown[] => nodes.map(n => [n.id, ...(n.children.length ? [titles(n.children)] : [])]);

describe('the list', () => {
  it('groups the tasks by their status in words, what needs people first, with the subtasks under their task', () => {
    const groups = listGroups(filterTasks(TASKS, {}, GOALS), id => id === 't419');
    expect(groups.map(g => g.status)).toEqual(['waitingYou', 'working', 'notStarted', 'done']);
    expect(groups.map(g => ids(g.trees.map(tree => tree.task)))).toEqual([['t419'], ['t412'], ['t500'], ['t502']]);
    const [find] = groups[1]!.trees;
    expect(ids(find!.children.map(c => c.task))).toEqual(['s1t', 's2t']);
    expect([find!.done, find!.total]).toEqual([1, 2]);
  });

  it('shows cancelled work only when the status filter asks for it', () => {
    expect(listGroups(filterTasks(TASKS, {}, GOALS)).some(g => g.status === 'cancelled')).toBe(false);
    expect(listGroups(filterTasks(TASKS, { status: 'cancelled' }, GOALS)).map(g => g.status)).toEqual(['cancelled']);
  });
});

describe('the board', () => {
  it('puts the tasks into the status columns, waits for a person among the waits, and cancelled ones only under the filter', () => {
    const columns = boardColumns([...TASKS, task({ id: 't9', number: 9, status: 'blocked' })], null);
    expect(columns.map(c => c.id)).toEqual(['notStarted', 'working', 'review', 'waits', 'done']);
    expect(columns.map(c => ids(c.cards.map(card => card.task)))).toEqual([['t500'], ['t412'], ['t419'], ['t9'], ['t502']]);
    expect(boardColumns(TASKS, null, { cancelled: true }).map(c => c.id)).toEqual(['notStarted', 'working', 'review', 'waits', 'done', 'cancelled']);
    expect(boardColumns([T412, S1, S2], null, {}, () => false).find(c => c.id === 'working')!.cards[0]).toMatchObject({ done: 1, total: 2 });
  });

  it('puts a waiting subtask in the waits column when its task is not among those shown', () => {
    const columns = boardColumns([S2], null);
    expect(columns.find(c => c.id === 'waits')!.cards.map(c => c.task.id)).toEqual(['s2t']);
  });

  it('with a pipeline, has its stages in tree order between Not started and Done, and only the tasks of that pipeline', () => {
    const columns = boardColumns(TASKS, PIPELINE);
    expect(columns.map(c => c.id)).toEqual(['notStarted', 's1', 's2', 's3', 'done']);
    expect(columns.map(c => ids(c.cards.map(card => card.task)))).toEqual([['t500'], ['t412'], [], ['t419'], ['t502']]);
    expect(columns[2]!.stage).toMatchObject({ name: 'Segments', depth: 1 });
  });
});

describe('the filters', () => {
  it('keeps the tasks of an executor, of a responsible person and of a goal with its smaller goals', () => {
    expect(ids(filterTasks(TASKS, { executor: 'b2' }, GOALS))).toEqual(['s2t']);
    expect(ids(filterTasks(TASKS, { responsible: 'p3' }, GOALS))).toEqual(['s2t']);
    expect(ids(filterTasks(TASKS, { goal: 'g1' }, GOALS))).toEqual(['t412', 's1t', 's2t', 't419', 't502']);
    expect(ids(filterTasks(TASKS, { status: 'waits' }, GOALS))).toEqual(['s2t']);
    expect(ids(filterTasks(TASKS, { status: 'done' }, GOALS))).toEqual(['s1t', 't502']);
    expect(ids(filterTasks(TASKS, { pipeline: 'pl1' }, GOALS))).toEqual(['t412', 't419', 't500', 't502']);
    expect(ids(filterTasks(TASKS, { department: 'none' }, GOALS))).toEqual([]);
  });

  it("finds a person's tasks and goals, only those still open", () => {
    const max = mine(TASKS, GOALS, 'p2');
    expect(ids(max.tasks)).toEqual(['t412', 't419', 't500']);
    expect(ids(max.goals)).toEqual(['g2']);
    expect(ids(mine(TASKS, GOALS, 'p3').goals)).toEqual(['g1']);
    expect(ids(mine(TASKS, GOALS, 'p3').tasks)).toEqual(['s2t']);
  });

  it('finds the tasks whose employees work on them right now', () => {
    const employee = (id: string, status: Employee['status'], taskId: string | null) => ({ id, status, task: taskId ? { id: taskId, number: 0, title: '', echelons: taskRoute() } : null }) as unknown as Employee;
    const org = { departments: [{ employees: [employee('b1', 'working', 't412'), employee('b2', 'waiting', 's2t'), employee('b3', 'working', null)] }] } as unknown as Org;
    expect(ids(workingNow(TASKS, org))).toEqual(['t412']);
    expect(workingNow(TASKS, null)).toEqual([]);
  });
});

describe('the left panel', () => {
  it('names who answers for the departments and goals, with their departments and how many open tasks they hold', () => {
    const departments = [{ id: 'd2', name: 'Development', responsible: MAX }, { id: 'd3', name: 'Sales', responsible: LUISA }];
    expect(responsibles(departments, GOALS, TASKS)).toEqual([
      { person: MAX, departments: ['d2'], open: 3 },
      { person: LUISA, departments: ['d3'], open: 1 },
    ]);
  });

  it('shows the employees at work first and folds the rest, keeping a few in sight', () => {
    const e = (id: string, status: Employee['status']) => ({ id, status }) as Employee;
    const { shown, more } = shownEmployees([e('a', 'idle'), e('b', 'working'), e('c', 'waiting'), e('d', 'idle'), e('e', 'working')], 3);
    expect(ids(shown)).toEqual(['b', 'e', 'a']);
    expect(ids(more)).toEqual(['c', 'd']);
    const busy = shownEmployees([e('a', 'working'), e('b', 'working'), e('c', 'working'), e('d', 'working')], 3);
    expect([busy.shown.length, busy.more.length]).toEqual([4, 0]);
  });
});

describe('the graph', () => {
  it('grows from every goal: a goal, its smaller goals, their tasks and subtasks, and the tasks with no goal apart', () => {
    expect(titles(graphTree({}, GOALS, TASKS))).toEqual([['g1', [['g2', [['t412', [['s1t'], ['s2t']]], ['t419'], ['t502']]]]], ['loose', [['t500'], ['t501']]]]);
  });

  it("grows from one goal, from a department's goals, and from one task", () => {
    expect(titles(graphTree({ goal: 'g2' }, GOALS, TASKS))).toEqual([['g2', [['t412', [['s1t'], ['s2t']]], ['t419'], ['t502']]]]);
    expect(titles(graphTree({ department: 'd2' }, GOALS, [T412]))).toEqual([['g2', [['t412']]]]);
    expect(titles(graphTree({ task: 't412' }, GOALS, TASKS))).toEqual([['t412', [['s1t'], ['s2t']]]]);
  });

  it('places each level further along and each leaf on its own row, with solid lines for parts and dashed ones for waits', () => {
    const layout = layoutTree(graphTree({ goal: 'g2' }, GOALS, TASKS));
    const at = (id: string) => layout.nodes.find(n => n.node.id === id)!;
    expect([at('g2').depth, at('t412').depth, at('s1t').depth]).toEqual([0, 1, 2]);
    expect(at('s2t').x - at('s1t').x).toBe(0);
    expect(at('s2t').y - at('s1t').y).toBe(NODE.dy);
    expect(at('t412').y).toBe((at('s1t').y + at('s2t').y) / 2);
    expect(layout.parts).toContainEqual({ from: 'g2', to: 't412' });
    expect(layout.parts).toContainEqual({ from: 't412', to: 's2t' });
    expect(layout.waits).toEqual([{ from: 't419', to: 't412' }]);
    expect(layout.width).toBeGreaterThanOrEqual(at('s1t').x + NODE.w);
    expect(layout.height).toBeGreaterThanOrEqual(Math.max(...layout.nodes.map(n => n.y)) + NODE.h);
  });

  it('leads back from a task to its goals and the tasks above it', () => {
    expect(graphPath({ task: 's2t' }, GOALS, TASKS).map(c => c.id)).toEqual(['g1', 'g2', 't412', 's2t']);
    expect(graphPath({ goal: 'g2' }, GOALS, TASKS).map(c => c.id)).toEqual(['g1', 'g2']);
    expect(graphPath({}, GOALS, TASKS)).toEqual([]);
  });

  it("draws a pipeline's stages with the number of open tasks on each", () => {
    const [root] = pipelineTree(PIPELINE, TASKS);
    expect(titles([root!])).toEqual([['pl1', [['s1', [['s2'], ['s3']]]]]]);
    const count = (node: GraphNode): Record<string, number> => ({ ...(node.kind === 'stage' || node.kind === 'pipeline' ? { [node.id]: node.count } : {}), ...Object.assign({}, ...node.children.map(count)) });
    expect(count(root!)).toEqual({ pl1: 3, s1: 1, s2: 0, s3: 1 });
  });
});
