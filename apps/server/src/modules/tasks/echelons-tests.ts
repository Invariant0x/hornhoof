import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, testParts, testRuns } from '../../db/schema.js';
import { currentCandidate } from './echelons-candidates.js';
import { changeRoute, type Route } from './echelons-store.js';
import { sameChecker } from './echelons-policy.js';
import { agentIdentity } from './echelons-assign.js';
import { requireCandidateRun } from './echelons-run.js';
import { verifiedReuse } from './review-reuse.js';
import { move, refuse, type Moved, type Task, type Tx } from './engine.js';

export const Verification = z.object({ candidateId: z.uuid(), revision: z.number().int().positive(), runIds: z.array(z.uuid()).min(1).max(100) }).strict();
export type Verification = z.infer<typeof Verification>;
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;

/* Server-owned run and part rows prove the same final source; a status label alone proves nothing. */
export async function candidateRunEvidence(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[], testedRevision = route.revision) {
  if (!ids.length || new Set(ids).size !== ids.length) throw refuse(409, 'task_invalid', 'Name distinct completed candidate runs.');
  const candidate = await currentCandidate(db, task, route);
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.companyId, task.companyId), eq(testRuns.taskId, task.id), inArray(testRuns.id, ids)));
  if (runs.length !== ids.length) throw refuse(409, 'task_invalid', 'A test run is missing or belongs to another task.');
  const testerId = route.state.stages.find(step => step.stage === 'tests')?.ownerAgentId ?? null;
  for (const run of runs) {
    await requireCandidateRun(db, task, candidate, testedRevision, testerId, run);
    if (run.kind !== 'tests' || run.commitSha !== candidate.commit || run.branch !== candidate.branch || run.status !== 'passed' || !run.finishedAt) throw refuse(409, 'task_changed', 'A run does not verify the current candidate.');
    const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
    const complete = run.parts > 0 ? parts.length === run.parts && parts.every((part, i) => part.companyId === task.companyId && part.part === i + 1 && part.status === 'passed' && part.commit === candidate.commit && part.exitCode === 0 && part.error === null) : await verifiedReuse(run);
    if (!complete) throw refuse(409, 'task_invalid', 'A run has incomplete, failed or mismatched parts and no complete reuse proof.');
  }
  return runs.map(run => ({ runId: run.id, commit: candidate.commit }));
}

export async function testsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, value: Verification | undefined): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current Tests owner can verify this candidate.');
  const input = Verification.safeParse(value);
  if (!input.success || input.data.candidateId !== route.state.candidateId || input.data.revision !== route.revision) throw refuse(409, 'task_changed', 'Name the exact current candidate and route revision.');
  const identity = await agentIdentity(ctx.db, task.companyId, agentId);
  if (!identity || !sameChecker(identity, route.state.assignment)) throw refuse(409, 'task_changed', 'The Tests assignment changed. Ask the head to assign it again.');
  const [head] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, task.companyId), eq(agents.departmentId, task.departmentId!), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).limit(1);
  if (!head) throw refuse(409, 'task_invalid', 'The department needs a head to accept the checked candidate.');
  const evidence = await candidateRunEvidence(ctx.db, task, route, input.data.runIds);
  const candidate = await currentCandidate(ctx.db, task, route);
  const wakes = [{ agentId: head.id, taskId: task.id, why: 'reviewed' as const }];
  const state: Route['state'] = { ...route.state, phase: 'ready', assignment: null, stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, status: 'complete', candidateId: candidate.id } : step) };
  const row = await move(ctx, task, { status: 'open', assigneeAgentId: head.id, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { verifiedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, testedRevision: route.revision, evidence } },
  }, async tx => {
    await candidateRunEvidence(tx, task, route, input.data.runIds);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}
