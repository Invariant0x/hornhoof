import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requests, turns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { NO_DEPARTMENT_CHECKER } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { changeRoute, type Route } from './echelons-store.js';
import { testedEvidence } from './echelons-tests.js';
import { requireTaskHead } from './echelons-update.js';
import { giver, move, refuse, type Moved, type Task, type Tx } from './engine.js';
import { exactComparison } from './review-context.js';
import { ReviewSha } from './review-schema.js';

export const AcceptanceInput = z.object({ candidateId: z.uuid(), revision: z.number().int().positive(), integrationCommit: ReviewSha }).strict();
export type AcceptanceInput = z.infer<typeof AcceptanceInput>;

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;

export function requiredStagesComplete(route: Route): boolean {
  /* Review and Tests are never skipped where the route has them, unless nobody in the department can do them, and Security
     not once it is required. */
  const mayBeSkipped = (step: Route['state']['stages'][number]) => !(step.stage === 'security' && route.state.security.required)
    && (step.reason === NO_DEPARTMENT_CHECKER || (step.stage !== 'review' && step.stage !== 'tests'));
  return route.state.stages.every(step => step.status === 'complete' || (step.status === 'skipped' && mayBeSkipped(step)));
}

function requireReady(route: Route, input: AcceptanceInput): void {
  if (route.state.resultKind !== 'code' || route.state.phase !== 'ready' || !requiredStagesComplete(route)) throw refuse(409, 'task_invalid', 'The required stages have not verified this result.');
  if (input.candidateId !== route.state.candidateId || input.revision !== route.revision) throw refuse(409, 'task_changed', 'Name the exact ready candidate and route revision.');
}


async function mainApproval(db: Ctx['db'] | Tx, task: Task, commit: string): Promise<string> {
  const [approval] = await db.select({ id: requests.id }).from(requests).where(and(eq(requests.companyId, task.companyId), eq(requests.taskId, task.id),
    eq(requests.kind, 'approval'), eq(requests.status, 'approved'), eq(requests.commit, commit), isNotNull(requests.answeredBy), isNotNull(requests.answeredAt))).limit(1);
  if (!approval) throw refuse(403, 'decision_not_allowed', 'Main acceptance needs the authorized human approval of this exact integration commit.');
  return approval.id;
}

async function integrationBranch(db: Ctx['db'], task: Task): Promise<string> {
  if (!task.turnId) return 'main';
  const [turn] = await db.select({ number: turns.number }).from(turns).where(and(eq(turns.id, task.turnId), eq(turns.companyId, task.companyId)));
  if (!turn) throw refuse(409, 'task_invalid', 'The integration turn is unavailable.');
  return `turn-${turn.number}`;
}

type ObservedHead = Awaited<ReturnType<Ctx['readCommit']>>;
type Repository = Parameters<Ctx['readCommit']>[0];

function matchesObservedHead(value: ObservedHead, branch: string, commit: string): boolean {
  return !('problem' in value) && value.branch === branch && value.commitSha === commit;
}

async function requireInclusion(ctx: Reader, repository: Repository, candidate: string, integration: string): Promise<void> {
  if (integration === candidate) return;
  const comparison = await ctx.readCompare?.(repository, { base: candidate, head: integration }, 10_000);
  if (!comparison || !exactComparison(comparison, candidate, integration)) throw new Error('inclusion unproved');
}

/* Read-only proof of an integration already performed through the authorized Git route. */
async function observedIntegration(ctx: Reader, task: Task, candidate: EchelonCandidate, input: AcceptanceInput) {
  if (!ctx.config || !ctx.readCommit) throw refuse(409, 'repo_invalid', 'The repository integration cannot be verified.');
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  if (!found) throw refuse(409, 'repo_invalid', 'The result has no repository to verify.');
  const branch = await integrationBranch(ctx.db, task);
  const approval = branch === 'main' ? await mainApproval(ctx.db, task, input.integrationCommit) : null;
  try {
    const source = await ctx.readCommit(found.repo, { branch: candidate.branch }, 5_000);
    const target = await ctx.readCommit(found.repo, { branch }, 5_000);
    if (!matchesObservedHead(source, candidate.branch, candidate.commit) || !matchesObservedHead(target, branch, input.integrationCommit)) throw new Error('stale integration');
    await requireInclusion(ctx, found.repo, candidate.commit, input.integrationCommit);
  } catch { throw refuse(409, 'task_changed', 'The source or integration changed, or candidate inclusion cannot be verified.'); }
  return { branch, commit: input.integrationCommit, approval, observedAt: new Date().toISOString() };
}

export async function acceptCandidate(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, value: AcceptanceInput | undefined): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', 'Only the current accepting owner may close this candidate.');
  await requireTaskHead(ctx, task, agentId);
  const input = AcceptanceInput.safeParse(value);
  if (!input.success) throw refuse(400, 'task_invalid', 'Acceptance needs the candidate, route revision and exact integration commit.');
  requireReady(route, input.data);
  const candidate = await currentCandidate(ctx.db, task, route);
  const evidence = await testedEvidence(ctx.db, task, route, candidate);
  const integration = await observedIntegration(ctx, task, candidate, input.data);
  const wakes = giver(task, 'done', agentId, summary);
  const row = await move(ctx, task, { status: 'done', assigneeAgentId: null, closedAt: new Date(), silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { done: true, acceptedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, evidence, integration } }, returned: true,
  }, async tx => {
    await requireTaskHead({ db: tx }, task, agentId);
    await testedEvidence(tx, task, route, candidate);
    if (integration.branch === 'main') await mainApproval(tx, task, integration.commit);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
  }, wakes);
  return { task: row, wakes };
}
