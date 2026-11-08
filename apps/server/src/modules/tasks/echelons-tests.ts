import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { candidateTestUnits, EnvironmentSnapshot, validateEnvironmentDescription } from '@hornhoof/protocol';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents, testParts, testRuns } from '../../db/schema.js';
import { currentCandidate } from './echelons-candidates.js';
import { changeRoute, type Route } from './echelons-store.js';
import { sameChecker } from './echelons-policy.js';
import { agentIdentity, departmentHead } from './echelons-assign.js';
import { requireCandidateRun } from './echelons-run.js';
import { ReviewSha } from './review-schema.js';
import { verifiedReuse } from './review-reuse.js';
import { productReceipt, scopeKey } from '../testruns/describe.js';
import { move, refuse, type Moved, type Task, type Tx } from './engine.js';

export const Verification = z.object({ candidateId: z.uuid(), revision: z.number().int().positive(), runIds: z.array(z.uuid()).min(1).max(100) }).strict();
export type Verification = z.infer<typeof Verification>;
const Verified = z.object({ candidateId: z.uuid(), commit: ReviewSha, routeRevision: z.number().int().positive(), testedRevision: z.number().int().positive(), evidence: z.array(z.object({ runId: z.uuid(), commit: ReviewSha })).min(1) });
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;

async function boundRuns(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[], testedRevision: number) {
  if (!ids.length || new Set(ids).size !== ids.length) throw refuse(409, 'task_invalid', 'Name distinct completed candidate runs.');
  const candidate = await currentCandidate(db, task, route);
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.companyId, task.companyId), eq(testRuns.taskId, task.id), inArray(testRuns.id, ids)));
  if (runs.length !== ids.length) throw refuse(409, 'task_invalid', 'A test run is missing or belongs to another task.');
  const testerId = route.state.stages.find(step => step.stage === 'tests')?.ownerAgentId ?? null;
  for (const run of runs) {
    await requireCandidateRun(db, task, candidate, testedRevision, testerId, run);
    if (run.kind !== 'tests' || run.commitSha !== candidate.commit || run.branch !== candidate.branch || !run.finishedAt) throw refuse(409, 'task_changed', 'A run does not verify the current candidate.');
  }
  return { candidate, runs };
}

async function candidateProductSnapshot(run: typeof testRuns.$inferSelect, candidate: EchelonCandidate): Promise<EnvironmentSnapshot> {
  try {
    const snapshot = EnvironmentSnapshot.parse(run.environmentSnapshot), request = run.environmentRequest;
    const { description } = snapshot, scope = description.repositoryScope;
    const profile = description.manifest.execution?.fullRun?.profile ?? description.manifest.defaultProfile;
    if (run.command !== '' || !request || request.problem || request.suite || (request.profile !== undefined && request.profile !== profile)
      || request.baseCommit !== candidate.baseCommit || snapshot.candidate?.baseCommit !== candidate.baseCommit
      || snapshot.profile !== profile || description.commitSha !== candidate.commit || run.environmentHash !== description.manifestHash
      || scope.companyId !== run.companyId || scope.repositoryOwnerId !== run.departmentId || scopeKey(scope) !== scopeKey(request.repositoryScope)) throw new Error('The run does not prove the bound candidate scope.');
    await validateEnvironmentDescription(description);
    candidateTestUnits(snapshot);
    return snapshot;
  } catch { throw refuse(409, 'task_invalid', 'Tests needs the bound base/final fingerprints and valid product environment evidence.'); }
}

/* Server-owned run and part rows prove the same final source; a status label alone proves nothing. */
export async function candidateRunEvidence(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[], testedRevision = route.revision) {
  const { candidate, runs } = await boundRuns(db, task, route, ids, testedRevision);
  for (const run of runs) {
    if (run.status !== 'passed') throw refuse(409, 'task_changed', 'A run did not pass.');
    const snapshot = await candidateProductSnapshot(run, candidate);
    const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
    const complete = run.parts > 0 ? parts.length === run.parts && parts.every((part, i) => part.companyId === task.companyId && part.part === i + 1 && part.status === 'passed' && part.commit === candidate.commit && part.exitCode === 0 && part.error === null) : await verifiedReuse(run);
    if (!complete) throw refuse(409, 'task_invalid', 'A run has incomplete, failed or mismatched parts and no complete reuse proof.');
    for (const part of parts) {
      const receipt = productReceipt(snapshot, part.environmentSelection, { type: 'tests.done', partId: part.id, ok: true, commit: part.commit, exitCode: part.exitCode, error: part.error, log: '',
        ...(part.environmentReceipt ? { environmentReceipt: part.environmentReceipt } : {}) }, snapshot.description.runtimeCapabilities);
      if (!part.finishedAt || !receipt) throw refuse(409, 'task_invalid', 'A passed part has no valid receipt for its assigned candidate selection.');
    }
  }
  return runs.map(run => ({ runId: run.id, commit: candidate.commit }));
}

