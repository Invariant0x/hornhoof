import type { TaskLine, TurnView } from './types';

/* The state of a task in plain words, as the tracker shows it: the table of the Design department, and paused, which a person
   says. */
export type HumanStatus = 'notStarted' | 'working' | 'review' | 'waiting' | 'waitingYou' | 'stopped' | 'paused' | 'done' | 'cancelled';

/* A task with the work under it: how many related tasks right under it are done of those that count, and how far it is,
   from 0 to 1. */
export type Goal = { task: TaskLine; children: Goal[]; done: number; total: number; progress: number };
/* Goals still going, and apart from them what is over. */
export type Split = { open: Goal[]; closed: Goal[] };
/* One department's goals; none for the orchestrator's own work. */
export type DepartmentSection = { id: string; split: Split };
/* Whether an open question on a task is the person's to answer. */
export type Asks = (taskId: string) => boolean;
/* The next release of a department getting ready: its goals still going and those done in its turn. */
export type Preparing = { turn: TurnView; going: Goal[]; done: Goal[] };
/* A turn that came out as a release, with the goals that went into it. */
export type Released = { turn: TurnView; goals: Goal[] };
/* The next releases, the work outside every release and the releases out already, the newest first. */
export type Releases = { preparing: Preparing[]; outside: Split; released: Released[] };
/* What the tracker counts at a glance: goals waiting for the person's answer, goals going on now, and results ready for the
   next releases. */
export type Summary = { waitingYou: number; working: number; ready: number };

export const NO_DEPARTMENT = 'none';
export const ALL_DEPARTMENTS = 'all';

const closed = (task: TaskLine) => task.status === 'done' || task.status === 'cancelled';

/* asksYou: an open question on the task is the person's to answer. */
export function humanStatus(task: TaskLine, asksYou = false): HumanStatus {
  if (task.status === 'done' || task.status === 'cancelled') return task.status;
  if (task.paused) return 'paused';
  if (asksYou) return 'waitingYou';
  if (task.status === 'blocked') return 'stopped';
  if (task.externalWait || task.status === 'waiting') return 'waiting';
  if (task.status === 'review') return 'review';
  return task.status === 'open' ? 'notStarted' : 'working';
}

/* A goal whose related work began, or which passed a stage of its own, is in progress, though its own task waits for the next
   turn of its holder. */
export function goalStatus(goal: Goal, asksYou = false): HumanStatus {
  const own = humanStatus(goal.task, asksYou);
  if (own !== 'notStarted') return own;
  return goal.progress > 0 || goal.children.some(child => !['notStarted', 'cancelled'].includes(goalStatus(child))) ? 'working' : own;
}

/* The task of a goal whose open question is the person's to answer: the goal itself first, then the related tasks deep down in
   number order; never a closed one. */
export function askingTask(goal: Goal, asksYou?: Asks): TaskLine | null {
  if (!asksYou) return null;
  if (!closed(goal.task) && asksYou(goal.task.id)) return goal.task;
  for (const child of goal.children) {
    const found = askingTask(child, asksYou);
    if (found) return found;
  }
  return null;
}

/* The state of a goal, waiting for the person when a question on it or deep under it is theirs. */
export const stateOf = (goal: Goal, asksYou?: Asks): HumanStatus => goalStatus(goal, askingTask(goal, asksYou) !== null);

/* What needs people first, then what stopped, is being checked, moves and has not started, and what stands still. */
const ORDER: HumanStatus[] = ['waitingYou', 'waiting', 'stopped', 'review', 'working', 'notStarted', 'paused', 'done', 'cancelled'];
const byNeed = (asksYou?: Asks) => (a: Goal, b: Goal) => ORDER.indexOf(stateOf(a, asksYou)) - ORDER.indexOf(stateOf(b, asksYou)) || b.task.number - a.task.number;
const newestFirst = (a: Goal, b: Goal) => b.task.number - a.task.number;

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
export function split(nodes: Goal[], asksYou?: Asks): Split {
  return { open: nodes.filter(g => !closed(g.task)).sort(byNeed(asksYou)), closed: nodes.filter(g => closed(g.task)).sort(newestFirst) };
}

/* The goals being worked on and those over. */
export const inProgress = (tasks: TaskLine[], asksYou?: Asks): Split => split(goals(tasks), asksYou);

/* The tasks of one department, of the orchestrator's own work, or of all of them. */
export function inDepartment(tasks: TaskLine[], filter: string): TaskLine[] {
  if (filter === ALL_DEPARTMENTS) return tasks;
  return tasks.filter(t => (t.department?.id ?? NO_DEPARTMENT) === filter);
}

/* Every department given, in that order, with what is in progress in it; then the orchestrator's own work, when there is any. */
export function byDepartment(tasks: TaskLine[], order: string[], asksYou?: Asks): DepartmentSection[] {
  const ids = tasks.some(t => !t.department) ? [...order, NO_DEPARTMENT] : order;
  return ids.map(id => ({ id, split: inProgress(inDepartment(tasks, id), asksYou) }));
}

/* A turn of a department that keeps a repository comes out as a release; that of one without stays outside releases. */
const releasing = (turn: TurnView) => turn.releases !== false && turn.departmentId !== null;

/* Each releasing department's next release getting ready: the goals of the department still going, which go into it as they
   are done, and those done in its turn. Then the work of the departments without releases and of the orchestrator himself,
   and the turns that came out, the newest first, each with what went into it. An open turn shows with nothing in it yet; a
   released one only with goals to show. A goal of a releasing department done in no turn goes into no release. */
export function byRelease(tasks: TaskLine[], turns: TurnView[], asksYou?: Asks): Releases {
  const tree = goals(tasks);
  const open = [...turns].filter(t => t.status === 'open' && releasing(t)).sort((a, b) => a.number - b.number);
  const departments = new Set(open.map(t => t.departmentId));
  const released = [...turns].filter(t => t.status === 'closed' && releasing(t)).sort((a, b) => b.number - a.number);
  const releases = (goal: Goal) => departments.has(goal.task.department?.id ?? null) || [...open, ...released].some(t => t.number === goal.task.turn);
  return {
    preparing: open.map(turn => ({
      turn,
      going: split(tree.filter(g => !closed(g.task) && (g.task.department?.id === turn.departmentId || g.task.turn === turn.number)), asksYou).open,
      done: tree.filter(g => closed(g.task) && g.task.turn === turn.number).sort(newestFirst),
    })),
    outside: split(tree.filter(g => !releases(g)), asksYou),
    released: released.map(turn => ({ turn, goals: tree.filter(g => g.task.turn === turn.number).sort(newestFirst) })).filter(r => r.goals.length > 0),
  };
}

/* What waits for the person's answer and what goes on now, in goals, and the results the next releases already hold. */
export function summaryOf(tasks: TaskLine[], turns: TurnView[], asksYou?: Asks): Summary {
  const going = goals(tasks).filter(g => !closed(g.task));
  return {
    waitingYou: going.filter(g => askingTask(g, asksYou) !== null).length,
    working: going.filter(g => stateOf(g, asksYou) === 'working').length,
    ready: turns.filter(t => t.status === 'open' && releasing(t)).reduce((sum, t) => sum + t.tasks.done, 0),
  };
}
