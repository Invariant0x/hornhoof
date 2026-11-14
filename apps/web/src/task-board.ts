import type { TaskLine, TurnView } from './types';

/* The state of a task in plain words, as the tracker shows it. */
export type HumanStatus = 'planned' | 'working' | 'review' | 'waiting' | 'paused' | 'done' | 'cancelled';

/* A task with the work under it: how many related tasks right under it are done of those that count, and how far it is. */
export type Goal = { task: TaskLine; children: Goal[]; done: number; total: number; progress: number };
export type Split = { open: Goal[]; closed: Goal[] };
export type DepartmentSection = { id: string; split: Split };
export type ReleaseKind = 'preparing' | 'planned' | 'outside' | 'released';
export type ReleaseSection = { key: string; kind: ReleaseKind; turn: TurnView | null; split: Split };

export function humanStatus(task: TaskLine): HumanStatus {
  return task.status === 'done' ? 'done' : 'working';
}

export function goals(tasks: TaskLine[]): Goal[] {
  return tasks.map(task => ({ task, children: [], done: 0, total: 0, progress: 0 }));
}

export function split(nodes: Goal[]): Split {
  return { open: nodes, closed: [] };
}

export function inDepartment(tasks: TaskLine[], _filter: string): TaskLine[] {
  return tasks;
}

export function byDepartment(_tasks: TaskLine[], _order: string[]): DepartmentSection[] {
  return [];
}

export function byRelease(_tasks: TaskLine[], _turns: TurnView[]): ReleaseSection[] {
  return [];
}
