import { randomUUID } from 'node:crypto';
import { AuthorCheckPin, AuthorCheckRun, docsOnly, type AuthorCheckDone } from '@hornhoof/protocol';
import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { jobs, subscriptions, taskEvents, tasks } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { identityOf, keyOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { captureReview } from './review-context.js';
import { pathInScope, ReviewSha } from './review-schema.js';
import { AUTHOR_CHECK_PASSED, routeOf, skippedAuthorReview, type Route } from './route-records.js';
import { loadTask, refuse, type Task, type Tx } from './state.js';
import { headOf, integrationTarget } from './turn-integration.js';

const Requested = z.strictObject({
  pin: AuthorCheckPin, routeRevision: z.number().int().positive(), node: z.string(), verifyCherryPick: z.boolean(),
});
const Receipt = z.strictObject({
  pin: AuthorCheckPin, routeRevision: z.number().int().positive(),
  crap: z.number().nonnegative().nullable(), cherryPick: ReviewSha.nullable(),
});
const Skip = z.strictObject({ receiptId: z.uuid(), candidateId: z.uuid(), reason: z.literal(AUTHOR_CHECK_PASSED) });
export type AuthorReviewSkip = z.infer<typeof Skip>;
type Reader = { db: Ctx['db'] | Tx };
type RepositoryReader = Reader & Partial<Pick<Ctx, 'config'>>;

function mayRequest(task: Task, route: Route, agentId: string): boolean {
  return task.assigneeAgentId === agentId && !task.paused && (task.status === 'open' || task.status === 'working')
    && route.state.resultKind === 'code' && route.state.stage === 'development' && route.state.phase === 'active'
    && route.state.stages.some(step => step.stage === 'review' && step.status === 'pending');
}

async function jobNode(ctx: Ctx, task: Task, agentId: string, jobId: string): Promise<NodeIdentity> {
  const [job] = await ctx.db.select({ nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, kind: subscriptions.kind }).from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId), eq(jobs.companyId, task.companyId), eq(jobs.taskId, task.id), eq(jobs.status, 'running')));
  const node = job && identityOf(job, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
  if (!node || !ctx.hub.isOnline(node)) throw refuse(409, 'task_invalid', 'The executing node is unavailable for an author check.');
  return node;
}

async function pinCheck(ctx: Ctx, task: Task, route: Route, agentId: string) {
  const target = await integrationTarget(ctx, task);
  const found = await repoAt(ctx, [task.productId, task.departmentId]);
  if (!target || !found || found.repo.url !== target.repo.url) throw refuse(409, 'repo_invalid', 'The task repository cannot be read.');
  const baseCommit = await headOf(ctx, target.repo, target.branch);
  const mainCommit = target.branch === target.repo.branch ? baseCommit : await headOf(ctx, target.repo, target.repo.branch);
  if (!baseCommit || !mainCommit) throw refuse(409, 'repo_invalid', 'The current turn or main branch could not be pinned.');
  const review = await captureReview(ctx, { ...task, executorAgentId: agentId }, { baseCommit });
  if (!review.source?.paths.every(path => pathInScope(path, route.paths))) throw refuse(403, 'task_not_yours', 'The candidate changes paths outside its approved scope.');
  const verifyCherryPick = !task.small && !docsOnly(review.source.paths);
  const repoUrlHash = hashToken(found.repo.url);
  return AuthorCheckRun.parse({
    type: 'author_check.run', requestId: randomUUID(),
    pin: { taskId: task.id, agentId, branch: review.branch, baseCommit, commit: review.commit, repoUrlHash, paths: review.source.paths },
    repo: { url: found.repo.url, token: found.repo.token },
    repositoryScope: { companyId: task.companyId, repositoryOwnerId: found.department.id, repoUrlHash },
    mainCommit, verifyCherryPick,
  });
}

const invalidRequest = () => refuse(409, 'task_invalid', 'Only the active Development owner of a code task with Review pending can request check:author.');

export async function requestAuthorCheck(ctx: Ctx, agentId: string, jobId: string, taskId: string) {
  const task = await loadTask(ctx.db, taskId);
  const route = await routeOf(ctx.db, task);
  if (!mayRequest(task, route, agentId)) throw invalidRequest();
  const node = await jobNode(ctx, task, agentId, jobId);
  const run = await pinCheck(ctx, task, route, agentId);
  await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(tasks).where(eq(tasks.id, task.id)).for('no key update');
    const held = await routeOf(tx, task);
    if (!current || held.revision !== route.revision || !mayRequest(current, held, agentId)) throw invalidRequest();
    const request: z.infer<typeof Requested> = { pin: run.pin, routeRevision: route.revision, node: keyOf(node), verifyCherryPick: run.verifyCherryPick };
    await tx.insert(taskEvents).values({ uuid: run.requestId, companyId: task.companyId, taskId, kind: 'comment', agentId,
      text: `Requested check:author on ${run.pin.commit} against ${run.pin.baseCommit}.`, data: { authorCheckRequest: request },
    });
  });
  if (!ctx.hub.send(node, run)) throw refuse(409, 'task_invalid', 'The node disconnected before it took the check. Request it again.');
  return { requestId: run.requestId, commit: run.pin.commit, baseCommit: run.pin.baseCommit };
}

