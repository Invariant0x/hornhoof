import type { DecisionTopic, REQUEST_KINDS } from '../db/schema.js';
import type { Access, Spot } from './access.js';

/* Whose a decision is: one rule for its owner, who counts it, and for the people who may take it. */

export type Candidate = { id: string; status: 'active' | 'invited' | 'disabled'; isOwner: boolean; access: Access };

/* A request of an agent on a task, or a card of the orchestrator. His request for a machine is its owner's, and no
   decision of this kind. A card that names departments changes only their staff, sub-units and products. */
export type DecisionSubject =
  | { source: 'request'; kind: (typeof REQUEST_KINDS)[number]; topic: DecisionTopic | null; spot: Spot; recipient?: string | null | undefined }
  | { source: 'proposal'; departments?: readonly string[] }
  /* What a merge could not prove about people, access, plans, machines or protected records: the CEO's alone. */
  | { source: 'merge' };

/* The topics a department's own person decides; every other one, and one not given, is the CEO's. */
export const DEPARTMENTAL: readonly DecisionTopic[] = ['task', 'employee'];

/* The topics of a department's work its named owner decides too, as the CEO does: its repository and its releases. */
const OWNED: readonly DecisionTopic[] = ['repositories', 'release'];

function ceoOf(people: readonly Candidate[]): string {
  const ceo = people.find(p => p.isOwner && p.status === 'active');
  if (!ceo) throw new Error('The company has no active CEO to give its decisions to.');
  return ceo.id;
}

/* Whether a person's access lists the place itself or the department holding it. A team, or the whole company, is not a
   department's own. */
export const listsPlace = (access: Access, spot: Spot) =>
  !access.whole && Boolean((spot.departmentId && access.departments.has(spot.departmentId)) || (spot.parentId && access.departments.has(spot.parentId)));

/* The department or product whose people a decision belongs to: a question, a choice or a stuck task, on a task or an
   employee of a department. Approvals, which only a named owner takes besides the CEO, the CEO's topics, unknown topics, the
   orchestrator's own tasks and its cards belong to no department's people. */
export function decisionPlace(d: DecisionSubject): Spot | null {
  if (d.source !== 'request' || d.kind === 'approval' || !d.topic || !DEPARTMENTAL.includes(d.topic) || !d.spot.departmentId) return null;
  return d.spot;
}

/* The department whose owner takes a decision: every approval on its work or a product's, of any kind and topic, its own
   decisions, and what is asked about its repository and releases. What only the CEO decides, and what no department holds,
   has none. */
export function ownerDepartment(d: DecisionSubject): string | null {
  if (d.source !== 'request' || !d.spot.departmentId) return null;
  if (d.kind !== 'approval' && !decisionPlace(d) && !(d.topic && OWNED.includes(d.topic))) return null;
  return d.spot.parentId ?? d.spot.departmentId;
}

/* The active owner the CEO named for a decision's department, if any. */
export function namedOwner(d: DecisionSubject, people: readonly Candidate[]): string | null {
  if (d.source === 'request' && d.recipient) return d.recipient;
  const department = ownerDepartment(d);
  if (!department) return null;
  return people.find(p => p.status === 'active' && p.access.owns?.has(department))?.id ?? null;
}

/* A department's own decision with no named owner goes, as it did before owners, to the one active person other than the CEO
   whose access lists that department or the product it is about; with nobody or with several such people, to the CEO.
   People who see the whole company are no department's own. Every other decision goes to the CEO. */
function unownedDecision(d: DecisionSubject, people: readonly Candidate[]): string {
  const place = decisionPlace(d);
  if (!place) return ceoOf(people);
  const own = people.filter(p => p.status === 'active' && !p.isOwner && listsPlace(p.access, place));
  return own.length === 1 ? own[0]!.id : ceoOf(people);
}

/* A decision goes to its department's named owner. Without one, an approval goes to the CEO: an owner is never worked out
   from who has access. */
export function decisionOwner(d: DecisionSubject, people: readonly Candidate[]): string {
  return namedOwner(d, people) ?? unownedDecision(d, people);
}
