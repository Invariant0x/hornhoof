import { KeptFiles, PREPARATION_UNIT, runsInClass, type EnvironmentSnapshot, type FileOutcome, type RepositoryScope, type TestEnvironmentV1, type TestExecution, type TestUnit, type UnitFingerprint } from '@hornhoof/protocol';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, tasks, testFileResults, testParts, testRuns, testSuiteMemory, turns, type TestFileKey, type TestRunFileCache } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { unitKey as keyOf } from './plan-environment.js';
import { reusableUnits } from './reuse-evidence.js';
import { openTurnOf } from '../tasks/turn-department.js';

/* Reusing green test results. A file that passed at a fingerprint need not run again at that fingerprint. Every doubt runs the
   file: no fingerprint, no green result, a group with one file changed, a machine that sent none. The full run, which every
   release runs on its exact commit, reuses nothing, and what it finds red that was kept green is shown. */

type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
type Db = Ctx['db'];
type Selection = TestExecution['selection'];
type Mode = TestRunFileCache['mode'];

/* Results no run proved again in this long go. Whatever went is only run again. */
const KEPT_DAYS = 30;
const SHOWN_FILES = 30;

export const printKey = (unit: TestFileKey, fingerprint: string): string => `${keyOf(unit)}\0${fingerprint}`;

/* A manifest that names no full run reuses nothing, as nothing would ever check what it reused. Only the full profile asked for
   by name is the full run, and never one suite of it: it would stand in for the rest of its release. */
export function chooseRunMode(manifest: TestEnvironmentV1, request: { profile?: string; suite?: string }, printed: boolean): { mode: Mode; profile: string } | null {
  const fullRun = manifest.execution?.fullRun, profile = request.profile ?? manifest.defaultProfile;
  if (!fullRun) return null;
  if (!request.suite && profile === fullRun.profile) return { mode: 'full', profile: fullRun.profile };
  return { mode: printed ? 'cached' : 'off', profile };
}

export type ReuseDecision = { reused: ReadonlySet<string>; preparation: boolean };
const NO_REUSE: ReuseDecision = { reused: new Set(), preparation: false };

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

type GreenFile = TestFileKey & { ms?: number; note?: string };
/* What a runner said of each file. Two projects of a suite may run the same file, and one failure is a failure. */
function saidOfEach(reported: FileOutcome[] | undefined): Map<string, FileOutcome> {
  const said = new Map<string, FileOutcome>();
  for (const item of reported ?? []) if (said.get(keyOf(item))?.status !== 'failed') said.set(keyOf(item), item);
  return said;
}
/* What a part proved of its own files. A part that passed proves them all, but for one its runner still called failed. One that
   failed proves only what its runner named, and what it did not name stays unknown. */
export function partFileResults(snapshot: EnvironmentSnapshot, selection: Selection, passed: boolean, reported: FileOutcome[] | undefined): { green: GreenFile[]; failed: TestFileKey[] } {
  const files = selectedFiles(snapshot, selection), said = saidOfEach(reported);
  const named = files.filter(file => said.has(keyOf(file)));
  const failed = named.filter(file => said.get(keyOf(file))!.status === 'failed');
  const proved = passed ? files.filter(file => said.get(keyOf(file))?.status !== 'failed') : named.filter(file => said.get(keyOf(file))!.status === 'passed');
  const green = proved.map(file => { const { ms, note } = said.get(keyOf(file)) ?? {}; return { ...file, ...(ms === undefined ? {} : { ms }), ...(note === undefined ? {} : { note }) }; });
  return { green, failed };
}

