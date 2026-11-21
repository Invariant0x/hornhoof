import { TASK_PRIORITIES } from '@hornhoof/protocol';
import { isPersonWait } from '@hornhoof/protocol/waits';
import { humanStatus, isClosed, taskTrees, taskWaits, type Asks, type HumanStatus, type TaskTree } from './task-tree';
import type { Decisions, Employee, GoalView, MergeDecision, Org, Pipeline, PipelineStage, TaskLine } from './types';

/* Ways to look at the same work. */
export const TRACKER_VIEWS = ['list', 'board', 'graph'] as const;
export type TrackerView = (typeof TRACKER_VIEWS)[number];

/* The state columns and the status filter use the same groups. */
export const BOARD_STATUSES = ['notStarted', 'working', 'review', 'waits', 'failure', 'stopped', 'paused', 'done', 'cancelled'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export function boardStatus(task: TaskLine, asksYou = false): BoardStatus {
  const status = humanStatus(task, asksYou);
  return status === 'waiting' || status === 'waitingYou' ? 'waits' : status;
}

type ListStatus = Exclude<HumanStatus, 'waiting' | 'waitingYou'> | 'waitingPerson';
const LIST_ORDER: ListStatus[] = ['working', 'review', 'waitingPerson', 'failure', 'stopped', 'notStarted', 'paused', 'done', 'cancelled'];

function listStatus(task: TaskLine, asksYou = false): ListStatus {
  const status = humanStatus(task, asksYou);
  return status === 'waiting' || status === 'waitingYou' ? 'waitingPerson' : status;
}
export const priorityOf = (task: TaskLine) => task.priority ?? 'normal';
const byPriority = (a: TaskTree, b: TaskTree) => TASK_PRIORITIES.indexOf(priorityOf(a.task)) - TASK_PRIORITIES.indexOf(priorityOf(b.task)) || newestFirst(a, b);
const newestFirst = (a: TaskTree, b: TaskTree) => b.task.number - a.task.number;

export type ListGroup = { status: ListStatus; trees: TaskTree[] };

/* Failures stay visible even when the task containing them is folded. */
function surfaced(nodes: TaskTree[], asksYou?: Asks): TaskTree[] {
  const failed = (tree: TaskTree) => boardStatus(tree.task, asksYou?.(tree.task.id)) === 'failure';
  const find = (tree: TaskTree): TaskTree[] => failed(tree) ? [tree] : tree.children.flatMap(find);
  return [...nodes, ...nodes.filter(tree => !failed(tree)).flatMap(tree => tree.children.flatMap(find))];
}

/* The tasks at the top of those given, by their status in words, each with its subtasks under it. all: the work the
   subtasks are counted over, when those given are only part of it. */
export function listGroups(tasks: TaskLine[], asksYou?: Asks, all: TaskLine[] = tasks): ListGroup[] {
  const top = surfaced(taskTrees(tasks, all), asksYou);
  return LIST_ORDER.map(status => ({ status, trees: top.filter(tree => listStatus(tree.task, asksYou?.(tree.task.id) ?? false) === status).sort(byPriority) })).filter(g => g.trees.length > 0);
}

/* A stage with how deep it stands in its pipeline's tree. */
export type StageColumn = PipelineStage & { depth: number };
export type BoardColumn = { id: string; status?: BoardStatus; stage?: StageColumn; cards: TaskTree[] };

/* Stages depth first, each level by its position, as the server keeps them. */
export function stagesInOrder(stages: PipelineStage[]): StageColumn[] {
  const walk = (parent: string | null, depth: number): StageColumn[] =>
    stages.filter(s => s.parentId === parent).sort((a, b) => a.position - b.position).flatMap(s => [{ ...s, depth }, ...walk(s.id, depth + 1)]);
  return walk(null, 0);
}

/* The status board: one column per status, the tasks at the top of those given as cards with their subtasks counted over
   all, and cancelled ones only when asked. With a pipeline: its tasks, those nobody holds yet under Not started, then a
   column per stage in tree order, then what is over. */
export function boardColumns(tasks: TaskLine[], pipeline: Pipeline | null, opts: { cancelled?: boolean; all?: TaskLine[] } = {}, asksYou?: Asks): BoardColumn[] {
  const asks = (task: TaskLine) => asksYou?.(task.id) ?? false;
  const ends: BoardStatus[] = opts.cancelled ? ['done', 'cancelled'] : ['done'];
  if (!pipeline) {
    const cards = surfaced(taskTrees(tasks, opts.all), asksYou);
    return BOARD_STATUSES.filter(s => s !== 'cancelled' || opts.cancelled)
      .map(status => ({ id: status, status, cards: cards.filter(c => boardStatus(c.task, asks(c.task)) === status).sort(newestFirst) }))
      .filter(({ status, cards }) => cards.length > 0 || !['failure', 'stopped', 'paused'].includes(status));
  }
  const under = new Map<string, TaskTree>();
  const index = (nodes: TaskTree[]) => nodes.forEach(n => { under.set(n.task.id, n); index(n.children); });
  index(taskTrees(tasks, opts.all));
  const cards = tasks.filter(t => t.pipelineId === pipeline.id).map(t => under.get(t.id)!).sort(newestFirst);
  const stages = stagesInOrder(pipeline.stages);
  const known = new Set(stages.map(s => s.id));
  const open = cards.filter(c => !isClosed(c.task));
  const failed = open.filter(c => boardStatus(c.task, asks(c.task)) === 'failure');
  const inStages = open.filter(c => !failed.includes(c));
  return [
    { id: 'notStarted', status: 'notStarted', cards: inStages.filter(c => !c.task.pipelineStageId || !known.has(c.task.pipelineStageId)) },
    ...stages.map(stage => ({ id: stage.id, stage, cards: inStages.filter(c => c.task.pipelineStageId === stage.id) })),
    ...(failed.length ? [{ id: 'failure', status: 'failure' as const, cards: failed }] : []),
    ...ends.map(status => ({ id: status, status, cards: cards.filter(c => c.task.status === (status === 'done' ? 'done' : 'cancelled')) })),
  ];
}

/* What narrows the work shown: a status, who does it now, who answers for it, a goal with its smaller goals, a department
   (none: the orchestrator's own), a product and a pipeline. Cancelled work shows only when the status asks for it. */
export type WorkFilter = { status?: BoardStatus | null; executor?: string | null; responsible?: string | null; goal?: string | null; department?: string | null; product?: string | null; pipeline?: string | null };

/* A goal and every smaller goal under it, at any depth. */
export function goalsUnder(id: string, goals: GoalView[]): Set<string> {
  const found = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of goals) if (g.parentId && found.has(g.parentId) && !found.has(g.id)) grew = !!found.add(g.id);
  }
  return found;
}

