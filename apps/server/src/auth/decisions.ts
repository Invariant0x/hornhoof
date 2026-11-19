import type { ScopeKind } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Access } from './access.js';
import { decisionPlace, listsPlace, namedOwner, ownerDepartment, type Candidate, type DecisionSubject } from './decision-owner.js';

/* Who may take a decision. The CEO and the CEO's delegate take every one; a department's owner also its approvals, its own
   decisions, what is asked about its repository and releases, and a change to its staff, sub-units and products; a
   department's own decision also every active person whose access lists that department or the product it is about. Seeing
   a decision is a matter of access alone: someone who sees one without this right reads it and cannot take it. */

export type Decider = { companyId: string; status: 'active' | 'invited' | 'disabled'; scopeKind: ScopeKind; isOwner: boolean; isCeoDelegate: boolean; id?: string; via?: string; assistant?: unknown };

/* The CEO, or the CEO's delegate while they are active with the whole company: they take the CEO's decisions. */
export const actsAsCeo = (p: Decider): boolean => p.status === 'active' && (p.isOwner || (p.isCeoDelegate && p.scopeKind === 'company'));

const takesAsOwner = (subject: DecisionSubject, access: Access): boolean => {
  const department = ownerDepartment(subject);
  return department !== null && access.owns?.has(department) === true;
};

/* A change inside departments the person owns, every one of them. */
const runsAll = (subject: DecisionSubject, access: Access): boolean =>
  subject.source === 'proposal' && Boolean(subject.departments?.length) && subject.departments!.every(id => access.owns?.has(id) === true);

const takesWithDepartment = (subject: DecisionSubject, access: Access): boolean => {
  const place = decisionPlace(subject);
  return place !== null && listsPlace(access, place);
};

export function canDecide(subject: DecisionSubject, person: Decider, access: Access, companyId: string): boolean {
  if (person.companyId !== companyId || person.status !== 'active') return false;
  if (subject.source === 'request' && subject.recipient) return person.id === subject.recipient && !person.via && !person.assistant;
  if (actsAsCeo(person)) return true;
  return runsAll(subject, access) || takesAsOwner(subject, access) || takesWithDepartment(subject, access);
}

export function requireDecision(subject: DecisionSubject, person: Decider, access: Access, companyId: string): void {
  if (!canDecide(subject, person, access, companyId)) throw notAllowed();
}

export const notAllowed = () =>
  new ApiError(403, 'forbidden', 'This decision is not yours to take. Its department\'s owner or people, the CEO or the CEO delegate take it.', 'decision_not_allowed');

/* Whom people see a decision is for: the department's people with the CEO and the delegate, its owner with them, or the
   CEO and the delegate. A product's decision is its department's. Opening a machine that holds its owner's key is its
   owner's alone. */
export type DecidedBy = { kind: 'ceo_and_delegate' | 'department_and_ceo' | 'owner_and_ceo' | 'machine_owner' | 'named_person'; departmentId: string | null };

/* What no department's people take: its named owner's with the CEO, or the CEO's. */
const decidedAbove = (subject: DecisionSubject, people: readonly Candidate[]): DecidedBy =>
  namedOwner(subject, people) ? { kind: 'owner_and_ceo', departmentId: ownerDepartment(subject) } : { kind: 'ceo_and_delegate', departmentId: null };

export function decidedBy(subject: DecisionSubject, people: readonly Candidate[] = []): DecidedBy {
  if (subject.source === 'request' && subject.recipient) return { kind: 'named_person', departmentId: null };
  const place = decisionPlace(subject);
  if (!place) return decidedAbove(subject, people);
  return { kind: 'department_and_ceo', departmentId: place.parentId ?? place.departmentId };
}
