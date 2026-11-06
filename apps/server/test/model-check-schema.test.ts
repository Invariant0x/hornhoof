import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, departments, modelCheckDatasets, modelCheckEvaluations, modelCheckRevisions, modelChecks } from '../src/db/schema.js';
import { createTestDb } from './helpers.js';
import { binding, hashOf } from './model-check-fixture.js';

const THRESHOLDS = { falseAllowRate: 0, falseDenyRate: 0.1, classErrorRate: 0.1 };
const COUNTS = { falseAllows: 0, falseDenies: 0, classErrors: 0, total: 1, unavailable: 0 };

/* A check of a department of its own, off as every check starts, with one definition and one set of examples. */
async function aCheck() {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'support', roleCode: 'SUP' }).returning();
  const place = { companyId: company!.id, departmentId: department!.id, kind: 'outbound_review' as const };
  const [check] = await db.insert(modelChecks).values(place).returning();
  const party = { kind: 'agent' as const, id: randomUUID() };
  const definition = { checkId: check!.id, definitionVersion: 1, checkerCodeHash: hashOf('code'), promptHash: hashOf('prompt'), outputSchemaHash: hashOf('output'), sourceListHash: hashOf('list'), model: binding().model, authorKind: party.kind, authorId: party.id };
  const [revision] = await db.insert(modelCheckRevisions).values(definition).returning();
  const examples = { checkId: check!.id, version: 1, hash: hashOf('set'), jsonlEnc: 'sealed', cases: 3, holdoutCases: 1, mustBlockCases: 1, addedByKind: party.kind, addedById: party.id };
  const [dataset] = await db.insert(modelCheckDatasets).values(examples).returning();
  const run = { checkId: check!.id, revisionId: revision!.id, datasetId: dataset!.id, binding: binding(), bindingDigest: hashOf('binding'), trigger: 'change' as const, dedupKey: 'change:one' };
  return { db, place, check: check!, definition, examples, run };
}

const refusedBy = (constraint: string) => ({ cause: { constraint } });

