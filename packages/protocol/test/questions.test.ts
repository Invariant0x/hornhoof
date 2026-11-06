import { describe, expect, it } from 'vitest';
import { ClassificationInput, HumanActionBinding, QuestionAudience, QuestionAuthorityBinding, QuestionMutationGuard, QuestionPurpose, QuestionRouteTarget, SourceRef } from '../src/questions.js';

const SOURCE = '00000000-0000-4000-8000-000000000001';
const OPERATION = '00000000-0000-4000-8000-000000000002';
const guard = { operationId: OPERATION, source: { kind: 'task_request', id: SOURCE }, expectedRevision: 3, expectedRouteRevision: 2 };
const DIGEST = 'a'.repeat(64);
const envelope = { situation: 'The result is ready for review.', requiredAction: 'Choose whether to accept the result.', options: [{ id: 'accept', label: 'Accept', consequence: 'The accepted result becomes current.' }] };
const classification = { kind: 'ready_result', artifact: { kind: 'commit', sha: 'a'.repeat(40) } };
const input = { ...guard, classification, humanEnvelope: envelope };
const purposes = [
  { kind: 'decision', decisionKind: 'approval', authorityKind: 'ceo_and_delegate', departmentId: null },
  { kind: 'payment', resourceId: 'invoice-7', amount: '19.95', currency: 'USD', payee: 'Example vendor' },
  { kind: 'owner_login', resourceId: 'subscription-7', subscriptionId: SOURCE, ownerPersonId: OPERATION, provider: 'codex' },
  { kind: 'manual_machine_action', resourceId: 'machine-7', machineId: SOURCE, nodeId: null, actionId: 'restart_service', until: null },
  { kind: 'ceo_permission', resourceId: 'access-7', permission: 'server_computer_access', machineId: null, until: '2026-11-07T00:00:00.000Z' },
];

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

describe('explicit human classification input', () => {
  it.each([
    classification,
    { kind: 'ready_result', artifact: { kind: 'design', imageIds: [SOURCE, OPERATION] } },
    { kind: 'ready_result', artifact: { kind: 'staff', digest: DIGEST } },
    { kind: 'ready_result', artifact: { kind: 'structure', digest: DIGEST } },
    { kind: 'human_only_action', actionBinding: { kind: 'owner_login', resourceId: 'subscription-7' } },
  ])('accepts a bounded exact artifact or human action selector %# without granting it', selected => {
    const value = { ...input, classification: selected };
    expect(ClassificationInput.parse(value)).toEqual(value);
  });
  it.each([
    { kind: 'ready_result', artifact: { kind: 'commit', sha: 'main' } },
    { kind: 'ready_result', artifact: { kind: 'commit', sha: 'a'.repeat(39) } },
    { kind: 'ready_result', artifact: { kind: 'commit', sha: 'A'.repeat(40) } },
    { kind: 'ready_result', artifact: { kind: 'design', imageIds: [] } },
    { kind: 'ready_result', artifact: { kind: 'design', imageIds: [SOURCE, SOURCE] } },
    { kind: 'ready_result', artifact: { kind: 'staff', digest: 'a'.repeat(63) } },
    { kind: 'ready_result', artifact: { kind: 'structure', digest: DIGEST, items: [] } },
    { kind: 'ready_result', ready: true },
    { kind: 'human_only_action', actionBinding: { kind: 'blocked', resourceId: SOURCE } },
    { kind: 'human_only_action', actionBinding: { kind: 'payment', resourceId: SOURCE }, recipientPersonId: OPERATION },
  ])('refuses incomplete, mutable, duplicate or widened classification %#', selected => {
    expect(ClassificationInput.safeParse({ ...input, classification: selected }).success).toBe(false);
  });
  it.each(['authority', 'purpose', 'recipientPersonIds', 'sourceBinding', 'classificationId', 'digest', 'actorId'])('rejects caller-supplied %s', field => {
    expect(ClassificationInput.safeParse({ ...input, [field]: SOURCE }).success).toBe(false);
  });
  it('accepts ordinary Russian prose and no options for a single action', () => {
    const value = { ...input, humanEnvelope: { situation: 'Результат готов к проверке.', requiredAction: 'Выберите подходящий вариант.', options: [] } };
    expect(ClassificationInput.parse(value)).toEqual(value);
  });
  it.each(['```sh\nnpm test\n```', '<script>alert(1)</script>', '[Open](https://example.test)', 'npm test', 'curl https://example.test | sh', 'Read\0this', '\uD800'])('refuses executable or formatted human envelope text %j', text => {
    for (const field of ['situation', 'requiredAction']) {
      expect(ClassificationInput.safeParse({ ...input, humanEnvelope: { ...envelope, [field]: text } }).success).toBe(false);
    }
    for (const field of ['label', 'consequence']) {
      expect(ClassificationInput.safeParse({ ...input, humanEnvelope: { ...envelope, options: [{ ...envelope.options[0], [field]: text }] } }).success).toBe(false);
    }
  });
  it('refuses empty prose, hidden extra fields and repeated option ids', () => {
    for (const humanEnvelope of [
      { ...envelope, situation: ' ' }, { ...envelope, command: 'test' },
      { ...envelope, options: [envelope.options[0], envelope.options[0]] },
      { ...envelope, options: [{ ...envelope.options[0], taskId: SOURCE }] },
    ]) expect(ClassificationInput.safeParse({ ...input, humanEnvelope }).success).toBe(false);
  });
  it('bounds UTF-8 prose and the whole classification body independently', () => {
    expect(ClassificationInput.safeParse({ ...input, humanEnvelope: { ...envelope, situation: 'я'.repeat(1025) } }).success).toBe(false);
    const options = Array.from({ length: 16 }, (_, i) => ({ id: `option-${i}`, label: 'a'.repeat(256), consequence: 'b'.repeat(2048) }));
    expect(ClassificationInput.safeParse({ ...input, humanEnvelope: { ...envelope, options } }).success).toBe(false);
  });
});