async function connectedRequest(tx: Tx, task: Task, node: NodeIdentity, result: AuthorCheckDone) {
  const [asked] = await tx.select().from(taskEvents).where(and(eq(taskEvents.uuid, result.requestId),
    eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'comment')));
  const parsed = Requested.safeParse(asked?.data.authorCheckRequest);
  if (!parsed.success) return null;
  const request = parsed.data;
  if (asked?.agentId !== request.pin.agentId || request.node !== keyOf(node) || request.pin.commit !== result.commit) return null;
  const route = await routeOf(tx, task);
  return route.revision === request.routeRevision && mayRequest(task, route, request.pin.agentId) ? request : null;
}

export async function recordAuthorCheck(ctx: Reader, node: NodeIdentity, result: AuthorCheckDone): Promise<void> {
  await ctx.db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, result.taskId)).for('no key update');
    if (!task) return;
    const request = await connectedRequest(tx, task, node, result);
    if (!request) return;
    const [existing] = await tx.select({ id: taskEvents.id }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id),
      sql`${taskEvents.data}->>'authorCheckRequestId' = ${result.requestId}`)).limit(1);
    if (existing) return;
    const receipt: z.infer<typeof Receipt> = { pin: request.pin, routeRevision: request.routeRevision,
      crap: result.crap, cherryPick: request.verifyCherryPick ? result.cherryPick : null };
    await tx.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'comment',
      text: `check:author on ${result.commit}: ${result.crap === null ? 'no green receipt' : `CRAP ${result.crap}`}.`,
      data: { authorCheckReceipt: receipt, authorCheckRequestId: result.requestId },
    });
  });
}

function matches(receipt: z.infer<typeof Receipt>, task: Task, candidate: EchelonCandidate, repository: string): boolean {
  const { pin, routeRevision } = receipt;
  return routeRevision === candidate.revision - 1 && pin.taskId === task.id && pin.agentId === candidate.producedBy.agentId
    && pin.branch === candidate.branch && pin.baseCommit === candidate.baseCommit && pin.commit === candidate.commit
    && pin.repoUrlHash === repository && samePaths(pin.paths, candidate.paths);
}

function qualifies(task: Task, receipt: z.infer<typeof Receipt>): boolean {
  return receipt.crap !== null && receipt.crap < 10 && (task.small || docsOnly(receipt.pin.paths) || receipt.cherryPick !== null);
}

async function repositoryHash(ctx: RepositoryReader, task: Task): Promise<string | null> {
  if (!ctx.config) return null;
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  return found ? hashToken(found.repo.url) : null;
}

function samePaths(a: string[], b: string[]): boolean {
  return JSON.stringify(a.toSorted()) === JSON.stringify(b.toSorted());
}

function receiptRows(db: Reader['db'], task: Task) {
  return db.select({ uuid: taskEvents.uuid, data: taskEvents.data }).from(taskEvents).where(and(
    eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'comment'),
    isNull(taskEvents.agentId), isNull(taskEvents.personId), sql`${taskEvents.data} ? 'authorCheckReceipt'`,
  )).orderBy(desc(taskEvents.id));
}

export async function reviewSkip(ctx: RepositoryReader, task: Task, candidate: EchelonCandidate): Promise<AuthorReviewSkip | null> {
  if (candidate.producedBy.stage !== 'development') return null;
  const repository = await repositoryHash(ctx, task);
  if (!repository) return null;
  const events = await receiptRows(ctx.db, task);
  for (const event of events) {
    const receipt = Receipt.safeParse(event.data.authorCheckReceipt);
    if (!receipt.success || !matches(receipt.data, task, candidate, repository)) continue;
    return qualifies(task, receipt.data) ? { receiptId: event.uuid, candidateId: candidate.id, reason: AUTHOR_CHECK_PASSED } : null;
  }
  return null;
}

export async function requireAuthorReviewSkip(ctx: RepositoryReader, task: Task, route: Route, candidate: EchelonCandidate): Promise<void> {
  const step = skippedAuthorReview(route.state);
  if (!step) return;
  const [submitted] = await ctx.db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id),
    eq(taskEvents.companyId, task.companyId), eq(taskEvents.kind, 'submitted'), eq(taskEvents.agentId, candidate.producedBy.agentId),
    sql`${taskEvents.data}->'candidate'->>'id' = ${candidate.id}`)).orderBy(desc(taskEvents.id)).limit(1);
  const skip = Skip.safeParse(submitted?.data.authorCheckSkip);
  if (step.inputCandidateId === candidate.id && skip.success && skip.data.candidateId === candidate.id) {
    const repository = await repositoryHash(ctx, task);
    const events = await receiptRows(ctx.db, task);
    const receipt = Receipt.safeParse(events.find(event => event.uuid === skip.data.receiptId)?.data.authorCheckReceipt);
    if (repository && receipt.success && matches(receipt.data, task, candidate, repository) && qualifies(task, receipt.data)) return;
  }
  throw refuse(409, 'task_changed', 'The current candidate has no valid author-check receipt for its skipped Review.');
}