const INFRASTRUCTURE = new Set(['no_machine', 'clone_failed', 'files_failed', 'timeout', 'cancelled', 'machine_restarted', 'machine_offline', 'machine_disconnected', 'subscription_removed', 'no_repository', 'commit_unavailable', 'runtime_missing', 'isolation_missing']);

async function failureKind(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[]): Promise<'content' | 'infrastructure'> {
  const { candidate, runs } = await boundRuns(db, task, route, ids, route.revision);
  let failed = false, content = false;
  for (const run of runs) {
    if (!['failed', 'passed', 'stopped'].includes(run.status)) throw refuse(409, 'task_invalid', 'The reported check has not ended.');
    const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
    if (!run.parts || parts.length !== run.parts) throw refuse(409, 'task_invalid', 'A failed check needs complete part results.');
    for (const [index, part] of parts.entries()) {
      if (part.companyId !== task.companyId || part.part !== index + 1 || !['passed', 'failed'].includes(part.status) || !part.finishedAt || (part.commit !== null && part.commit !== candidate.commit)) throw refuse(409, 'task_changed', 'A failed part is incomplete or belongs to another source.');
      if (part.status === 'passed') continue;
      if (run.status === 'passed') throw refuse(409, 'task_invalid', 'The run and failed part disagree.');
      failed = true;
      if (!INFRASTRUCTURE.has(part.error ?? '')) {
        if (part.commit !== candidate.commit || part.exitCode === null || part.exitCode === 0) throw refuse(409, 'task_invalid', 'A content failure needs the checked candidate and failing process result.');
        content = true;
      }
    }
  }
  if (!failed) throw refuse(409, 'task_invalid', 'No failed check was reported.');
  return content ? 'content' : 'infrastructure';
}

async function failedTestsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, input: Verification): Promise<Moved> {
  const kind = await failureKind(ctx.db, task, route, input.runIds);
  const headId = kind === 'content' ? await departmentHead(ctx.db, task) : null;
  const wakes = headId ? [{ agentId: headId, taskId: task.id, why: 'blocked' as const, text: summary }] : [];
  const state: Route['state'] = { ...route.state, phase: 'escalated', stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, reason: 'tests_failed' } : step) };
  const row = await move(ctx, task, { status: kind === 'content' ? 'blocked' : 'working', assigneeAgentId: kind === 'content' ? null : agentId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { failedVerification: { kind, candidateId: input.candidateId, routeRevision: route.revision, runIds: input.runIds } },
  }, async tx => {
    if (await failureKind(tx, task, route, input.runIds) !== kind) throw refuse(409, 'task_changed', 'The failed check changed.');
    if (kind === 'content') await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

export async function testsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, value: Verification | undefined, done = true): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current Tests owner can verify this candidate.');
  const input = Verification.safeParse(value);
  if (!input.success || input.data.candidateId !== route.state.candidateId || input.data.revision !== route.revision) throw refuse(409, 'task_changed', 'Name the exact current candidate and route revision.');
  const identity = await agentIdentity(ctx.db, task.companyId, agentId);
  if (!identity || !sameChecker(identity, route.state.assignment)) throw refuse(409, 'task_changed', 'The Tests assignment changed. Ask the head to assign it again.');
  if (!done) return failedTestsReport(ctx, task, route, agentId, summary, input.data);
  const headId = await departmentHead(ctx.db, task);
  const evidence = await candidateRunEvidence(ctx.db, task, route, input.data.runIds);
  const candidate = await currentCandidate(ctx.db, task, route);
  const wakes = [{ agentId: headId, taskId: task.id, why: 'reviewed' as const }];
  const state: Route['state'] = { ...route.state, phase: 'ready', assignment: null, stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, status: 'complete', candidateId: candidate.id } : step) };
  const row = await move(ctx, task, { status: 'open', assigneeAgentId: headId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { verifiedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, testedRevision: route.revision, evidence } },
  }, async tx => {
    await candidateRunEvidence(tx, task, route, input.data.runIds);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

export async function verifiedCandidateEvidence(db: Ctx['db'] | Tx, task: Task, route: Route, candidate: EchelonCandidate, verifiedRevision = route.revision) {
  const [event] = await db.select({ data: taskEvents.data, agentId: taskEvents.agentId }).from(taskEvents)
    .where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report'), sql`${taskEvents.data} ? 'verifiedCandidate'`)).orderBy(desc(taskEvents.id)).limit(1);
  const proof = Verified.safeParse(event?.data.verifiedCandidate);
  const tester = route.state.stages.find(step => step.stage === 'tests')?.ownerAgentId;
  if (!proof.success || event?.agentId !== tester || proof.data.candidateId !== candidate.id || proof.data.commit !== candidate.commit || proof.data.routeRevision !== verifiedRevision || proof.data.evidence.some(run => run.commit !== candidate.commit)) throw refuse(409, 'task_changed', 'The current candidate has no valid Tests report.');
  return candidateRunEvidence(db, task, route, proof.data.evidence.map(run => run.runId), proof.data.testedRevision);
}