/* Who does a task: the employee who writes it, else the one who holds it now. */
export const doerOf = (task: Partial<Pick<TaskLine, 'executor' | 'assignee'>>) => task.executor ?? task.assignee;

export function filterTasks(tasks: TaskLine[], f: WorkFilter, goals: GoalView[], asksYou?: Asks): TaskLine[] {
  const served = f.goal ? goalsUnder(f.goal, goals) : null;
  return tasks.filter(task => {
    if (f.status ? boardStatus(task, asksYou?.(task.id) ?? false) !== f.status : task.status === 'cancelled') return false;
    if (f.executor && doerOf(task)?.id !== f.executor) return false;
    if (f.responsible && task.responsible?.id !== f.responsible) return false;
    if (served && !(task.goal && served.has(task.goal.id))) return false;
    if (f.department && (task.department?.id ?? 'none') !== f.department) return false;
    if (f.product && task.product?.id !== f.product) return false;
    return !f.pipeline || (task.pipelineId ?? 'none') === f.pipeline;
  });
}

/* What a person answers for and is not over yet: their goals and their tasks. */
export function mine(tasks: TaskLine[], goals: GoalView[], personId: string): { goals: GoalView[]; tasks: TaskLine[] } {
  return { goals: goals.filter(g => g.status === 'active' && g.responsible.id === personId), tasks: tasks.filter(t => !isClosed(t) && t.responsible?.id === personId) };
}

/* The tasks an employee works on at this moment. */
export function workingNow(tasks: TaskLine[], org: Org | null): TaskLine[] {
  const held = new Set((org?.departments ?? []).flatMap(d => d.employees.filter(e => e.status === 'working' && e.task).map(e => e.task!.id)));
  return tasks.filter(t => held.has(t.id));
}

