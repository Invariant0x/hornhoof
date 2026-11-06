import { KeptFiles, PREPARATION_UNIT, type EnvironmentSnapshot, type FileOutcome, type RepositoryScope, type TestEnvironmentV1, type TestExecution, type TestUnit, type UnitFingerprint } from '@hornhoof/protocol';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { tasks, testFileResults, testParts, testRuns, testSuiteMemory, turns, type TestFileKey, type TestRunFileCache } from '../../db/schema.js';
import { unitKey as keyOf } from './plan-environment.js';

/* Reusing green test results. A file that passed at a fingerprint need not run again at that fingerprint. Every doubt runs the
   file: no fingerprint, no green result, a group with one file changed, a machine that sent none. Every so many turns a run
   reuses nothing, and what it finds red that was kept green is shown. */

type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
type Db = Ctx['db'];
type Selection = TestExecution['selection'];
type Mode = TestRunFileCache['mode'];

/* Results no run asked for in this long go. Whatever went is only run again. */
const KEPT_DAYS = 30;
const SHOWN_FILES = 30;

export const printKey = (unit: TestFileKey, fingerprint: string): string => `${keyOf(unit)}\0${fingerprint}`;

/* Due on a multiple of the interval, or when a multiple went by without one, and not twice in one turn. */
export function fullRunDue({ turn, everyTurns, lastFullTurn }: { turn: number | null; everyTurns: number; lastFullTurn: number | null }): boolean {
  if (turn === null || lastFullTurn === turn) return false;
  return turn % everyTurns === 0 || (lastFullTurn !== null && turn - lastFullTurn >= everyTurns);
}

/* A manifest that names no full run reuses nothing, as nothing would ever check what it reused. */
export function chooseRunMode(manifest: TestEnvironmentV1, request: { profile?: string; suite?: string }, due: boolean, printed: boolean): { mode: Mode; profile: string } | null {
  const fullRun = manifest.execution?.fullRun, profile = request.profile ?? manifest.defaultProfile;
  if (!fullRun) return null;
  if (profile === fullRun.profile) return { mode: 'full', profile };
  if (due && profile === fullRun.replaces && !request.suite) return { mode: 'full', profile: fullRun.profile };
  return { mode: printed ? 'cached' : 'off', profile };
}

export type ReuseDecision = { reused: ReadonlySet<string>; preparation: boolean };
export const NO_REUSE: ReuseDecision = { reused: new Set(), preparation: false };

function completeGroups(units: TestUnit[], known: (unit: TestUnit) => boolean): TestUnit[] {
  const missing = new Set(units.filter(unit => !known(unit)).map(unit => `${unit.suiteId}\0${unit.selectionUnit}`));
  return units.filter(unit => !missing.has(`${unit.suiteId}\0${unit.selectionUnit}`));
}
/* What a run need not run. Suites the preparation runs go with it: they run all or none. */
export function decideReuse({ units, prints, green, once }: { units: TestUnit[]; prints: UnitFingerprint[]; green: { has(key: string): boolean }; once: string[] }): ReuseDecision {
  const byUnit = new Map(prints.map(print => [keyOf(print), print.fingerprint]));
  const known = (unit: TestFileKey): boolean => { const print = byUnit.get(keyOf(unit)); return print !== undefined && green.has(printKey(unit, print)); };
  const prepared = units.filter(unit => once.includes(unit.suiteId));
  const preparation = once.length > 0 && known(PREPARATION_UNIT) && prepared.every(known);
  const reused = completeGroups(units.filter(unit => !once.includes(unit.suiteId)), known);
  return { reused: new Set([...reused, ...(preparation ? prepared : [])].map(keyOf)), preparation };
}

function selectedFiles(snapshot: EnvironmentSnapshot, selection: Selection): TestFileKey[] {
  if (selection.kind === 'batch') return selection.selections.flatMap(member => member.files.map(file => ({ suiteId: member.suiteId, file })));
  if (selection.kind === 'prepare') {
    const suiteIds = snapshot.description.manifest.execution?.oncePreparation?.suiteIds ?? [];
    return [PREPARATION_UNIT, ...snapshot.description.inventory.filter(unit => suiteIds.includes(unit.suiteId)).map(unit => ({ suiteId: unit.suiteId, file: unit.file }))];
  }
  return selection.kind === 'suite' ? selection.files.map(file => ({ suiteId: selection.suiteId, file })) : [];
}

