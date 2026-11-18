import { externalWaitFact, isPersonWait, type TaskWaitFact } from '@hornhoof/protocol/waits';
import type { TaskLine } from './types';

/* How the web shows a task, in one vocabulary for the tracker, the task card and Turns and releases: its state in plain
   words, what it waits for, and the work under it as a tree. Releases group these trees in releases.ts. */

/* The state of a task in plain words, as the tracker shows it: the table of the Design department, and paused, which a person
   says. */
export type HumanStatus = 'notStarted' | 'working' | 'review' | 'waiting' | 'waitingYou' | 'failure' | 'stopped' | 'paused' | 'done' | 'cancelled';

/* A task with the work under it: how many subtasks right under it are done of those that count, and how far it is, from 0
   to 1. */
export type TaskTree = { task: TaskLine; children: TaskTree[]; done: number; total: number; progress: number };
/* Whether an open question on a task is the person's to answer. */
export type Asks = (taskId: string) => boolean;

/* Work that is over: done, or cancelled. */
export const isClosed = (task: Pick<TaskLine, 'status'>) => task.status === 'done' || task.status === 'cancelled';

export type WaitTask = Pick<TaskLine, 'time' | 'status' | 'externalWait'> & Partial<Pick<TaskLine, 'executor' | 'assignee' | 'waitsFor'>>;

export const matchesExternalWait = (fact: TaskWaitFact, external: NonNullable<WaitTask['externalWait']>) =>
  fact.since === external.since && (fact.until === external.until || (fact.until === undefined && ['external', 'run', 'work'].includes(fact.kind)));

/* The external wait the task records, in place of the fact the server keeps of it, or beside the others when it keeps none. */
function withExternal(waits: TaskWaitFact[], external: WaitTask['externalWait'], now: number): TaskWaitFact[] {
  if (!external) return waits;
  const index = waits.findIndex(fact => matchesExternalWait(fact, external));
  if (index < 0) return [...waits, externalWaitFact(external, now)];
  return waits.map((fact, i) => (i === index ? externalWaitFact(external, now, fact) : fact));
}

/* A task it waits for that no fact names yet, as a wait since the task came to its status. */
function withPrerequisites(waits: TaskWaitFact[], task: WaitTask, now: number): TaskWaitFact[] {
  const named = new Set(waits.filter(wait => wait.kind === 'after').map(wait => wait.reason));
  const since = task.time?.inStatusSince ?? new Date(now).toISOString();
  const missing = (task.waitsFor ?? []).map(number => `#${number}`).filter(reason => !named.has(reason));
  return [...waits, ...missing.map(reason => ({ kind: 'after' as const, reason, who: null, since }))];
}

/* A failure first, then a wait for a person, then the oldest. */
const byUrgency = (a: TaskWaitFact, b: TaskWaitFact) =>
  Number(!!b.failure) - Number(!!a.failure) || Number(isPersonWait(b)) - Number(isPersonWait(a)) || a.since.localeCompare(b.since);

export function taskWaits(task: WaitTask, now = Date.now()): TaskWaitFact[] {
  if (isClosed(task)) return [];
  return withPrerequisites(withExternal([...(task.time?.waitsOn ?? [])], task.externalWait, now), task, now).sort(byUrgency);
}

/* Of an open task nobody waits on but its own people: stopped, at work while it waits for anything but a check, being checked,
   or not started. */
function ownStatus(task: WaitTask, facts: TaskWaitFact[]): HumanStatus {
  if (task.status === 'blocked') return 'stopped';
  if (facts.some(fact => fact.kind !== 'review') || task.status === 'waiting') return 'working';
  if (task.status === 'review') return 'review';
  return task.status === 'open' ? 'notStarted' : 'working';
}

/* asksYou: an open question on the task is the person's to answer. */
export function humanStatus(task: WaitTask & Pick<TaskLine, 'paused'>, asksYou = false): HumanStatus {
  if (isClosed(task)) return task.status === 'done' ? 'done' : 'cancelled';
  if (task.paused) return 'paused';
  const facts = taskWaits(task);
  if (facts.some(fact => fact.failure)) return 'failure';
  if (asksYou) return 'waitingYou';
  if (facts.some(isPersonWait)) return 'waiting';
  return ownStatus(task, facts);
}

/* A task whose work under it began, or which passed a stage of its own, is in progress, though its own task waits for the
   next turn of its holder. */
export function treeStatus(tree: TaskTree, asksYou = false): HumanStatus {
  const own = humanStatus(tree.task, asksYou);
  if (own !== 'notStarted') return own;
  return tree.progress > 0 || tree.children.some(child => !['notStarted', 'cancelled'].includes(treeStatus(child))) ? 'working' : own;
}

/* The task of a tree whose open question is the person's to answer: the one at the top first, then the subtasks deep down in
   number order; never a closed one. */
export function askingTask(tree: TaskTree, asksYou?: Asks): TaskLine | null {
  if (!asksYou) return null;
  if (!isClosed(tree.task) && asksYou(tree.task.id)) return tree.task;
  for (const child of tree.children) {
    const found = askingTask(child, asksYou);
    if (found) return found;
  }
  return null;
}

/* The state of a tree, waiting for the person when a question on it or deep under it is theirs. */
export const stateOf = (tree: TaskTree, asksYou?: Asks): HumanStatus => treeStatus(tree, askingTask(tree, asksYou) !== null);

/* Of a task with nothing under it: done or not, and on the way the stages that apply to it, those passed of them. */
function ownProgress(task: TaskLine): number {
  if (task.status === 'done') return 1;
  const stages = task.echelons.stages.filter(s => s.status !== 'skipped');
  return stages.length ? stages.filter(s => s.status === 'complete').length / stages.length : 0;
}

type Counts = ReadonlyMap<string, { done: number; total: number }>;

/* Each task's subtasks done of all of them, cancelled ones aside. */
function subtaskCounts(all: TaskLine[]): Counts {
  const counts = new Map<string, { done: number; total: number }>();
  for (const t of all) {
    if (!t.parentId || t.status === 'cancelled') continue;
    const c = counts.get(t.parentId) ?? { done: 0, total: 0 };
    counts.set(t.parentId, { done: c.done + (t.status === 'done' ? 1 : 0), total: c.total + 1 });
  }
  return counts;
}

function grow(task: TaskLine, under: Map<string, TaskLine[]>, counts: Counts): TaskTree {
  const children = (under.get(task.id) ?? []).sort((a, b) => a.number - b.number).map(child => grow(child, under, counts));
  const counted = children.filter(c => c.task.status !== 'cancelled');
  const progress = task.status === 'done' ? 1 : counted.length ? counted.reduce((sum, c) => sum + c.progress, 0) / counted.length : ownProgress(task);
  return { task, children, ...(counts.get(task.id) ?? { done: 0, total: 0 }), progress };
}

/* Every task at the top of those given, its parent not among them, with the work under it as a tree, in number order. all:
   the work the subtasks are counted over, when those given are only part of it; what a view leaves out of sight still
   counts. */
export function taskTrees(tasks: TaskLine[], all: TaskLine[] = tasks): TaskTree[] {
  const ids = new Set(tasks.map(t => t.id));
  const under = new Map<string, TaskLine[]>();
  for (const task of tasks) if (task.parentId && ids.has(task.parentId)) under.set(task.parentId, [...(under.get(task.parentId) ?? []), task]);
  const counts = subtaskCounts(all);
  return tasks.filter(t => !t.parentId || !ids.has(t.parentId)).sort((a, b) => a.number - b.number).map(task => grow(task, under, counts));
}