/* The open tasks that wait for a person's answer or work. */
export const isWaitForPerson = (wait: NonNullable<TaskLine['time']>['waitsOn'][number], personId: string): boolean =>
  isPersonWait(wait) && wait.who?.kind === 'person' && wait.who.id === personId;

export function waitingOn(tasks: TaskLine[], personId: string): TaskLine[] {
  return tasks.filter(t => !t.paused && taskWaits(t).some(w => isWaitForPerson(w, personId)));
}

/* The first person an open task waits for, if any. */
export const personWaited = (task: TaskLine): string | undefined =>
  taskWaits(task).find(w => isPersonWait(w) && w.who?.kind === 'person')?.who?.id;

/* The open tasks that wait for any person. */
export const waitingOnPeople = (tasks: TaskLine[]): TaskLine[] => tasks.filter(t => !t.paused && personWaited(t) !== undefined);

/* Open requests have their own cards and a server-checked right to answer. Their task summaries should never stand in for
   those cards, even while the task list catches up with an answer or an older server does not mark request waits. */
export function withoutRequestWaits(tasks: TaskLine[], decisions?: Decisions): TaskLine[] {
  const withCards = new Set(decisions?.requests?.map(request => request.task.id));
  return tasks.map(task => {
    const time = task.time;
    if (!time) return task;
    const hasCard = withCards.has(task.id);
    const waitsOn = time.waitsOn.filter(wait => !wait.request && !(hasCard && isPersonWait(wait) && wait.event !== 'ceo'));
    return waitsOn.length === time.waitsOn.length ? task : { ...task, time: { ...time, waitsOn } };
  });
}

/* Whose decisions a list shows: one person's; the viewer's own, without a question asked of another person by name, which
   only that person answers; or everything the viewer sees in the company. */
export type DecisionsOf = { person: string } | 'viewer' | 'everyone';
export type ShownDecisions = Pick<Decisions, 'requests' | 'proposals'> & { merges: MergeDecision[] };

const isOf = (owner: string, whose: DecisionsOf, canAnswer: boolean) =>
  whose === 'everyone' || (whose === 'viewer' ? canAnswer : owner === whose.person);

/* What of the decisions a list shows; nothing before the first answer. */
export function shownDecisions(decisions: Decisions | undefined, whose: DecisionsOf): ShownDecisions {
  if (!decisions) return { requests: [], proposals: [], merges: [] };
  const theirs = <T extends { ownerPersonId: string; canAnswer: boolean }>(items: T[]) => items.filter(d => isOf(d.ownerPersonId, whose, d.canAnswer));
  return { requests: theirs(decisions.requests ?? []), proposals: theirs(decisions.proposals ?? []), merges: (decisions.merges ?? []).filter(d => isOf(d.ownerPersonId, whose, true)) };
}

/* What a list of what waits shows, counted: a task with a question once, alongside decisions that have no task and the cards
   Hornhoof kept. */
export function waitsCount(s: ShownDecisions, tasks: TaskLine[], cards: readonly { id: string }[]): number {
  const represented = new Set(s.requests.map(r => r.task.id));
  return s.requests.length + tasks.filter(task => !represented.has(task.id)).length + s.proposals.length + s.merges.length + cards.length;
}

/* A department's employees for the left panel: those at work first, then the rest, at least so many in sight. */
export function shownEmployees<E extends Pick<Employee, 'status'>>(employees: E[], least: number): { shown: E[]; more: E[] } {
  const ordered = [...employees.filter(e => e.status === 'working'), ...employees.filter(e => e.status !== 'working')];
  const count = Math.max(least, employees.filter(e => e.status === 'working').length);
  return { shown: ordered.slice(0, count), more: ordered.slice(count) };
}

/* Where the graph grows from: one task, one goal, every goal of a department, or every goal of the company. */
export type GraphRoot = { task?: string | null; goal?: string | null; department?: string | null };
export type GraphNode =
  | { kind: 'goal'; id: string; goal: GoalView; children: GraphNode[] }
  | { kind: 'task'; id: string; task: TaskLine; children: GraphNode[] }
  | { kind: 'loose'; id: 'loose'; children: GraphNode[] }
  | { kind: 'pipeline'; id: string; pipeline: Pipeline; count: number; children: GraphNode[] }
  | { kind: 'stage'; id: string; stage: PipelineStage; count: number; children: GraphNode[] };

