import { describe, expect, it } from 'vitest';
import { boardColumns, filterTasks, graphPath, graphTree, layoutTree, listGroups, mine, NODE, personWaited, pipelineTree, pruneGoals, shownDecisions, shownEmployees, waitingOn, waitingOnPeople, waitsCount, workingNow, type GraphNode } from '../src/tracker';
import type { Decisions, Employee, GoalView, Org, Pipeline, ProposalDecision, TaskLine, WaitingRequest } from '../src/types';
import { taskRoute } from './task-route';

const DEV = { id: 'd2', name: 'Development' };
const SAM = { id: 'p2', name: 'Sam' };
const LEO = { id: 'p3', name: 'Leo' };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: null };
const RITA = { id: 'b2', name: 'Rita', kind: 'worker' as const, role: null };

const task = (over: Partial<TaskLine> & { id: string; number: number }): TaskLine => ({
  echelons: taskRoute(), title: `Task ${over.number}`, brief: '', status: 'working', department: DEV, product: null, assignee: BRUNO, turn: null, parentId: null, waitsFor: [],
  createdAt: '2026-11-16T08:00:00.000Z', updatedAt: '2026-11-16T09:00:00.000Z', goal: null, responsible: SAM, why: '', dueAt: null, pipelineId: null, pipelineStageId: null, ...over,
});
const goal = (over: Partial<GoalView> & { id: string; number: number }): GoalView => ({
  title: `Goal ${over.number}`, why: '', department: DEV, parentId: null, responsible: SAM, target: null, current: null, unit: '', dueAt: null, status: 'active', progress: null, done: 0, total: 0, version: 0, ...over,
});

/* A company goal, a smaller goal of Development under it, two tasks under the smaller goal and two subtasks of the first;
   the second task waits for the first; one task serves no goal. */
const BIG = goal({ id: 'g1', number: 1, title: '500 trial sign-ups', department: null, responsible: LEO });
const SMALL = goal({ id: 'g2', number: 2, title: 'Invite people to the trial', parentId: 'g1' });
const OTHER = goal({ id: 'g3', number: 3, title: 'Accounts', status: 'dropped' });
const GOALS = [BIG, SMALL, OTHER];
const SERVES = { id: 'g2', number: 2, title: 'Invite people to the trial' };
const T312 = task({ id: 't312', number: 312, title: 'Find pilot teams', goal: SERVES, pipelineId: 'pl1', pipelineStageId: 's1' });
const S1 = task({ id: 's1t', number: 313, title: 'List from the directory', status: 'done', parentId: 't312', goal: SERVES });
const S2 = task({ id: 's2t', number: 314, title: 'List from the forum', status: 'waiting', parentId: 't312', goal: SERVES, assignee: RITA, responsible: LEO });
const T319 = task({ id: 't319', number: 319, title: 'Invite the first group', status: 'review', goal: SERVES, waitsFor: [312], pipelineId: 'pl1', pipelineStageId: 's3' });
const LOOSE = task({ id: 't500', number: 500, title: 'Tidy the inbox', status: 'open', assignee: null, pipelineId: 'pl1' });
const GONE = task({ id: 't501', number: 501, title: 'Old idea', status: 'cancelled' });
const SHIPPED = task({ id: 't502', number: 502, title: 'Box ready', status: 'done', goal: SERVES, pipelineId: 'pl1', pipelineStageId: 's3' });
const TASKS = [T312, S1, S2, T319, LOOSE, GONE, SHIPPED];

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
  it('groups the tasks by their status in tracker order, with the subtasks under their task', () => {
    const groups = listGroups(filterTasks(TASKS, {}, GOALS), id => id === 't319');
    expect(groups.map(g => g.status)).toEqual(['working', 'waitingPerson', 'notStarted', 'done']);
    expect(groups.map(g => ids(g.trees.map(tree => tree.task)))).toEqual([['t312'], ['t319'], ['t500'], ['t502']]);
    const [find] = groups[0]!.trees;
    expect(ids(find!.children.map(c => c.task))).toEqual(['s1t', 's2t']);
    expect([find!.done, find!.total]).toEqual([1, 2]);
  });

  it('counts the subtasks of a task over all the work under it, whatever the list shows', () => {
    /* Sam's own open tasks leave out the subtask done and Leo's; a status filter leaves out what does not match. */
    const own = listGroups(mine(TASKS, GOALS, 'p2').tasks, undefined, TASKS).find(g => g.status === 'working')!.trees.find(tree => tree.task.id === 't312');
    expect([own!.task.id, own!.done, own!.total]).toEqual(['t312', 1, 2]);
    const working = listGroups(filterTasks(TASKS, { status: 'working' }, GOALS), undefined, TASKS)[0]!.trees.find(tree => tree.task.id === 't312');
    expect([working!.task.id, working!.done, working!.total]).toEqual(['t312', 1, 2]);
    const card = boardColumns(mine(TASKS, GOALS, 'p2').tasks, null, { all: TASKS }).find(c => c.id === 'working')!.cards.find(c => c.task.id === 't312');
    expect(card).toMatchObject({ done: 1, total: 2 });
  });

  it('shows cancelled work only when the status filter asks for it', () => {
    expect(listGroups(filterTasks(TASKS, {}, GOALS)).some(g => g.status === 'cancelled')).toBe(false);
    expect(listGroups(filterTasks(TASKS, { status: 'cancelled' }, GOALS)).map(g => g.status)).toEqual(['cancelled']);
  });
});