const listed = (items: string[], between: string): string => items.slice(0, SHOWN_FILES).join(between) + (items.length > SHOWN_FILES ? `, and ${items.length - SHOWN_FILES} more` : '');
const names = (files: TestFileKey[]): string => listed([...new Set(files.map(file => file.file))], ', ');
function modeLine(cache: TestRunFileCache, parts: Pick<Part, 'failedFiles'>[]): string[] {
  if (cache.mode === 'full') return [`This was ${cache.turn === null || !cache.mainLine ? 'a full run' : `the full run of turn ${cache.turn}`}: nothing was reused.`];
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
  const fingerprints = (cache.verifiedFingerprints ?? cache.fingerprints).length;
  return { reuse: { mode: cache.mode, turn: cache.turn, reused: cache.reused, preparationReused: cache.preparationReused, fingerprints, ...(cache.kept === undefined ? {} : { kept: cache.kept }),
    mismatches: cache.mismatches.map(file => file.file), failedFiles, notes: cache.notes } };
}

/* The turn a run belongs to: its task's, or the one its department runs now. */
async function turnOfRun(db: Db, run: Pick<Run, 'taskId' | 'companyId' | 'departmentId'>): Promise<number | null> {
  const [own] = await db.select(only(turns, 'number')).from(tasks).innerJoin(turns, eq(turns.id, tasks.turnId)).where(eq(tasks.id, run.taskId));
  if (own) return own.number;
  return (await openTurnOf(db, run.companyId, run.departmentId))?.number ?? null;
}
/* What a release relies on was proved on its own line: the repository's main branch or the turn's. A job writes its own report, so
   what another branch says holds for that branch's work and no further, until the main branch holds its commit (ofMainLine), and a
   turn's full run is of the turn's branch. */
async function onMainLine(db: Db, branch: string | null, scope: RepositoryScope, turn: number | null): Promise<boolean> {
  if (turn !== null && branch === `turn-${turn}`) return true;
  const [owner] = await db.select({ branch: departments.repoBranch }).from(departments).where(eq(departments.id, scope.repositoryOwnerId));
  return branch === (owner?.branch ?? 'main');
}
export type RunMode = { mode: Mode; profile: string; turn: number | null; mainLine: boolean } | null;
export async function runModeOf(ctx: Pick<Ctx, 'db'>, run: Run, manifest: TestEnvironmentV1, scope: RepositoryScope, printed: boolean): Promise<RunMode> {
  const request = run.environmentRequest!, fullRun = manifest.execution?.fullRun;
  if (!fullRun) return null;
  const turn = await turnOfRun(ctx.db, run), mainLine = await onMainLine(ctx.db, run.branch, scope, turn);
  const chosen = chooseRunMode(manifest, request, printed);
  return chosen && { ...chosen, turn, mainLine };
}

const ofRepository = (table: typeof testFileResults | typeof testSuiteMemory, scope: RepositoryScope) => and(eq(table.companyId, scope.companyId), eq(table.repositoryOwnerId, scope.repositoryOwnerId), eq(table.repoUrlHash, scope.repoUrlHash));

/* Which of these commits the main line holds now. A commit it cannot tell of is not there. */
export type MainLineCommits = (commits: string[]) => Promise<ReadonlySet<string>>;
/* Only the newest commits another branch proved results on are asked about: each question goes to the repository's host. */
const ASKED_COMMITS = 8;

/* What was green at these fingerprints in this one repository, with what each result came to. */
type GreenSource = Pick<typeof testFileResults.$inferSelect, 'suiteId' | 'file' | 'fingerprint' | 'note' | 'runId' | 'commitSha'>;
type GreenRow = GreenSource & Pick<typeof testFileResults.$inferSelect, 'mainLine' | 'createdAt'>;
/* What another branch proved on a commit the main line holds now ran the line's own code, at a fingerprint that names the file and all
   it reads: it holds for the line. */
