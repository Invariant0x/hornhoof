import type { ScopeKind } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Access } from './access.js';
import { decisionPlace, listsPlace, type DecisionSubject } from './decision-owner.js';

/* Who may take a decision. The CEO and the CEO's delegate take every one; a department's decision also every active
   person whose access lists that department or the product it is about. Seeing a decision is a matter of access alone:
   someone who sees one without this right reads it and cannot take it. */

export type Decider = { companyId: string; status: 'active' | 'invited' | 'disabled'; scopeKind: ScopeKind; isOwner: boolean; isCeoDelegate: boolean };

/* The CEO, or the CEO's delegate while they are active with the whole company: they take the CEO's decisions. */
export const actsAsCeo = (p: Decider): boolean => p.status === 'active' && (p.isOwner || (p.isCeoDelegate && p.scopeKind === 'company'));

export function canDecide(subject: DecisionSubject, person: Decider, access: Access, companyId: string): boolean {
  if (person.companyId !== companyId || person.status !== 'active') return false;
  if (actsAsCeo(person)) return true;
  const place = decisionPlace(subject);
  return place !== null && listsPlace(access, place);
}

export function requireDecision(subject: DecisionSubject, person: Decider, access: Access, companyId: string): void {
  if (!canDecide(subject, person, access, companyId)) throw notAllowed();
}

export const notAllowed = () =>
  new ApiError(403, 'forbidden', 'This decision is not yours to take. The people of its department, the CEO or the CEO delegate take it.', 'decision_not_allowed');

/* Whom people see a decision is for: the department's people with the CEO and the delegate, or the CEO and the delegate.
   A product's decision is its department's. */
export type DecidedBy = { kind: 'ceo_and_delegate' | 'department_and_ceo'; departmentId: string | null };

export function decidedBy(subject: DecisionSubject): DecidedBy {
  const place = decisionPlace(subject);
  if (!place) return { kind: 'ceo_and_delegate', departmentId: null };
  return { kind: 'department_and_ceo', departmentId: place.parentId ?? place.departmentId };
}