describe('the board', () => {
  it('separates stopped work, and shows cancelled work only when requested', () => {
    const columns = boardColumns([...TASKS, task({ id: 't9', number: 9, status: 'blocked' })], null);
    expect(columns.map(c => c.id)).toEqual(['notStarted', 'working', 'review', 'waits', 'stopped', 'done']);
    expect(columns.map(c => ids(c.cards.map(card => card.task)))).toEqual([['t500'], ['t319', 't312'], [], [], ['t9'], ['t502']]);
    expect(boardColumns(TASKS, null, { cancelled: true }).map(c => c.id)).toEqual(['notStarted', 'working', 'review', 'waits', 'done', 'cancelled']);
    expect(boardColumns([T312, S1, S2], null, {}, () => false).find(c => c.id === 'working')!.cards[0]).toMatchObject({ done: 1, total: 2 });
    /* A bare waiting status is work in progress (task-tree.test.ts has the whole table of states). */
    expect(boardColumns([S2], null).find(c => c.id === 'working')!.cards.map(c => c.task.id)).toEqual(['s2t']);
  });

  it('with a pipeline, has its stages in tree order between Not started and Done, and only the tasks of that pipeline', () => {
    const columns = boardColumns(TASKS, PIPELINE);
    expect(columns.map(c => c.id)).toEqual(['notStarted', 's1', 's2', 's3', 'done']);
    expect(columns.map(c => ids(c.cards.map(card => card.task)))).toEqual([['t500'], ['t312'], [], ['t319'], ['t502']]);
    expect(columns[2]!.stage).toMatchObject({ name: 'Segments', depth: 1 });
  });
});

