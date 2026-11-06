import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, modelCheckDatasets, modelChecks } from '../src/db/schema.js';
import { runNextEvaluation, saveDefinition } from '../src/modules/model-checks/store.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';
import { AUTHOR, LABELLER, SET, asJsonl, binding, hashOf, modelFor, mustBlock, reviewCase } from './model-check-fixture.js';

const LIMITS = { falseAllowRate: 0, falseDenyRate: 0.5, classErrorRate: 0 };
const DEFINITION = { checkerCodeHash: hashOf('code'), promptHash: hashOf('prompt'), outputSchemaHash: hashOf('output'), sourceListHash: hashOf('list'), taxonomyHash: null, model: binding().model };
const NOW = new Date('2026-11-06T10:00:00.000Z');
type Company = Awaited<ReturnType<typeof company>>;

const base = (c: Company, departmentId = c.dev.id) => `/api/departments/${departmentId}/model-checks`;
const list = (c: Company, token: string, departmentId = c.dev.id) => c.app.inject({ method: 'GET', url: base(c, departmentId), ...as(token) });
const setLimits = (c: Company, token: string, thresholds: unknown, productId: string | null = null) => c.app.inject({ method: 'PUT', url: `${base(c)}/outbound_review/thresholds`, payload: { productId, thresholds }, ...as(token) });
const addSet = (c: Company, token: string, jsonl: string) => c.app.inject({ method: 'POST', url: `${base(c)}/outbound_review/sets`, payload: { productId: null, jsonl }, ...as(token) });
const addMiss = (c: Company, token: string, example: unknown) => c.app.inject({ method: 'POST', url: `${base(c)}/outbound_review/misses`, payload: { productId: null, example }, ...as(token) });
const owned = async () => {
  const c = await company();
  await c.db.update(departments).set({ ownerPersonId: c.ids.dana }).where(eq(departments.id, c.dev.id));
  return c;
};
const place = (c: Company) => ({ companyId: c.companyId, departmentId: c.dev.id, productId: null, kind: 'outbound_review' as const });

describe('limits of a check', () => {
  it('are set by the owner of the department, in their name', async () => {
    const c = await owned();
    const answer = await setLimits(c, c.danaToken, LIMITS);
    expect(answer.statusCode).toBe(200);
    const [check] = await c.db.select().from(modelChecks);
    expect(check).toMatchObject({ thresholds: LIMITS, thresholdsBy: c.ids.dana, departmentId: c.dev.id, productId: null, status: 'off' });
  });

  it('are set by the CEO too', async () => {
    const c = await company();
    expect((await setLimits(c, c.ceoToken, LIMITS)).statusCode).toBe(200);
  });

  it.each(['danaToken', 'samToken', 'wholeToken'] as const)('are not set by anyone else: %s', async token => {
    const c = await company();
    const answer = await setLimits(c, c[token], LIMITS);
    expect(answer.statusCode).toBe(403);
    expect(await c.db.select().from(modelChecks)).toEqual([]);
  });

  it('are refused when they are no limits', async () => {
    const c = await owned();
    const answer = await setLimits(c, c.danaToken, { ...LIMITS, falseDenyRate: 2 });
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ code: 'model_check_thresholds' });
    expect(await c.db.select().from(modelChecks)).toEqual([]);
  });

  it('go on a product of the department', async () => {
    const c = await owned();
    expect((await setLimits(c, c.danaToken, LIMITS, c.product.id)).statusCode).toBe(200);
    expect(await c.db.select().from(modelChecks)).toMatchObject([{ productId: c.product.id }]);
  });

  it('do not go on a product of another department', async () => {
    const c = await owned();
    expect((await setLimits(c, c.danaToken, LIMITS, c.sales.id)).statusCode).toBe(400);
    expect(await c.db.select().from(modelChecks)).toEqual([]);
  });

  it('are for a kind of check that exists', async () => {
    const c = await owned();
    const answer = await c.app.inject({ method: 'PUT', url: `${base(c)}/brand_review/thresholds`, payload: { productId: null, thresholds: LIMITS }, ...as(c.danaToken) });
    expect(answer.statusCode).toBe(400);
  });
});

