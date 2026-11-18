import type { WaitFinalReview, WaitPlan, WaitSourceKind } from '@hornhoof/protocol/waits';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, departments, people, waitPolicies } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { departmentOwners } from './decision-people.js';
import type { Task, Tx } from './state.js';

/* The review after the one due, on the sequence its anchor and interval declare: a late sweep neither moves the sequence
   nor sends what it passed over, only counts it. Without repeats, none follows. */
export function nextReview(review: WaitFinalReview, due: Date, at: Date): { at: Date | null; skipped: number } {
  if (review.intervalMs === null) return { at: null, skipped: 0 };
  const anchor = Date.parse(review.anchorAt);
  const passed = Math.floor((at.getTime() - anchor) / review.intervalMs);
  return { at: new Date(anchor + (passed + 1) * review.intervalMs), skipped: passed - Math.round((due.getTime() - anchor) / review.intervalMs) };
}

type PolicyPlace = { companyId: string; departmentId: string; kind: WaitSourceKind; stage: string; at: Date };

export async function departmentHead(tx: Tx, departmentId: string): Promise<string | null> {
  const [head] = await tx.select(idOnly(agents)).from(agents)
    .where(and(eq(agents.departmentId, departmentId), eq(agents.kind, 'head'), isNull(agents.removedAt)))
    .orderBy(asc(agents.createdAt)).limit(1);
  return head?.id ?? null;
}

/* A department that set any policy has said its waits have dates: from then on one with none is refused, a question to a person
   excepted. Not while it has no head: no dates can be made without one to look at what they miss, and setting more would not
   help whoever is refused. */
export async function setsWaitDates(tx: Tx, companyId: string, departmentId: string): Promise<boolean> {
  const [any] = await tx.select(idOnly(waitPolicies)).from(waitPolicies).where(and(eq(waitPolicies.companyId, companyId), eq(waitPolicies.departmentId, departmentId))).limit(1);
  return Boolean(any) && (await departmentHead(tx, departmentId)) !== null;
}

/* A plan from the newest version a department set for this kind of wait at this stage, its dates counted from when the stage
   began. Where it set none there is no plan: nothing here falls back on a common deadline, a run's limit or a whole kind. */
export async function planFromPolicy(tx: Tx, place: PolicyPlace): Promise<WaitPlan | null> {
  const [policy] = await tx.select().from(waitPolicies).where(and(
    eq(waitPolicies.companyId, place.companyId), eq(waitPolicies.departmentId, place.departmentId), eq(waitPolicies.kind, place.kind), eq(waitPolicies.stage, place.stage),
  )).orderBy(desc(waitPolicies.version)).limit(1);
  if (!policy) return null;
  const headAgentId = await departmentHead(tx, place.departmentId);
  if (!headAgentId) return null;
  const after = (ms: number) => new Date(place.at.getTime() + ms).toISOString();
  return {
    version: 1,
    ownerDueAt: after(policy.ownerMs),
    headDueAt: after(policy.headMs),
    decisionDueAt: after(policy.decisionMs),
    provenance: {
      kind: 'department_policy',
      actor: policy.createdByPersonId ? { personId: policy.createdByPersonId } : { agentId: policy.createdByAgentId! },
      ref: `wait-policy:${policy.id}`,
      revision: policy.version,
      origin: place.stage ? `${place.kind}:${place.stage}` : place.kind,
    },
    finalReview: { headAgentId, anchorAt: after(policy.decisionMs), intervalMs: policy.reviewIntervalMs },
  };
}

export type WaitRoute = { finalDecisionPersonId: string | null; fallbackToCeo: boolean };

/* Who decides in the end: the owner named for the department, as for its decisions, and the CEO without one. It is authority
   kept on the record, and asks the CEO for nothing by itself. */
export async function waitRoute(tx: Tx, task: Pick<Task, 'companyId' | 'departmentId'>): Promise<WaitRoute> {
  const [department] = task.departmentId ? await tx.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(eq(departments.id, task.departmentId)) : [];
  const owner = department ? (await departmentOwners({ db: tx as unknown as Db }, task.companyId)).get(department.parentId ?? department.id) : undefined;
  if (owner) return { finalDecisionPersonId: owner, fallbackToCeo: false };
  const [ceo] = await tx.select(idOnly(people)).from(people).where(and(eq(people.companyId, task.companyId), eq(people.isOwner, true), eq(people.status, 'active'))).limit(1);
  return { finalDecisionPersonId: ceo?.id ?? null, fallbackToCeo: true };
}
