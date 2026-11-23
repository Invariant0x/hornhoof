/* What Hornhoof does with each branch of a company's repository (#1964), decided from what the repository says and what
   Hornhoof's own records say, and nothing else. This only decides: pruning reads it and does what it says. */

import { GitHubRateLimited, type RateLimit } from '../testruns/github-limit.js';

/* The newest turn branches that stay, tagged or not. */
export const TURNS_KEPT = 20;
/* How long a closed task keeps a branch no turn, main or tag holds yet, in case its work is still to be taken in. A cancelled
   task has no work to wait for. */
export const CLOSED_GRACE_MS = 7 * 86_400_000;

/* A task as Hornhoof's records keep it. */
export type TaskFact = { status: string; paused: boolean; closedAt: number | null };
export type Facts = {
  /* The repository's main branch. */
  main: string;
  /* Every branch of it, with its head, and every tag, with the commit it stands on. */
  heads: Readonly<Record<string, string>>;
  tags: Readonly<Record<string, string>>;
  /* The company's tasks by number, and the branch names Hornhoof's records name besides: the turns, and the branches of test runs. */
  tasks: ReadonlyMap<number, TaskFact>;
  recorded: ReadonlySet<string>;
  now: number;
};
/* Whether the commit holder holds head (head is under it): none where the repository could not say. */
export type Holds = (holder: string, head: string) => Promise<boolean | null>;
/* category: what the branch is to Hornhoof, for counting a plan: the main branch, a branch whose work a turn, main or tag holds, one
   to archive, one of an open or paused task (live), one of a task closed lately, one Hornhoof has no record of (foreign), a
   turn branch kept or to delete, or one the repository could not say of. */
export type Category = 'main' | 'held' | 'archive' | 'live' | 'closed-lately' | 'foreign' | 'turn-kept' | 'turn-delete' | 'unreadable' | 'waiting';
export type Verdict = { branch: string; head: string; action: 'delete' | 'archive' | 'keep'; category: Category; reason: string; heldBy?: string };

type Holder = { ref: string; commit: string };

const TASK_BRANCH = /^(?:task|release-check)-(\d+)(?:-.+)?$/;
const TURN_BRANCH = /^turn-(\d+)$/;
/* A release tag, v1.2.3: nothing else stands for a release. */
const RELEASE_TAG = /^v\d/;

export const taskNumberOf = (branch: string): number | null => {
  const found = TASK_BRANCH.exec(branch);
  return found ? Number(found[1]) : null;
};

const verdict = (branch: string, head: string, action: Verdict['action'], category: Category, reason: string, heldBy?: string): Verdict => ({ branch, head, action, category, reason, ...(heldBy ? { heldBy } : {}) });

/* Where a branch's work may be held: main, then each turn branch and release tag that main does not hold already, as one a
   branch is under before it reaches main. One read per ref, however many branches ask. */
async function holdersOf(facts: Facts, holds: Holds): Promise<Holder[]> {
  const main = facts.heads[facts.main];
  const turns = Object.entries(facts.heads).filter(([name]) => TURN_BRANCH.test(name)).sort(([a], [b]) => turnNumber(b) - turnNumber(a)).map(([ref, commit]) => ({ ref, commit }));
  const tags = Object.entries(facts.tags).filter(([name]) => RELEASE_TAG.test(name)).sort(([a], [b]) => b.localeCompare(a, 'en', { numeric: true })).map(([ref, commit]) => ({ ref, commit }));
  const holders: Holder[] = main ? [{ ref: facts.main, commit: main }] : [];
  for (const candidate of [...turns, ...tags]) if (!main || (await holds(main, candidate.commit)) !== true) holders.push(candidate);
  return holders;
}

const turnNumber = (branch: string): number => Number(TURN_BRANCH.exec(branch)?.[1] ?? -1);

/* The first holder under which the head is, or unknown where one could not say and none did, or none. */
async function heldBy(holders: readonly Holder[], head: string, holds: Holds): Promise<Holder | 'unknown' | null> {
  let unknown = false;
  for (const holder of holders) {
    const held = await holds(holder.commit, head);
    if (held === true) return holder;
    if (held === null) unknown = true;
  }
  return unknown ? 'unknown' : null;
}