describe('a set of examples sent in', () => {
  it('is kept sealed in a new version, in the name of whoever sent it', async () => {
    const c = await owned();
    const answer = await addSet(c, c.danaToken, asJsonl(SET()).toString());
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ version: 1 });
    const [row] = await c.db.select().from(modelCheckDatasets);
    expect(row).toMatchObject({ cases: 4, addedByKind: 'person', addedById: c.ids.dana });
    expect(row!.jsonlEnc).not.toContain('Words only a test holds');
  });

  it('comes back with its lines and what is wrong, and no words of it', async () => {
    const c = await owned();
    await saveDefinition(c.app.ctx, place(c), DEFINITION, AUTHOR, NOW);
    const answer = await addSet(c, c.danaToken, asJsonl([reviewCase({ labelledBy: AUTHOR })]).toString());
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ code: 'model_check_set', problems: [{ line: 1, code: 'self_labelled' }] });
    expect(answer.body).not.toContain('Words only a test holds');
  });

  it('is not taken from anyone else', async () => {
    const c = await owned();
    expect((await addSet(c, c.samToken, asJsonl(SET()).toString())).statusCode).toBe(403);
    expect(await c.db.select().from(modelCheckDatasets)).toEqual([]);
  });
});

describe('a miss found in real work', () => {
  it('becomes one more example', async () => {
    const c = await owned();
    await addSet(c, c.danaToken, asJsonl(SET()).toString());
    const answer = await addMiss(c, c.danaToken, mustBlock({ sourceIncidentId: c.task.id }));
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ version: 2 });
  });

  it('is refused when it is no example', async () => {
    const c = await owned();
    const answer = await addMiss(c, c.danaToken, { note: 'x' });
    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ code: 'model_check_set' });
  });

  it('is not taken from anyone else', async () => {
    const c = await owned();
    expect((await addMiss(c, c.samToken, mustBlock({ sourceIncidentId: c.task.id }))).statusCode).toBe(403);
  });
});

describe('the checks of a department as a person reads them', () => {
  const withARun = async () => {
    const c = await owned();
    const rows = SET();
    await saveDefinition(c.app.ctx, place(c), DEFINITION, AUTHOR, NOW);
    await addSet(c, c.danaToken, asJsonl(rows).toString());
    await setLimits(c, c.danaToken, LIMITS);
    await runNextEvaluation(c.app.ctx, modelFor(rows, { [rows[2]!.id]: 'block' }), new Date());
    return c;
  };

  it('show the false yes and false no of the whole set and of the held-out part apart', async () => {
    const c = await withARun();
    const answer = await list(c, c.danaToken);
    expect(answer.statusCode).toBe(200);
    const { checks, canChange } = answer.json() as { checks: unknown[]; canChange: boolean };
    expect(canChange).toBe(true);
    expect(checks).toMatchObject([{
      kind: 'outbound_review', productId: null, on: true, status: 'on', offReason: null, thresholds: LIMITS,
      set: { version: 1, cases: 4, holdoutCases: 2, mustBlockCases: 2 },
      lastRun: { status: 'passed', trigger: 'change', problems: [], infraErrors: 0, mustBlockMisses: 0, all: { total: 4, falseAllows: 0, falseDenies: 1 }, holdout: { total: 2, falseAllows: 0, falseDenies: 1 }, missedDevCases: [] },
    }]);
  });

  it('hold no words of an example and no sealed lines', async () => {
    const c = await withARun();
    const answer = await list(c, c.danaToken);
    expect(answer.body).not.toContain('Words only a test holds');
    expect(answer.body).not.toContain('jsonl');
    expect(answer.body).not.toContain(LABELLER.id);
  });

  it('say that someone with access cannot change them', async () => {
    const c = await withARun();
    expect((await list(c, c.wholeToken)).json()).toMatchObject({ canChange: false });
  });

  it('read as nothing for a department a person does not have', async () => {
    const c = await withARun();
    expect((await list(c, c.samToken)).statusCode).toBe(404);
  });

  it('are empty for a department with none', async () => {
    const c = await company();
    expect((await list(c, c.ceoToken)).json()).toEqual({ canChange: true, checks: [] });
  });
});
