import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { modelCheckDatasets, modelCheckEvaluations, modelCheckRevisions, modelChecks, tasks, waitNotices } from '../src/db/schema.js';
import { NO_MODEL_YET, type RunModelCheck } from '../src/modules/model-checks/run.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { addLiveMiss, checkIsOn, modelCheckRound, runNextEvaluation, saveDataset, saveDefinition, saveThresholds, weeklyRound } from '../src/modules/model-checks/store.js';
import { company } from './department-owner-fixture.js';
import { AUTHOR, LABELLER, SET, asJsonl, binding, hashOf, modelFor, mustBlock, reviewCase } from './model-check-fixture.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number) => new Date(NOW.getTime() + days * DAY);
const LIMITS = { falseAllowRate: 0, falseDenyRate: 0.5, classErrorRate: 0 };
const DEFINITION = { checkerCodeHash: hashOf('code'), promptHash: hashOf('prompt'), outputSchemaHash: hashOf('output'), sourceListHash: hashOf('list'), taxonomyHash: null, model: binding().model };

async function aPlace() {
  const c = await company();
  return { c, ctx: c.app.ctx, where: { companyId: c.companyId, departmentId: c.dev.id, productId: null, kind: 'outbound_review' as const } };
}
type Place = Awaited<ReturnType<typeof aPlace>>;

/* A check with all it needs, its first run waiting. */
async function aReadyCheck(rows = SET()) {
  const place = await aPlace();
  await saveDefinition(place.ctx, place.where, DEFINITION, AUTHOR, NOW);
  await saveDataset(place.ctx, place.where, asJsonl(rows), LABELLER, NOW);
  await saveThresholds(place.ctx, place.where, place.c.ids.dana, LIMITS, NOW);
  return { ...place, rows };
}

async function aCheckThatIsOn() {
  const ready = await aReadyCheck();
  await runNextEvaluation(ready.ctx, modelFor(ready.rows), NOW);
  return ready;
}

const checkOf = async ({ c }: Place) => (await c.db.select().from(modelChecks).where(eq(modelChecks.departmentId, c.dev.id)))[0]!;
const runsOf = ({ c }: Place) => c.db.select().from(modelCheckEvaluations).orderBy(modelCheckEvaluations.createdAt);
const setsOf = ({ c }: Place) => c.db.select().from(modelCheckDatasets).orderBy(modelCheckDatasets.version);
const noticesTo = ({ c }: Place, agentId: string) => c.db.select().from(waitNotices).where(and(eq(waitNotices.companyId, c.companyId), eq(waitNotices.agentId, agentId)));
const lastRun = async (place: Place) => (await runsOf(place)).at(-1)!;

