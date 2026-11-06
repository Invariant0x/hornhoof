import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, CatalogValue, GATE_CODES, GateCode, MESSAGE_STATUSES, OutboundAccountView, OutboundApprovalBinding, OutboundMessageView, OutboundPolicyValue, OutboundStatusInput, OutboundSubmit, SubmitResult, SupportClassifyInput, SupportClassifyResult, SupportSubmit } from '../src/index.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const accepted = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const withField = (value: object, field: Record<string, unknown>) => ({ ...value, ...field });
const NOW = '2026-11-06T10:00:00.000Z';
const LATER = '2026-12-06T10:00:00.000Z';

const document = {
  locale: 'pt-BR', templateId: randomUUID(), templateRevision: 3,
  blocks: [{ kind: 'price', id: randomUUID(), revision: 1 }, { kind: 'link', id: randomUUID(), revision: 2 }],
  variables: [{ slotId: randomUUID(), valueRef: randomUUID() }],
};
const submit = { task: 12, idempotencyKey: randomUUID(), channelId: randomUUID(), accountId: randomUUID(), bindingGeneration: 1, target: { kind: 'contact', contactId: randomUUID() }, segmentId: randomUUID(), document, scheduledAt: NOW };
const reply = { task: randomUUID(), idempotencyKey: randomUUID(), channelId: randomUUID(), accountId: randomUUID(), bindingGeneration: 2, ticketId: randomUUID(), ticketRevision: 1, classificationReceiptId: randomUUID(), document, scheduledAt: NOW };
const result = { messageId: randomUUID(), revision: 1, contentDigest: sha('bytes'), status: 'waiting_checks', reasonCodes: [] };
const view = { messageId: randomUUID(), revision: 1, contentDigest: sha('bytes'), status: 'sending', reasonCodes: ['delivery_unknown'], channelId: randomUUID(), accountId: randomUUID(), scheduledAt: NOW, updatedAt: NOW };
const messageApproval = { kind: 'message', requestId: randomUUID(), messageId: randomUUID(), revision: 1, contentDigest: sha('bytes'), policyDigest: sha('policy'), sourceRevisionsDigest: sha('sources'), accountId: randomUUID(), bindingGeneration: 1, authorityFingerprint: sha('authority') };
const approachApproval = { kind: 'approach', requestId: randomUUID(), channelId: randomUUID(), templateId: randomUUID(), templateRevision: 1, segmentId: randomUUID(), locale: 'en', policyDigest: sha('policy'), sourceRevisionsDigest: sha('sources'), authorityFingerprint: sha('authority') };
const price = { kind: 'price', amount: '1999.50', currency: 'USD', scale: 2, rounding: 'half_up', discountId: null, termsId: randomUUID(), validFrom: NOW, validUntil: LATER };
const template = { kind: 'template', locale: 'ar', subject: 'مرحبا', parts: [{ kind: 'text', text: 'مرحبا بك\n' }, { kind: 'slot', slotId: randomUUID(), type: 'price' }, { kind: 'slot', slotId: randomUUID(), type: 'unsubscribe' }] };
const policy = { timezone: 'Europe/Lisbon', accountDailyLimit: 50, domainDailyLimit: 200, sampling: { matureAfter: 50, firstPerSegment: 5, firstPerAuthor: 5, everyNth: 10 }, circuit: { windowHours: 24, minimumSample: 20, maxComplaints: 1, maxRefusals: 3, maxBounces: 5 } };

