import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents } from '../../db/schema.js';
import { currentCandidate } from './echelons-candidates.js';
import { changeRoute, type Route } from './echelons-store.js';
import { checkingIdentity, departmentHead, heldCheckingIdentity } from './echelons-assign.js';
import { ReviewSha } from './review-schema.js';
import { move, refuse, type Moved, type Task, type Tx } from './engine.js';

export const Verification = z.object({ candidateId: z.uuid(), revision: z.number().int().positive() }).strict();
export type Verification = z.input<typeof Verification>;
/* Reports made before checks went local also name test runs, which are left out. */
const Verified = z.object({ candidateId: z.uuid(), commit: ReviewSha, routeRevision: z.number().int().positive() });
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;

/* A failed check goes to the head with the candidate: Tests checks it locally, and only the release runs the full suite. */
async function failedTestsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, candidate: EchelonCandidate): Promise<Moved> {
  const headId = await departmentHead(ctx.db, task);
  const wakes = [{ agentId: headId, taskId: task.id, why: 'blocked' as const, text: summary }];
  const state: Route['state'] = { ...route.state, phase: 'escalated', stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, reason: 'tests_failed' } : step) };
  const row = await move(ctx, task, { status: 'blocked', assigneeAgentId: null, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { failedVerification: { candidateId: candidate.id, routeRevision: route.revision } }, returned: true,
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, candidate);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

export async function testsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, value: Verification | undefined, done = true): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current Tests owner can verify this candidate.');
  const input = Verification.safeParse(value);
  if (!input.success || input.data.candidateId !== route.state.candidateId || input.data.revision !== route.revision) throw refuse(409, 'task_changed', 'Name the exact current candidate and route revision.');
  const candidate = await currentCandidate(ctx.db, task, route);
  await checkingIdentity({ db: ctx.db }, task, route, candidate);
  if (!done) return failedTestsReport(ctx, task, route, agentId, summary, candidate);
  const headId = await departmentHead(ctx.db, task);
  const wakes = [{ agentId: headId, taskId: task.id, why: 'reviewed' as const }];
  const state: Route['state'] = { ...route.state, phase: 'ready', assignment: null, stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, status: 'complete', candidateId: candidate.id } : step) };
  const row = await move(ctx, task, { status: 'open', assigneeAgentId: headId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { verifiedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, testedRevision: route.revision } }, returned: true,
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, candidate);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

/* The current candidate has its Tests owner's report, where the route of its department has Tests. */
export async function requireTestsReport(db: Ctx['db'] | Tx, task: Task, route: Route, candidate: EchelonCandidate, verifiedRevision = route.revision): Promise<void> {
  if (!route.state.stages.some(step => step.stage === 'tests' && step.status !== 'skipped')) return;
  const [event] = await db.select({ data: taskEvents.data, agentId: taskEvents.agentId }).from(taskEvents)
    .where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report'), sql`${taskEvents.data} ? 'verifiedCandidate'`)).orderBy(desc(taskEvents.id)).limit(1);
  const proof = Verified.safeParse(event?.data.verifiedCandidate);
  const tester = route.state.stages.find(step => step.stage === 'tests')?.ownerAgentId;
  if (!proof.success || event?.agentId !== tester || proof.data.candidateId !== candidate.id || proof.data.commit !== candidate.commit || proof.data.routeRevision !== verifiedRevision) {
    throw refuse(409, 'task_changed', 'The current candidate has no valid Tests report.');
  }
}