describe('what makes a run start', () => {
  it('queues nothing while a check has only a definition', async () => {
    const place = await aPlace();
    await saveDefinition(place.ctx, place.where, DEFINITION, AUTHOR, NOW);
    expect(await runsOf(place)).toEqual([]);
    expect(await checkOf(place)).toMatchObject({ status: 'off', bindingDigest: null });
  });

  it('queues nothing while a check has no limits from its owner', async () => {
    const place = await aPlace();
    await saveDefinition(place.ctx, place.where, DEFINITION, AUTHOR, NOW);
    await saveDataset(place.ctx, place.where, asJsonl(SET()), LABELLER, NOW);
    expect(await runsOf(place)).toEqual([]);
  });

  it('queues one run as soon as a check has a definition, a set and limits, with it still off', async () => {
    const ready = await aReadyCheck();
    const check = await checkOf(ready);
    const runs = await runsOf(ready);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'queued', trigger: 'change', bindingDigest: check.bindingDigest });
    expect(runs[0]!.binding).toMatchObject({ checkId: check.id, companyId: ready.c.companyId, departmentId: ready.c.dev.id, kind: 'outbound_review', definitionVersion: 1, promptHash: DEFINITION.promptHash });
    expect(check).toMatchObject({ status: 'off', offReason: null });
  });

  it.each([
    ['prompt', 'prompt', { promptHash: hashOf('another prompt') }],
    ['checker code', 'code', { checkerCodeHash: hashOf('another code') }],
    ['list of prices, links and bans', 'list', { sourceListHash: hashOf('another list') }],
    ['output schema', 'output_schema', { outputSchemaHash: hashOf('another output') }],
    ['class list', 'taxonomy', { taxonomyHash: hashOf('another taxonomy') }],
    ['model', 'model', { model: { ...DEFINITION.model, revisionId: 'rev-2' } }],
  ])('turns the check off and starts a run when its %s changes', async (_name, part, change) => {
    const on = await aCheckThatIsOn();
    expect(await checkOf(on)).toMatchObject({ status: 'on' });
    await saveDefinition(on.ctx, on.where, { ...DEFINITION, ...change }, AUTHOR, later(1));
    expect(await checkOf(on)).toMatchObject({ status: 'off', offReason: part, validUntil: null });
    const runs = await runsOf(on);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ status: 'queued', trigger: 'change', parts: [part] });
    expect(runs[1]!.binding).toMatchObject({ definitionVersion: 2 });
  });

  it('changes nothing when the same definition comes again', async () => {
    const on = await aCheckThatIsOn();
    await saveDefinition(on.ctx, on.where, DEFINITION, AUTHOR, later(1));
    expect(await checkOf(on)).toMatchObject({ status: 'on' });
    expect(await runsOf(on)).toHaveLength(1);
    expect(await on.c.db.select().from(modelCheckRevisions)).toHaveLength(1);
  });

  it('turns the check off and starts a run on a new set of examples', async () => {
    const on = await aCheckThatIsOn();
    expect(await saveDataset(on.ctx, on.where, asJsonl([...on.rows, reviewCase()]), LABELLER, later(1))).toMatchObject({ ok: true, version: 2 });
    expect(await checkOf(on)).toMatchObject({ status: 'off', offReason: 'dataset' });
    expect(await lastRun(on)).toMatchObject({ status: 'queued', parts: ['dataset'] });
  });

  it('turns the check off and starts a run on new limits', async () => {
    const on = await aCheckThatIsOn();
    expect(await saveThresholds(on.ctx, on.where, on.c.ids.ceo, { ...LIMITS, falseDenyRate: 0.2 }, later(1))).toBe(true);
    expect(await checkOf(on)).toMatchObject({ status: 'off', offReason: 'thresholds', thresholdsBy: on.c.ids.ceo });
    expect(await lastRun(on)).toMatchObject({ status: 'queued', parts: ['thresholds'] });
  });
});