export type GreenFile = TestFileKey & { ms?: number; note?: string };
/* What a part proved of its own files. A part that passed proves them all, but for one its runner still called failed. One that
   failed proves only what its runner named, and what it did not name stays unknown. */
export function partFileResults(snapshot: EnvironmentSnapshot, selection: Selection, passed: boolean, reported: FileOutcome[] | undefined): { green: GreenFile[]; failed: TestFileKey[] } {
  const files = selectedFiles(snapshot, selection), said = new Map((reported ?? []).map(item => [keyOf(item), item]));
  const named = files.filter(file => said.has(keyOf(file)));
  const failed = named.filter(file => said.get(keyOf(file))!.status === 'failed');
  const proved = passed ? files.filter(file => said.get(keyOf(file))?.status !== 'failed') : named.filter(file => said.get(keyOf(file))!.status === 'passed');
  const green = proved.map(file => { const { ms, note } = said.get(keyOf(file)) ?? {}; return { ...file, ...(ms === undefined ? {} : { ms }), ...(note === undefined ? {} : { note }) }; });
  return { green, failed };
}

const listed = (items: string[], between: string): string => items.slice(0, SHOWN_FILES).join(between) + (items.length > SHOWN_FILES ? `, and ${items.length - SHOWN_FILES} more` : '');
const names = (files: TestFileKey[]): string => listed([...new Set(files.map(file => file.file))], ', ');
function modeLine(cache: TestRunFileCache, parts: Pick<Part, 'failedFiles'>[]): string[] {
  if (cache.mode === 'full') return [`This was ${cache.turn === null ? 'a full run' : `the full run of turn ${cache.turn}`}: nothing was reused.`];
  if (cache.mode === 'off') return ['Nothing was reused: the machine that described this commit sent no fingerprints.'];
  if (!cache.reused) return [];
  return [`${cache.reused} test files kept their fingerprint and a green result, so ${parts.length ? 'they did not run again' : 'nothing had to run'}.`];
}
function mismatchLine(files: TestFileKey[]): string {
  const what = files.length === 1
    ? 'was green at this same fingerprint and failed now. Either it depends on something its fingerprint does not see, or it is flaky.'
    : 'were green at these same fingerprints and failed now. Either they depend on something their fingerprints do not see, or they are flaky.';
  return `Mismatch with the kept results: ${names(files)} ${what}`;
}
/* What a run's result says of reuse. */
export function reuseLines(cache: TestRunFileCache | null, parts: Pick<Part, 'failedFiles'>[]): string[] {
  if (!cache) return [];
  const failed = parts.flatMap(part => part.failedFiles ?? []), lines = modeLine(cache, parts);
  if (failed.length) lines.push(`Failed test files: ${names(failed)}.`);
  if (cache.mismatches.length) lines.push(mismatchLine(cache.mismatches));
  if (cache.notes.length) lines.push(`Notes on test files: ${listed(cache.notes.map(({ file, note }) => `${file}: ${note}`), '; ')}.`);
  return lines;
}
export function reuseView(cache: TestRunFileCache | null, parts: Pick<Part, 'failedFiles'>[]): object {
  if (!cache) return {};
  const failedFiles = [...new Set(parts.flatMap(part => part.failedFiles ?? []).map(file => file.file))];
  return { reuse: { mode: cache.mode, turn: cache.turn, reused: cache.reused, preparationReused: cache.preparationReused, mismatches: cache.mismatches.map(file => file.file), failedFiles, notes: cache.notes } };
}

