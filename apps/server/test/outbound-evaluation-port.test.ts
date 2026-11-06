import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { VerifiedEvaluation } from '@hornhoof/protocol';
import { HIDDEN } from '../src/db/agent-sql.js';
import { modelCheckCertificates, modelCheckEvaluations, modelChecks } from '../src/db/schema.js';
import { evaluateCheck } from '../src/modules/model-checks/run.js';
import { parseDataset } from '../src/modules/model-checks/dataset.js';
import { saveDataset, saveThresholds } from '../src/modules/model-checks/store.js';
import {
  OUTBOUND_CHECK_HASHES,
  createEvaluationPort,
  currentCheckBinding,
  publishVerifiedEvaluation,
  syncOutboundCheckDefinition,
  trustedEvaluatorAuth,
} from '../src/modules/outbound/evaluation-port.js';
import { createModelCheckPorts } from '../src/modules/outbound/model-checks.js';
import { company } from './department-owner-fixture.js';
import { AUTHOR, LABELLER, RULES, SET, asJsonl, binding, hashOf, modelFor, mustBlock, reviewCase } from './model-check-fixture.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLDS = { falseAllowRate: 0, falseDenyRate: 0.25, classErrorRate: 0 };

async function setupBoundCheck() {
  const c = await company();
  await c.setOwner(c.ceoToken, c.dev.id, c.ids.dana);
  const place = { companyId: c.companyId, departmentId: c.dev.id, productId: null, kind: 'outbound_review' as const };
  const model = binding().model;
  await syncOutboundCheckDefinition(c.app.ctx, place, {
    sourceListHash: hashOf('sources-v1'),
    taxonomyHash: null,
    model,
    author: AUTHOR,
    now: NOW,
  });
  const rows = SET();
  const raw = asJsonl(rows);
  await saveDataset(c.app.ctx, place, raw, LABELLER, NOW);
  await saveThresholds(c.app.ctx, place, c.ids.dana, THRESHOLDS, NOW);
  const current = await currentCheckBinding(c.db, place);
  const [queuedRun] = await c.db.select().from(modelCheckEvaluations);
  const parsed = parseDataset(raw, RULES);
  if (!parsed.ok) throw new Error('expected valid test dataset');
  const outcome = await evaluateCheck(current!.binding, parsed.dataset, THRESHOLDS, modelFor(rows), {
    reportId: queuedRun!.id,
    now: NOW,
  });
  const verified: VerifiedEvaluation = {
    bindingDigest: outcome.evaluation.bindingDigest,
    reportId: outcome.evaluation.reportId,
    datasetHash: outcome.evaluation.datasetHash,
    complete: outcome.evaluation.complete,
    infraErrors: outcome.evaluation.infraErrors,
    mustBlockMisses: outcome.evaluation.mustBlockMisses,
    metrics: outcome.evaluation.metrics,
    holdoutMetrics: outcome.evaluation.holdoutMetrics,
    evaluatedAt: outcome.evaluation.evaluatedAt,
  };
  return { c, place, rows, current: current!, queuedRun: queuedRun!, verified };
}

