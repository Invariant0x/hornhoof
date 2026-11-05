import type { DecisionTopic, REQUEST_KINDS } from '../db/schema.js';
import type { Access, Spot } from './access.js';

/* Whose a decision is: one rule for its owner, who counts it, and for the people who may take it. */

export type Candidate = { id: string; status: 'active' | 'invited' | 'disabled'; isOwner: boolean; access: Access };

/* A request of an agent on a task, a card of the orchestrator, or its request for the computer the server runs on. */
export type DecisionSubject =
  | { source: 'request'; kind: (typeof REQUEST_KINDS)[number]; topic: DecisionTopic | null; spot: Spot }
  | { source: 'proposal' }
  | { source: 'computer_access' };

/* The topics a department's own person decides; every other one, and one not given, is the CEO's. */
export const DEPARTMENTAL: readonly DecisionTopic[] = ['task', 'employee'];

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
   orchestrator's own tasks, its cards and its request for the computer belong to no department's people. */
export function decisionPlace(d: DecisionSubject): Spot | null {
  if (d.source !== 'request' || d.kind === 'approval' || !d.topic || !DEPARTMENTAL.includes(d.topic) || !d.spot.departmentId) return null;
  return d.spot;
}

/* The department whose owner takes a decision: every approval on its work or a product's, of any kind and topic, and its
   own decisions. What only the CEO decides, and what no department holds, has none. */
export function ownerDepartment(d: DecisionSubject): string | null {
  if (d.source !== 'request' || !d.spot.departmentId) return null;
  if (d.kind !== 'approval' && !decisionPlace(d)) return null;
  return d.spot.parentId ?? d.spot.departmentId;
}

/* The active owner the CEO named for a decision's department, if any. */
export function namedOwner(d: DecisionSubject, people: readonly Candidate[]): string | null {
  const department = ownerDepartment(d);
  if (!department) return null;
  return people.find(p => p.status === 'active' && p.access.owns?.has(department))?.id ?? null;
}

/* A decision goes to its department's named owner. Without one, an approval goes to the CEO: an owner is never worked out
   from who has access. A department's own decision goes, as it did before owners, to the one active person other than the
   CEO whose access lists that department or the product it is about; with nobody or with several such people, to the CEO.
   People who see the whole company are no department's own. Every other decision goes to the CEO. */
export function decisionOwner(d: DecisionSubject, people: readonly Candidate[]): string {
  const named = namedOwner(d, people);
  if (named) return named;
  const place = decisionPlace(d);
  if (!place) return ceoOf(people);
  const own = people.filter(p => p.status === 'active' && !p.isOwner && listsPlace(p.access, place));
  return own.length === 1 ? own[0]!.id : ceoOf(people);
}