async function ofMainLine(rows: GreenRow[], inMainLine: MainLineCommits | undefined): Promise<GreenRow[]> {
  const others = rows.filter(row => !row.mainLine).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const commits = [...new Set(others.map(row => row.commitSha))].slice(0, ASKED_COMMITS);
  const held = inMainLine && commits.length ? await inMainLine(commits) : new Set<string>();
  return rows.filter(row => row.mainLine || held.has(row.commitSha));
}
async function greenAt(db: Db, scope: RepositoryScope, prints: UnitFingerprint[], onlyMainLine: boolean, inMainLine?: MainLineCommits): Promise<Map<string, GreenSource>> {
  if (!prints.length) return new Map();
  const rows = await db.select({ suiteId: testFileResults.suiteId, file: testFileResults.file, fingerprint: testFileResults.fingerprint, note: testFileResults.note, runId: testFileResults.runId, commitSha: testFileResults.commitSha, mainLine: testFileResults.mainLine, createdAt: testFileResults.createdAt }).from(testFileResults).where(and(ofRepository(testFileResults, scope), inArray(testFileResults.fingerprint, [...new Set(prints.map(print => print.fingerprint))])));
  const kept = onlyMainLine ? await ofMainLine(rows, inMainLine) : rows;
  return new Map(kept.map(row => [printKey(row, row.fingerprint), row]));
}
/* The profiles of a release, which take a result only from its own line. */
function ofRelease(manifest: TestEnvironmentV1, profile: string): boolean {
  const fullRun = manifest.execution?.fullRun;
  return profile === fullRun?.replaces || profile === fullRun?.profile;
}
/* What the results a run takes over came to. */
function sourcesOf(units: TestUnit[], prints: UnitFingerprint[], green: Map<string, GreenSource>, taken: ReuseDecision): GreenSource[] {
  const byUnit = new Map(prints.map(print => [keyOf(print), print.fingerprint]));
  return units.filter(unit => taken.reused.has(keyOf(unit))).map(unit => green.get(printKey(unit, byUnit.get(keyOf(unit))!))!);
}

type RunReuse = { decision: ReuseDecision; fileCache: TestRunFileCache | null };
async function candidateGreen(ctx: Pick<Ctx, 'db'>, snapshot: EnvironmentSnapshot, known: Map<string, GreenSource>): Promise<Map<string, GreenSource>> {
  if (!snapshot.candidate) return known;
  const valid = new Set((await reusableUnits(ctx.db, snapshot.description.repositoryScope, [...known.values()])).map(unit => printKey(unit, unit.fingerprint)));
  return new Map([...known].filter(([key]) => valid.has(key)));
}

function reuseCache(mode: NonNullable<RunMode>, snapshot: EnvironmentSnapshot, units: TestUnit[], prints: UnitFingerprint[], green: Map<string, GreenSource>, decision: ReuseDecision): RunReuse {
  const full = mode.mode === 'full';
  const wouldSkip = full ? units.filter(unit => decision.reused.has(keyOf(unit))).map(unit => ({ suiteId: unit.suiteId, file: unit.file })) : [];
  const taken = mode.mode === 'cached' ? decision : NO_REUSE;
  const sources = sourcesOf(units, prints, green, taken), notes = sources.flatMap(source => source.note ? [{ file: source.file, note: source.note }] : []);
  const reusedUnits = sources.map(source => ({ suiteId: source.suiteId, file: source.file, fingerprint: source.fingerprint, runId: source.runId, commitSha: source.commitSha }));
  return { decision: taken, fileCache: { mode: mode.mode, turn: mode.turn, mainLine: mode.mainLine, fingerprints: prints, reused: taken.reused.size, preparationReused: taken.preparation,
    ...(snapshot.candidate ? { reusedUnits } : {}), wouldSkip, compared: 0, mismatches: [], notes } };
}

/* A full run decides as well, reuses nothing and remembers what it would have reused. */
export async function reuseFor(ctx: Pick<Ctx, 'db'>, mode: RunMode, snapshot: EnvironmentSnapshot, units: TestUnit[], prints: UnitFingerprint[], inMainLine?: MainLineCommits): Promise<RunReuse> {
  if (!mode) return { decision: NO_REUSE, fileCache: null };
  const { description } = snapshot, policy = description.manifest.execution?.oncePreparation;
  const once = !snapshot.candidate && policy?.profiles.includes(snapshot.profile) ? policy.suiteIds : [];
  const known = await greenAt(ctx.db, description.repositoryScope, prints, !snapshot.candidate && ofRelease(description.manifest, snapshot.profile), inMainLine);
  const green = await candidateGreen(ctx, snapshot, known);
  const decision = decideReuse({ units, prints, green, once });
  return reuseCache(mode, snapshot, units, prints, green, decision);
}

