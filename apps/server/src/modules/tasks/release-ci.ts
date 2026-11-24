import type { Ctx } from '../../app.js';
import { repoAt } from '../departments/repository.js';
import { commitProof, proofLine } from '../testruns/commit-proof.js';
import type { CiAt } from '../testruns/github-ci.js';
import { GitHubRateLimited } from '../testruns/github-limit.js';
import type { RepoAddress } from '../testruns/refs.js';
import { refuse, type Task } from './state.js';

/* What a release relies on instead of a run of Hornhoof's machines: the repository's own CI, as its host says it of the exact
   commit. green names how many checks passed; none is a repository with no CI at all, which records with no run. Nothing here
   takes a caller's word: the answer is the host's, read when the release is recorded. */
export type CiResult = { state: 'green'; checks: number } | { state: 'none' };

type Reading = Pick<Ctx, 'readCi'>;
/* What a card or an answer needs to say what CI says: the database, and where there is one, the server's config and reader. */
export type Said = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCi'>>;

/* The host's answer for commit, or an unread one where no reader is there or it failed. */
export async function readCiOf(ctx: Reading, repo: RepoAddress, commit: string): Promise<CiAt> {
  if (!ctx.readCi) return { state: 'unread', why: 'this server has no reader of the repository host' };
  try {
    return await ctx.readCi(repo, commit);
  } catch {
    return { state: 'unread', why: "the repository host didn't answer" };
  }
}

/* A check's link, where the host gave a plain one. */
const linked = (url: string | null) => (url ? ` (${url})` : '');
const checksOf = (count: number): string => `${count} ${count === 1 ? 'check' : 'checks'}`;

/* The answer in a sentence, for an approval card and for whoever is told why a release waits. */
export function ciLine(ci: CiAt): string {
  switch (ci.state) {
    case 'green': return `The repository's CI is green on this commit: ${checksOf(ci.checks)} passed.`;
    case 'none': return 'The repository has no CI.';
    case 'red': return `The repository's CI is red on this commit: check ${ci.check} ended with ${ci.outcome}${linked(ci.url)}.`;
    case 'pending': return `The repository's CI has not finished on this commit: ${ci.check} is ${ci.outcome}${linked(ci.url)}.`;
    case 'idle': return `The repository's CI ran ${checksOf(ci.checks)} on this commit and none succeeded: every one was skipped or neutral.`;
    case 'limited': return new GitHubRateLimited(ci.limit).message;
    case 'unread': return `The repository's CI could not be read now: ${ci.why}.`;
  }
}

/* The result in a few words, for the log and the note of an approval that went without a card. */
export const ciWords = (ci: CiResult): string => (ci.state === 'green' ? `the repository's CI was green with ${checksOf(ci.checks)}` : 'the repository has no CI');

/* The result a release or an approval may rest on, or null where the answer lets none. */
export function ciResult(ci: CiAt): CiResult | null {
  if (ci.state === 'green') return { state: 'green', checks: ci.checks };
  return ci.state === 'none' ? { state: 'none' } : null;
}

/* The CI of commit as a release records it: green or none, else a refusal that says what stopped it and records nothing. */
export async function requireCi(ctx: Reading, repo: RepoAddress, commit: string): Promise<CiResult> {
  const ci = await readCiOf(ctx, repo, commit);
  const result = ciResult(ci);
  if (result) return result;
  const unread = ci.state === 'unread' || ci.state === 'limited';
  throw unread
    ? refuse(409, 'repo_invalid', `${ciLine(ci)} Nothing was recorded for ${commit}. Try again.`)
    : refuse(409, 'task_invalid', `${ciLine(ci)} A release is recorded on the repository's green CI for its exact commit ${commit}, or where the repository has no CI. Record it again once CI is green on that commit.`);
}

/* What the repository's CI says of commit, in a sentence, as a card that asks for its approval says it; nothing where the task's
   place keeps no repository. */
async function ciSaid(ctx: Said, task: Pick<Task, 'productId' | 'departmentId'>, commit: string): Promise<{ line: string; decisive: boolean } | undefined> {
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]).catch(() => null) : null;
  if (!found) return undefined;
  const ci = await readCiOf(ctx, found.repo, commit);
  return { line: ciLine(ci), decisive: ['green', 'red', 'pending', 'idle'].includes(ci.state) };
}

/* What the checks of commit say, for whoever asks for an approval of it, gives it, or releases on it: the repository's CI, and
   the test runs that checked it where any did. */
export async function proofSaid(ctx: Said, task: Pick<Task, 'id' | 'companyId' | 'turnId' | 'departmentId' | 'productId'>, commit: string): Promise<string> {
  return proofLine(await commitProof(ctx.db, task, commit), await ciSaid(ctx, task, commit));
}