describe('the tables of checks made by a model', () => {
  it.each(['model_checks', 'model_check_revisions', 'model_check_datasets', 'model_check_evaluations'])('come empty on a new database: %s', async table => {
    const db = await createTestDb();
    expect((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows).toEqual([{ n: 0 }]);
  });

  it('start a check off, with nothing it was bound to', async () => {
    const { check } = await aCheck();
    expect(check).toMatchObject({ status: 'off', offReason: null, bindingDigest: null, validUntil: null, thresholds: null, thresholdsBy: null, productId: null });
  });

  it.each([
    ['a binding', { validUntil: new Date(), thresholds: THRESHOLDS }],
    ['an end of its week', { bindingDigest: hashOf('binding'), thresholds: THRESHOLDS }],
    ['limits from the owner', { bindingDigest: hashOf('binding'), validUntil: new Date() }],
  ])('keep a check from being on without %s', async (_name, more) => {
    const { db, check } = await aCheck();
    await expect(db.update(modelChecks).set({ status: 'on', ...more }).where(eq(modelChecks.id, check.id))).rejects.toMatchObject(refusedBy('model_checks_on_is_bound'));
  });

  it('keep a check from being on with a reason it is off', async () => {
    const { db, check } = await aCheck();
    const on = { status: 'on' as const, bindingDigest: hashOf('binding'), validUntil: new Date(), thresholds: THRESHOLDS, offReason: 'prompt' as const };
    await expect(db.update(modelChecks).set(on).where(eq(modelChecks.id, check.id))).rejects.toMatchObject(refusedBy('model_checks_on_is_bound'));
  });

  it('let a check be on when it has all of them', async () => {
    const { db, check } = await aCheck();
    const on = { status: 'on' as const, bindingDigest: hashOf('binding'), validUntil: new Date(), thresholds: THRESHOLDS };
    const [row] = await db.update(modelChecks).set(on).where(eq(modelChecks.id, check.id)).returning();
    expect(row).toMatchObject({ status: 'on', thresholds: THRESHOLDS });
  });

  it('refuse a state nobody named', async () => {
    const { db, check } = await aCheck();
    const change = sql`update model_checks set status = 'maybe', binding_digest = 'x', valid_until = now(), thresholds = '{}' where id = ${check.id}`;
    await expect(db.execute(change)).rejects.toMatchObject(refusedBy('model_checks_status'));
  });

  it('hold one check of a kind for a department, with no product too', async () => {
    const { db, place } = await aCheck();
    await expect(db.insert(modelChecks).values(place)).rejects.toMatchObject(refusedBy('model_checks_place'));
  });

  it('hold one check of a kind for each product of a department', async () => {
    const { db, place } = await aCheck();
    const productId = place.departmentId;
    await db.insert(modelChecks).values({ ...place, productId });
    await expect(db.insert(modelChecks).values({ ...place, productId })).rejects.toMatchObject(refusedBy('model_checks_place'));
  });

  it('never take a second definition under a version', async () => {
    const { db, definition } = await aCheck();
    await expect(db.insert(modelCheckRevisions).values(definition)).rejects.toMatchObject(refusedBy('model_check_revisions_version'));
  });

  it('never take a second set of examples under a version', async () => {
    const { db, examples } = await aCheck();
    await expect(db.insert(modelCheckDatasets).values(examples)).rejects.toMatchObject(refusedBy('model_check_datasets_version'));
  });

  it.each([
    ['no examples', { cases: 0, holdoutCases: 0, mustBlockCases: 0 }],
    ['more held out than it has', { version: 2, cases: 1, holdoutCases: 2, mustBlockCases: 0 }],
    ['more that must block than it has', { version: 2, cases: 1, holdoutCases: 0, mustBlockCases: 2 }],
  ])('refuse a set with %s', async (_name, more) => {
    const { db, examples } = await aCheck();
    await expect(db.insert(modelCheckDatasets).values({ ...examples, version: 2, ...more })).rejects.toMatchObject(refusedBy('model_check_datasets_counts'));
  });

  it('make one run of a change, however many rounds see it', async () => {
    const { db, run } = await aCheck();
    await db.insert(modelCheckEvaluations).values(run);
    await expect(db.insert(modelCheckEvaluations).values(run)).rejects.toMatchObject(refusedBy('model_check_evaluations_dedup'));
  });

  it('queue a run with nothing decided yet', async () => {
    const { db, run } = await aCheck();
    const [row] = await db.insert(modelCheckEvaluations).values(run).returning();
    expect(row).toMatchObject({ status: 'queued', complete: false, infraErrors: 0, mustBlockMisses: 0, metrics: null, holdoutMetrics: null, parts: [], problems: [], missedDevCases: [], finishedAt: null });
  });

  it.each([
    ['cut short', { complete: false, metrics: COUNTS, holdoutMetrics: COUNTS }],
    ['with an error', { complete: true, infraErrors: 1, metrics: COUNTS, holdoutMetrics: COUNTS }],
    ['that missed what it must block', { complete: true, mustBlockMisses: 1, metrics: COUNTS, holdoutMetrics: COUNTS }],
    ['with no scores', { complete: true, holdoutMetrics: COUNTS }],
    ['with no scores of the held-out part', { complete: true, metrics: COUNTS }],
  ])('refuse a pass for a run %s', async (_name, more) => {
    const { db, run } = await aCheck();
    const passed = { ...run, status: 'passed' as const, finishedAt: new Date(), ...more };
    await expect(db.insert(modelCheckEvaluations).values(passed)).rejects.toMatchObject(refusedBy('model_check_evaluations_clean_pass'));
  });

  it('take a pass for a clean run', async () => {
    const { db, run } = await aCheck();
    const [row] = await db.insert(modelCheckEvaluations).values({ ...run, status: 'passed', finishedAt: new Date(), complete: true, metrics: COUNTS, holdoutMetrics: COUNTS }).returning();
    expect(row).toMatchObject({ status: 'passed', metrics: COUNTS, holdoutMetrics: COUNTS });
  });

  it.each([
    ['ended with no end', { status: 'failed' as const }],
    ['waiting with an end', { status: 'queued' as const, finishedAt: new Date() }],
  ])('refuse a run %s', async (_name, more) => {
    const { db, run } = await aCheck();
    await expect(db.insert(modelCheckEvaluations).values({ ...run, ...more })).rejects.toMatchObject(refusedBy('model_check_evaluations_ended'));
  });

  it('go with their department', async () => {
    const { db, check, place } = await aCheck();
    await db.delete(departments).where(eq(departments.id, place.departmentId));
    expect(await db.select().from(modelChecks).where(eq(modelChecks.id, check.id))).toEqual([]);
    expect(await db.select().from(modelCheckRevisions).where(eq(modelCheckRevisions.checkId, check.id))).toEqual([]);
    expect(await db.select().from(modelCheckDatasets).where(eq(modelCheckDatasets.checkId, check.id))).toEqual([]);
  });
});