const printsOf = (cache: TestRunFileCache): Map<string, string> => new Map(cache.fingerprints.map(print => [keyOf(print), print.fingerprint]));
/* What another branch proved leaves what the main line proved as it was. */
async function keepGreen(db: Db, run: Run, cache: TestRunFileCache, scope: RepositoryScope, green: GreenFile[]): Promise<void> {
  const prints = printsOf(cache);
  const values = green.flatMap(file => {
    const fingerprint = prints.get(keyOf(file));
    return fingerprint ? [{ companyId: scope.companyId, repositoryOwnerId: scope.repositoryOwnerId, repoUrlHash: scope.repoUrlHash, fingerprint, suiteId: file.suiteId, file: file.file, runId: run.id, commitSha: run.commitSha!, ms: file.ms === undefined ? null : Math.round(file.ms), note: file.note ?? null, mainLine: cache.mainLine }] : [];
  });
  if (!values.length) return;
  await db.insert(testFileResults).values(values).onConflictDoUpdate({
    target: [testFileResults.companyId, testFileResults.repositoryOwnerId, testFileResults.repoUrlHash, testFileResults.fingerprint, testFileResults.suiteId, testFileResults.file],
    set: { runId: run.id, commitSha: run.commitSha!, ms: sql`excluded.ms`, note: sql`excluded.note`, mainLine: sql`excluded.main_line`, createdAt: sql`now()` },
    setWhere: sql`excluded.main_line or not ${testFileResults.mainLine}`,
  });
  await db.delete(testFileResults).where(and(eq(testFileResults.companyId, scope.companyId), lt(testFileResults.createdAt, new Date(Date.now() - KEPT_DAYS * 86_400_000))));
}
/* A file that failed at a fingerprint has no green result there, whatever an earlier run left: it may belong to a group that had to
   run again, or to a run beside this one. */
async function forgetFailed(db: Db, cache: TestRunFileCache, scope: RepositoryScope, failed: TestFileKey[]): Promise<void> {
  const prints = printsOf(cache);
  for (const file of failed) {
    const fingerprint = prints.get(keyOf(file));
    if (fingerprint) await db.delete(testFileResults).where(and(ofRepository(testFileResults, scope), eq(testFileResults.fingerprint, fingerprint), eq(testFileResults.suiteId, file.suiteId), eq(testFileResults.file, file.file)));
  }
}

type PartEnd = { ok: boolean; commit: string | null; files?: FileOutcome[] };
/* The fingerprints name the class of the runtimes that described the run. A part proves its files at them only where it ran on
   runtimes of that class; on others it proved them somewhere no fingerprint names. */
function ranInClass(snapshot: EnvironmentSnapshot, receipt: Part['environmentReceipt']): boolean {
  return Boolean(receipt) && runsInClass(snapshot, receipt!.runtimes);
}

/* What a part that ended leaves behind. A part that lost its machine, checked another commit or passed without proof leaves nothing. */
export async function recordPartFiles(ctx: Pick<Ctx, 'db'>, run: Run, part: Part, ended: Pick<Part, 'status' | 'environmentReceipt'>, message: PartEnd): Promise<void> {
  const cache = run.fileCache, snapshot = run.environmentSnapshot, selection = part.environmentSelection?.selection;
  if (!cache || !snapshot || !selection || message.commit !== run.commitSha) return;
  if (message.ok && ended.status !== 'passed') return;
  const { green, failed } = partFileResults(snapshot, selection, message.ok, message.files);
  if (ranInClass(snapshot, ended.environmentReceipt)) await keepGreen(ctx.db, run, cache, snapshot.description.repositoryScope, green);
  if (!failed.length) return;
  await forgetFailed(ctx.db, cache, snapshot.description.repositoryScope, failed);
  await ctx.db.update(testParts).set({ failedFiles: failed }).where(eq(testParts.id, part.id));
}