describe('a set of examples in the store', () => {
  it('keeps the lines sealed and only their counts and hash in the open', async () => {
    const place = await aPlace();
    const raw = asJsonl(SET());
    expect(await saveDataset(place.ctx, place.where, raw, LABELLER, NOW)).toEqual({ ok: true, version: 1, hash: hashOf(raw.toString()) });
    const [set] = await setsOf(place);
    expect(set).toMatchObject({ version: 1, hash: hashOf(raw.toString()), cases: 4, holdoutCases: 2, mustBlockCases: 2, addedByKind: LABELLER.kind, addedById: LABELLER.id });
    expect(set!.jsonlEnc).not.toContain('Words only a test holds');
  });

  it('refuses a set the check\'s own author labelled, and keeps nothing of it', async () => {
    const place = await aPlace();
    await saveDefinition(place.ctx, place.where, DEFINITION, AUTHOR, NOW);
    const answer = await saveDataset(place.ctx, place.where, asJsonl([reviewCase({ labelledBy: AUTHOR })]), LABELLER, NOW);
    expect(answer).toEqual({ ok: false, problems: [{ line: 1, code: 'self_labelled' }] });
    expect(await setsOf(place)).toEqual([]);
  });

  it('makes no new version of the same bytes', async () => {
    const place = await aPlace();
    const raw = asJsonl(SET());
    await saveDataset(place.ctx, place.where, raw, LABELLER, NOW);
    expect(await saveDataset(place.ctx, place.where, raw, LABELLER, NOW)).toMatchObject({ ok: true, version: 1 });
    expect(await setsOf(place)).toHaveLength(1);
  });

  it('turns a live miss into one more example, in a new version with the earlier bytes as they were', async () => {
    const on = await aCheckThatIsOn();
    const miss = mustBlock({ sourceIncidentId: on.c.task.id });
    const answer = await addLiveMiss(on.ctx, on.where, miss, LABELLER, later(1));
    expect(answer).toMatchObject({ ok: true, version: 2 });
    const [first, second] = await setsOf(on);
    expect(second).toMatchObject({ cases: first!.cases + 1, mustBlockCases: first!.mustBlockCases + 1 });
    expect(await checkOf(on)).toMatchObject({ status: 'off', offReason: 'dataset' });
    expect(await lastRun(on)).toMatchObject({ status: 'queued', parts: ['dataset'] });
  });

  it('refuses a live miss that names no incident', async () => {
    const on = await aCheckThatIsOn();
    expect(await addLiveMiss(on.ctx, on.where, mustBlock(), LABELLER, later(1))).toMatchObject({ ok: false, problems: [{ code: 'no_incident' }] });
    expect(await setsOf(on)).toHaveLength(1);
  });

  it('refuses a live miss while a check has no set to add it to', async () => {
    const place = await aPlace();
    const miss = mustBlock({ sourceIncidentId: place.c.task.id });
    expect(await addLiveMiss(place.ctx, place.where, miss, LABELLER, NOW)).toEqual({ ok: false, problems: [{ line: 1, code: 'empty' }] });
    expect(await setsOf(place)).toEqual([]);
  });
});

describe('limits from the owner', () => {
  it.each([['a share above one', { ...LIMITS, falseDenyRate: 2 }], ['a field nobody agreed on', { ...LIMITS, note: 'x' }], ['no number', { ...LIMITS, falseDenyRate: 'low' }], ['nothing', null]])('are refused with %s, leaving what was there', async (_name, given) => {
    const on = await aCheckThatIsOn();
    expect(await saveThresholds(on.ctx, on.where, on.c.ids.ceo, given, later(1))).toBe(false);
    expect(await checkOf(on)).toMatchObject({ status: 'on', thresholds: LIMITS, thresholdsBy: on.c.ids.dana });
  });

  it('change nothing when the same ones come again, but who set them', async () => {
    const on = await aCheckThatIsOn();
    expect(await saveThresholds(on.ctx, on.where, on.c.ids.ceo, LIMITS, later(1))).toBe(true);
    expect(await checkOf(on)).toMatchObject({ status: 'on', thresholdsBy: on.c.ids.ceo });
    expect(await runsOf(on)).toHaveLength(1);
  });
});

