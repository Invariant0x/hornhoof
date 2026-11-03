import { describe, expect, it } from 'vitest';
import { WHOLE, type Access, type Spot } from '../src/auth/access.js';
import { decisionOwner as ownerFromAuth, decisionPlace } from '../src/auth/decision-owner.js';
import { actsAsCeo, canDecide, decidedBy, requireDecision, type Decider } from '../src/auth/decisions.js';
import { ApiError } from '../src/errors.js';
import { decisionOwner as ownerFromTasks, type DecisionSubject } from '../src/modules/tasks/decisions.js';

const C = 'acme';
const listed = (departmentIds: string[], teamIds: string[] = []): Access => ({ whole: false, departments: new Set(departmentIds), teams: new Set(teamIds) });
const decider = (extra: Partial<Decider> = {}): Decider => ({ companyId: C, status: 'active', scopeKind: 'listed', isOwner: false, isCeoDelegate: false, ...extra });

const ceo = { who: decider({ scopeKind: 'company', isOwner: true }), access: WHOLE };
const delegate = { who: decider({ scopeKind: 'company', isCeoDelegate: true }), access: WHOLE };
const companyPerson = { who: decider({ scopeKind: 'company' }), access: WHOLE };
const devPerson = { who: decider(), access: listed(['dev']) };
const salesPerson = { who: decider(), access: listed(['sales']) };

const dev: Spot = { departmentId: 'dev', parentId: null };
const shop: Spot = { departmentId: 'shop', parentId: 'dev' };
const request = (kind: 'question' | 'choice' | 'stuck' | 'approval', topic: string | null, spot: Spot = dev): DecisionSubject => ({ source: 'request', kind, topic: topic as never, spot });

type Row = [string, DecisionSubject, boolean];
/* The matrix of #49: what each of them may decide. Department people decide their department's tasks and employees only. */
const rows: Row[] = [
  ['a question on a department task', request('question', 'task'), true],
  ['a choice about a department employee', request('choice', 'employee'), true],
  ['a stuck task of a department to retry', request('stuck', 'task'), true],
  ['a question on a product task of the department', request('question', 'task', shop), true],
  ['a question on a CEO topic', request('question', 'people'), false],
  ['a question without a topic', request('question', null), false],
  ['a question with an unknown topic', request('question', 'weather'), false],
  ['a question on a task of no department', request('question', 'task', { departmentId: null }), false],
  ['an approval of a commit', request('approval', 'task'), false],
  ['an approval of a release', request('approval', 'release'), false],
  ['a structure or staff card', { source: 'proposal' }, false],
  ['the request for the computer', { source: 'computer_access' }, false],
];

describe('canDecide', () => {
  it.each(rows)('lets the CEO and the CEO delegate decide %s', (_, subject) => {
    expect(canDecide(subject, ceo.who, ceo.access, C)).toBe(true);
    expect(canDecide(subject, delegate.who, delegate.access, C)).toBe(true);
  });

  it.each(rows)('does not let a person of the whole company without the mark decide %s', (_, subject) => {
    expect(canDecide(subject, companyPerson.who, companyPerson.access, C)).toBe(false);
  });

  it.each(rows)('lets a person of the department decide %s only when it is the department own', (_, subject, departmental) => {
    expect(canDecide(subject, devPerson.who, devPerson.access, C)).toBe(departmental);
    expect(canDecide(subject, decider(), listed(['shop']), C)).toBe(departmental && subject.source === 'request' && subject.spot.departmentId === 'shop');
  });

  it.each(rows)('does not let a person of another department decide %s', (_, subject) => {
    expect(canDecide(subject, salesPerson.who, salesPerson.access, C)).toBe(false);
  });

  it('lets every listed person of a department decide, however many, and a person listed for several departments decide in each', () => {
    const both = listed(['dev', 'sales']);
    expect(canDecide(request('question', 'task'), devPerson.who, devPerson.access, C)).toBe(true);
    expect(canDecide(request('question', 'task'), decider(), listed(['dev']), C)).toBe(true);
    expect(canDecide(request('question', 'task'), decider(), both, C)).toBe(true);
    expect(canDecide(request('question', 'task', { departmentId: 'sales', parentId: null }), decider(), both, C)).toBe(true);
  });

  it('does not count access through a team only', () => {
    expect(canDecide(request('question', 'task', { departmentId: 'dev', teamId: 'red', parentId: null }), decider(), listed([], ['red']), C)).toBe(false);
  });

  it('gives no right to someone not active, of another company, or a delegate mark without the whole company', () => {
    const subject = request('question', 'task');
    for (const status of ['invited', 'disabled'] as const) {
      expect(canDecide(subject, decider({ scopeKind: 'company', isOwner: true, status }), WHOLE, C)).toBe(false);
      expect(canDecide(subject, decider({ status }), listed(['dev']), C)).toBe(false);
    }
    expect(canDecide(subject, decider({ scopeKind: 'company', isOwner: true, companyId: 'other' }), WHOLE, C)).toBe(false);
    expect(canDecide({ source: 'proposal' }, decider({ isCeoDelegate: true }), listed(['dev']), C)).toBe(false);
    expect(actsAsCeo(decider({ isCeoDelegate: true }))).toBe(false);
    expect(actsAsCeo(delegate.who)).toBe(true);
    expect(actsAsCeo(ceo.who)).toBe(true);
    expect(actsAsCeo(companyPerson.who)).toBe(false);
  });
});

describe('requireDecision', () => {
  it('refuses with decision_not_allowed', () => {
    let refused: unknown;
    try {
      requireDecision({ source: 'proposal' }, companyPerson.who, companyPerson.access, C);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 403, code: 'forbidden', reason: 'decision_not_allowed' });
    expect(() => requireDecision({ source: 'proposal' }, ceo.who, ceo.access, C)).not.toThrow();
  });
});

describe('decidedBy and decisionPlace', () => {
  it('names the department for its own decisions, and the CEO with the delegate for the rest', () => {
    expect(decidedBy(request('question', 'task'))).toEqual({ kind: 'department_and_ceo', departmentId: 'dev' });
    expect(decidedBy(request('question', 'task', shop))).toEqual({ kind: 'department_and_ceo', departmentId: 'dev' });
    for (const [, subject, departmental] of rows) if (!departmental) expect(decidedBy(subject)).toEqual({ kind: 'ceo_and_delegate', departmentId: null });
    expect(decisionPlace(request('question', 'task', shop))).toEqual(shop);
    expect(decisionPlace(request('approval', 'task'))).toBeNull();
  });

  it('keeps one owner rule, the same from both modules', () => {
    expect(ownerFromTasks).toBe(ownerFromAuth);
  });
});
