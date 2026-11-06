import { createHash } from 'node:crypto';
import type { QuestionAuthorityBinding, QuestionClassificationInput, QuestionPurpose } from '@hornhoof/protocol';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { canDecide, decidedBy } from '../../auth/decisions.js';
import type { Db } from '../../db/client.js';
import { agents, departments, jobs, people, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { candidates } from './decisions.js';
import { requestSubject, type Request, type Task, type Tx } from './engine.js';

/* A question of an agent stays inside the company until someone who may says otherwise. Whoever it goes to is worked out here
   from who is there now, and whoever acts on it from their turn: never from what a caller says it is, whom it quotes or who
   wrote into the turn. */

type Reader = Pick<Db, 'select'> | Tx;
type Place = { companyId: string; departmentId: string | null };

export type InternalRoute = { target: 'head' | 'orchestrator'; agentId: string };

/* The department and the one it is a product of, nearest first. */
async function placesOf(db: Reader, departmentId: string | null): Promise<string[]> {
  if (!departmentId) return [];
  const [row] = await db.select({ parentId: departments.parentId }).from(departments).where(eq(departments.id, departmentId));
  return row?.parentId ? [departmentId, row.parentId] : [departmentId];
}

/* Who can look at a question of this place now: its head, or the head of the one a product is in, and the orchestrator. Someone who
   has left, is switched off or has no plan cannot. */
export async function currentLeads(db: Reader, place: Place): Promise<{ head: string | null; orchestrator: string | null }> {
  const here = await db.select({ id: agents.id, kind: agents.kind, departmentId: agents.departmentId }).from(agents)
    .innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .where(and(eq(agents.companyId, place.companyId), inArray(agents.kind, ['head', 'orchestrator']), isNull(agents.removedAt), isNull(agents.switchedOffAt), isNull(subscriptions.removedAt)))
    .orderBy(asc(agents.createdAt));
  const head = (await placesOf(db, place.departmentId)).flatMap(id => here.filter(a => a.kind === 'head' && a.departmentId === id))[0];
  return { head: head?.id ?? null, orchestrator: here.find(a => a.kind === 'orchestrator')?.id ?? null };
}

/* A head and the orchestrator ask the orchestrator; everyone else their head, and with none there the orchestrator. With nobody there
   is no route: a person does not take its place. */
export async function internalRoute(db: Reader, place: Place, askerId: string): Promise<InternalRoute | null> {
  const { head, orchestrator } = await currentLeads(db, place);
  const [asker] = await db.select({ kind: agents.kind }).from(agents).where(eq(agents.id, askerId));
  if (head && asker?.kind !== 'head' && asker?.kind !== 'orchestrator') return { target: 'head', agentId: head };
  return orchestrator ? { target: 'orchestrator', agentId: orchestrator } : null;
}

export const staleRevision = () => new ApiError(409, 'conflict', 'stale_revision: This question changed since you read it. Read it again.', 'stale_revision');
export const staleRoute = () => new ApiError(409, 'conflict', 'stale_route: This question went elsewhere since you read it. Read it again.', 'stale_route');
export const sourceClosed = () => new ApiError(409, 'conflict', 'source_closed: This question is closed already.', 'source_closed');
export const operationConflict = () => new ApiError(409, 'conflict', 'operation_conflict: This operation id was used with other words. Use a new id for a new decision.', 'operation_conflict');
export const producerUnavailable = (what: string) => new ApiError(503, 'unavailable', `source_producer_unavailable: ${what}`, 'source_producer_unavailable');

export const classificationRequired = () =>
  new ApiError(409, 'conflict', 'classification_required: This question is still inside the company, and no person takes it yet. Whoever has it settles it with resolve_question, or puts it before a person with classify_human_intent.', 'classification_required');

/* A turn of an agent, as its tools know it. */

export type TriageCall = { jobId: string; agentId: string; companyId: string };
/* A question as far as who may act on it goes: where it is and whom it was last given to. */
export type TriagePlace = Place & { triageAgentId: string | null };
export type TriageActor = { agentId: string; role: 'head' | 'orchestrator' | 'triage' };

const notAllowed = () => new ApiError(403, 'forbidden', 'This question is not yours to settle or to put before a person.', 'question_not_allowed');

/* Who may act now, in the write that acts: a head of the place or the orchestrator, in a turn of theirs that is running. Whoever
   it was handed to, as Operations may be, may settle it and nothing more. A person's words in the turn give no right here. */
export async function requireTriage(tx: Tx, call: TriageCall, on: TriagePlace, may: 'resolve' | 'classify'): Promise<TriageActor> {
  const [row] = await tx.select({ jobStatus: jobs.status, jobAgent: jobs.agentId, kind: agents.kind, departmentId: agents.departmentId, removedAt: agents.removedAt }).from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(and(eq(jobs.id, call.jobId), eq(jobs.companyId, on.companyId)));
  if (!row || row.jobStatus !== 'running' || row.jobAgent !== call.agentId || row.removedAt) throw notAllowed();
  if (row.kind === 'orchestrator') return { agentId: call.agentId, role: 'orchestrator' };
  if (row.kind === 'head' && (await placesOf(tx, on.departmentId)).includes(row.departmentId ?? '')) return { agentId: call.agentId, role: 'head' };
  if (may === 'resolve' && on.triageAgentId === call.agentId) return { agentId: call.agentId, role: 'triage' };
  throw notAllowed();
}

export const digestOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const bound = (purpose: QuestionPurpose, recipientPersonIds: string[]): QuestionAuthorityBinding => ({ recipientPersonIds, purpose, authorityDigest: digestOf({ purpose, recipientPersonIds }) });

/* Who takes a decision is the rule every other decision follows: nobody is picked here, and nobody gains a right. */
async function decisionAuthority(tx: Tx, task: Task, request: Request): Promise<QuestionAuthorityBinding> {
  const subject = requestSubject(request, task);
  const everyone = await candidates({ db: tx as unknown as Db }, task.companyId);
  const access = new Map(everyone.map(p => [p.id, p.access]));
  const rows = await tx.select({ id: people.id, companyId: people.companyId, status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate }).from(people).where(eq(people.companyId, task.companyId));
  const recipients = rows.filter(p => canDecide(subject, p, access.get(p.id)!, task.companyId)).map(p => p.id).sort();
  if (!recipients.length) throw producerUnavailable('Nobody can take this decision now.');
  const by = decidedBy(subject, everyone);
  return bound({ kind: 'decision', decisionKind: request.kind, authorityKind: by.kind, departmentId: by.departmentId }, recipients);
}

const notARealResource = () => new ApiError(400, 'validation', 'There is no such resource of this company, or it has nobody who owns it.', 'task_invalid');

/* A login only the owner of a plan can do goes to that owner. It lets them do that and nothing else. */
async function ownerLogin(tx: Tx, task: Task, resourceId: string): Promise<QuestionAuthorityBinding> {
  const [plan] = await tx.select({ id: subscriptions.id, ownerPersonId: subscriptions.ownerPersonId, provider: subscriptions.provider }).from(subscriptions)
    .where(and(eq(subscriptions.companyId, task.companyId), eq(subscriptions.id, resourceId), isNull(subscriptions.removedAt)));
  if (!plan?.ownerPersonId) throw notARealResource();
  const [owner] = await tx.select({ status: people.status }).from(people).where(eq(people.id, plan.ownerPersonId));
  if (owner?.status !== 'active') throw notARealResource();
  return bound({ kind: 'owner_login', resourceId, subscriptionId: plan.id, ownerPersonId: plan.ownerPersonId, provider: plan.provider }, [plan.ownerPersonId]);
}

type Classification = QuestionClassificationInput['classification'];

/* Worked out from the source and who holds the resource now; a caller names neither a person nor a right. What has no real
   producer behind it says so, and nothing is put before anybody. */
export async function questionAuthority(tx: Tx, task: Task, request: Request, classification: Classification): Promise<QuestionAuthorityBinding> {
  if (classification.kind === 'ready_result') return decisionAuthority(tx, task, request);
  const { kind, resourceId } = classification.actionBinding;
  if (kind === 'owner_login') return ownerLogin(tx, task, resourceId);
  if (kind === 'ceo_permission') throw new ApiError(400, 'validation', 'Access to the computer is asked for with ask_computer_access, not on a task.', 'task_invalid');
  throw producerUnavailable(`Hornhoof cannot carry out ${kind === 'payment' ? 'a payment' : 'an action on a machine'} yet, so it cannot be put before a person.`);
}
