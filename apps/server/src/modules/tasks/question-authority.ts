import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments, jobs, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Tx } from './engine.js';

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

/* The head of the department, or of the one a product is in, when the one who asks is not a head itself; else the orchestrator.
   Someone who has left, is switched off or has no plan cannot look at it. With nobody there is no route: a person does not
   take its place. */
export async function internalRoute(db: Reader, place: Place, askerId: string): Promise<InternalRoute | null> {
  const here = await db.select({ id: agents.id, kind: agents.kind, departmentId: agents.departmentId }).from(agents)
    .innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .where(and(eq(agents.companyId, place.companyId), inArray(agents.kind, ['head', 'orchestrator']), isNull(agents.removedAt), isNull(agents.switchedOffAt), isNull(subscriptions.removedAt)))
    .orderBy(asc(agents.createdAt));
  const askedByALead = here.some(a => a.id === askerId);
  const head = askedByALead ? undefined : (await placesOf(db, place.departmentId)).flatMap(id => here.filter(a => a.kind === 'head' && a.departmentId === id))[0];
  if (head) return { target: 'head', agentId: head.id };
  const orchestrator = here.find(a => a.kind === 'orchestrator');
  return orchestrator ? { target: 'orchestrator', agentId: orchestrator.id } : null;
}

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
