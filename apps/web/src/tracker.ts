import { goals as trees, humanStatus, type Asks, type Goal as TaskTree, type HumanStatus } from './task-board';
import type { Employee, GoalView, Org, PersonRef, Pipeline, PipelineStage, TaskLine } from './types';

export type { TaskTree };

/* Three ways to look at the same work. */
export const TRACKER_VIEWS = ['list', 'board', 'graph'] as const;
export type TrackerView = (typeof TRACKER_VIEWS)[number];

/* The columns of the status board, and what the status filter picks: waits holds whatever stands still, a person's answer
   among it. */
export const BOARD_STATUSES = ['notStarted', 'working', 'review', 'waits', 'done', 'cancelled'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

const closed = (task: TaskLine) => task.status === 'done' || task.status === 'cancelled';

export function boardStatus(task: TaskLine, asksYou = false): BoardStatus {
  const status = humanStatus(task, asksYou);
  if (status === 'waiting' || status === 'waitingYou' || status === 'stopped' || status === 'paused') return 'waits';
  return status;
}

/* The order the list's groups read in: what needs people first, then what stopped, is checked, moves and has not started,
   and what is over. */
const NEED: HumanStatus[] = ['waitingYou', 'waiting', 'stopped', 'review', 'working', 'notStarted', 'paused', 'done', 'cancelled'];
const newestFirst = (a: TaskTree, b: TaskTree) => b.task.number - a.task.number;

export type ListGroup = { status: HumanStatus; trees: TaskTree[] };

/* The tasks at the top of those given, by their status in words, each with its subtasks under it. */
export function listGroups(tasks: TaskLine[], asksYou?: Asks): ListGroup[] {
  const top = trees(tasks);
  return NEED.map(status => ({ status, trees: top.filter(tree => humanStatus(tree.task, asksYou?.(tree.task.id) ?? false) === status).sort(newestFirst) })).filter(g => g.trees.length > 0);
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

/* The status board: one column per status, the tasks at the top of those given as cards with their subtasks counted, and
   cancelled ones only when asked. With a pipeline: its tasks, those nobody holds yet under Not started, then a column per
   stage in tree order, then what is over. */
export function boardColumns(tasks: TaskLine[], pipeline: Pipeline | null, opts: { cancelled?: boolean } = {}, asksYou?: Asks): BoardColumn[] {
  const asks = (task: TaskLine) => asksYou?.(task.id) ?? false;
  const ends: BoardStatus[] = opts.cancelled ? ['done', 'cancelled'] : ['done'];
  if (!pipeline) {
    const cards = trees(tasks);
    return BOARD_STATUSES.filter(s => s !== 'cancelled' || opts.cancelled).map(status => ({ id: status, status, cards: cards.filter(c => boardStatus(c.task, asks(c.task)) === status).sort(newestFirst) }));
  }
  const all = trees(tasks);
  const under = new Map<string, TaskTree>();
  const index = (nodes: TaskTree[]) => nodes.forEach(n => { under.set(n.task.id, n); index(n.children); });
  index(all);
  const cards = tasks.filter(t => t.pipelineId === pipeline.id).map(t => under.get(t.id)!).sort(newestFirst);
  const stages = stagesInOrder(pipeline.stages);
  const known = new Set(stages.map(s => s.id));
  const open = cards.filter(c => !closed(c.task));
  return [
    { id: 'notStarted', status: 'notStarted', cards: open.filter(c => !c.task.pipelineStageId || !known.has(c.task.pipelineStageId)) },
    ...stages.map(stage => ({ id: stage.id, stage, cards: open.filter(c => c.task.pipelineStageId === stage.id) })),
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

export function filterTasks(tasks: TaskLine[], f: WorkFilter, goals: GoalView[], asksYou?: Asks): TaskLine[] {
  const served = f.goal ? goalsUnder(f.goal, goals) : null;
  return tasks.filter(task => {
    if (f.status ? boardStatus(task, asksYou?.(task.id) ?? false) !== f.status : task.status === 'cancelled') return false;
    if (f.executor && task.assignee?.id !== f.executor) return false;
    if (f.responsible && task.responsible?.id !== f.responsible) return false;
    if (served && !(task.goal && served.has(task.goal.id))) return false;
    if (f.department && (task.department?.id ?? 'none') !== f.department) return false;
    if (f.product && task.product?.id !== f.product) return false;
    return !f.pipeline || task.pipelineId === f.pipeline;
  });
}

/* What a person answers for and is not over yet: their goals and their tasks. */
export function mine(tasks: TaskLine[], goals: GoalView[], personId: string): { goals: GoalView[]; tasks: TaskLine[] } {
  return { goals: goals.filter(g => g.status === 'active' && g.responsible.id === personId), tasks: tasks.filter(t => !closed(t) && t.responsible?.id === personId) };
}

/* The tasks an employee works on at this moment. */
export function workingNow(tasks: TaskLine[], org: Org | null): TaskLine[] {
  const held = new Set((org?.departments ?? []).flatMap(d => d.employees.filter(e => e.status === 'working' && e.task).map(e => e.task!.id)));
  return tasks.filter(t => held.has(t.id));
}

/* The open tasks that wait for a person's answer or work. */
export function waitingOn(tasks: TaskLine[], personId: string): TaskLine[] {
  return tasks.filter(t => !closed(t) && (t.time?.waitsOn ?? []).some(w => w.who?.kind === 'person' && w.who.id === personId));
}

/* Who answers for the departments and the goals, in the departments' order: the departments each answers for and how many
   open tasks they hold. */
export type Responsible = { person: PersonRef; departments: string[]; open: number };
export function responsibles(departments: { id: string; responsible?: PersonRef | null }[], goals: GoalView[], tasks: TaskLine[]): Responsible[] {
  const people: Responsible[] = [];
  const add = (person: PersonRef, department?: string) => {
    let found = people.find(r => r.person.id === person.id);
    if (!found) people.push((found = { person, departments: [], open: tasks.filter(t => !closed(t) && t.responsible?.id === person.id).length }));
    if (department) found.departments.push(department);
  };
  for (const d of departments) if (d.responsible) add(d.responsible, d.id);
  for (const g of goals) if (g.status === 'active') add(g.responsible);
  return people;
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
  const loose = tasks.filter(t => top(t) && !t.goal).sort(byNumber).map(taskNode);
  return [...place.filter(g => !g.parentId || !inPlace.has(g.parentId)).sort(byNumber).map(goalNode), ...(loose.length ? [{ kind: 'loose' as const, id: 'loose' as const, children: loose }] : [])];
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
  const on = tasks.filter(t => t.pipelineId === pipeline.id && !closed(t));
  const stageNode = (stage: PipelineStage): GraphNode => ({
    kind: 'stage', id: stage.id, stage, count: on.filter(t => t.pipelineStageId === stage.id).length,
    children: pipeline.stages.filter(s => s.parentId === stage.id).sort((a, b) => a.position - b.position).map(stageNode),
  });
  return [{ kind: 'pipeline', id: pipeline.id, pipeline, count: on.length, children: pipeline.stages.filter(s => !s.parentId).sort((a, b) => a.position - b.position).map(stageNode) }];
}

/* The size of a node and the steps between levels and rows, in the units of the canvas. */
export const NODE = { w: 290, h: 56, dx: 330, dy: 66, pad: 20 };
export type Placed = { node: GraphNode; x: number; y: number; depth: number };
export type Layout = { nodes: Placed[]; parts: { from: string; to: string }[]; waits: { from: string; to: string }[]; width: number; height: number };

/* Each level one step further along, each leaf on a row of its own, a node in the middle of what is under it. A dashed line
   goes from a task to each task of the tree it waits for. */
export function layoutTree(forest: GraphNode[]): Layout {
  const nodes: Placed[] = [];
  const parts: Layout['parts'] = [];
  let row = 0;
  const place = (node: GraphNode, depth: number): number => {
    const ys = node.children.map(child => {
      parts.push({ from: node.id, to: child.id });
      return place(child, depth + 1);
    });
    const y = ys.length ? (ys[0]! + ys.at(-1)!) / 2 : NODE.pad + row++ * NODE.dy;
    nodes.push({ node, x: NODE.pad + depth * NODE.dx, y, depth });
    return y;
  };
  forest.forEach(tree => place(tree, 0));
  const numbered = new Map(nodes.flatMap(p => (p.node.kind === 'task' ? [[p.node.task.number, p.node.id] as const] : [])));
  const waits = nodes.flatMap(p => (p.node.kind === 'task' ? p.node.task.waitsFor.flatMap(n => (numbered.has(n) ? [{ from: p.node.id, to: numbered.get(n)! }] : [])) : []));
  nodes.sort((a, b) => a.depth - b.depth || a.y - b.y);
  return {
    nodes, parts, waits,
    width: Math.max(0, ...nodes.map(p => p.x + NODE.w)) + NODE.pad,
    height: Math.max(0, ...nodes.map(p => p.y + NODE.h)) + NODE.pad,
  };
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