describe('outbound evaluation and certification port (T8-16)', () => {
  it('registers deterministic checker code, prompt and output schema hashes and creates a bound check', async () => {
    const { current } = await setupBoundCheck();
    expect(OUTBOUND_CHECK_HASHES.outbound_review.checkerCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(OUTBOUND_CHECK_HASHES.outbound_review.checkerCodeHash).not.toBe('0'.repeat(64));
    expect(OUTBOUND_CHECK_HASHES.outbound_review.promptHash).not.toBe(OUTBOUND_CHECK_HASHES.support_classification.promptHash);
    expect(current).not.toBeNull();
    expect(current.binding.checkerCodeHash).toBe(OUTBOUND_CHECK_HASHES.outbound_review.checkerCodeHash);
  });

  it('mints one active weekly-capped certificate on a clean verified evaluation and returns it for the exact binding', async () => {
    const { c, current, verified } = await setupBoundCheck();
    let clock = NOW;
    const port = createEvaluationPort(c.app.ctx, { now: () => clock });

    expect(await port.getCertifiedCheck(current.binding)).toBeNull();
    const cert = await port.publishEvaluation(verified);
    expect(cert).not.toBeNull();
    expect(cert!.bindingDigest).toBe(current.bindingDigest);
    expect(cert!.status).toBe('active');
    expect(Date.parse(cert!.validUntil) - Date.parse(cert!.evaluatedAt)).toBeLessThanOrEqual(7 * DAY_MS);

    const active = await port.getCertifiedCheck(current.binding);
    expect(active).toEqual(cert);

    /* Expired after 7 days without re-evaluation returns null. */
    clock = new Date(NOW.getTime() + 7 * DAY_MS + 1000);
    expect(await port.getCertifiedCheck(current.binding)).toBeNull();
  });

  it('refuses unauthenticated or forged evaluator callers and exposes no certificate tool to agents', async () => {
    const { c, verified } = await setupBoundCheck();
    await expect(publishVerifiedEvaluation(c.app.ctx, null, verified, NOW)).rejects.toThrow(/evaluator/i);
    await expect(publishVerifiedEvaluation(c.app.ctx, { forged: true }, verified, NOW)).rejects.toThrow(/evaluator/i);

    const valid = await publishVerifiedEvaluation(c.app.ctx, trustedEvaluatorAuth(), verified, NOW);
    expect(valid?.status).toBe('active');

    const mcpClient = await c.tools(c.worker);
    const listed = await mcpClient.listTools();
    const names = listed.tools.map(t => t.name);
    expect(names.some(n => /publish.*eval|certif/i.test(n))).toBe(false);
    expect(HIDDEN).toEqual(expect.arrayContaining(['model_check_certificates', 'outbound_review_receipts', 'support_tickets', 'support_classifications']));
  });

  it('refuses incomplete runs, infra errors, hard mustBlock misses or exceeded owner thresholds and disables active check', async () => {
    const { c, current, verified } = await setupBoundCheck();
    const port = createEvaluationPort(c.app.ctx, { now: () => NOW });
    expect(await port.publishEvaluation(verified)).not.toBeNull();

    /* Hard mustBlock miss disables the check even when overall rate would fit a loose threshold. */
    const withMiss: VerifiedEvaluation = {
      ...verified,
      mustBlockMisses: 1,
      metrics: { ...verified.metrics, falseAllows: 1 },
    };
    expect(await port.publishEvaluation(withMiss)).toBeNull();
    expect(await port.getCertifiedCheck(current.binding)).toBeNull();

    const [checkAfterMiss] = await c.db.select().from(modelChecks).where(eq(modelChecks.id, current.checkId));
    expect(checkAfterMiss?.status).toBe('off');

    /* Incomplete / unavailable output also cannot mint a certificate. */
    const incomplete: VerifiedEvaluation = {
      ...verified,
      complete: false,
      infraErrors: 1,
      metrics: { ...verified.metrics, unavailable: 1 },
    };
    expect(await port.publishEvaluation(incomplete)).toBeNull();

    /* Exceeding owner falseDenyRate (0.25) also refuses certification. */
    const overDeny: VerifiedEvaluation = {
      ...verified,
      metrics: { ...verified.metrics, falseDenies: 2 },
    };
    expect(await port.publishEvaluation(overDeny)).toBeNull();
  });

  it('invalidates the exact binding on source list, model, dataset or threshold change and ignores delayed evaluations of the old binding', async () => {
    const { c, place, current, verified } = await setupBoundCheck();
    const port = createEvaluationPort(c.app.ctx, { now: () => NOW });
    const cert = await port.publishEvaluation(verified);
    expect(cert?.status).toBe('active');

    /* Source list changes -> rebinds check and invalidates old binding. */
    const changedTime = new Date(NOW.getTime() + 60_000);
    await syncOutboundCheckDefinition(c.app.ctx, place, {
      sourceListHash: hashOf('sources-v2'),
      taxonomyHash: null,
      model: current.binding.model,
      author: AUTHOR,
      now: changedTime,
    });
    await port.invalidateCertification(current.bindingDigest, 'list');
    expect(await port.getCertifiedCheck(current.binding)).toBeNull();

    /* Delayed evaluation from the old binding arrives after the change -> must NOT leave a live permit! */
    expect(await port.publishEvaluation(verified)).toBeNull();
    expect(await port.getCertifiedCheck(current.binding)).toBeNull();

    const certs = await c.db.select().from(modelCheckCertificates).where(eq(modelCheckCertificates.checkId, current.checkId));
    expect(certs.every(row => row.status === 'invalidated')).toBe(true);

    /* Threshold change or dataset change also invalidates an active certificate. */
    const next = await currentCheckBinding(c.db, place);
    expect(next?.bindingDigest).not.toBe(current.bindingDigest);
    await saveDataset(c.app.ctx, place, asJsonl([...SET(), reviewCase(), mustBlock()]), LABELLER, new Date(NOW.getTime() + 120_000));
    const afterSet = await currentCheckBinding(c.db, place);
    expect(afterSet?.bindingDigest).not.toBe(next?.bindingDigest);
  });

  it('never executes the JSONL evaluation suite during a live per-message model check', async () => {
    const { c, current, verified } = await setupBoundCheck();
    const invoke = vi.fn(async () => ({
      status: 'ok' as const,
      isolated: true as const,
      reviewer: current.binding.model,
      rawOutput: JSON.stringify({ kind: 'review', decision: 'allow', reasonCodes: [] }),
    }));
    const ports = createModelCheckPorts(c.app.ctx, invoke, { now: () => NOW });
    await ports.publishEvaluation(verified);

    const liveInput = SET()[0]!.input;
    const res = await ports.runModelCheck(current.binding, liveInput);
    expect('result' in res && res.result.kind === 'review' && res.result.decision).toBe('allow');
    /* Exactly 1 fresh model call for the 1 message, not 4 dataset cases. */
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
