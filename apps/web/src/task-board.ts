import type { TaskLine, TurnView } from './types';

/* The state of a task in plain words, as the tracker shows it. */
export type HumanStatus = 'working' | 'review' | 'waiting' | 'paused' | 'done' | 'cancelled';

/* A task with the work under it: how many related tasks right under it are done of those that count, and how far it is,
   from 0 to 1. */
export type Goal = { task: TaskLine; children: Goal[]; done: number; total: number; progress: number };
/* Goals still going, and apart from them what is over. */
export type Split = { open: Goal[]; closed: Goal[] };
/* One department's goals; none for the orchestrator's own work. */
export type DepartmentSection = { id: string; split: Split };
/* A turn by where it stands for a release, or the work outside every turn. */
export type ReleaseKind = 'preparing' | 'outside' | 'released';
export type ReleaseSection = { key: string; kind: ReleaseKind; turn: TurnView | null; split: Split };

export const NO_DEPARTMENT = 'none';
export const ALL_DEPARTMENTS = 'all';

const closed = (task: TaskLine) => task.status === 'done' || task.status === 'cancelled';

export function humanStatus(task: TaskLine): HumanStatus {
  if (task.status === 'done' || task.status === 'cancelled') return task.status;
  if (task.paused) return 'paused';
  if (task.externalWait || task.status === 'waiting' || task.status === 'blocked') return 'waiting';
  if (task.status === 'review') return 'review';
  return 'working';
}

/* What needs people first, then what is being checked, what moves and what stands still. */
const ORDER: HumanStatus[] = ['waiting', 'review', 'working', 'paused', 'done', 'cancelled'];
const byNeed = (a: Goal, b: Goal) => ORDER.indexOf(humanStatus(a.task)) - ORDER.indexOf(humanStatus(b.task)) || b.task.number - a.task.number;

/* Of a task with nothing under it: done or not, and on the way the stages that apply to it, those passed of them. */
function ownProgress(task: TaskLine): number {
  if (task.status === 'done') return 1;
  const stages = task.echelons.stages.filter(s => s.status !== 'skipped');
  return stages.length ? stages.filter(s => s.status === 'complete').length / stages.length : 0;
}

function grow(task: TaskLine, under: Map<string, TaskLine[]>): Goal {
  const children = (under.get(task.id) ?? []).sort((a, b) => a.number - b.number).map(child => grow(child, under));
  const counted = children.filter(c => c.task.status !== 'cancelled');
  const done = counted.filter(c => c.task.status === 'done').length;
  const progress = task.status === 'done' ? 1 : counted.length ? counted.reduce((sum, c) => sum + c.progress, 0) / counted.length : ownProgress(task);
  return { task, children, done, total: counted.length, progress };
}

/* Every task at the top of those given, its parent not among them, with the work under it as a tree, in number order. */
export function goals(tasks: TaskLine[]): Goal[] {
  const ids = new Set(tasks.map(t => t.id));
  const under = new Map<string, TaskLine[]>();
  for (const task of tasks) if (task.parentId && ids.has(task.parentId)) under.set(task.parentId, [...(under.get(task.parentId) ?? []), task]);
  return tasks.filter(t => !t.parentId || !ids.has(t.parentId)).sort((a, b) => a.number - b.number).map(task => grow(task, under));
}

/* Every goal of the trees by the id of its task, the related tasks deep down too. */
export function indexGoals(nodes: Goal[], into = new Map<string, Goal>()): Map<string, Goal> {
  for (const node of nodes) {
    into.set(node.task.id, node);
    indexGoals(node.children, into);
  }
  return into;
}

/* Goals still going by what needs people first, and those over, the newest first. */
export function split(nodes: Goal[]): Split {
  return { open: nodes.filter(g => !closed(g.task)).sort(byNeed), closed: nodes.filter(g => closed(g.task)).sort((a, b) => b.task.number - a.task.number) };
}

/* The goals being worked on and those over. */
export const inProgress = (tasks: TaskLine[]): Split => split(goals(tasks));

/* The tasks of one department, of the orchestrator's own work, or of all of them. */
export function inDepartment(tasks: TaskLine[], filter: string): TaskLine[] {
  if (filter === ALL_DEPARTMENTS) return tasks;
  return tasks.filter(t => (t.department?.id ?? NO_DEPARTMENT) === filter);
}

/* Every department given, in that order, with what is in progress in it; then the orchestrator's own work, when there is any. */
export function byDepartment(tasks: TaskLine[], order: string[]): DepartmentSection[] {
  const ids = tasks.some(t => !t.department) ? [...order, NO_DEPARTMENT] : order;
  return ids.map(id => ({ id, split: inProgress(inDepartment(tasks, id)) }));
}

/* The open turns, getting ready for release, then the work in no turn yet and the released turns, the newest first. An open
   turn shows with nothing in it yet; a released one only with tasks to show. */
export function byRelease(tasks: TaskLine[], turns: TurnView[]): ReleaseSection[] {
  const of = (turn: TurnView | null) => split(goals(tasks.filter(t => t.turn === (turn?.number ?? null))));
  const section = (kind: ReleaseKind) => (turn: TurnView): ReleaseSection => ({ key: turn.id, kind, turn, split: of(turn) });
  const numbered = [...turns].sort((a, b) => a.number - b.number);
  const outside = of(null);
  return [
    ...numbered.filter(t => t.status === 'open').map(section('preparing')),
    ...(outside.open.length || outside.closed.length ? [{ key: 'outside', kind: 'outside' as const, turn: null, split: outside }] : []),
    ...numbered.filter(t => t.status === 'closed').reverse().map(section('released')).filter(s => s.split.open.length || s.split.closed.length),
  ];
}