/* The turn a run belongs to: its task's, or the one open now. */
async function turnOfRun(db: Db, run: Pick<Run, 'taskId' | 'companyId'>): Promise<number | null> {
  const [own] = await db.select({ number: turns.number }).from(tasks).innerJoin(turns, eq(turns.id, tasks.turnId)).where(eq(tasks.id, run.taskId));
  if (own) return own.number;
  const [open] = await db.select({ number: turns.number }).from(turns).where(and(eq(turns.companyId, run.companyId), eq(turns.status, 'open')));
  return open?.number ?? null;
}
/* A full run stopped halfway proves nothing, so the next one is the full run; one still going counts, so two do not start. */
async function lastFullTurnOf(db: Db, run: Pick<Run, 'id' | 'companyId'>, scope: RepositoryScope): Promise<number | null> {
  const [last] = await db.select({ turn: sql<number | null>`max((${testRuns.fileCache}->>'turn')::int)` }).from(testRuns).where(and(
    eq(testRuns.companyId, run.companyId), eq(testRuns.departmentId, scope.repositoryOwnerId), inArray(testRuns.status, ['running', 'passed', 'failed']),
    sql`${testRuns.fileCache}->>'mode' = 'full'`, sql`${testRuns.environmentRequest}->'repositoryScope'->>'repoUrlHash' = ${scope.repoUrlHash}`,
  ));
  return last?.turn ?? null;
}

export type RunMode = { mode: Mode; profile: string; turn: number | null } | null;
export async function runModeOf(ctx: Pick<Ctx, 'db'>, run: Run, manifest: TestEnvironmentV1, scope: RepositoryScope, printed: boolean): Promise<RunMode> {
  const request = run.environmentRequest!, fullRun = manifest.execution?.fullRun;
  if (!fullRun) return null;
  const turn = await turnOfRun(ctx.db, run);
  const due = fullRunDue({ turn, everyTurns: fullRun.everyTurns, lastFullTurn: await lastFullTurnOf(ctx.db, run, scope) });
  const chosen = chooseRunMode(manifest, request, due, printed);
  return chosen && { ...chosen, turn };
}

const ofRepository = (scope: RepositoryScope) => and(eq(testFileResults.companyId, scope.companyId), eq(testFileResults.repositoryOwnerId, scope.repositoryOwnerId), eq(testFileResults.repoUrlHash, scope.repoUrlHash));

/* What was green at these fingerprints in this one repository, with what each result came to. */
async function greenAt(db: Db, scope: RepositoryScope, prints: UnitFingerprint[]): Promise<Map<string, string | null>> {
  if (!prints.length) return new Map();
  const rows = await db.select({ suiteId: testFileResults.suiteId, file: testFileResults.file, fingerprint: testFileResults.fingerprint, note: testFileResults.note }).from(testFileResults).where(and(ofRepository(scope), inArray(testFileResults.fingerprint, [...new Set(prints.map(print => print.fingerprint))])));
  return new Map(rows.map(row => [printKey(row, row.fingerprint), row.note]));
}
/* What the results a run takes over came to. */
function notesOf(units: TestUnit[], prints: UnitFingerprint[], green: Map<string, string | null>, taken: ReuseDecision): TestRunFileCache['notes'] {
  const byUnit = new Map(prints.map(print => [keyOf(print), print.fingerprint]));
  return units.filter(unit => taken.reused.has(keyOf(unit))).flatMap(unit => {
    const note = green.get(printKey(unit, byUnit.get(keyOf(unit))!));
    return note ? [{ file: unit.file, note }] : [];
  });
}

export type RunReuse = { decision: ReuseDecision; fileCache: TestRunFileCache | null };
/* A full run decides as well, reuses nothing and remembers what it would have reused. */
export async function reuseFor(ctx: Pick<Ctx, 'db'>, mode: RunMode, snapshot: EnvironmentSnapshot, units: TestUnit[], prints: UnitFingerprint[]): Promise<RunReuse> {
  if (!mode) return { decision: NO_REUSE, fileCache: null };
  const { description } = snapshot, policy = description.manifest.execution?.oncePreparation;
  const once = policy?.profiles.includes(snapshot.profile) ? policy.suiteIds : [];
  const green = await greenAt(ctx.db, description.repositoryScope, prints), decision = decideReuse({ units, prints, green, once });
  const full = mode.mode === 'full';
  const wouldSkip = full ? units.filter(unit => decision.reused.has(keyOf(unit))).map(unit => ({ suiteId: unit.suiteId, file: unit.file })) : [];
  const taken = mode.mode === 'cached' ? decision : NO_REUSE;
  return { decision: taken, fileCache: { mode: mode.mode, turn: mode.turn, fingerprints: prints, reused: taken.reused.size, preparationReused: taken.preparation, wouldSkip, mismatches: [], notes: notesOf(units, prints, green, taken) } };
}

