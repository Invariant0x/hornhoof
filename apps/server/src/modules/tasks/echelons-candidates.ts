import { isTestPath, pathInScope, RepoPath } from './review-schema.js';
import { randomUUID } from 'node:crypto';
import { DocumentCandidate, EchelonCandidate, type HandedCandidate } from '@hornhoof/protocol/echelons';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Ctx } from '../../app.js';
import type { Tx } from './engine.js';
import { taskEvents } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { refuse, type Task } from './engine.js';
import type { Route } from './echelons-store.js';
import type { CheckerIdentity } from './echelons-policy.js';
import { exactComparison, type Review } from './review-context.js';

export function isTestFilePath(path: string): boolean {
  return RepoPath.safeParse(path).success && isTestPath(path);
}

function pathWithinScope(path: string, patterns: readonly string[], allowed?: ReadonlySet<string>): boolean {
  return RepoPath.safeParse(path).success && (allowed?.has(path) === true || pathInScope(path, patterns));
}

export function producedCandidate(route: Route, producer: CheckerIdentity, review: Review, allowedPaths?: ReadonlySet<string>): EchelonCandidate {
  if (!review.commit || !review.branch || !review.source) throw refuse(409, 'task_invalid', 'A handoff needs the exact candidate commit, branch and base comparison.');
  const inScope = review.source.paths.every(path => pathWithinScope(path, route.paths, allowedPaths));
  if (!inScope) throw refuse(403, 'task_not_yours', 'The candidate changes paths outside the head-approved scope. Ask the head to revise the scope.');
  return EchelonCandidate.parse({ id: randomUUID(), parentId: route.state.candidateId, revision: route.revision + 1,
    baseCommit: review.source.baseCommit, commit: review.commit, branch: review.branch, paths: review.source.paths,
    producedBy: { ...producer, stage: route.state.stage },
  });
}

async function handedOf<T extends HandedCandidate>(db: Db | Tx, task: Task, id: string | null, shape: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
  const [event] = await db.select({ data: taskEvents.data, agentId: taskEvents.agentId }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.companyId, task.companyId), eq(taskEvents.kind, 'submitted'),
    sql`${taskEvents.data}->'candidate'->>'id' = ${id}`)).orderBy(desc(taskEvents.id)).limit(1);
  const parsed = shape.safeParse(event?.data.candidate);
  if (!parsed.success || event?.agentId !== parsed.data.producedBy.agentId) throw refuse(409, 'task_invalid', 'The current candidate has no immutable producer submission.');
  return parsed.data;
}

export const currentCandidate = (db: Db | Tx, task: Task, route: Route): Promise<EchelonCandidate> => handedOf(db, task, route.state.candidateId, EchelonCandidate);
export const currentDocument = (db: Db | Tx, task: Task, route: Route): Promise<DocumentCandidate> => handedOf(db, task, route.state.candidateId, DocumentCandidate);
/* What the current stage holds, a commit or a document as the route of the task hands it in. */
export const currentHanded = (db: Db | Tx, task: Task, route: Route): Promise<EchelonCandidate | DocumentCandidate> =>
  route.state.resultKind === 'document' ? currentDocument(db, task, route) : currentCandidate(db, task, route);

/* Whose work the current stage checks: the producer of what it received, also once Tests took the main line into it. */
export async function checkedProducer(db: Db | Tx, task: Task, route: Route, candidate: HandedCandidate): Promise<CheckerIdentity> {
  if (candidate.producedBy.stage !== route.state.stage) return candidate.producedBy;
  const input = route.state.stages.find(step => step.stage === route.state.stage)?.inputCandidateId ?? null;
  const received = route.state.resultKind === 'document' ? await handedOf(db, task, input, DocumentCandidate) : await handedOf(db, task, input, EchelonCandidate);
  return received.producedBy;
}

/* A repair extends the assigned branch while keeping the full change relative to the original base. */
export async function requireRepairHistory(ctx: Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCompare'>>, task: Task, parent: EchelonCandidate, candidate: EchelonCandidate): Promise<void> {
  if (candidate.branch !== parent.branch || candidate.baseCommit !== parent.baseCommit) throw refuse(409, 'task_changed', 'A repair must keep the assigned branch and original candidate base.');
  if (!ctx.config || !ctx.readCompare) throw refuse(409, 'task_changed', 'The repair ancestry cannot be verified.');
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  let verified = false;
  if (found) {
    try { verified = exactComparison(await ctx.readCompare(found.repo, { base: parent.commit, head: candidate.commit }, 10_000), parent.commit, candidate.commit); }
    catch { /* An unavailable comparison never proves that the assigned candidate was preserved. */ }
  }
  if (!verified) throw refuse(409, 'task_changed', 'The repair must include the assigned candidate commit.');
}
