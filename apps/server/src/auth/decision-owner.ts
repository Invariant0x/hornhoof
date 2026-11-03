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

/* The department or product a decision belongs to: a question, a choice or a stuck task, on a task or an employee of a
   department. Approvals, the CEO's topics, unknown topics, the orchestrator's own tasks, its cards and its request for the
   computer belong to none, so they are the CEO's. */
export function decisionPlace(d: DecisionSubject): Spot | null {
  if (d.source !== 'request' || d.kind === 'approval' || !d.topic || !DEPARTMENTAL.includes(d.topic) || !d.spot.departmentId) return null;
  return d.spot;
}

/* A department's decision goes to the one active person, other than the CEO, whose access lists that department or the
   product it is about; with nobody or with several such people, to the CEO. People who see the whole company are no
   department's own. Every other decision goes to the CEO. */
export function decisionOwner(d: DecisionSubject, people: readonly Candidate[]): string {
  const place = decisionPlace(d);
  if (!place) return ceoOf(people);
  const own = people.filter(p => p.status === 'active' && !p.isOwner && listsPlace(p.access, place));
  return own.length === 1 ? own[0]!.id : ceoOf(people);
}
