import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { ciDispatches } from '../../db/schema.js';
import type { Dispatched } from '../testruns/github-dispatch.js';
import { GitHubRateLimited } from '../testruns/github-limit.js';
import type { RepoAddress } from '../testruns/refs.js';
import { refuse, type Task } from './state.js';

/* A release asked for on a commit no GitHub Actions run is on: the server starts the repository's release workflow on the turn
   branch itself, once for each commit, and keeps the request until CI says what it says of that exact commit. The minute round
   then records the release when CI is green, or ends the request with why it came to nothing, and the holder is told either way.
   Nothing here records a release from a caller's word: the round records through the same refusals as release_turn. */

type Starter = Pick<Ctx, 'db' | 'dispatchCi'>;
export type CiStarted = { workflow: string; run: number | null; url: string | null; again: boolean };

const noCiToStart = () => refuse(409, 'repo_invalid', 'This server has no way to start the repository\'s CI.');

/* Why CI was started before on this commit and came to no result: said to whoever asks again. */
const endedBefore = (commit: string, branch: string, note: string | null) =>
  refuse(409, 'task_invalid', `Hornhoof started CI on ${commit} before, once, as it does for each commit, and it ended with no result: ${note ?? 'no reason was kept'} Push a new commit to ${branch} and record that one.`);

type At = { task: Task; turnId: string; agentId: string; repo: RepoAddress; branch: string; commit: string; head: string | null };

/* The claim on the commit that says CI was started on it, taken at once for one caller only. A commit claimed before answers as
   its request stands: still waiting, or ended with no result. */
async function claim(ctx: Starter, at: At): Promise<{ id: string } | CiStarted> {
  const claimed = await ctx.db.insert(ciDispatches).values({ companyId: at.task.companyId, turnId: at.turnId, taskId: at.task.id, agentId: at.agentId, commit: at.commit, branch: at.branch, workflow: '' })
    .onConflictDoNothing({ target: [ciDispatches.companyId, ciDispatches.commit] }).returning({ id: ciDispatches.id });
  if (claimed[0]) return claimed[0];
  const [before] = await ctx.db.select().from(ciDispatches).where(and(eq(ciDispatches.companyId, at.task.companyId), eq(ciDispatches.commit, at.commit)));
  if (before?.state === 'waiting') return { workflow: before.workflow, run: before.runId, url: null, again: true };
  throw endedBefore(at.commit, at.branch, before?.note ?? null);
}

/* The refusal for a dispatch that started nothing, with why. */
function notStarted(sent: Exclude<Dispatched, { state: 'started' | 'unsure' }>): ReturnType<typeof refuse> {
  if (sent.state === 'limited') return refuse(409, 'repo_invalid', `${new GitHubRateLimited(sent.limit).message} Nothing was started.`);
  if (sent.state === 'unread') return refuse(409, 'repo_invalid', `${sent.why}. Nothing was started. Try again.`);
  return refuse(409, 'task_invalid', sent.state === 'unsupported' ? `The repository's CI can't be read: ${sent.why}. Nothing was started.` : `${sent.why} Nothing was started, and nothing is recorded.`);
}

/* Starts the release workflow on branch, whose head is commit, for the release the holder asks for, once for each commit. Where
   it was started before and still waits, says so; where GitHub refused, nothing stays kept and the refusal says why. */
export async function startCi(ctx: Starter, at: At): Promise<CiStarted> {
  const { commit, branch } = at;
  if (at.head !== commit) {
    throw refuse(409, 'task_changed', `No GitHub Actions run is on ${commit} yet, and ${branch} ${at.head ? `has gone on to ${at.head}` : 'could not be read'}: CI starts on the head of a branch only, so none can be started on ${commit}. Record the head of ${branch}${at.head ? ` (${at.head})` : ''} instead.`);
  }
  if (!ctx.dispatchCi) throw noCiToStart();
  const claimed = await claim(ctx, at);
  if ('again' in claimed) return claimed;
  const sent = await ctx.dispatchCi(at.repo, branch, commit).catch(() => ({ state: 'unread' as const, why: "the repository host didn't answer" }));
  if (sent.state !== 'started' && sent.state !== 'unsure') {
    await ctx.db.delete(ciDispatches).where(eq(ciDispatches.id, claimed.id));
    throw notStarted(sent);
  }
  const run = sent.state === 'started' ? sent : { run: null, url: null };
  await ctx.db.update(ciDispatches).set({ workflow: sent.workflow, runId: run.run }).where(eq(ciDispatches.id, claimed.id));
  return { workflow: sent.workflow, run: run.run, url: run.url, again: false };
}