describe('a run', () => {
  it('finds nothing to do when none waits', async () => {
    const place = await aPlace();
    expect(await runNextEvaluation(place.ctx, NO_MODEL_YET, NOW)).toBeNull();
  });

  it('turns the check on for a week when all comes out right, and tells nobody', async () => {
    const ready = await aReadyCheck();
    const id = await runNextEvaluation(ready.ctx, modelFor(ready.rows), NOW);
    const run = await lastRun(ready);
    expect(run.id).toBe(id);
    expect(run).toMatchObject({ status: 'passed', complete: true, infraErrors: 0, mustBlockMisses: 0, problems: [], startedAt: NOW, finishedAt: NOW });
    expect(run.metrics).toMatchObject({ total: 4, falseAllows: 0, falseDenies: 0 });
    expect(run.holdoutMetrics).toMatchObject({ total: 2, falseAllows: 0, falseDenies: 0 });
    expect(await checkOf(ready)).toMatchObject({ status: 'on', offReason: null, validUntil: later(7) });
    expect(await noticesTo(ready, ready.c.head.id)).toEqual([]);
    expect(await checkIsOn(ready.ctx, ready.where, later(6))).toBe(true);
  });

  it('asks the model about each example of the set, with the binding it queued', async () => {
    const ready = await aReadyCheck();
    const call = vi.fn(modelFor(ready.rows));
    await runNextEvaluation(ready.ctx, call, NOW);
    expect(call).toHaveBeenCalledTimes(ready.rows.length);
    expect(call.mock.calls[0]![0]).toEqual((await lastRun(ready)).binding);
  });

  it('turns the check off and signals the owner once when a must-block example was let through', async () => {
    const on = await aCheckThatIsOn();
    const rows = [...on.rows, reviewCase()];
    await saveDataset(on.ctx, on.where, asJsonl(rows), LABELLER, later(1));
    await runNextEvaluation(on.ctx, modelFor(rows, { [rows[1]!.id]: 'allow' }), later(1));
    const run = await lastRun(on);
    expect(run).toMatchObject({ status: 'failed', mustBlockMisses: 1, finishedAt: later(1) });
    expect(run.problems).toContain('must_block_missed');
    expect(await checkOf(on)).toMatchObject({ status: 'off', offReason: 'evaluation_failed', validUntil: null });
    const notices = await noticesTo(on, on.c.head.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.message.text).toContain('Must-block examples let through: 1');
    expect(await noticesTo(on, on.c.orchestrator.id)).toHaveLength(1);
  });

  it('keeps the check off with no model yet, and says so', async () => {
    const ready = await aReadyCheck();
    await runNextEvaluation(ready.ctx, NO_MODEL_YET, NOW);
    expect(await lastRun(ready)).toMatchObject({ status: 'incomplete', complete: false, infraErrors: 4, problems: ['no_result'] });
    expect(await checkOf(ready)).toMatchObject({ status: 'off', offReason: 'evaluation_failed' });
    expect(await noticesTo(ready, ready.c.head.id)).toHaveLength(1);
  });

  it('keeps the check off when the model only fails, whatever it was before', async () => {
    const on = await aCheckThatIsOn();
    await saveDefinition(on.ctx, on.where, { ...DEFINITION, promptHash: hashOf('next') }, AUTHOR, later(1));
    const failing: RunModelCheck = async () => { throw new Error('model down'); };
    await runNextEvaluation(on.ctx, failing, later(1));
    expect(await lastRun(on)).toMatchObject({ status: 'incomplete', infraErrors: 4 });
    expect(await checkOf(on)).toMatchObject({ status: 'off' });
    expect(await checkIsOn(on.ctx, on.where, later(2))).toBe(false);
  });

  it('keeps the check off without asking the model when its set cannot be read', async () => {
    const ready = await aReadyCheck();
    await ready.c.db.update(modelCheckDatasets).set({ jsonlEnc: 'not sealed by us' });
    const call = vi.fn(modelFor(ready.rows));
    await runNextEvaluation(ready.ctx, call, NOW);
    expect(call).not.toHaveBeenCalled();
    expect(await lastRun(ready)).toMatchObject({ status: 'incomplete', complete: false, problems: ['no_result'] });
    expect(await checkOf(ready)).toMatchObject({ status: 'off', offReason: 'evaluation_failed' });
    expect(await noticesTo(ready, ready.c.head.id)).toHaveLength(1);
  });

  it('keeps the check off when the author of a new definition had labelled the set', async () => {
    const ready = await aReadyCheck();
    await saveDefinition(ready.ctx, ready.where, { ...DEFINITION, promptHash: hashOf('next') }, LABELLER, NOW);
    await runNextEvaluation(ready.ctx, modelFor(ready.rows), NOW);
    await runNextEvaluation(ready.ctx, modelFor(ready.rows), NOW);
    expect(await lastRun(ready)).toMatchObject({ status: 'incomplete', problems: ['no_result'] });
    expect(await checkOf(ready)).toMatchObject({ status: 'off' });
  });

  it('asks nothing for a run of a binding already replaced, and it speaks for nothing', async () => {
    const ready = await aReadyCheck();
    await saveDefinition(ready.ctx, ready.where, { ...DEFINITION, promptHash: hashOf('next') }, AUTHOR, NOW);
    const call = vi.fn(modelFor(ready.rows));
    const before = await checkOf(ready);
    await runNextEvaluation(ready.ctx, call, NOW);
    expect(call).not.toHaveBeenCalled();
    expect((await runsOf(ready))[0]).toMatchObject({ status: 'incomplete', problems: [] });
    expect(await checkOf(ready)).toEqual(before);
    expect(await noticesTo(ready, ready.c.head.id)).toEqual([]);
    await runNextEvaluation(ready.ctx, call, NOW);
    expect(await checkOf(ready)).toMatchObject({ status: 'on', bindingDigest: before.bindingDigest });
  });

  it('cannot turn on a check that changed while it ran', async () => {
    const ready = await aReadyCheck();
    const model = modelFor(ready.rows);
    let changed = false;
    const changing: RunModelCheck = async (given, input) => {
      if (!changed) await saveDefinition(ready.ctx, ready.where, { ...DEFINITION, promptHash: hashOf('next') }, AUTHOR, NOW);
      changed = true;
      return model(given, input);
    };
    await runNextEvaluation(ready.ctx, changing, NOW);
    const check = await checkOf(ready);
    expect(check).toMatchObject({ status: 'off', offReason: 'prompt', validUntil: null });
    expect((await runsOf(ready))[0]).toMatchObject({ status: 'passed' });
    expect(await lastRun(ready)).toMatchObject({ status: 'queued', bindingDigest: check.bindingDigest });
    expect(await noticesTo(ready, ready.c.head.id)).toEqual([]);
  });

  it('takes up a run its server left behind, once its time has passed', async () => {
    const ready = await aReadyCheck();
    await ready.c.db.update(modelCheckEvaluations).set({ status: 'running', startedAt: NOW });
    expect(await runNextEvaluation(ready.ctx, modelFor(ready.rows), new Date(NOW.getTime() + 60_000))).toBeNull();
    expect(await lastRun(ready)).toMatchObject({ status: 'running' });
    await runNextEvaluation(ready.ctx, modelFor(ready.rows), later(1));
    expect(await lastRun(ready)).toMatchObject({ status: 'passed' });
  });

  it('records nothing for a run that was taken up from under it', async () => {
    const ready = await aReadyCheck();
    const model = modelFor(ready.rows);
    let once = false;
    const overtaken: RunModelCheck = async (given, input) => {
      if (!once) await ready.c.db.update(modelCheckEvaluations).set({ startedAt: later(1) });
      once = true;
      return model(given, input);
    };
    await runNextEvaluation(ready.ctx, overtaken, NOW);
    expect(await lastRun(ready)).toMatchObject({ status: 'running', startedAt: later(1) });
    expect(await checkOf(ready)).toMatchObject({ status: 'off' });
  });
});