describe('the filters', () => {
  it('keeps the tasks of an executor, of a responsible person and of a goal with its smaller goals', () => {
    expect(ids(filterTasks(TASKS, { executor: 'b2' }, GOALS))).toEqual(['s2t']);
    /* Who does a task is the one who writes it, else the one who holds it now, as its card says. */
    const checked = task({ id: 't9', number: 9, assignee: BRUNO, executor: RITA });
    expect(ids(filterTasks([checked], { executor: 'b2' }, GOALS))).toEqual(['t9']);
    expect(ids(filterTasks([checked], { executor: 'b1' }, GOALS))).toEqual([]);
    expect(ids(filterTasks(TASKS, { responsible: 'p3' }, GOALS))).toEqual(['s2t']);
    expect(ids(filterTasks(TASKS, { goal: 'g1' }, GOALS))).toEqual(['t312', 's1t', 's2t', 't319', 't502']);
    expect(ids(filterTasks(TASKS, { status: 'waits' }, GOALS))).toEqual([]);
    expect(ids(filterTasks(TASKS, { status: 'waits' }, GOALS, id => id === 't319'))).toEqual(['t319']);
    expect(ids(filterTasks(TASKS, { status: 'done' }, GOALS))).toEqual(['s1t', 't502']);
    expect(ids(filterTasks(TASKS, { pipeline: 'pl1' }, GOALS))).toEqual(['t312', 't319', 't500', 't502']);
    expect(ids(filterTasks(TASKS, { department: 'none' }, GOALS))).toEqual([]);
  });

  it("finds a person's tasks and goals, only those still open", () => {
    const max = mine(TASKS, GOALS, 'p2');
    expect(ids(max.tasks)).toEqual(['t312', 't319', 't500']);
    expect(ids(max.goals)).toEqual(['g2']);
    expect(ids(mine(TASKS, GOALS, 'p3').goals)).toEqual(['g1']);
    expect(ids(mine(TASKS, GOALS, 'p3').tasks)).toEqual(['s2t']);
  });

  it('finds the tasks whose employees work on them right now', () => {
    const employee = (id: string, status: Employee['status'], taskId: string | null) => ({ id, status, task: taskId ? { id: taskId, number: 0, title: '', echelons: taskRoute() } : null }) as unknown as Employee;
    const org = { departments: [{ employees: [employee('b1', 'working', 't312'), employee('b2', 'waiting', 's2t'), employee('b3', 'working', null)] }] } as unknown as Org;
    expect(ids(workingNow(TASKS, org))).toEqual(['t312']);
    expect(workingNow(TASKS, null)).toEqual([]);
  });

  it('finds the open tasks that wait for a person, and none that wait for an agent or are over', () => {
    const since = '2026-11-16T08:00:00.000Z';
    const waits = (over: Partial<TaskLine> & { id: string; number: number }, who: { kind: 'person' | 'agent'; id: string } | null) =>
      task({ ...over, time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: who?.kind === 'person' ? 'person' : 'review', who: who && { ...who, name: '' }, reason: null, since }] } });
    const tasks = [waits({ id: 'a', number: 1, status: 'waiting' }, { kind: 'person', id: 'p3' }), waits({ id: 'b', number: 2 }, { kind: 'agent', id: 'p3' }), waits({ id: 'c', number: 3, status: 'done' }, { kind: 'person', id: 'p3' }), waits({ id: 'd', number: 4 }, null), ...TASKS];
    expect(ids(waitingOn(tasks, 'p3'))).toEqual(['a']);
  });
});

