import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { CheckBinding, CheckInput, ModelIdentity } from '@hornhoof/protocol';
import { outboundReviewReceipts } from '../src/db/schema.js';
import { bindingDigest } from '../src/modules/model-checks/lifecycle.js';
import {
  areVendorsIndependent,
  createEvaluatorModelRunner,
  createLiveModelCheckRunner,
  resolveVendorSet,
  reviewOutboundMessageRevision,
  type FreshModelInvoke,
  type FreshModelResponse,
} from '../src/modules/outbound/model-checks.js';
import { aCompany, aFinishedRun, aMessage, sha, theBytes } from './outbound-fixture.js';
import { TAXONOMY, binding, classCase, reviewCase } from './model-check-fixture.js';
import { createTestDb } from './helpers.js';

const OPENAI_MODEL: ModelIdentity = {
  providerId: 'openai_api',
  vendorId: 'openai',
  modelId: 'gpt-5-mini',
  revisionId: 'gpt-5-mini-2026-10',
  inferenceConfigHash: sha('cfg-openai'),
};

const ANTHROPIC_MODEL: ModelIdentity = {
  providerId: 'anthropic_api',
  vendorId: 'anthropic',
  modelId: 'claude-haiku-4-5',
  revisionId: 'claude-haiku-4-5-20261001',
  inferenceConfigHash: sha('cfg-anthropic'),
};

function certifiedStub(activeBinding: CheckBinding) {
  const digest = bindingDigest(activeBinding);
  return vi.fn(async (given: CheckBinding) =>
    bindingDigest(given) === digest
      ? {
          certificateId: randomUUID(),
          bindingDigest: digest,
          reportId: randomUUID(),
          evaluatedAt: '2026-11-06T09:00:00.000Z',
          validUntil: '2026-11-13T09:00:00.000Z',
          status: 'active' as const,
        }
      : null,
  );
}

