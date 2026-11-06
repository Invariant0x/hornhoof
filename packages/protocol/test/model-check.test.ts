import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Case, CertifiedCheck, CheckBinding, CheckInput, CheckReceipt, CheckResult, CheckUnavailable, EvaluationCounts, INVALIDATION_CODES, InvalidationCode, MODEL_CHECK_KINDS, PROVIDER_IDS, REASON_CODES, ReasonCode, VerifiedEvaluation } from '../src/index.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const accepted = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const withField = (value: object, field: Record<string, unknown>) => ({ ...value, ...field });

const model = { providerId: 'claude', vendorId: 'anthropic', modelId: 'a-model', revisionId: 'rev-1', inferenceConfigHash: sha('config') };
const binding = {
  schemaVersion: 1, companyId: randomUUID(), departmentId: randomUUID(), productId: null, checkId: randomUUID(), kind: 'outbound_review', definitionVersion: 1,
  checkerCodeHash: sha('code'), promptHash: sha('prompt'), outputSchemaHash: sha('output'), sourceListHash: sha('list'), taxonomyHash: null, model,
  datasetVersion: randomUUID(), datasetHash: sha('dataset'), thresholdsHash: sha('thresholds'),
};
const subject = { id: randomUUID(), contentDigest: sha('subject') };
const fact = { kind: 'price', id: randomUUID(), revision: 1, canonicalValue: '10.00', sourceId: randomUUID() };
const reviewInput = { schemaVersion: 1, kind: 'support_reply_review', locale: 'en', subject, message: { subject: null, body: 'Words only a test holds' }, facts: [fact], policyDigest: sha('policy'), authorVendorId: 'openai' };
const classInput = { schemaVersion: 1, kind: 'support_classification', locale: 'en', subject, ticket: { text: 'Words only a test holds' }, taxonomyRevision: sha('taxonomy'), taxonomy: [{ classId: 'refund', requiresHuman: true, description: 'Asks for money back' }] };
const reviewCase = { schemaVersion: 1, id: randomUUID(), kind: 'support_reply_review', locale: 'en', split: 'holdout', input: reviewInput, expected: { decision: 'block' }, mustBlock: true, labelledBy: { kind: 'person', id: randomUUID() }, labelledAt: '2026-11-01T10:00:00.000Z', sourceIncidentId: null };
const classCase = withField(reviewCase, { kind: 'support_classification', split: 'dev', input: classInput, expected: { classId: 'refund', requiresHuman: true } });
const review = { kind: 'review', decision: 'escalate', reasonCodes: ['price_mismatch'] };
const classified = { kind: 'classification', classId: 'refund', requiresHuman: true, reasonCodes: [] };
const receipt = { schemaVersion: 1, checkId: randomUUID(), bindingDigest: sha('binding'), subjectDigest: sha('subject'), reviewer: model, result: review };
const certified = { certificateId: randomUUID(), bindingDigest: sha('binding'), reportId: randomUUID(), evaluatedAt: '2026-11-01T10:00:00.000Z', validUntil: '2026-11-08T10:00:00.000Z', status: 'active' };
const counts = { falseAllows: 0, falseDenies: 1, classErrors: 0, total: 3, unavailable: 0 };
const evaluation = { bindingDigest: sha('binding'), reportId: randomUUID(), datasetHash: sha('dataset'), complete: true, infraErrors: 0, mustBlockMisses: 0, metrics: counts, holdoutMetrics: withField(counts, { confusion: { refund: { howto: 2 } } }), evaluatedAt: '2026-11-01T10:00:00.000Z' };