/* A run that ended no longer needs its fingerprints. A full run says which files it found red that the kept results called green, and
   how many it got to compare: a part that failed without naming a file leaves that unknown. What the files it did run came to joins
   what it took over. */
export async function closeFileCache(tx: Pick<Db, 'select' | 'update'>, run: Run): Promise<Run> {
  const cache = run.fileCache, scope = run.environmentSnapshot?.description.repositoryScope;
  if (!cache || !scope) return run;
  const parts = await tx.select({ status: testParts.status, failedFiles: testParts.failedFiles }).from(testParts).where(eq(testParts.runId, run.id));
  const failed = new Set(parts.flatMap(part => part.failedFiles ?? []).map(keyOf));
  const toldAll = parts.every(part => part.status === 'passed' || part.failedFiles);
  const ran = await tx.select({ file: testFileResults.file, note: testFileResults.note }).from(testFileResults).where(and(ofRepository(testFileResults, scope), eq(testFileResults.runId, run.id)));
  const notes = [...cache.notes, ...ran.flatMap(({ file, note }) => (note === null ? [] : [{ file, note }]))].sort((a, b) => a.file.localeCompare(b.file));
  const fileCache: TestRunFileCache = { ...cache, kept: ran.length, verifiedFingerprints: cache.verifiedFingerprints ?? cache.fingerprints, fingerprints: [], wouldSkip: [], compared: toldAll ? cache.wouldSkip.length : 0, mismatches: cache.wouldSkip.filter(file => failed.has(keyOf(file))), notes };
  await tx.update(testRuns).set({ fileCache }).where(eq(testRuns.id, run.id));
  return { ...run, fileCache };
}

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
  const rows = await ctx.db.select({ suiteId: testSuiteMemory.suiteId, files: testSuiteMemory.files }).from(testSuiteMemory).where(and(ofRepository(testSuiteMemory, snapshot.description.repositoryScope), inArray(testSuiteMemory.suiteId, keeping)));
  const kept = KeptFiles.safeParse(rows);
  return kept.success && kept.data.length ? kept.data : undefined;
}

type KeptFile = KeptFiles[number]['files'][number];
const fitsOneMessage = (suiteId: string, files: KeptFile[]): boolean => KeptFiles.safeParse([{ suiteId, files }]).success;
/* Each part of a run leaves what it changed, so the files it did not touch stay as another part left them. When all of it no
   longer fits one message the part's own go on alone: to a tool, no memory only costs time. */
async function mergeKept(db: Db, scope: RepositoryScope, suiteId: string, files: KeptFile[]): Promise<void> {
  await db.transaction(async tx => {
    const [kept] = await tx.select(only(testSuiteMemory, 'files')).from(testSuiteMemory).where(and(ofRepository(testSuiteMemory, scope), eq(testSuiteMemory.suiteId, suiteId))).for('update');
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
/* Keeps what a part left, only under the paths its suite's manifest names, only from a part that checked this commit, and only from
   the main line: every later run of the repository starts from it. */
export async function rememberKept(ctx: Pick<Ctx, 'db'>, run: Run, message: { commit: string | null; kept?: KeptFiles }): Promise<void> {
  const snapshot = run.environmentSnapshot;
  if (!snapshot || !message.kept || message.commit !== run.commitSha || !run.fileCache?.mainLine) return;
  for (const { suiteId, files } of message.kept) {
    const allowed = allowedKept(snapshot.description.manifest, suiteId, files);
    if (allowed.length && fitsOneMessage(suiteId, allowed)) await mergeKept(ctx.db, snapshot.description.repositoryScope, suiteId, allowed);
  }
}