describe('the left panel', () => {
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
    expect(titles(graphTree({}, GOALS, TASKS))).toEqual([['g1', [['g2', [['t312', [['s1t'], ['s2t']]], ['t319'], ['t502']]]]], ['loose', [['t500'], ['t501']]]]);
  });

  it("puts a task whose goal is not drawn with the tasks outside the goals, so no task of the place goes missing", () => {
    const company = task({ id: 't600', number: 600, goal: { id: 'g1', number: 1, title: '500 trial sign-ups' } });
    const dropped = task({ id: 't601', number: 601, goal: { id: 'g3', number: 3, title: 'Accounts' } });
    expect(titles(graphTree({ department: 'd2' }, GOALS, [T312, company, dropped]))).toEqual([['g2', [['t312']]], ['loose', [['t600'], ['t601']]]]);
    expect(titles(graphTree({}, GOALS, [company, dropped]))).toEqual([['g1', [['g2'], ['t600']]], ['loose', [['t601']]]]);
  });

  it("grows from one goal, from a department's goals, and from one task", () => {
    expect(titles(graphTree({ goal: 'g2' }, GOALS, TASKS))).toEqual([['g2', [['t312', [['s1t'], ['s2t']]], ['t319'], ['t502']]]]);
    expect(titles(graphTree({ department: 'd2' }, GOALS, [T312]))).toEqual([['g2', [['t312']]]]);
    expect(titles(graphTree({ task: 't312' }, GOALS, TASKS))).toEqual([['t312', [['s1t'], ['s2t']]]]);
  });

  it('keeps a goal in the tree only when work of those shown is under it, or when it is asked to stay', () => {
    expect(titles(pruneGoals(graphTree({}, GOALS, [LOOSE]), () => false))).toEqual([['loose', [['t500']]]]);
    expect(titles(pruneGoals(graphTree({}, GOALS, [S2]), () => false))).toEqual([['g1', [['g2', [['s2t']]]]]]);
    expect(titles(pruneGoals(graphTree({}, GOALS, []), g => g.id === 'g1'))).toEqual([['g1']]);
  });

  it('places each level further along and each leaf on its own row, with solid lines for parts and dashed ones for waits', () => {
    const layout = layoutTree(graphTree({ goal: 'g2' }, GOALS, TASKS));
    const at = (id: string) => layout.nodes.find(n => n.node.id === id)!;
    expect([at('g2').depth, at('t312').depth, at('s1t').depth]).toEqual([0, 1, 2]);
    expect(at('s2t').x - at('s1t').x).toBe(0);
    expect(at('s2t').y - at('s1t').y).toBe(NODE.dy);
    expect(at('t312').y).toBe((at('s1t').y + at('s2t').y) / 2);
    expect(layout.parts).toContainEqual({ from: 'g2', to: 't312' });
    expect(layout.parts).toContainEqual({ from: 't312', to: 's2t' });
    expect(layout.waits).toEqual([{ from: 't319', to: 't312' }]);
    expect(layout.width).toBeGreaterThanOrEqual(at('s1t').x + NODE.w);
    expect(layout.height).toBeGreaterThanOrEqual(Math.max(...layout.nodes.map(n => n.y)) + NODE.h);
  });

  it('gives a node the height its words take, moves the rows under it down and keeps its parent in the middle', () => {
    const tall = new Map([['s1t', 100]]);
    const layout = layoutTree(graphTree({ goal: 'g2' }, GOALS, TASKS), id => tall.get(id));
    const at = (id: string) => layout.nodes.find(n => n.node.id === id)!;
    expect(at('s1t').h).toBe(100);
    expect(at('s2t').h).toBe(NODE.h);
    expect(at('s2t').y - at('s1t').y).toBe(100 + NODE.dy - NODE.h);
    expect(at('t312').y + at('t312').h / 2).toBe((at('s1t').y + at('s1t').h / 2 + at('s2t').y + at('s2t').h / 2) / 2);
    expect(layout.height).toBeGreaterThanOrEqual(Math.max(...layout.nodes.map(n => n.y + n.h)));
  });

  it('leads back from a task to its goals and the tasks above it', () => {
    expect(graphPath({ task: 's2t' }, GOALS, TASKS).map(c => c.id)).toEqual(['g1', 'g2', 't312', 's2t']);
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

/* Sam, the CEO, looks. Max is asked by name on task 312 and only he answers; Sam is asked by name on task 319; the question on
   task 314 is for anyone, Leo's as his department's, and Sam may take it too. The orchestrator's card and the merge are
   Sam's. */
describe('what waits for people', () => {
  const MAX = 'p9';
  const BY_NAME = { kind: 'named_person' as const, department: null };
  const asked = (id: string, on: TaskLine, over: Partial<WaitingRequest>): WaitingRequest => ({
    id, kind: 'question', text: 'Which way?', commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false,
    at: '2026-11-16T08:00:00.000Z', agent: { id: BRUNO.id, name: BRUNO.name }, task: { id: on.id, number: on.number, title: on.title, department: DEV },
    ownerPersonId: SAM.id, canAnswer: true, ...over,
  });
  const FOR_MAX = asked('r1', T312, { ownerPersonId: MAX, canAnswer: false, decidedBy: BY_NAME });
  const FOR_SAM = asked('r2', T319, { decidedBy: BY_NAME });
  const FOR_ANYONE = asked('r3', S2, { ownerPersonId: LEO.id, decidedBy: { kind: 'department_and_ceo', department: DEV } });
  const CARD = { id: 'pr1', kind: 'structure', agent: { id: 'a1', name: 'Orchestrator' }, department: null, brief: '', items: [], at: '2026-11-16T08:00:00.000Z', ownerPersonId: SAM.id, canAnswer: true } as ProposalDecision;
  const MERGE = { id: 'm1', label: 'the database', after: null, open: 1, ownerPersonId: SAM.id };
  const DECISIONS: Decisions = { requests: [FOR_MAX, FOR_SAM, FOR_ANYONE], proposals: [CARD], merges: [MERGE], counts: { byPerson: {}, byAgent: {}, total: 5 } };
  const requested = (d: { requests: WaitingRequest[] }) => d.requests.map(r => r.id);

  it("leaves a question asked of another person by name out of the viewer's own decisions, and keeps the rest as they were", () => {
    const own = shownDecisions(DECISIONS, { viewer: SAM.id });
    expect(requested(own)).toEqual(['r2', 'r3']);
    expect(own.proposals).toEqual([CARD]);
    expect(own.merges).toEqual([MERGE]);
  });

  it("keeps a question asked of a person by name in that person's decisions, and only theirs", () => {
    expect(requested(shownDecisions(DECISIONS, { person: MAX }))).toEqual(['r1']);
    expect(shownDecisions(DECISIONS, { person: MAX }).proposals).toEqual([]);
    expect(requested(shownDecisions(DECISIONS, { person: LEO.id }))).toEqual(['r3']);
  });

  it("keeps a question asked of the viewer by name in their own decisions, also when another person looks at the company's", () => {
    expect(requested(shownDecisions(DECISIONS, { viewer: MAX }))).toEqual(['r1', 'r3']);
  });

  it('gives everything the viewer sees for the company', () => {
    const all = shownDecisions(DECISIONS, 'everyone');
    expect(requested(all)).toEqual(['r1', 'r2', 'r3']);
    expect(all.proposals).toEqual([CARD]);
    expect(all.merges).toEqual([MERGE]);
  });

  it('gives nothing before the first answer, and takes a server without merges', () => {
    expect(shownDecisions(undefined, 'everyone')).toEqual({ requests: [], proposals: [], merges: [] });
    const { merges: _, ...older } = DECISIONS;
    expect(shownDecisions(older, 'everyone').merges).toEqual([]);
  });

  it('counts a task with a question once, with the tasks that wait, the cards and the merges', () => {
    const own = shownDecisions(DECISIONS, { viewer: SAM.id });
    expect(waitsCount(own, [], [])).toBe(4);
    expect(waitsCount(own, [T319, LOOSE], [{ id: 'c1' }])).toBe(6);
    expect(waitsCount(shownDecisions(DECISIONS, 'everyone'), [], [])).toBe(5);
  });

  it('finds the open tasks that wait for any person, and the first person each waits for', () => {
    const since = '2026-11-16T08:00:00.000Z';
    const waits = (over: Partial<TaskLine> & { id: string; number: number }, ...who: ({ kind: 'person' | 'agent'; id: string } | null)[]) =>
      task({ ...over, time: { inStatusSince: since, workSeconds: 0, waitsOn: who.map(w => ({ kind: w?.kind === 'person' ? 'person' as const : 'review' as const, who: w && { ...w, name: '' }, reason: null, since })) } });
    const external = task({ id: 'e', number: 5, time: { inStatusSince: since, workSeconds: 0, waitsOn: [{ kind: 'external', who: null, reason: 'Deployment', since }, { kind: 'person', who: { kind: 'person', id: LEO.id, name: LEO.name }, reason: null, since }] } });
    const tasks = [waits({ id: 'a', number: 1, status: 'waiting' }, { kind: 'person', id: 'p3' }), waits({ id: 'b', number: 2 }, { kind: 'agent', id: 'p3' }), waits({ id: 'c', number: 3, status: 'done' }, { kind: 'person', id: 'p3' }),
      waits({ id: 'd', number: 4 }, null), waits({ id: 'p', number: 6, paused: { at: since, reason: 'Holiday', root: 'p' } }, { kind: 'person', id: 'p3' }), external, ...TASKS];
    expect(ids(waitingOnPeople(tasks))).toEqual(['a', 'e']);
    expect(personWaited(external)).toBe(LEO.id);
    expect(personWaited(T312)).toBeUndefined();
  });
});