describe('the contract of a check by a model, as a reader of the protocol gets it', () => {
  it.each([
    ['a binding', CheckBinding, binding],
    ['a binding of one product and its class list', CheckBinding, withField(binding, { productId: randomUUID(), kind: 'support_classification', taxonomyHash: sha('taxonomy') })],
    ['a review input', CheckInput, reviewInput],
    ['a classification input', CheckInput, classInput],
    ['an example of a review', Case, reviewCase],
    ['an example of a class', Case, classCase],
    ['an example from a live miss', Case, withField(reviewCase, { sourceIncidentId: randomUUID() })],
    ['a review result', CheckResult, review],
    ['a class result', CheckResult, classified],
    ['a receipt', CheckReceipt, receipt],
    ['a receipt of a class', CheckReceipt, withField(receipt, { result: classified })],
    ['no answer', CheckUnavailable, { kind: 'unavailable', code: 'vendor_conflict' }],
    ['a certificate', CertifiedCheck, certified],
    ['a verified evaluation', VerifiedEvaluation, evaluation],
  ] as const)('takes %s', (_name, schema, value) => {
    expect(accepted(schema, value)).toBe(true);
  });

  it.each([
    ['a binding with a field the contract does not name', CheckBinding, withField(binding, { approved: true })],
    ['a model with a field the contract does not name', CheckBinding, withField(binding, { model: withField(model, { alias: 'latest' }) })],
    ['a binding of another schema', CheckBinding, withField(binding, { schemaVersion: 2 })],
    ['a provider that does not exist', CheckBinding, withField(binding, { model: withField(model, { providerId: 'somebody' }) })],
    ['a digest in capitals', CheckBinding, withField(binding, { promptHash: sha('prompt').toUpperCase() })],
    ['a digest of another length', CheckBinding, withField(binding, { promptHash: 'abc' })],
    ['a company that is no id', CheckBinding, withField(binding, { companyId: 'acme' })],
    ['a kind outside the list', CheckBinding, withField(binding, { kind: 'brand_review' })],
    ['a version that is no whole number', CheckBinding, withField(binding, { definitionVersion: 1.5 })],
    ['a version before the first', CheckBinding, withField(binding, { definitionVersion: 0 })],
    ['a review input with a ticket in it', CheckInput, withField(reviewInput, { ticket: { text: 'x' } })],
    ['a review input of the class kind', CheckInput, withField(reviewInput, { kind: 'support_classification' })],
    ['a fact of a kind outside the list', CheckInput, withField(reviewInput, { facts: [withField(fact, { kind: 'rumour' })] })],
    ['a class entry with a field the contract does not name', CheckInput, withField(classInput, { taxonomy: [{ classId: 'refund', requiresHuman: true, description: 'x', weight: 1 }] })],
    ['an example with a field the contract does not name', Case, withField(reviewCase, { note: 'x' })],
    ['an example of neither part', Case, withField(reviewCase, { split: 'train' })],
    ['an expected form of both kinds at once', Case, withField(reviewCase, { expected: { decision: 'block', classId: 'refund', requiresHuman: true } })],
    ['an expected escalation, which only a model may answer', Case, withField(reviewCase, { expected: { decision: 'escalate' } })],
    ['a labeller of no known kind', Case, withField(reviewCase, { labelledBy: { kind: 'team', id: randomUUID() } })],
    ['a time that is not in UTC', Case, withField(reviewCase, { labelledAt: '2026-11-01T10:00:00+03:00' })],
    ['a time that is no time', Case, withField(reviewCase, { labelledAt: 'yesterday' })],
    ['a decision outside the list', CheckResult, withField(review, { decision: 'maybe' })],
    ['a reason in the words of a customer', CheckResult, withField(review, { reasonCodes: ['Dear customer, the price is wrong'] })],
    ['a class result with such a reason', CheckResult, withField(classified, { reasonCodes: ['Dear customer'] })],
    ['a receipt with no reviewer', CheckReceipt, withField(receipt, { reviewer: undefined })],
    ['a receipt with a field the contract does not name', CheckReceipt, withField(receipt, { approved: true })],
    ['no answer with a code outside the list', CheckUnavailable, { kind: 'unavailable', code: 'try_later' }],
    ['no answer with words in it', CheckUnavailable, { kind: 'unavailable', code: 'unavailable', detail: 'x' }],
    ['a certificate that is not active', CertifiedCheck, withField(certified, { status: 'revoked' })],
    ['an evaluation with no held out part', VerifiedEvaluation, withField(evaluation, { holdoutMetrics: undefined })],
    ['an evaluation with a score the contract does not name', VerifiedEvaluation, withField(evaluation, { accuracy: 1 })],
    ['an evaluation that says it is a certificate', VerifiedEvaluation, withField(evaluation, { status: 'active' })],
    ['a count below zero', VerifiedEvaluation, withField(evaluation, { infraErrors: -1 })],
    ['a count that is no whole number', EvaluationCounts, withField(counts, { total: 0.5 })],
    ['counts with a single accuracy', EvaluationCounts, withField(counts, { accuracy: 1 })],
    ['a confusion count below zero', EvaluationCounts, withField(counts, { confusion: { refund: { howto: -1 } } })],
  ] as const)('refuses %s', (_name, schema, value) => {
    expect(accepted(schema, value)).toBe(false);
  });

  it('names the three kinds of check', () => {
    expect(MODEL_CHECK_KINDS).toEqual(['outbound_review', 'support_reply_review', 'support_classification']);
  });

  it('keeps reasons and invalidations to fixed codes, each of them a reader can match', () => {
    expect(REASON_CODES.length).toBeGreaterThan(0);
    expect(INVALIDATION_CODES.length).toBeGreaterThan(0);
    expect(REASON_CODES.every(code => accepted(ReasonCode, code))).toBe(true);
    expect(INVALIDATION_CODES.every(code => accepted(InvalidationCode, code))).toBe(true);
    expect(accepted(ReasonCode, 'free words')).toBe(false);
    expect(accepted(InvalidationCode, 'free words')).toBe(false);
  });

  it.each(['code', 'prompt', 'output_schema', 'list', 'taxonomy', 'model', 'dataset', 'thresholds', 'scope'])('has a code for a change of %s', part => {
    expect(accepted(InvalidationCode, part)).toBe(true);
  });

  it('has a code for a check turned off by its evaluation', () => {
    expect(accepted(InvalidationCode, 'evaluation_failed')).toBe(true);
  });

  it('checks the provider against the very list the rest of the protocol uses', () => {
    expect(PROVIDER_IDS.every(providerId => accepted(CheckBinding, withField(binding, { model: withField(model, { providerId }) })))).toBe(true);
  });
});
