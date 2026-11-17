import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { repoAt } from '../departments/repository.js';
import type { RepoAddress } from '../testruns/refs.js';
import { checkingIdentity, heldCheckingIdentity } from './echelons-assign.js';
import { currentCandidate, producedCandidate } from './echelons-candidates.js';
import type { Submission, submissionOperation } from './echelons-operations.js';
import { sameChecker, type CheckerIdentity } from './echelons-policy.js';
import { changeRoute, type Route } from './echelons-store.js';
import { move, refuse, type Moved, type Task } from './engine.js';
import { captureReview, exactComparison, type Review } from './review-context.js';

/* A candidate whose own change passed and that only needs the main line stays at
   Tests: its owner merges the main line into the candidate's branch, hands the merge in here and checks it again. */

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;
type Repository = { readCompare: NonNullable<Reader['readCompare']>; readCommit: NonNullable<Reader['readCommit']>; repo: RepoAddress & { branch: string } };

/* The paths from base to head, when head holds base; anything else proves nothing. */
async function changedPaths(at: Repository, base: string, head: string): Promise<string[]> {
  let compared: Awaited<ReturnType<Repository['readCompare']>> | null = null;
  try { compared = await at.readCompare(at.repo, { base, head }, 10_000); }
  catch { /* An unreadable comparison is refused below. */ }
  if (!compared || !exactComparison(compared, base, head)) throw refuse(409, 'task_changed', `${head} does not hold ${base}, or the change between them could not be read.`);
  return compared.paths;
}

async function mainHead(at: Repository): Promise<string> {
  let head: Awaited<ReturnType<Repository['readCommit']>> | null = null;
  try { head = await at.readCommit(at.repo, { branch: at.repo.branch }, 5_000); }
  catch { /* An unreadable main line is refused below. */ }
  if (!head || 'problem' in head) throw refuse(409, 'repo_invalid', `The main line ${at.repo.branch} could not be read. Try again.`);
  return head.commitSha;
}

async function repository(ctx: Reader, task: Task): Promise<Repository> {
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]) : null;
  if (!found || !ctx.readCompare || !ctx.readCommit) throw refuse(409, 'repo_invalid', 'The repository cannot be read here, so taking the main line in cannot be verified.');
  return { readCompare: ctx.readCompare, readCommit: ctx.readCommit, repo: found.repo };
}

/* The merge keeps the branch and the candidate it replaces, its base moves along the main line, and it changes nothing the
   main line did not bring: a base off the main line would hide the candidate's own change from the checks. */
async function requireMainTaken(ctx: Reader, task: Task, parent: EchelonCandidate, candidate: EchelonCandidate): Promise<void> {
  if (candidate.branch !== parent.branch) throw refuse(409, 'task_changed', 'Taking the main line in keeps the candidate branch.');
  if (candidate.baseCommit === parent.baseCommit) throw refuse(409, 'task_invalid', 'Name the newer main commit you took in as review.baseCommit.');
  const at = await repository(ctx, task);
  const brought = new Set(await changedPaths(at, parent.baseCommit, candidate.baseCommit));
  await changedPaths(at, candidate.baseCommit, await mainHead(at));
  const beyond = (await changedPaths(at, parent.commit, candidate.commit)).filter(path => !brought.has(path));
  if (beyond.length) throw refuse(409, 'task_invalid', `The merge changes what the main line did not bring: ${beyond.join(', ')}. Take in only the main line; a failed check of the candidate's own change is reported with done false.`);
}

export async function keepCandidateAtTests(
  ctx: Reader,
  agentId: string,
  task: Task,
  route: Route,
  parent: EchelonCandidate,
  identity: CheckerIdentity,
  candidate: EchelonCandidate,
  review: Review,
  input: Submission,
  operation: ReturnType<typeof submissionOperation>,
  detail: Record<string, unknown>,
): Promise<Moved> {
  const row = await move(ctx, task, { silent: 0 }, {
    kind: 'submitted', actor: { agentId }, text: input.summary,
    data: { evidence: input.evidence, candidate, ...detail, ...(operation ? { operation } : {}), routeRevision: route.revision, review },
  }, async tx => {
    if (!sameChecker(await heldCheckingIdentity(tx, task, route, parent), identity)) throw refuse(409, 'task_changed', 'The checking assignment changed. Ask the head to assign it again.');
    await changeRoute(tx, route, { ...route.state, candidateId: candidate.id });
  });
  return { task: row, wakes: [] };
}

export async function takeMainAtTests(ctx: Reader, agentId: string, task: Task, route: Route, input: Submission, operation: ReturnType<typeof submissionOperation>): Promise<Moved> {
  const parent = await currentCandidate(ctx.db, task, route);
  const identity = await checkingIdentity(ctx, task, route, parent);
  const review = await captureReview(ctx, { ...task, executorAgentId: agentId }, input.review, parent.branch);
  const candidate = producedCandidate(route, identity, review);
  await requireMainTaken(ctx, task, parent, candidate);
  return keepCandidateAtTests(ctx, agentId, task, route, parent, identity, candidate, review, input, operation, {
    tookMain: { from: parent.baseCommit, to: candidate.baseCommit },
  });
}