describe('the calls of the outbound gateway, as a reader of the protocol gets them', () => {
  it.each([
    ['a submit to a contact', OutboundSubmit, submit],
    ['a submit to an audience', OutboundSubmit, withField(submit, { target: { kind: 'audience', audienceId: randomUUID() } })],
    ['a support reply', SupportSubmit, reply],
    ['a result that waits', SubmitResult, result],
    ['a refusal with its reason', SubmitResult, withField(result, { status: 'rejected', reasonCodes: ['price_unapproved', 'consent_missing'] })],
    ['a safe status', OutboundMessageView, view],
    ['a status question', OutboundStatusInput, { messageId: randomUUID() }],
    ['a classification question', SupportClassifyInput, { task: 12, ticketId: randomUUID(), ticketRevision: 1, idempotencyKey: randomUUID() }],
    ['a classification answer', SupportClassifyResult, { classificationReceiptId: randomUUID(), status: 'pending' }],
    ['an approval of exact bytes', OutboundApprovalBinding, messageApproval],
    ['an approval of an approach', OutboundApprovalBinding, approachApproval],
    ['an account as an author sees it', OutboundAccountView, { accountId: randomUUID(), channelId: randomUUID(), available: true }],
    ['a price', CatalogValue, price],
    ['a price with no decimals', CatalogValue, withField(price, { amount: '2000', currency: 'JPY', scale: 0, termsId: null, validUntil: null })],
    ['a template in any language', CatalogValue, template],
    ['a link', CatalogValue, { kind: 'link', url: 'https://acme.example/pricing?plan=a' }],
    ['a claim', CatalogValue, { kind: 'claim', locale: 'ru', text: 'Работает на любом языке' }],
    ['a piece of knowledge', CatalogValue, { kind: 'knowledge', locale: 'en', text: 'Refunds go through a person.' }],
    ['an unsubscribe block', CatalogValue, { kind: 'unsubscribe', locale: 'en', text: 'Unsubscribe here' }],
    ['a percent off', CatalogValue, { kind: 'discount', off: { kind: 'percent', value: '12.5' } }],
    ['an amount off', CatalogValue, { kind: 'discount', off: { kind: 'amount', value: '10.00', currency: 'EUR' } }],
    ['terms', CatalogValue, { kind: 'terms', locale: 'en', text: 'Net 30' }],
    ['a segment', CatalogValue, { kind: 'segment', name: 'New shops' }],
    ['a public destination', CatalogValue, { kind: 'audience', name: 'Company blog', destination: 'https://acme.example/blog' }],
    ['a field a template may name', CatalogValue, { kind: 'variable', field: 'contact_first_name' }],
    ['a list of support classes', CatalogValue, { kind: 'taxonomy', classes: [{ classId: 'refund', requiresHuman: true, description: 'Asks for money back' }] }],
    ['a policy', OutboundPolicyValue, policy],
  ] as const)('takes %s', (_name, schema, value) => {
    expect(accepted(schema, value)).toBe(true);
  });

  it.each([
    ['free words in a submit', OutboundSubmit, withField(submit, { body: 'Buy now at 10 USD' })],
    ['a recipient header in a submit', OutboundSubmit, withField(submit, { cc: 'a@b.example' })],
    ['a flag that says it may send', OutboundSubmit, withField(submit, { canSend: true })],
    ['a company named by the author', OutboundSubmit, withField(submit, { companyId: randomUUID() })],
    ['a stale generation that is no number', OutboundSubmit, withField(submit, { bindingGeneration: 0 })],
    ['a target of no known kind', OutboundSubmit, withField(submit, { target: { kind: 'email', address: 'a@b.example' } })],
    ['a contact with an address in it', OutboundSubmit, withField(submit, { target: { kind: 'contact', contactId: randomUUID(), address: 'a@b.example' } })],
    ['free words in a document', OutboundSubmit, withField(submit, { document: withField(document, { text: 'hello' }) })],
    ['a block of raw text', OutboundSubmit, withField(submit, { document: withField(document, { blocks: [{ kind: 'text', id: randomUUID(), revision: 1 }] }) })],
    ['a block with its own value', OutboundSubmit, withField(submit, { document: withField(document, { blocks: [{ kind: 'price', id: randomUUID(), revision: 1, amount: '1.00' }] }) })],
    ['a variable with a raw value', OutboundSubmit, withField(submit, { document: withField(document, { variables: [{ slotId: randomUUID(), value: 'Ann' }] }) })],
    ['a block of revision zero', OutboundSubmit, withField(submit, { document: withField(document, { blocks: [{ kind: 'price', id: randomUUID(), revision: 0 }] }) })],
    ['a language that is no tag', OutboundSubmit, withField(submit, { document: withField(document, { locale: 'any language' }) })],
    ['a time that is not in UTC', OutboundSubmit, withField(submit, { scheduledAt: '2026-11-06T10:00:00+03:00' })],
    ['a task that is no reference', OutboundSubmit, withField(submit, { task: 'checkout' })],
    ['a reply with no ticket', SupportSubmit, withField(reply, { ticketId: undefined })],
    ['a reply that names its own recipient', SupportSubmit, withField(reply, { target: { kind: 'contact', contactId: randomUUID() } })],
    ['a reply with its own class', SupportSubmit, withField(reply, { classId: 'safe' })],
    ['a refusal with no reason', SubmitResult, withField(result, { status: 'rejected' })],
    ['a reason outside the list', SubmitResult, withField(result, { reasonCodes: ['provider said no: smtp 550'] })],
    ['a result of a state a submit cannot end in', SubmitResult, withField(result, { status: 'sent' })],
    ['a capital digest', SubmitResult, withField(result, { contentDigest: sha('bytes').toUpperCase() })],
    ['a status with an adapter setting', OutboundMessageView, withField(view, { endpoint: 'https://hook.example' })],
    ['a status with a contact in it', OutboundMessageView, withField(view, { recipient: 'a@b.example' })],
    ['a status with a provider receipt', OutboundMessageView, withField(view, { providerReceipt: 'queued as 1' })],
    ['a status of a state nobody named', OutboundMessageView, withField(view, { status: 'maybe' })],
    ['a classification result with a state nobody named', SupportClassifyResult, { classificationReceiptId: randomUUID(), status: 'safe' }],
    ['a classification with a class chosen by its caller', SupportClassifyInput, { task: 12, ticketId: randomUUID(), ticketRevision: 1, idempotencyKey: randomUUID(), classId: 'safe' }],
    ['an account with its password', OutboundAccountView, { accountId: randomUUID(), channelId: randomUUID(), available: true, password: 'x' }],
    ['an account with its signing key', OutboundAccountView, { accountId: randomUUID(), channelId: randomUUID(), available: true, signingKey: 'x' }],
    ['an approval of no kind', OutboundApprovalBinding, withField(messageApproval, { kind: undefined })],
    ['an approval of bytes with no digest', OutboundApprovalBinding, withField(messageApproval, { contentDigest: undefined })],
    ['an approval of an approach with a message in it', OutboundApprovalBinding, withField(approachApproval, { messageId: randomUUID() })],
    ['an approval by a kind string alone', OutboundApprovalBinding, { kind: 'known', requestId: randomUUID() }],
    ['a price as a number', CatalogValue, withField(price, { amount: 1999.5 })],
    ['a price with a sign', CatalogValue, withField(price, { amount: '-1.00' })],
    ['a price with an exponent', CatalogValue, withField(price, { amount: '1e3', scale: 0 })],
    ['a price with a thousands mark', CatalogValue, withField(price, { amount: '1,999.50' })],
    ['a price whose decimals do not fit its scale', CatalogValue, withField(price, { amount: '1999.5' })],
    ['a price in no currency', CatalogValue, withField(price, { currency: 'usd' })],
    ['a price that ends before it starts', CatalogValue, withField(price, { validUntil: '2026-01-01T00:00:00.000Z' })],
    ['a price with no way to round', CatalogValue, withField(price, { rounding: undefined })],
    ['a link that is not https', CatalogValue, { kind: 'link', url: 'http://acme.example' }],
    ['a link that runs code', CatalogValue, { kind: 'link', url: 'javascript:alert(1)' }],
    ['a link with a sign-in in it', CatalogValue, { kind: 'link', url: 'https://user:pass@acme.example' }],
    ['a link with a new line in it', CatalogValue, { kind: 'link', url: 'https://acme.example/\r\nBcc: a@b.example' }],
    ['a subject with a new line', CatalogValue, withField(template, { subject: 'Hello\r\nBcc: a@b.example' })],
    ['a text with a control character', CatalogValue, { kind: 'claim', locale: 'en', text: 'Hello\u0007' }],
    ['a template with free parts', CatalogValue, withField(template, { parts: [{ kind: 'script', text: 'x' }] })],
    ['a template slot of no known type', CatalogValue, withField(template, { parts: [{ kind: 'slot', slotId: randomUUID(), type: 'html' }] })],
    ['a value of no known kind', CatalogValue, { kind: 'html', text: '<a>' }],
    ['a field with an expression in it', CatalogValue, { kind: 'variable', field: 'contact.first_name || 1' }],
    ['a discount of both kinds', CatalogValue, { kind: 'discount', off: { kind: 'percent', value: '10', currency: 'EUR' } }],
    ['a policy with no daily limit', OutboundPolicyValue, withField(policy, { accountDailyLimit: undefined })],
    ['a policy with a limit of nothing', OutboundPolicyValue, withField(policy, { domainDailyLimit: 0 })],
    ['a policy with no time zone', OutboundPolicyValue, withField(policy, { timezone: undefined })],
    ['a policy with a time zone that does not exist', OutboundPolicyValue, withField(policy, { timezone: 'Mars/Olympus' })],
    ['a policy with a field nobody agreed on', OutboundPolicyValue, withField(policy, { skipChecks: true })],
    ['a policy with no sampling', OutboundPolicyValue, withField(policy, { sampling: undefined })],
    ['a policy with no way to stop', OutboundPolicyValue, withField(policy, { circuit: undefined })],
  ] as const)('refuses %s', (_name, schema, value) => {
    expect(accepted(schema, value)).toBe(false);
  });

  it('makes up nothing the caller left out', () => {
    const { sampling: _sampling, ...noSampling } = policy;
    expect(OutboundPolicyValue.safeParse(noSampling).success).toBe(false);
    expect(OutboundPolicyValue.parse(policy)).toEqual(policy);
    expect(OutboundSubmit.parse(submit)).toEqual(submit);
  });

  it('names every reason the design asks for', () => {
    expect(GATE_CODES).toEqual(expect.arrayContaining(['price_unapproved', 'terms_unapproved', 'link_unapproved', 'claim_unapproved', 'template_unapproved', 'unsupported_locale', 'contact_suppressed', 'consent_missing', 'support_escalation_required', 'support_intent_forbidden', 'secret_forbidden', 'pii_forbidden', 'channel_stopped', 'account_bound_elsewhere', 'stale_binding', 'daily_limit_exceeded', 'approval_required', 'review_unavailable', 'review_failed', 'check_uncertified', 'delivery_unknown']));
    expect(GATE_CODES.every(code => accepted(GateCode, code))).toBe(true);
    expect(accepted(GateCode, 'free words')).toBe(false);
  });

  it('names every state of a message from its submit to its end', () => {
    expect(MESSAGE_STATUSES).toEqual(expect.arrayContaining(['scheduled', 'waiting_checks', 'waiting_approval', 'rejected', 'reserved', 'sending', 'sent', 'definitely_failed', 'unknown', 'cancelled']));
  });
});

describe('the bytes a digest is taken of', () => {
  it('do not depend on the order of keys, at any depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });

  it('are sorted, with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [2, 1], c: { e: null, d: 'x y' } })).toBe('{"a":[2,1],"b":1,"c":{"d":"x y","e":null}}');
  });

  it('keep the order of a list, as it means something', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it('keep words in any language as they are', () => {
    expect(canonicalJson({ a: 'مرحبا', b: 'Привет' })).toBe('{"a":"مرحبا","b":"Привет"}');
  });

  it('keep a price as the decimal string it is', () => {
    expect(canonicalJson({ amount: '10.50' })).toBe('{"amount":"10.50"}');
  });

  it('do not let a key named like a built-in slip away', () => {
    expect(canonicalJson(JSON.parse('{"__proto__":{"a":1},"b":2}'))).toBe('{"__proto__":{"a":1},"b":2}');
  });
});
