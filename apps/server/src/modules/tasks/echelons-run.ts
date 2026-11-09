import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents, tasks } from '../../db/schema.js';
import { checkingIdentity, heldCheckingIdentity } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { routeOf, type Route } from './echelons-store.js';
import { note, refuse, type Task, type Tx } from './engine.js';

export const EchelonRun = z.object({ candidateId: z.uuid(), revision: z.number().int().positive() }).strict();
export type EchelonRun = z.infer<typeof EchelonRun>;
const Binding = z.object({ runId: z.uuid(), candidateId: z.uuid(), routeRevision: z.number().int().positive(), baseCommit: z.string(), commit: z.string(), branch: z.string(), testerId: z.uuid() }).strict();
type Reader = Ctx['db'] | Tx;
export type CandidateRun = Omit<z.infer<typeof Binding>, 'runId'>;

function requireCurrentRequest(route: Route, input: EchelonRun | undefined): void {
  const request = EchelonRun.safeParse(input);
  if (route.state.phase !== 'active' || !request.success || request.data.candidateId !== route.state.candidateId || request.data.revision !== route.revision) throw refuse(409, 'task_changed', 'Name the exact current Tests candidate and route revision.');
}

function requireCandidateBranch(branch: string | undefined, expected: string): void {
  if (branch !== undefined && branch !== expected) throw refuse(409, 'task_changed', 'Tests must run the current candidate branch.');
}

export async function candidateForRun(db: Reader, task: Task, agentId: string, input: { candidate?: EchelonRun; branch?: string }, kind: 'tests' | 'work'): Promise<CandidateRun | null> {
  if (kind !== 'tests') return null;
  const route = await routeOf(db, task);
  if (route.state.stage !== 'tests') {
    if (input.candidate) throw refuse(409, 'task_changed', 'The task is not at Tests for this candidate.');
    return null;
  }
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', 'Only the current Tests owner can start candidate verification.');
  requireCurrentRequest(route, input.candidate);
  const candidate = await currentCandidate(db, task, route);
  await checkingIdentity({ db }, task, route, candidate);
  requireCandidateBranch(input.branch, candidate.branch);
  return { candidateId: candidate.id, routeRevision: route.revision, baseCommit: candidate.baseCommit, commit: candidate.commit, branch: candidate.branch, testerId: agentId };
}

/* Held with run creation so a remote pin cannot cross a local ownership or route change. */
export async function bindCandidateRun(tx: Tx, task: Task, binding: CandidateRun, run: { id: string; commitSha: string | null; branch: string | null }): Promise<void> {
  const [current] = await tx.select().from(tasks).where(and(eq(tasks.id, task.id), eq(tasks.companyId, task.companyId))).for('update');
  if (!current || current.version !== task.version || current.assigneeAgentId !== binding.testerId) throw refuse(409, 'task_changed', 'The task changed while Tests was being pinned.');
  const route = await routeOf(tx, current);
  await heldCheckingIdentity(tx, current, route, await currentCandidate(tx, current, route));
  const now = await candidateForRun(tx, current, binding.testerId, { candidate: { candidateId: binding.candidateId, revision: binding.routeRevision }, branch: binding.branch }, 'tests');
  if (!now || JSON.stringify(now) !== JSON.stringify(binding) || run.commitSha !== binding.commit || run.branch !== binding.branch) throw refuse(409, 'task_changed', 'The candidate changed while Tests was being pinned.');
  await note(tx, task, { kind: 'comment', actor: { agentId: binding.testerId }, text: 'Tests run bound to the current candidate.', data: { candidateRun: { runId: run.id, ...binding } } });
}

type RunCandidate = { id: string; commit: string; baseCommit: string; branch: string };

function matchesCandidate(binding: CandidateRun, candidate: RunCandidate, revision: number): boolean {
  return binding.candidateId === candidate.id && binding.routeRevision === revision && binding.commit === candidate.commit && binding.baseCommit === candidate.baseCommit && binding.branch === candidate.branch;
}

export async function requireCandidateRun(db: Reader, task: Task, candidate: RunCandidate, revision: number, testerId: string | null, run: { id: string; agentId: string }): Promise<void> {
  const [event] = await db.select({ data: taskEvents.data, agentId: taskEvents.agentId }).from(taskEvents).where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'comment'), sql`${taskEvents.data}->'candidateRun'->>'runId' = ${run.id}`)).orderBy(desc(taskEvents.id)).limit(1);
  const parsed = Binding.safeParse(event?.data.candidateRun);
  if (!parsed.success || event?.agentId !== testerId || run.agentId !== testerId || parsed.data.testerId !== testerId || !matchesCandidate(parsed.data, candidate, revision)) throw refuse(409, 'task_changed', 'The run has no server-owned binding to this Tests assignment and candidate.');
}