describe('the weekly run', () => {
  const closeWork = async ({ c }: Place) => c.db.update(tasks).set({ status: 'done', closedAt: NOW }).where(eq(tasks.id, c.task.id));

  it('comes a week after the last run while the department has work, once', async () => {
    const on = await aCheckThatIsOn();
    await weeklyRound(on.ctx, later(7));
    await weeklyRound(on.ctx, later(7));
    const runs = await runsOf(on);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ status: 'queued', trigger: 'weekly', bindingDigest: runs[0]!.bindingDigest, parts: [] });
    expect(runs[1]!.dedupKey).toMatch(/^weekly:/);
  });

  it('does not come sooner', async () => {
    const on = await aCheckThatIsOn();
    await weeklyRound(on.ctx, later(6));
    expect(await runsOf(on)).toHaveLength(1);
  });

  it('does not come while the department has no work, and the check ends with its week', async () => {
    const on = await aCheckThatIsOn();
    await closeWork(on);
    await weeklyRound(on.ctx, later(30));
    expect(await runsOf(on)).toHaveLength(1);
    expect(await checkIsOn(on.ctx, on.where, later(7))).toBe(false);
  });

  it('does not come while another run waits', async () => {
    const ready = await aReadyCheck();
    await weeklyRound(ready.ctx, later(30));
    expect(await runsOf(ready)).toHaveLength(1);
  });

  it('does not come for a check nothing was bound to yet', async () => {
    const place = await aPlace();
    await saveDefinition(place.ctx, place.where, DEFINITION, AUTHOR, NOW);
    await weeklyRound(place.ctx, later(30));
    expect(await runsOf(place)).toEqual([]);
  });

  it('turns a check that is on off and signals once when it misses what it must block', async () => {
    const on = await aCheckThatIsOn();
    await weeklyRound(on.ctx, later(7));
    await runNextEvaluation(on.ctx, modelFor(on.rows, { [on.rows[1]!.id]: 'allow' }), later(7));
    expect(await lastRun(on)).toMatchObject({ trigger: 'weekly', status: 'failed', mustBlockMisses: 1 });
    expect(await checkOf(on)).toMatchObject({ status: 'off', offReason: 'evaluation_failed', validUntil: null });
    expect(await noticesTo(on, on.c.head.id)).toHaveLength(1);
    await weeklyRound(on.ctx, later(14));
    await runNextEvaluation(on.ctx, modelFor(on.rows, { [on.rows[1]!.id]: 'allow' }), later(14));
    expect(await noticesTo(on, on.c.head.id)).toHaveLength(1);
  });

  it('keeps the check on until it ends, and turns it on again for another week', async () => {
    const on = await aCheckThatIsOn();
    await weeklyRound(on.ctx, later(7));
    await runNextEvaluation(on.ctx, modelFor(on.rows), later(7));
    expect(await checkOf(on)).toMatchObject({ status: 'on', validUntil: later(14) });
  });
});