async function keepGreen(db: Db, run: Run, cache: TestRunFileCache, scope: RepositoryScope, green: GreenFile[]): Promise<void> {
  const prints = new Map(cache.fingerprints.map(print => [keyOf(print), print.fingerprint]));
  const values = green.flatMap(file => {
    const fingerprint = prints.get(keyOf(file));
    return fingerprint ? [{ companyId: scope.companyId, repositoryOwnerId: scope.repositoryOwnerId, repoUrlHash: scope.repoUrlHash, fingerprint, suiteId: file.suiteId, file: file.file, runId: run.id, commitSha: run.commitSha!, ms: file.ms === undefined ? null : Math.round(file.ms), note: file.note ?? null }] : [];
  });
  if (!values.length) return;
  await db.insert(testFileResults).values(values).onConflictDoUpdate({
    target: [testFileResults.companyId, testFileResults.repositoryOwnerId, testFileResults.repoUrlHash, testFileResults.fingerprint, testFileResults.suiteId, testFileResults.file],
    set: { runId: run.id, commitSha: run.commitSha!, ms: sql`excluded.ms`, note: sql`excluded.note`, createdAt: sql`now()` },
  });
  await db.delete(testFileResults).where(and(eq(testFileResults.companyId, scope.companyId), lt(testFileResults.createdAt, new Date(Date.now() - KEPT_DAYS * 86_400_000))));
}

type PartEnd = { ok: boolean; commit: string | null; files?: FileOutcome[] };
/* What a part that ended leaves behind. A part that lost its machine, checked another commit or passed without proof leaves nothing. */
export async function recordPartFiles(ctx: Pick<Ctx, 'db'>, run: Run, part: Part, ended: Pick<Part, 'status'>, message: PartEnd): Promise<void> {
  const cache = run.fileCache, snapshot = run.environmentSnapshot, selection = part.environmentSelection?.selection;
  if (!cache || !snapshot || !selection || message.commit !== run.commitSha) return;
  if (message.ok && ended.status !== 'passed') return;
  const { green, failed } = partFileResults(snapshot, selection, message.ok, message.files);
  await keepGreen(ctx.db, run, cache, snapshot.description.repositoryScope, green);
  if (failed.length) await ctx.db.update(testParts).set({ failedFiles: failed }).where(eq(testParts.id, part.id));
}

/* Files a full run found red that the kept results called green. Their results go, as they were wrong, and a run that ended
   no longer needs its fingerprints. What the files it did run came to joins what it took over. */
export async function closeFileCache(tx: Pick<Db, 'select' | 'update' | 'delete'>, run: Run, parts: Pick<Part, 'failedFiles'>[]): Promise<Run> {
  const cache = run.fileCache, scope = run.environmentSnapshot?.description.repositoryScope;
  if (!cache || !scope) return run;
  const failed = new Set(parts.flatMap(part => part.failedFiles ?? []).map(keyOf));
  const mismatches = cache.wouldSkip.filter(file => failed.has(keyOf(file))), prints = new Map(cache.fingerprints.map(print => [keyOf(print), print.fingerprint]));
  for (const file of mismatches) {
    await tx.delete(testFileResults).where(and(ofRepository(scope), eq(testFileResults.fingerprint, prints.get(keyOf(file))!), eq(testFileResults.suiteId, file.suiteId), eq(testFileResults.file, file.file)));
  }
  const ran = await tx.select({ file: testFileResults.file, note: testFileResults.note }).from(testFileResults).where(and(ofRepository(scope), eq(testFileResults.runId, run.id), isNotNull(testFileResults.note)));
  const notes = [...cache.notes, ...ran.map(({ file, note }) => ({ file, note: note! }))].sort((a, b) => a.file.localeCompare(b.file));
  const fileCache: TestRunFileCache = { ...cache, fingerprints: [], wouldSkip: [], mismatches, notes };
  await tx.update(testRuns).set({ fileCache }).where(eq(testRuns.id, run.id));
  return { ...run, fileCache };
}

