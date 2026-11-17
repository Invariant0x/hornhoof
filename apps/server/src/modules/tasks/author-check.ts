import { randomUUID } from 'node:crypto';
import { AuthorCheckRequest, AuthorCheckDone, sameAuthorCheck } from '@hornhoof/protocol';
import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, subscriptions, taskEvents, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { identityOf, keyOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';
import { repoAt } from '../departments/repository.js';
import { authorCheckAllowsReviewSkip } from './author-check-policy.js';
import { loadTask, refuse, type Task, type Tx } from './engine.js';
import { routeOf, type Route } from './echelons-store.js';
import { captureReview } from './review-context.js';
import { pathInScope } from './review-schema.js';
import { headOf, integrationTarget } from './turn-integration.js';

type Reader = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config'>>;

function requireAuthor(task: Task, route: Route, agentId: string): void {
  if (task.assigneeAgentId !== agentId || task.paused || !['open', 'working'].includes(task.status)) throw refuse(409, 'task_not_yours', 'Only the active Development owner may request an author check.');
  if (route.state.resultKind !== 'code' || route.state.stage !== 'development' || route.state.phase !== 'active') throw refuse(409, 'task_invalid', 'Author receipts apply only to a code candidate at Development.');
}

async function assignedNode(ctx: Ctx, task: Task, agentId: string, jobId: string): Promise<NodeIdentity> {
  const [job] = await ctx.db.select({ nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, kind: subscriptions.kind }).from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId), eq(jobs.companyId, task.companyId), eq(jobs.status, 'running')));
  const node = job && identityOf(job, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
  if (!node || !ctx.hub.isOnline(node)) throw refuse(409, 'task_invalid', 'The executing node is unavailable for an author check.');
  return node;
}

/* The only public input is a task. Repository, comparison, SHA and command are chosen here, before submit. */
export async function requestAuthorCheck(ctx: Ctx, agentId: string, jobId: string, taskId: string): Promise<AuthorCheckRequest> {
  const task = await loadTask(ctx.db, taskId), route = await routeOf(ctx.db, task);
  requireAuthor(task, route, agentId);
  const node = await assignedNode(ctx, task, agentId, jobId);
  const target = await integrationTarget(ctx, task);
  const base = target && await headOf(ctx, target.repo, target.branch);
  if (!base) throw refuse(409, 'repo_invalid', 'The target branch base cannot be read.');
  const review = await captureReview(ctx, task, { baseCommit: base });
  if (!review.source!.paths.every(path => pathInScope(path, route.paths))) throw refuse(403, 'task_not_yours', 'The candidate changes paths outside the approved scope.');
  const request = AuthorCheckRequest.parse({ type: 'author_check.run', requestId: randomUUID(), jobId, agentId, taskId,
    repoUrl: target!.repo.url, branch: review.branch, baseCommit: base, commit: review.commit, paths: review.source!.paths });
  await ctx.db.transaction(async tx => {
    const [current] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('no key update');
    const currentRoute = await routeOf(tx, task);
    requireAuthor(current!, currentRoute, agentId);
    if (currentRoute.revision !== route.revision) throw refuse(409, 'task_changed', 'The task changed while the author check was pinned.');
    await tx.insert(taskEvents).values({ uuid: request.requestId, companyId: task.companyId, taskId, kind: 'comment', agentId,
      text: `Requested check:author on ${request.commit} against ${base}.`, data: { authorCheckRequest: request, node: keyOf(node), routeRevision: route.revision } });
  });
  ctx.hub.send(node, request);
  return request;
}

/* Completion is reachable only from the authenticated node message handler, never from an agent's tool. */
async function requestedRoute(tx: Tx, task: Task, node: NodeIdentity, result: AuthorCheckDone): Promise<Route | null> {
  const [asked] = await tx.select().from(taskEvents).where(and(eq(taskEvents.uuid, result.requestId), eq(taskEvents.taskId, task.id), eq(taskEvents.companyId, task.companyId)));
  const request = AuthorCheckRequest.safeParse(asked?.data.authorCheckRequest);
  if (!request.success || asked!.data.node !== keyOf(node) || !sameAuthorCheck(request.data, result)) return null;
  const route = await routeOf(tx, task);
  return route.revision === asked!.data.routeRevision && task.assigneeAgentId === result.agentId ? route : null;
}

async function firstCompletion(tx: Tx, task: Task, result: AuthorCheckDone): Promise<boolean> {
  const [existing] = await tx.select(only(taskEvents, 'id')).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), sql`${taskEvents.data}->'authorCheck'->>'requestId' = ${result.requestId}`));
  return !existing && result.finishedAt >= result.startedAt;
}

export async function recordAuthorCheck(ctx: Pick<Ctx, 'db'>, node: NodeIdentity, value: AuthorCheckDone): Promise<void> {
  const parsed = AuthorCheckDone.safeParse(value);
  if (!parsed.success) return;
  const result = parsed.data;
  await ctx.db.transaction(async tx => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, result.taskId)).for('no key update');
    if (!task) return;
    const route = await requestedRoute(tx, task, node, result);
    if (!route || !await firstCompletion(tx, task, result)) return;
    await tx.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'comment',
      text: `check:author on ${result.commit}: exit ${result.exitCode ?? 'unknown'}, ${result.reason ?? result.crap.kind}.`,
      data: { authorCheck: result, node: keyOf(node), routeRevision: route.revision } });
  });
}

function matchesCandidate(receipt: AuthorCheckDone, candidate: EchelonCandidate, repo: string): boolean {
  return receipt.repoUrl === repo && receipt.commit === candidate.commit && receipt.baseCommit === candidate.baseCommit
    && receipt.branch === candidate.branch && receipt.agentId === candidate.producedBy.agentId
    && JSON.stringify([...receipt.paths].sort()) === JSON.stringify([...candidate.paths].sort());
}

export async function authorReceiptFor(ctx: Reader, task: Task, route: Route, candidate: EchelonCandidate): Promise<string | null> {
  if (!ctx.config || route.state.stage !== 'development') return null;
  const repo = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  if (!repo) return null;
  const events = await ctx.db.select().from(taskEvents).where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id),
    isNull(taskEvents.agentId), isNull(taskEvents.personId), sql`${taskEvents.data} ? 'authorCheck'`)).orderBy(desc(taskEvents.id));
  for (const event of events) {
    const result = AuthorCheckDone.safeParse(event.data.authorCheck);
    if (!result.success || event.data.routeRevision !== route.revision || !matchesCandidate(result.data, candidate, repo.repo.url)) continue;
    if (authorCheckAllowsReviewSkip(task.small, candidate.paths, result.data)) return event.uuid;
    return null;
  }
  return null;
}