describe('whether a check is on', () => {
  it('is not, for a check nobody made', async () => {
    const place = await aPlace();
    expect(await checkIsOn(place.ctx, place.where, NOW)).toBe(false);
  });
});

describe('the round of model checks', () => {
  it('queues what a week made due and runs what waits', async () => {
    const on = await aCheckThatIsOn();
    await modelCheckRound(on.ctx, later(7), modelFor(on.rows));
    const runs = await runsOf(on);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ trigger: 'weekly', status: 'passed' });
  });

  it('runs one after another until none waits', async () => {
    const ready = await aReadyCheck();
    await saveDefinition(ready.ctx, ready.where, { ...DEFINITION, promptHash: hashOf('next') }, AUTHOR, NOW);
    await modelCheckRound(ready.ctx, NOW, modelFor(ready.rows));
    expect((await runsOf(ready)).map(run => run.status)).toEqual(['incomplete', 'passed']);
  });

  it('is one at a time, however long a run takes', async () => {
    const ready = await aReadyCheck();
    const model = modelFor(ready.rows);
    let open = () => {};
    const gate = new Promise<void>(resolve => { open = resolve; });
    const call = vi.fn<RunModelCheck>(async (given, input) => {
      await gate;
      return model(given, input);
    });
    const first = modelCheckRound(ready.ctx, NOW, call);
    await modelCheckRound(ready.ctx, NOW, call);
    open();
    await first;
    expect(call).toHaveBeenCalledTimes(ready.rows.length);
  });

  it('is a part of the server\'s minute, and with no model yet leaves the check off', async () => {
    const ready = await aReadyCheck();
    const failed = () => (err: unknown) => { throw err; };
    await minuteRound(ready.ctx, NOW, failed);
    expect(await lastRun(ready)).toMatchObject({ status: 'incomplete', problems: ['no_result'] });
    expect(await checkOf(ready)).toMatchObject({ status: 'off' });
  });
});