const memoryOf = (scope: RepositoryScope) => and(eq(testSuiteMemory.companyId, scope.companyId), eq(testSuiteMemory.repositoryOwnerId, scope.repositoryOwnerId), eq(testSuiteMemory.repoUrlHash, scope.repoUrlHash));
function suitesThatKeep(snapshot: EnvironmentSnapshot, selection: Selection): string[] {
  const selected = new Set(selectedFiles(snapshot, selection).map(file => file.suiteId));
  return snapshot.description.manifest.suites.filter(suite => selected.has(suite.id) && suite.keep?.length).map(suite => suite.id);
}
/* What a suite's last run left, for the suites of a part that keep something. A full run starts without it. */
export async function keptFor(ctx: Pick<Ctx, 'db'>, run: Run, part: Part): Promise<KeptFiles | undefined> {
  const snapshot = run.environmentSnapshot, selection = part.environmentSelection?.selection;
  if (!snapshot || !selection || run.fileCache?.mode !== 'cached') return undefined;
  const keeping = suitesThatKeep(snapshot, selection);
  if (!keeping.length) return undefined;
  const rows = await ctx.db.select({ suiteId: testSuiteMemory.suiteId, files: testSuiteMemory.files }).from(testSuiteMemory).where(and(memoryOf(snapshot.description.repositoryScope), inArray(testSuiteMemory.suiteId, keeping)));
  const kept = KeptFiles.safeParse(rows);
  return kept.success && kept.data.length ? kept.data : undefined;
}

type KeptFile = KeptFiles[number]['files'][number];
const fitsOneMessage = (suiteId: string, files: KeptFile[]): boolean => KeptFiles.safeParse([{ suiteId, files }]).success;
/* Each part of a run leaves what it changed, so the files it did not touch stay as another part left them. When all of it no
   longer fits one message the part's own go on alone: to a tool, no memory only costs time. */
async function mergeKept(db: Db, scope: RepositoryScope, suiteId: string, files: KeptFile[]): Promise<void> {
  await db.transaction(async tx => {
    const [kept] = await tx.select({ files: testSuiteMemory.files }).from(testSuiteMemory).where(and(memoryOf(scope), eq(testSuiteMemory.suiteId, suiteId))).for('update');
    const paths = new Set(files.map(file => file.path)), merged = [...(kept?.files ?? []).filter(file => !paths.has(file.path)), ...files];
    const value = fitsOneMessage(suiteId, merged) ? merged : files;
    await tx.insert(testSuiteMemory).values({ companyId: scope.companyId, repositoryOwnerId: scope.repositoryOwnerId, repoUrlHash: scope.repoUrlHash, suiteId, files: value })
      .onConflictDoUpdate({ target: [testSuiteMemory.companyId, testSuiteMemory.repositoryOwnerId, testSuiteMemory.repoUrlHash, testSuiteMemory.suiteId], set: { files: value, updatedAt: new Date() } });
  });
}
function allowedKept(manifest: TestEnvironmentV1, suiteId: string, files: KeptFile[]): KeptFile[] {
  const keep = manifest.suites.find(suite => suite.id === suiteId)?.keep ?? [];
  return files.filter(file => keep.some(path => file.path === path || file.path.startsWith(`${path}/`)));
}
/* Keeps what a part left, only under the paths its suite's manifest names, and only from a part that checked this commit. */
export async function rememberKept(ctx: Pick<Ctx, 'db'>, run: Run, message: { commit: string | null; kept?: KeptFiles }): Promise<void> {
  const snapshot = run.environmentSnapshot;
  if (!snapshot || !message.kept || message.commit !== run.commitSha || !run.fileCache) return;
  for (const { suiteId, files } of message.kept) {
    const allowed = allowedKept(snapshot.description.manifest, suiteId, files);
    if (allowed.length && fitsOneMessage(suiteId, allowed)) await mergeKept(ctx.db, snapshot.description.repositoryScope, suiteId, allowed);
  }
}