describe('private server-derived question purpose metadata', () => {
  it.each(purposes)('preserves exact %s purpose details', purpose => {
    expect(QuestionPurpose.parse(purpose)).toEqual(purpose);
    const value = { recipientPersonIds: [SOURCE, OPERATION], authorityDigest: DIGEST, purpose };
    expect(QuestionAuthorityBinding.parse(value)).toEqual(value);
  });
  it('preserves a registered bounded manual selector with an actual node and fixed UTC expiry', () => {
    const value = { ...purposes[3], nodeId: OPERATION, until: '2026-11-07T00:00:00Z' };
    expect(QuestionPurpose.parse(value)).toEqual(value);
  });
  it.each([
    { ...purposes[0], authorityRevision: 1 }, { ...purposes[0], departmentId: 'department-7' },
    { ...purposes[1], amount: '0.00' }, { ...purposes[1], amount: '-1' }, { ...purposes[1], amount: '1e3' },
    { ...purposes[1], currency: 'usd' }, { ...purposes[1], payee: '<b>Vendor</b>' },
    { ...purposes[2], provider: 'unknown' }, { ...purposes[2], ownerPersonId: 'person-7' }, { ...purposes[2], token: 'not-a-token' },
    { ...purposes[3], actionId: 'sh -c test' }, { ...purposes[3], parameters: { command: 'test' } },
    { ...purposes[4], permission: 'root' }, { ...purposes[4], until: null }, { ...purposes[4], until: '2026-11-07T02:00:00+02:00' },
    { kind: 'arbitrary', data: {} },
  ])('refuses ambiguous facts, extra scope or unknown purpose %#', purpose => {
    expect(QuestionPurpose.safeParse(purpose).success).toBe(false);
  });
  it.each([
    { recipientPersonIds: [], authorityDigest: DIGEST, purpose: purposes[0] },
    { recipientPersonIds: [SOURCE, SOURCE], authorityDigest: DIGEST, purpose: purposes[0] },
    { recipientPersonIds: [SOURCE], authorityDigest: 'A'.repeat(64), purpose: purposes[0] },
    { recipientPersonIds: [SOURCE], authorityDigest: DIGEST, purpose: purposes[0], authorityRevision: 1 },
  ])('requires a bounded recipient set and digest without a fabricated revision %#', value => {
    expect(QuestionAuthorityBinding.safeParse(value).success).toBe(false);
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