/* A branch of a task: what its task and the repository say. A branch of an open or paused task is never touched. */
async function taskBranch(name: string, head: string, task: TaskFact, facts: Facts, holders: readonly Holder[], holds: Holds): Promise<Verdict> {
  const closed = task.status === 'done' || task.status === 'cancelled';
  if (task.paused) return verdict(name, head, 'keep', 'live', 'its task is paused');
  if (!closed) return verdict(name, head, 'keep', 'live', 'its task is still open');
  const held = await heldBy(holders, head, holds);
  if (held === 'unknown') return verdict(name, head, 'keep', 'unreadable', 'the repository could not be read to say whether its work is held');
  if (held) return verdict(name, head, 'delete', 'held', `its work is in ${held.ref}`, held.ref);
  const idle = task.status === 'cancelled' || (task.closedAt !== null && facts.now - task.closedAt >= CLOSED_GRACE_MS);
  return idle ? verdict(name, head, 'archive', 'archive', `its task is ${task.status} and no turn, main or tag holds its work`) : verdict(name, head, 'keep', 'closed-lately', 'its task closed lately and no turn, main or tag holds its work yet');
}

/* A branch Hornhoof's records name that is no task's: a service branch, deleted once its work is held. */
async function serviceBranch(name: string, head: string, holders: readonly Holder[], holds: Holds): Promise<Verdict> {
  const held = await heldBy(holders, head, holds);
  if (held === 'unknown') return verdict(name, head, 'keep', 'unreadable', 'the repository could not be read to say whether its work is held');
  return held ? verdict(name, head, 'delete', 'held', `its work is in ${held.ref}`, held.ref) : verdict(name, head, 'keep', 'waiting', 'no turn, main or tag holds its work yet');
}

/* The newest turn branches stay; an older one goes only where a release tag stands on its head. */
function turnBranch(name: string, head: string, facts: Facts, newest: readonly string[]): Verdict {
  if (newest.indexOf(name) < TURNS_KEPT) return verdict(name, head, 'keep', 'turn-kept', `one of the ${TURNS_KEPT} newest turn branches`);
  const tag = Object.entries(facts.tags).find(([tagName, commit]) => RELEASE_TAG.test(tagName) && commit === head)?.[0];
  return tag ? verdict(name, head, 'delete', 'turn-delete', `release tag ${tag} stands on its head`, tag) : verdict(name, head, 'keep', 'turn-kept', 'no release tag stands on its head');
}

async function planOne(name: string, head: string, facts: Facts, holders: readonly Holder[], newest: readonly string[], holds: Holds): Promise<Verdict> {
  if (name === facts.main) return verdict(name, head, 'keep', 'main', 'the main branch');
  if (TURN_BRANCH.test(name)) return facts.recorded.has(name) ? turnBranch(name, head, facts, newest) : verdict(name, head, 'keep', 'foreign', 'not made by Hornhoof: no turn of its records');
  const number = taskNumberOf(name);
  if (number !== null) {
    const task = facts.tasks.get(number);
    return task ? taskBranch(name, head, task, facts, holders, holds) : verdict(name, head, 'keep', 'foreign', `not a task of this company: #${number}`);
  }
  return facts.recorded.has(name) ? serviceBranch(name, head, holders, holds) : verdict(name, head, 'keep', 'foreign', 'not made by Hornhoof: no record of it');
}

/* What the plan reached, by branch name, and the request limit it stopped at, if GitHub's was used up first: the branches
   after it have no verdict yet. */
export type Plan = { verdicts: Verdict[]; stopped: RateLimit | null };

/* The verdict on every branch, by name, as far as the repository answers, or on the branches up to the want-th to change where
   a want is given, which spares the requests a bigger plan would make. A tag is never one of them. */
export async function planPrune(facts: Facts, holds: Holds, want = Infinity): Promise<Plan> {
  const verdicts: Verdict[] = [];
  try {
    const holders = await holdersOf(facts, holds);
    const newest = Object.keys(facts.heads).filter(name => TURN_BRANCH.test(name) && facts.recorded.has(name)).sort((a, b) => turnNumber(b) - turnNumber(a));
    let changes = 0;
    for (const name of Object.keys(facts.heads).sort()) {
      const planned = await planOne(name, facts.heads[name]!, facts, holders, newest, holds);
      verdicts.push(planned);
      if (planned.action !== 'keep' && ++changes >= want) break;
    }
  } catch (error) {
    if (error instanceof GitHubRateLimited) return { verdicts, stopped: error.limit };
    throw error;
  }
  return { verdicts, stopped: null };
}