const byNumber = <T extends { number: number }>(a: T, b: T) => a.number - b.number;

export function graphTree(root: GraphRoot, goals: GoalView[], tasks: TaskLine[]): GraphNode[] {
  const ids = new Set(tasks.map(t => t.id));
  const top = (t: TaskLine) => !t.parentId || !ids.has(t.parentId);
  const taskNode = (task: TaskLine): GraphNode => ({ kind: 'task', id: task.id, task, children: tasks.filter(t => t.parentId === task.id).sort(byNumber).map(taskNode) });
  const shown = goals.filter(g => g.status !== 'dropped');
  const goalNode = (goal: GoalView): GraphNode => ({
    kind: 'goal', id: goal.id, goal,
    children: [...shown.filter(g => g.parentId === goal.id).sort(byNumber).map(goalNode), ...tasks.filter(t => top(t) && t.goal?.id === goal.id).sort(byNumber).map(taskNode)],
  });
  if (root.task) {
    const task = tasks.find(t => t.id === root.task);
    return task ? [taskNode(task)] : [];
  }
  if (root.goal) {
    const goal = goals.find(g => g.id === root.goal);
    return goal ? [goalNode(goal)] : [];
  }
  const place = root.department ? shown.filter(g => g.department?.id === root.department) : shown;
  const inPlace = new Set(place.map(g => g.id));
  const roots = place.filter(g => !g.parentId || !inPlace.has(g.parentId)).sort(byNumber).map(goalNode);
  /* A task whose goal is not drawn, of another place or dropped, stands with those that serve none. */
  const drawn = new Set<string>();
  const mark = (node: GraphNode) => { if (node.kind === 'goal') drawn.add(node.id); node.children.forEach(mark); };
  roots.forEach(mark);
  const loose = tasks.filter(t => top(t) && !(t.goal && drawn.has(t.goal.id))).sort(byNumber).map(taskNode);
  return [...roots, ...(loose.length ? [{ kind: 'loose' as const, id: 'loose' as const, children: loose }] : [])];
}

/* The tree without the goals that hold none of the work shown, at any depth, but for those asked to stay. */
export function pruneGoals(forest: GraphNode[], keep: (goal: GoalView) => boolean): GraphNode[] {
  return forest.flatMap(node => {
    const children = pruneGoals(node.children, keep);
    if (node.kind === 'goal' && !children.length && !keep(node.goal)) return [];
    return [{ ...node, children }];
  });
}

/* A pipeline's stages as a tree under its name, each with the open tasks that stand on it. */
export function pipelineTree(pipeline: Pipeline, tasks: TaskLine[]): GraphNode[] {
  const on = tasks.filter(t => t.pipelineId === pipeline.id && !isClosed(t));
  const stageNode = (stage: PipelineStage): GraphNode => ({
    kind: 'stage', id: stage.id, stage, count: on.filter(t => t.pipelineStageId === stage.id).length,
    children: pipeline.stages.filter(s => s.parentId === stage.id).sort((a, b) => a.position - b.position).map(stageNode),
  });
  return [{ kind: 'pipeline', id: pipeline.id, pipeline, count: on.length, children: pipeline.stages.filter(s => !s.parentId).sort((a, b) => a.position - b.position).map(stageNode) }];
}

/* The width and least height of a node and the steps between levels and rows, in the units of the canvas. */
export const NODE = { w: 290, h: 52, dx: 330, dy: 62, pad: 20 };
/* A wait's lane past the whole tree: the first this far out, each next one a step further, and room past the last for its
   arrow and its word. */
export const LANE = { first: 24, step: 14, room: 70 };
export type Placed = { node: GraphNode; x: number; y: number; h: number; depth: number };
/* width and height: the tree's own box, which Fit frames, from left in the drawing; drawn: the width of the whole drawing,
   the lanes of the waits with it. */
export type Layout = {
  nodes: Placed[]; parts: { from: string; to: string }[]; waits: { from: string; to: string; lane: number }[];
  width: number; height: number; left: number; drawn: number;
};

/* Where the lanes of count waits end past a tree that ends at right, the word of the last one with them; none, none. */
const lanesEnd = (right: number, count: number) => (count ? right + LANE.first + count * LANE.step + LANE.room : 0);

