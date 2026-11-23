import type { RateLimit } from '../testruns/github-limit.js';
import type { RepoAddress } from '../testruns/refs.js';
import { planPrune, type Facts, type Holds, type Verdict } from './prune-plan.js';
import { pushRefs, refusalOf, REFS_PER_PUSH, type Push, type RefUpdate } from './ref-push.js';

/* A repository's branches pruned by what the plan says (#1964): a branch whose work a turn, main or tag holds is deleted; one
   of a closed task that nothing holds goes to a hidden ref first and is deleted after, so it can come back. */

/* How many branches one run changes at most, so a repository of thousands is done in turns, gently. */
export const BATCH = 50;

/* The hidden ref an unmerged branch of a closed task is kept at, and the one command that brings it back. */
export const archiveRef = (branch: string): string => `refs/hornhoof/archive/${branch}`;
export const restoreCommand = (branch: string): string => `git fetch origin ${archiveRef(branch)} && git push origin FETCH_HEAD:refs/heads/${branch}`;

/* What was done to one branch: it is gone (deleted), or kept at its archive and gone (archived), or the repository refused. */
export type Entry = Verdict & { done: 'deleted' | 'archived' | 'refused'; problem?: string };
export type Stopped = { why: 'batch' } | { why: 'budget' } | { why: 'limit'; resetAt: string | null } | { why: 'unreadable'; problem: string };
export type Pruned = { verdicts: Verdict[]; entries: Entry[]; stopped: Stopped | null };
export type Deps = {
  facts: () => Promise<Facts | { problem: string }>;
  holds: Holds;
  push: Push;
  /* Every branch deleted or archived, as it is done: the task's log keeps it with the branch, its head and the reason. */
  record: (entry: Entry) => Promise<void>;
};

const chunks = <T,>(items: readonly T[]): T[][] => Array.from({ length: Math.ceil(items.length / REFS_PER_PUSH) }, (_, i) => items.slice(i * REFS_PER_PUSH, (i + 1) * REFS_PER_PUSH));

/* What each ref of the updates came to: none where it was changed. A push that came to nothing refuses all of them. */
async function pushAll(push: Push, updates: readonly RefUpdate[]): Promise<Map<string, string | null>> {
  const done = new Map<string, string | null>();
  for (const chunk of chunks(updates)) {
    const pushed = await push(chunk);
    for (const { ref } of chunk) done.set(ref, refusalOf(pushed, ref));
  }
  return done;
}

const headRef = (branch: string) => `refs/heads/${branch}`;

const refused = (v: Verdict, problem: string): Entry => ({ ...v, done: 'refused', problem });

/* What was done to one branch, from what each push said of its refs. */
function entryOf(v: Verdict, archived: Map<string, string | null>, deleted: Map<string, string | null>): Entry {
  const notArchived = v.action === 'archive' ? archived.get(archiveRef(v.branch)) : null;
  if (notArchived !== null) return refused(v, `its archive was not made: ${notArchived ?? 'it was not tried'}`);
  const notDeleted = deleted.get(headRef(v.branch));
  if (notDeleted === null) return { ...v, done: v.action === 'archive' ? 'archived' : 'deleted' };
  return refused(v, notDeleted ?? 'it was not tried');
}

/* The archives of the branches to archive, then the deletion of those archived and of those to delete, each ref moved only
   from the commit the plan saw: a branch that moved since, or that is gone, is kept. */
async function applyAll(todo: readonly Verdict[], push: Push): Promise<Entry[]> {
  const archives = todo.filter(v => v.action === 'archive');
  const archived = await pushAll(push, archives.map(v => ({ ref: archiveRef(v.branch), old: null, next: v.head })));
  const going = todo.filter(v => v.action === 'delete' || archived.get(archiveRef(v.branch)) === null);
  const deleted = await pushAll(push, going.map(v => ({ ref: headRef(v.branch), old: v.head, next: null })));
  return todo.map(v => entryOf(v, archived, deleted));
}

const limitStop = (limit: RateLimit): Stopped => ({ why: 'limit', resetAt: limit.resetAt === null ? null : new Date(limit.resetAt).toISOString() });

/* How many requests to GitHub one run makes at most, so the pruning of a repository of thousands of branches stays well inside
   the hour's limit of the account it shares with everything else Hornhoof reads. */
export const BUDGET = 300;

/* The reader of what a commit holds, asking at most budget times and the same question once: past that it says it could not
   read, and the branch asked about is kept. spent says whether it ran out. */
function budgeted(holds: Holds, budget: number): { holds: Holds; spent: () => boolean } {
  const answers = new Map<string, Promise<boolean | null>>();
  let asked = 0;
  let spent = false;
  return {
    spent: () => spent,
    holds: (holder, head) => {
      const key = `${holder} ${head}`;
      const known = answers.get(key);
      if (known) return known;
      if (asked >= budget) {
        spent = true;
        return Promise.resolve(null);
      }
      asked += 1;
      const answer = holds(holder, head);
      answers.set(key, answer);
      return answer;
    },
  };
}

/* One run over one repository: the plan, and with apply the first limit changes of it, recorded one by one. Without apply it
   changes nothing and says what it would. It never touches a ref the plan did not name, and never a tag or main. */
export async function pruneRepository(deps: Deps, { apply, limit = BATCH, budget = Infinity }: { apply: boolean; limit?: number; budget?: number }): Promise<Pruned> {
  const read = await deps.facts();
  if ('problem' in read) return { verdicts: [], entries: [], stopped: { why: 'unreadable', problem: read.problem } };
  const reader = budgeted(deps.holds, budget);
  const { verdicts, stopped } = await planPrune(read, reader.holds, apply ? limit + 1 : Infinity);
  const rest = stopped ? limitStop(stopped) : reader.spent() ? { why: 'budget' as const } : null;
  if (!apply) return { verdicts, entries: [], stopped: rest };
  const work = verdicts.filter(v => v.action !== 'keep');
  const entries = await applyAll(work.slice(0, limit), deps.push);
  for (const entry of entries) await deps.record(entry);
  return { verdicts, entries, stopped: rest ?? (work.length > limit ? { why: 'batch' } : null) };
}

/* The refs of the repository as it advertises them, by name, or why it could not. */
export type RefsReader = () => Promise<Record<string, string> | { problem: string }>;

/* Brings an archived branch back at its head, only where the repository has no such branch now. */
export async function restoreBranch(repo: RepoAddress, branch: string, refs: RefsReader, push: Push = updates => pushRefs(repo, updates)): Promise<{ restored: string } | { problem: string }> {
  const read = await refs();
  if ('problem' in read) return { problem: read.problem };
  const head = read[archiveRef(branch)];
  if (!head) return { problem: `There is no archive of ${branch}.` };
  const pushed = await push([{ ref: headRef(branch), old: null, next: head }]);
  const why = refusalOf(pushed, headRef(branch));
  return why ? { problem: `${branch} was not restored: ${why}` } : { restored: head };
}

