import { createHash } from 'node:crypto';
import { canonicalJson, type Case, type CheckBinding } from '@hornhoof/protocol';
import { and, desc, eq, inArray, isNotNull, lt, max, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { modelCheckDatasets, modelCheckEvaluations, modelCheckRevisions, modelChecks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { parseDataset, withLiveMiss, type Dataset, type DatasetProblem, type DatasetRules, type Party } from './dataset.js';
import { afterChange, afterRun, isOn, weeklyRun } from './lifecycle.js';
import { evaluateCheck, NO_MODEL_YET, unreadableSet, type Evaluation, type RunModelCheck, type RunOutcome } from './run.js';
import { parseThresholds, type Thresholds } from './score.js';
import { recordCheckSignal } from './signal.js';
import { departmentHasWork } from './work.js';
import { sameCheckPlace, type CheckPlace } from './place.js';
export type { CheckPlace } from './place.js';

/* Checks made by a model as they stand in the database. Each write goes under a lock on its check, so that a change and the
   end of a run see each other. Whatever changes a binding turns the check off and queues one run in the same transaction. */

export type CheckDefinition = Pick<CheckBinding, 'checkerCodeHash' | 'promptHash' | 'outputSchemaHash' | 'sourceListHash' | 'taxonomyHash' | 'model'>;
export type SavedSet = { ok: true; version: number; hash: string } | { ok: false; problems: DatasetProblem[] };

type Reader = Pick<Db, 'select'>;
type Writer = Pick<Db, 'select' | 'insert' | 'update'>;
type CheckRow = typeof modelChecks.$inferSelect;
type RevisionRow = typeof modelCheckRevisions.$inferSelect;
type SetRow = typeof modelCheckDatasets.$inferSelect;
type RunRow = typeof modelCheckEvaluations.$inferSelect;

/* Long enough for a slow model over a whole set. A run still marked as running after this was left by a server that stopped. */
const RUN_LEASE_MS = 3 * 60 * 60_000;
const NO_SET: SavedSet = { ok: false, problems: [{ line: 1, code: 'empty' }] };

async function lockedCheck(tx: Writer, place: CheckPlace): Promise<CheckRow> {
  await tx.insert(modelChecks).values(place).onConflictDoNothing();
  const [check] = await tx.select().from(modelChecks).where(sameCheckPlace(place)).for('update');
  return check!;
}

const latestRevision = async (db: Reader, checkId: string): Promise<RevisionRow | null> =>
  (await db.select().from(modelCheckRevisions).where(eq(modelCheckRevisions.checkId, checkId)).orderBy(desc(modelCheckRevisions.definitionVersion)).limit(1))[0] ?? null;

const latestSet = async (db: Reader, checkId: string): Promise<SetRow | null> =>
  (await db.select().from(modelCheckDatasets).where(eq(modelCheckDatasets.checkId, checkId)).orderBy(desc(modelCheckDatasets.version)).limit(1))[0] ?? null;

const boundRun = async (db: Reader, checkId: string, digest: string | null): Promise<RunRow | null> =>
  (digest ? (await db.select().from(modelCheckEvaluations).where(and(eq(modelCheckEvaluations.checkId, checkId), eq(modelCheckEvaluations.bindingDigest, digest))).limit(1))[0] : undefined) ?? null;

/* Whoever wrote any version of a check labels none of its examples, so a set is read against all of them. */
async function rulesOf(db: Reader, place: CheckPlace): Promise<DatasetRules> {
  const authors = await db.select({ kind: modelCheckRevisions.authorKind, id: modelCheckRevisions.authorId }).from(modelCheckRevisions)
    .innerJoin(modelChecks, eq(modelChecks.id, modelCheckRevisions.checkId)).where(sameCheckPlace(place));
  return { kind: place.kind, authors };
}

const definitionOf = (row: RevisionRow): CheckDefinition => ({
  checkerCodeHash: row.checkerCodeHash, promptHash: row.promptHash, outputSchemaHash: row.outputSchemaHash, sourceListHash: row.sourceListHash, taxonomyHash: row.taxonomyHash, model: row.model,
});

const bindingOf = (check: CheckRow, revision: RevisionRow, set: SetRow, thresholds: Thresholds): CheckBinding => ({
  schemaVersion: 1, companyId: check.companyId, departmentId: check.departmentId, productId: check.productId, checkId: check.id, kind: check.kind,
  definitionVersion: revision.definitionVersion, ...definitionOf(revision),
  datasetVersion: set.id, datasetHash: set.hash,
  thresholdsHash: createHash('sha256').update(canonicalJson(thresholds)).digest('hex'),
});

/* A check with a definition, a set and limits has a binding. Another binding turns it off and queues its run; the same one
   leaves all as it was. */
async function rebind(tx: Writer, check: CheckRow, now: Date): Promise<void> {
  const revision = await latestRevision(tx, check.id);
  const set = await latestSet(tx, check.id);
  if (!revision || !set || !check.thresholds) return;
  const next = bindingOf(check, revision, set, check.thresholds);
  const previous = (await boundRun(tx, check.id, check.bindingDigest))?.binding ?? null;
  const change = afterChange(previous, next, now);
  if (!change) return;
  const [part = null] = change.run.parts;
  await tx.update(modelChecks).set({ status: 'off', offReason: previous ? part : null, bindingDigest: change.state.bindingDigest, validUntil: null }).where(eq(modelChecks.id, check.id));
  await tx.insert(modelCheckEvaluations).values({ checkId: check.id, revisionId: revision.id, datasetId: set.id, binding: next, bindingDigest: change.run.bindingDigest, trigger: change.run.trigger, parts: change.run.parts, dedupKey: change.run.dedupKey }).onConflictDoNothing();
}

export async function saveDefinition(ctx: Pick<Ctx, 'db'>, place: CheckPlace, definition: CheckDefinition, author: Party, now: Date): Promise<void> {
  await ctx.db.transaction(async tx => {
    const check = await lockedCheck(tx, place);
    const last = await latestRevision(tx, check.id);
    if (last && canonicalJson(definitionOf(last)) === canonicalJson(definition)) return;
    await tx.insert(modelCheckRevisions).values({ checkId: check.id, definitionVersion: (last?.definitionVersion ?? 0) + 1, ...definition, authorKind: author.kind, authorId: author.id });
    await rebind(tx, check, now);
  });
}

/* Bytes that were read as UTF-8 come back the same, so the seal holds what the hash is of. */
async function storeSet(ctx: Pick<Ctx, 'config'>, tx: Writer, check: CheckRow, raw: Buffer, dataset: Dataset, by: Party, now: Date): Promise<SavedSet> {
  const last = await latestSet(tx, check.id);
  if (last?.hash === dataset.hash) return { ok: true, version: last.version, hash: last.hash };
  const version = (last?.version ?? 0) + 1;
  await tx.insert(modelCheckDatasets).values({ checkId: check.id, version, hash: dataset.hash, jsonlEnc: encryptSecret(raw.toString('utf8'), ctx.config.secret), cases: dataset.cases.length, holdoutCases: dataset.holdout, mustBlockCases: dataset.mustBlock, addedByKind: by.kind, addedById: by.id });
  await rebind(tx, check, now);
  return { ok: true, version, hash: dataset.hash };
}

export async function saveDataset(ctx: Pick<Ctx, 'db' | 'config'>, place: CheckPlace, raw: Buffer, by: Party, now: Date): Promise<SavedSet> {
  const parsed = parseDataset(raw, await rulesOf(ctx.db, place));
  if (!parsed.ok) return parsed;
  return ctx.db.transaction(async tx => storeSet(ctx, tx, await lockedCheck(tx, place), raw, parsed.dataset, by, now));
}

/* Under the lock, as two misses at once must not each make a version that lacks the other. */
export async function addLiveMiss(ctx: Pick<Ctx, 'db' | 'config'>, place: CheckPlace, miss: Case, by: Party, now: Date): Promise<SavedSet> {
  return ctx.db.transaction(async (tx): Promise<SavedSet> => {
    const [check] = await tx.select().from(modelChecks).where(sameCheckPlace(place)).for('update');
    const last = check ? await latestSet(tx, check.id) : null;
    if (!check || !last) return NO_SET;
    const next = withLiveMiss(Buffer.from(decryptSecret(last.jsonlEnc, ctx.config.secret)), miss, await rulesOf(tx, place));
    return next.ok ? storeSet(ctx, tx, check, next.raw, next.dataset, by, now) : next;
  });
}

/* What is no limits changes nothing: limits a check had stay. */
export async function saveThresholds(ctx: Pick<Ctx, 'db'>, place: CheckPlace, personId: string, given: unknown, now: Date): Promise<boolean> {
  const thresholds = parseThresholds(given);
  if (!thresholds) return false;
  await ctx.db.transaction(async tx => {
    const check = await lockedCheck(tx, place);
    await tx.update(modelChecks).set({ thresholds, thresholdsBy: personId }).where(eq(modelChecks.id, check.id));
    await rebind(tx, { ...check, thresholds }, now);
  });
  return true;
}

async function claimNext(db: Db, now: Date): Promise<RunRow | null> {
  const left = new Date(now.getTime() - RUN_LEASE_MS);
  const waiting = or(eq(modelCheckEvaluations.status, 'queued'), and(eq(modelCheckEvaluations.status, 'running'), lt(modelCheckEvaluations.startedAt, left)));
  const next = db.select(idOnly(modelCheckEvaluations)).from(modelCheckEvaluations).where(waiting).orderBy(modelCheckEvaluations.createdAt).limit(1).for('update', { skipLocked: true });
  const [run] = await db.update(modelCheckEvaluations).set({ status: 'running', startedAt: now }).where(inArray(modelCheckEvaluations.id, next)).returning();
  return run ?? null;
}

/* The set this run was queued with, or null when it cannot be read back as what was stored or a check's author labelled it. */
async function readSet(ctx: Pick<Ctx, 'db' | 'config'>, check: CheckRow, run: RunRow): Promise<Dataset | null> {
  const [row] = await ctx.db.select().from(modelCheckDatasets).where(eq(modelCheckDatasets.id, run.datasetId));
  const rules = await rulesOf(ctx.db, check);
  try {
    const parsed = parseDataset(Buffer.from(decryptSecret(row!.jsonlEnc, ctx.config.secret)), rules);
    return parsed.ok && parsed.dataset.hash === row!.hash ? parsed.dataset : null;
  } catch {
    return null;
  }
}

async function outcomeOf(ctx: Pick<Ctx, 'db' | 'config'>, check: CheckRow, run: RunRow, call: RunModelCheck, now: Date): Promise<RunOutcome> {
  const set = await readSet(ctx, check, run);
  const about = { reportId: run.id, now };
  return set ? evaluateCheck(run.binding, set, parseThresholds(check.thresholds), call, about) : unreadableSet(run.binding, about);
}

const stillTheRun = (run: RunRow) => and(eq(modelCheckEvaluations.id, run.id), eq(modelCheckEvaluations.status, 'running'), eq(modelCheckEvaluations.startedAt, run.startedAt!));

/* What a run says about its check: only a run of the binding the check has now may speak. */
async function applyToCheck(ctx: Pick<Ctx, 'db' | 'templates'>, check: CheckRow, run: RunRow, outcome: RunOutcome, now: Date): Promise<void> {
  if (check.bindingDigest !== run.bindingDigest) return;
  const { state, signal } = afterRun(check, run, outcome.decision, now);
  await ctx.db.update(modelChecks).set({ status: state.status, validUntil: state.validUntil, offReason: state.status === 'on' ? null : 'evaluation_failed' }).where(eq(modelChecks.id, check.id));
  if (signal) await recordCheckSignal(ctx, { companyId: check.companyId, departmentId: check.departmentId, checkId: check.id, kind: check.kind }, signal, outcome.report);
}

/* A run taken up from under this one, by a later round, is that round's to finish. */
async function finishRun(ctx: Pick<Ctx, 'db' | 'templates'>, run: RunRow, outcome: RunOutcome, now: Date): Promise<void> {
  const { complete, infraErrors, mustBlockMisses, metrics, holdoutMetrics } = outcome.evaluation;
  await ctx.db.transaction(async tx => {
    const [check] = await tx.select().from(modelChecks).where(eq(modelChecks.id, run.checkId)).for('update');
    const ended = await tx.update(modelCheckEvaluations)
      .set({ status: outcome.decision.status, complete, infraErrors, mustBlockMisses, metrics, holdoutMetrics, problems: outcome.decision.problems, missedDevCases: outcome.report.missedDevCases, finishedAt: now })
      .where(stillTheRun(run)).returning({ id: modelCheckEvaluations.id });
    if (ended.length) await applyToCheck({ db: tx as unknown as Db, templates: ctx.templates }, check!, run, outcome, now);
  });
}

/* What a passed run leads to beyond its check being on: the minute round gives it the certifier. */
type PassedRun = (evaluation: Evaluation) => Promise<void>;
const NOTHING_MORE: PassedRun = async () => {};

async function endRun(ctx: Pick<Ctx, 'db' | 'config' | 'templates'>, check: CheckRow, run: RunRow, call: RunModelCheck, passed: PassedRun, now: Date): Promise<void> {
  const outcome = await outcomeOf(ctx, check, run, call, now);
  await finishRun(ctx, run, outcome, now);
  if (outcome.decision.status === 'passed') await passed(outcome.evaluation);
}

/* Takes the oldest run that waits and runs it to its end. A run of a binding already replaced asks nothing and says nothing. */
export async function runNextEvaluation(ctx: Pick<Ctx, 'db' | 'config' | 'templates'>, call: RunModelCheck, now: Date, passed: PassedRun = NOTHING_MORE): Promise<string | null> {
  const run = await claimNext(ctx.db, now);
  if (!run) return null;
  const [check] = await ctx.db.select().from(modelChecks).where(eq(modelChecks.id, run.checkId));
  if (check!.bindingDigest === run.bindingDigest) await endRun(ctx, check!, run, call, passed, now);
  else await ctx.db.update(modelCheckEvaluations).set({ status: 'incomplete', finishedAt: now }).where(stillTheRun(run));
  return run.id;
}

async function queueWeekly(ctx: Pick<Ctx, 'db'>, check: CheckRow, now: Date): Promise<void> {
  const waitingRuns = sql<number>`count(*) filter (where ${modelCheckEvaluations.status} in ('queued', 'running'))::int`;
  const [seen] = await ctx.db.select({ waiting: waitingRuns, lastFinishedAt: max(modelCheckEvaluations.finishedAt) }).from(modelCheckEvaluations).where(eq(modelCheckEvaluations.checkId, check.id));
  if (seen!.waiting > 0) return;
  const due = weeklyRun(check, seen!.lastFinishedAt, await departmentHasWork(ctx, check.companyId, check.departmentId), now);
  const bound = due ? await boundRun(ctx.db, check.id, check.bindingDigest) : null;
  if (!due || !bound) return;
  await ctx.db.insert(modelCheckEvaluations).values({ checkId: check.id, revisionId: bound.revisionId, datasetId: bound.datasetId, binding: bound.binding, bindingDigest: due.bindingDigest, trigger: due.trigger, parts: due.parts, dedupKey: due.dedupKey }).onConflictDoNothing();
}

export async function weeklyRound(ctx: Pick<Ctx, 'db'>, now: Date): Promise<void> {
  for (const check of await ctx.db.select().from(modelChecks).where(isNotNull(modelChecks.bindingDigest))) await queueWeekly(ctx, check, now);
}

const rounds = new WeakSet<object>();

/* One round at a time, however long its model takes: the server's minute goes on meanwhile. With no call given every run ends
   as no result, which leaves its check off. */
export async function modelCheckRound(ctx: Pick<Ctx, 'db' | 'config' | 'templates'>, now: Date, call: RunModelCheck = NO_MODEL_YET, passed: PassedRun = NOTHING_MORE): Promise<void> {
  if (rounds.has(ctx)) return;
  rounds.add(ctx);
  try {
    await weeklyRound(ctx, now);
    let ran = await runNextEvaluation(ctx, call, now, passed);
    while (ran) ran = await runNextEvaluation(ctx, call, now, passed);
  } finally {
    rounds.delete(ctx);
  }
}

export async function checkIsOn(ctx: Pick<Ctx, 'db'>, place: CheckPlace, now: Date): Promise<boolean> {
  const [check] = await ctx.db.select().from(modelChecks).where(sameCheckPlace(place));
  return check !== undefined && isOn(check, now);
}
