import { describe, expect, it } from 'vitest';
import { HumanActionBinding, QuestionAudience, QuestionMutationGuard, QuestionRouteTarget, SourceRef } from '../src/questions.js';

const SOURCE = '00000000-0000-4000-8000-000000000001';
const OPERATION = '00000000-0000-4000-8000-000000000002';
const guard = { operationId: OPERATION, source: { kind: 'task_request', id: SOURCE }, expectedRevision: 3, expectedRouteRevision: 2 };

describe('canonical internal question references', () => {
  it.each(['task_request', 'proposal', 'computer_access'])('preserves the native %s source without inventing a task', kind => {
    expect(SourceRef.parse({ kind, id: SOURCE })).toEqual({ kind, id: SOURCE });
  });
  it.each([
    { kind: 'task', id: SOURCE }, { kind: 'task_request', id: 'request-7' }, { kind: 'proposal' },
    { kind: 'computer_access', id: SOURCE, taskId: SOURCE }, { kind: 'proposal', id: SOURCE, companyId: SOURCE },
  ])('rejects an unknown, incomplete or extended source %#', source => {
    expect(SourceRef.safeParse(source).success).toBe(false);
  });
});

describe('question mutation metadata', () => {
  it('requires an exact retry operation and both independent source/route revisions', () => {
    expect(QuestionMutationGuard.parse(guard)).toEqual(guard);
  });
  it.each(['operationId', 'source', 'expectedRevision', 'expectedRouteRevision'])('refuses missing %s', key => {
    const input: Record<string, unknown> = { ...guard }; delete input[key];
    expect(QuestionMutationGuard.safeParse(input).success).toBe(false);
  });
  it.each(['actorKind', 'actorId', 'personId', 'recipient', 'role', 'audience', 'approved'])('never accepts caller authority through %s', field => {
    expect(QuestionMutationGuard.safeParse({ ...guard, [field]: 'human' }).success).toBe(false);
  });
  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])('refuses a nonpositive or unsafe revision %j', revision => {
    expect(QuestionMutationGuard.safeParse({ ...guard, expectedRevision: revision }).success).toBe(false);
    expect(QuestionMutationGuard.safeParse({ ...guard, expectedRouteRevision: revision }).success).toBe(false);
  });
});

describe('internal routing and actual human action bindings', () => {
  it.each(['head', 'orchestrator', 'operations'])('names the internal %s route', target => {
    expect(QuestionRouteTarget.parse(target)).toBe(target);
  });
  it('does not turn a human label into an internal route', () => {
    expect(QuestionRouteTarget.safeParse('ceo').success).toBe(false);
    expect(QuestionRouteTarget.safeParse('person').success).toBe(false);
  });
  it.each(['internal', 'human', 'legacy'])('can describe stored %s audience without granting mutation authority', audience => {
    expect(QuestionAudience.parse(audience)).toBe(audience);
  });
  it.each(['payment', 'owner_login', 'manual_machine_action', 'ceo_permission'])('describes an exact %s resource, not a permission', kind => {
    expect(HumanActionBinding.parse({ kind, resourceId: SOURCE })).toEqual({ kind, resourceId: SOURCE });
  });
  it.each([
    { kind: 'blocked', resourceId: SOURCE }, { kind: 'owner_login', resourceId: '' },
    { kind: 'payment', resourceId: ' ' }, { kind: 'payment', resourceId: 'x'.repeat(201) },
    { kind: 'payment', resourceId: 'bad\0resource' }, { kind: 'payment', resourceId: SOURCE, personId: SOURCE },
    { kind: 'ceo_permission', resourceId: SOURCE, granted: true },
  ])('refuses an unspecified action, bad resource or claimed authority %#', input => {
    expect(HumanActionBinding.safeParse(input).success).toBe(false);
  });
});