describe('independent-vendor fresh model checks (T8-09)', () => {
  it('resolves canonical vendors across CLI and API providers and rejects same-vendor aliases or unknown identities', () => {
    /* codex and openai_api are both OpenAI; claude and anthropic_api are both Anthropic. */
    expect(areVendorsIndependent('codex', 'openai', OPENAI_MODEL)).toBe(false);
    expect(areVendorsIndependent('codex', 'codex', OPENAI_MODEL)).toBe(false);
    expect(areVendorsIndependent(null, 'codex', { ...OPENAI_MODEL, vendorId: 'custom-openai-alias' })).toBe(false);
    expect(areVendorsIndependent('claude', 'anthropic', ANTHROPIC_MODEL)).toBe(false);
    expect(areVendorsIndependent(null, 'claude', ANTHROPIC_MODEL)).toBe(false);

    /* Missing or placeholder vendor identity fails closed. */
    expect(resolveVendorSet(null, '')).toBeNull();
    expect(resolveVendorSet(null, 'unknown')).toBeNull();
    expect(areVendorsIndependent(null, 'unknown', OPENAI_MODEL)).toBe(false);

    /* Disguising an OpenAI provider as Anthropic is rejected. */
    expect(resolveVendorSet('openai_api', 'anthropic')).toBeNull();

    /* True cross-vendor pair (Anthropic author vs OpenAI reviewer) passes. */
    expect(areVendorsIndependent('claude', 'anthropic', OPENAI_MODEL)).toBe(true);
    expect(areVendorsIndependent('antigravity', 'google', ANTHROPIC_MODEL)).toBe(true);
  });

  it('holds uncertified live checks without invoking the model', async () => {
    const checkBinding = binding({ model: OPENAI_MODEL });
    const invoke = vi.fn<FreshModelInvoke>();
    const run = createLiveModelCheckRunner({
      getCertifiedCheck: async () => null,
      invoke,
    });
    const input = reviewCase({ input: { ...reviewCase().input as Extract<CheckInput, { kind: 'outbound_review' }>, authorVendorId: 'anthropic' } }).input;
    await expect(run(checkBinding, input)).resolves.toEqual({ kind: 'unavailable', code: 'uncertified' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects same-vendor aliases, non-isolated author context reuse and uncertified mutable model drift', async () => {
    const checkBinding = binding({ model: OPENAI_MODEL });
    const getCertifiedCheck = certifiedStub(checkBinding);

    /* 1. Author on codex (OpenAI) vs reviewer on openai_api -> vendor_conflict without model call. */
    const invoke = vi.fn<FreshModelInvoke>(async () => ({
      status: 'ok',
      isolated: true,
      reviewer: OPENAI_MODEL,
      rawOutput: JSON.stringify({ kind: 'review', decision: 'allow', reasonCodes: [] }),
    }));
    const run = createLiveModelCheckRunner({ getCertifiedCheck, invoke });
    const sameVendorInput: CheckInput = {
      ...(reviewCase().input as Extract<CheckInput, { kind: 'outbound_review' }>),
      authorVendorId: 'codex',
    };
    await expect(run(checkBinding, sameVendorInput)).resolves.toEqual({ kind: 'unavailable', code: 'vendor_conflict' });
    expect(invoke).not.toHaveBeenCalled();

    /* 2. Non-isolated invocation (author session reuse) fails closed. */
    const nonIsolated = createLiveModelCheckRunner({
      getCertifiedCheck,
      invoke: async () => ({
        status: 'ok',
        isolated: false as unknown as true,
        reviewer: OPENAI_MODEL,
        rawOutput: JSON.stringify({ kind: 'review', decision: 'allow', reasonCodes: [] }),
      }),
    });
    const crossVendorInput: CheckInput = {
      ...(reviewCase().input as Extract<CheckInput, { kind: 'outbound_review' }>),
      authorVendorId: 'anthropic',
    };
    await expect(nonIsolated(checkBinding, crossVendorInput)).resolves.toEqual({ kind: 'unavailable', code: 'unavailable' });

    /* 3. Mutable model alias resolves to a different revisionId than certified binding -> uncertified hold. */
    const drifted = createLiveModelCheckRunner({
      getCertifiedCheck,
      invoke: async () => ({
        status: 'ok',
        isolated: true,
        reviewer: { ...OPENAI_MODEL, revisionId: 'gpt-5-mini-2026-11-drifted' },
        rawOutput: JSON.stringify({ kind: 'review', decision: 'allow', reasonCodes: [] }),
      }),
    });
    await expect(drifted(checkBinding, crossVendorInput)).resolves.toEqual({ kind: 'unavailable', code: 'uncertified' });
  });

  it('rejects malformed JSON, extra fields, wrong result kind, unknown taxonomy class, weakened requiresHuman and provider exceptions without leaking raw error text', async () => {
    const reviewBind = binding({ kind: 'outbound_review', model: OPENAI_MODEL });
    const reviewIn: CheckInput = {
      ...(reviewCase().input as Extract<CheckInput, { kind: 'outbound_review' }>),
      authorVendorId: 'anthropic',
    };

    const callWithOutput = (rawOutput: string) =>
      createEvaluatorModelRunner(async () => ({ status: 'ok', isolated: true, reviewer: OPENAI_MODEL, rawOutput }))(reviewBind, reviewIn);

    /* Malformed JSON & extra field */
    await expect(callWithOutput('not json at all')).resolves.toEqual({ kind: 'unavailable', code: 'invalid_output' });
    await expect(callWithOutput(JSON.stringify({ kind: 'review', decision: 'allow', reasonCodes: [], extra: 'sneaky' }))).resolves.toEqual({
      kind: 'unavailable',
      code: 'invalid_output',
    });
    /* Classification output returned for a review check */
    await expect(callWithOutput(JSON.stringify({ kind: 'classification', classId: 'howto', requiresHuman: false, reasonCodes: [] }))).resolves.toEqual({
      kind: 'unavailable',
      code: 'invalid_output',
    });

    /* Support classification taxonomy enforcement */
    const classBind = binding({ kind: 'support_classification', taxonomyHash: sha('taxonomy'), model: OPENAI_MODEL });
    const classIn = classCase().input;
    const callClass = (payload: unknown) =>
      createEvaluatorModelRunner(async () => ({ status: 'ok', isolated: true, reviewer: OPENAI_MODEL, rawOutput: JSON.stringify(payload) }))(classBind, classIn);

    /* Unknown classId rejected */
    await expect(callClass({ kind: 'classification', classId: 'invented_class', requiresHuman: false, reasonCodes: [] })).resolves.toEqual({
      kind: 'unavailable',
      code: 'invalid_output',
    });
    /* Weakening taxonomy entry refund (requiresHuman: true -> false) rejected */
    expect(TAXONOMY.find(t => t.classId === 'refund')?.requiresHuman).toBe(true);
    await expect(callClass({ kind: 'classification', classId: 'refund', requiresHuman: false, reasonCodes: [] })).resolves.toEqual({
      kind: 'unavailable',
      code: 'invalid_output',
    });

    /* Provider exception text is stripped, never serialized into output */
    const throwingRunner = createEvaluatorModelRunner(async (): Promise<FreshModelResponse> => {
      throw new Error('Upstream provider secret sk-live-999999 failed at internal host');
    });
    const failed = await throwingRunner(reviewBind, reviewIn);
    expect(failed).toEqual({ kind: 'unavailable', code: 'unavailable' });
    expect(JSON.stringify(failed)).not.toContain('sk-live-999999');
  });

  it('constructs CheckReceipt from server-verified invocation digests and persists immutable outbound_review_receipts once', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    const { check } = await aFinishedRun(db, at);
    const sending = await aMessage(db, at);
    const rev = await theBytes(db, at, sending, 1);

    const checkBind = binding({
      companyId: at.companyId,
      departmentId: at.department.id,
      checkId: check.id,
      kind: 'outbound_review',
      model: OPENAI_MODEL,
    });
    const getCertifiedCheck = certifiedStub(checkBind);
    const invoke = vi.fn<FreshModelInvoke>(async req => {
      /* Verify fresh request contains no tools or author session, only prompt + payload */
      expect(Object.keys(req).sort()).toEqual(['expectedModel', 'kind', 'systemPrompt', 'userPayload']);
      return {
        status: 'ok',
        isolated: true,
        reviewer: OPENAI_MODEL,
        rawOutput: JSON.stringify({ kind: 'review', decision: 'allow', reasonCodes: [] }),
      };
    });
    const runModelCheck = createLiveModelCheckRunner({ getCertifiedCheck, invoke });

    const input: Extract<CheckInput, { kind: 'outbound_review' }> = {
      schemaVersion: 1,
      kind: 'outbound_review',
      locale: 'en',
      subject: { id: sending.message.id, contentDigest: rev.contentDigest },
      message: { subject: 'Hello', body: 'Approved text' },
      facts: [],
      policyDigest: rev.policyDigest,
      authorVendorId: 'anthropic',
    };

    const first = await reviewOutboundMessageRevision({ db }, { runModelCheck }, {
      companyId: at.companyId,
      messageId: sending.message.id,
      messageRevision: 1,
      binding: checkBind,
      input,
    });
    expect('result' in first && first.checkId).toBe(check.id);
    expect('result' in first && first.bindingDigest).toBe(bindingDigest(checkBind));
    expect('result' in first && first.subjectDigest).toBe(rev.contentDigest);

    /* Second call for same (messageId, messageRevision, bindingDigest) reuses stored receipt without calling model again. */
    const second = await reviewOutboundMessageRevision({ db }, { runModelCheck }, {
      companyId: at.companyId,
      messageId: sending.message.id,
      messageRevision: 1,
      binding: checkBind,
      input,
    });
    expect(second).toEqual(first);
    expect(invoke).toHaveBeenCalledTimes(1);

    const stored = await db.select().from(outboundReviewReceipts).where(eq(outboundReviewReceipts.messageId, sending.message.id));
    expect(stored).toHaveLength(1);
  });
});
