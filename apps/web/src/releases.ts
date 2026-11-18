import { isClosed, stateOf, taskTrees, type Asks, type HumanStatus, type TaskTree } from './task-tree';
import type { TaskLine, TurnView } from './types';

/* Turns and releases: the task trees of task-tree.ts grouped by the release they go into. */

/* Work still going, and apart from it what is over. */
export type Split = { open: TaskTree[]; closed: TaskTree[] };
/* The next release of a department getting ready: its work still going and that done in its turn. */
export type Preparing = { turn: TurnView; going: TaskTree[]; done: TaskTree[] };
/* A turn that came out as a release, with the work that went into it. */
export type Released = { turn: TurnView; trees: TaskTree[] };
/* The next releases, the work outside every release and the releases out already, the newest first. */
export type Releases = { preparing: Preparing[]; outside: Split; released: Released[] };

export const NO_DEPARTMENT = 'none';
export const ALL_DEPARTMENTS = 'all';

/* What needs people first, then what stopped, is being checked, moves and has not started, and what stands still. */
const ORDER: HumanStatus[] = ['failure', 'waitingYou', 'waiting', 'stopped', 'review', 'working', 'notStarted', 'paused', 'done', 'cancelled'];
const byNeed = (asksYou?: Asks) => (a: TaskTree, b: TaskTree) => ORDER.indexOf(stateOf(a, asksYou)) - ORDER.indexOf(stateOf(b, asksYou)) || b.task.number - a.task.number;
const newestFirst = (a: TaskTree, b: TaskTree) => b.task.number - a.task.number;

/* Work still going by what needs people first, and that over, the newest first. */
export function split(nodes: TaskTree[], asksYou?: Asks): Split {
  return { open: nodes.filter(g => !isClosed(g.task)).sort(byNeed(asksYou)), closed: nodes.filter(g => isClosed(g.task)).sort(newestFirst) };
}

/* The tasks of one department, of the orchestrator's own work, or of all of them. */
export function inDepartment(tasks: TaskLine[], filter: string): TaskLine[] {
  if (filter === ALL_DEPARTMENTS) return tasks;
  return tasks.filter(t => (t.department?.id ?? NO_DEPARTMENT) === filter);
}

/* A turn of a department that keeps a repository comes out as a release; that of one without stays outside releases. */
const releasing = (turn: TurnView) => turn.releases !== false && turn.departmentId !== null;

/* The next release of a turn's department: its work still going, which goes into it as it is done, and that done in its turn. */
function preparing(turn: TurnView, tree: TaskTree[], asksYou?: Asks): Preparing {
  const going = tree.filter(g => !isClosed(g.task) && (g.task.department?.id === turn.departmentId || g.task.turn === turn.number));
  return { turn, going: split(going, asksYou).open, done: tree.filter(g => isClosed(g.task) && g.task.turn === turn.number).sort(newestFirst) };
}

/* Each releasing department's next release getting ready. Then the work of the departments without releases and of the
   orchestrator himself, and the turns that came out, the newest first, each with what went into it. An open turn shows with
   nothing in it yet; a released one only with work to show. Work of a releasing department done in no turn goes into no
   release. */
export function byRelease(tasks: TaskLine[], turns: TurnView[], asksYou?: Asks): Releases {
  const tree = taskTrees(tasks);
  const open = turns.filter(t => t.status === 'open' && releasing(t)).sort((a, b) => a.number - b.number);
  const released = turns.filter(t => t.status === 'closed' && releasing(t)).sort((a, b) => b.number - a.number);
  const departments = new Set(open.map(t => t.departmentId));
  const numbers = new Set<number | null>([...open, ...released].map(t => t.number));
  const releases = (node: TaskTree) => departments.has(node.task.department?.id ?? null) || numbers.has(node.task.turn);
  return {
    preparing: open.map(turn => preparing(turn, tree, asksYou)),
    outside: split(tree.filter(g => !releases(g)), asksYou),
    released: released.map(turn => ({ turn, trees: tree.filter(g => g.task.turn === turn.number).sort(newestFirst) })).filter(r => r.trees.length > 0),
  };
}