/* A drawing seen from the other side: each node and lane as far from its right as it stood from its left, the tree's box with
   them. */
function mirrored(layout: Layout): Layout {
  const { drawn } = layout;
  return {
    ...layout,
    nodes: layout.nodes.map(p => ({ ...p, x: drawn - p.x - NODE.w })),
    waits: layout.waits.map(wait => ({ ...wait, lane: drawn - wait.lane })),
    left: drawn - layout.width,
  };
}
/* A drawing laid out left to right, turned to the page's direction. */
const TURNED: Record<'ltr' | 'rtl', (layout: Layout) => Layout> = { ltr: layout => layout, rtl: mirrored };

/* Each level one step further along, each leaf on a row of its own, a node in the middle of what is under it and never over
   the node above it in its level. heightOf: the height a node's words take on the page, once measured; a node is never
   lower than NODE.h. A dashed line goes from a task to each task of the tree it waits for, along a lane of its own past the
   whole tree. Right to left the drawing is the mirror of the one left to right: the root at the right, each level further to
   the left, the lanes left of the tree (#1670). */
export function layoutTree(forest: GraphNode[], heightOf: (id: string) => number | undefined = () => undefined, dir: 'ltr' | 'rtl' = 'ltr'): Layout {
  const nodes: Placed[] = [];
  const parts: Layout['parts'] = [];
  const gap = NODE.dy - NODE.h;
  const bottoms: number[] = [];
  let next = NODE.pad;
  const middle = (p: Placed) => p.y + p.h / 2;
  const place = (node: GraphNode, depth: number): Placed => {
    const kids = node.children.map(child => {
      parts.push({ from: node.id, to: child.id });
      return place(child, depth + 1);
    });
    const h = Math.max(NODE.h, heightOf(node.id) ?? 0);
    const wanted = kids.length ? (middle(kids[0]!) + middle(kids.at(-1)!)) / 2 - h / 2 : next;
    const y = Math.max(wanted, bottoms[depth] === undefined ? NODE.pad : bottoms[depth]! + gap);
    bottoms[depth] = y + h;
    if (!kids.length) next = y + h + gap;
    const placed = { node, x: NODE.pad + depth * NODE.dx, y, h, depth };
    nodes.push(placed);
    return placed;
  };
  forest.forEach(tree => place(tree, 0));
  const numbered = new Map(nodes.flatMap(p => (p.node.kind === 'task' ? [[p.node.task.number, p.node.id] as const] : [])));
  const right = Math.max(0, ...nodes.map(p => p.x + NODE.w));
  const waits = nodes.flatMap(p => (p.node.kind === 'task' ? p.node.task.waitsFor.flatMap(n => (numbered.has(n) ? [{ from: p.node.id, to: numbered.get(n)! }] : [])) : []))
    .map((wait, i) => ({ ...wait, lane: right + LANE.first + i * LANE.step }));
  nodes.sort((a, b) => a.depth - b.depth || a.y - b.y);
  const width = right + NODE.pad;
  const height = Math.max(0, ...nodes.map(p => p.y + p.h)) + NODE.pad;
  return TURNED[dir]({ nodes, parts, waits, width, height, left: 0, drawn: Math.max(width, lanesEnd(right, waits.length)) });
}

/* The way back up from where the graph grows: the goals above, the tasks above, and the root itself. */
export type Crumb = { kind: 'goal' | 'task'; id: string; number: number; title: string };
export function graphPath(root: GraphRoot, goals: GoalView[], tasks: TaskLine[]): Crumb[] {
  const goalChain = (id: string | null | undefined): Crumb[] => {
    const chain: Crumb[] = [];
    for (let g = goals.find(x => x.id === id); g && !chain.some(c => c.id === g!.id); g = goals.find(x => x.id === g!.parentId)) chain.unshift({ kind: 'goal', id: g.id, number: g.number, title: g.title });
    return chain;
  };
  if (root.task) {
    const above: Crumb[] = [];
    let task = tasks.find(t => t.id === root.task);
    const served = task?.goal?.id;
    for (; task && !above.some(c => c.id === task!.id); task = tasks.find(t => t.id === task!.parentId)) above.unshift({ kind: 'task', id: task.id, number: task.number, title: task.title });
    return [...goalChain(served), ...above];
  }
  return root.goal ? goalChain(root.goal) : [];
}
