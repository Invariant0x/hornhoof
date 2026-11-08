import { candidateTestUnits, EnvironmentSnapshot, UnitFingerprints, validateEnvironmentDescription, type RepositoryScope } from '@hornhoof/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { testParts, testRuns, type ReusedTestUnit } from '../../db/schema.js';
import { scopeKey } from './load.js';
import { unitKey } from './plan-environment.js';
import { passedProductPart } from './receipts.js';

type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
type Reader = Pick<Db, 'select'>;
type Source = { run: Run; snapshot: EnvironmentSnapshot };

function sourceRequest(run: Run): NonNullable<Run['environmentRequest']> {
  const request = run.environmentRequest;
  if (run.kind !== 'tests' || run.command !== '' || run.status === 'running' || !run.finishedAt || !request || request.problem) throw new Error('The reused source is not an attested product result in this repository.');
  return request;
}

function matchesSource(snapshot: EnvironmentSnapshot, run: Run, scope: RepositoryScope, request: NonNullable<Run['environmentRequest']>): boolean {
  const { description } = snapshot;
  return description.commitSha === run.commitSha && description.manifestHash === run.environmentHash
    && description.repositoryScope.companyId === run.companyId && description.repositoryScope.repositoryOwnerId === run.departmentId
    && scopeKey(description.repositoryScope) === scopeKey(scope) && scopeKey(request.repositoryScope) === scopeKey(scope);
}

async function sourceSnapshot(run: Run, scope: RepositoryScope): Promise<EnvironmentSnapshot> {
  const snapshot = EnvironmentSnapshot.parse(run.environmentSnapshot), { description } = snapshot;
  if (!matchesSource(snapshot, run, scope, sourceRequest(run))) throw new Error('The reused source is not an attested product result in this repository.');
  await validateEnvironmentDescription(description);
  if (snapshot.candidate) candidateTestUnits(snapshot);
  return snapshot;
}

function preparedUnit(snapshot: EnvironmentSnapshot, unit: ReusedTestUnit): boolean {
  return Boolean(snapshot.description.manifest.execution?.oncePreparation?.suiteIds.includes(unit.suiteId))
    && snapshot.description.inventory.some(value => unitKey(value) === unitKey(unit));
}

function containsUnit(snapshot: EnvironmentSnapshot, part: Part, unit: ReusedTestUnit): boolean {
  const selection = part.environmentSelection?.selection;
  if (!selection) return false;
  if (selection.kind === 'prepare') return preparedUnit(snapshot, unit);
  const suites = selection.kind === 'batch' ? selection.selections : selection.kind === 'suite' ? [selection] : [];
  return suites.some(suite => suite.suiteId === unit.suiteId && suite.files.includes(unit.file));
}

function hasSourceReceipt(unit: ReusedTestUnit, source: Source | undefined, parts: Part[]): boolean {
  if (!source || source.run.commitSha !== unit.commitSha) return false;
  try {
    return sameFingerprint(source.run, source.snapshot, unit) && parts.some(part => part.runId === unit.runId && containsUnit(source.snapshot, part, unit) && passedProductPart(source.snapshot, part));
  } catch { return false; }
}

function sameFingerprint(run: Run, snapshot: EnvironmentSnapshot, unit: ReusedTestUnit): boolean {
  const prints = UnitFingerprints.parse(run.fileCache?.verifiedFingerprints);
  const matching = prints.filter(print => unitKey(print) === unitKey(unit));
  if (matching.length !== 1 || matching[0]!.fingerprint !== unit.fingerprint) return false;
  return !snapshot.candidate || snapshot.candidate.fingerprints.some(print => unitKey(print) === unitKey(unit) && print.fingerprint === unit.fingerprint);
}

/* Recheck the original executed part, including after the transient cache index expires or changes. */
export async function reusableUnits(db: Reader, scope: RepositoryScope, units: ReusedTestUnit[]): Promise<ReusedTestUnit[]> {
  if (!units.length) return [];
  const ids = [...new Set(units.map(unit => unit.runId))];
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.companyId, scope.companyId), inArray(testRuns.id, ids)));
  const parts = await db.select().from(testParts).where(and(eq(testParts.companyId, scope.companyId), inArray(testParts.runId, ids)));
  const sources = new Map<string, Source>();
  for (const run of runs) {
    try { sources.set(run.id, { run, snapshot: await sourceSnapshot(run, scope) }); }
    catch { /* Unattested sources run again instead of becoming a cache hit. */ }
  }
  return units.filter(unit => hasSourceReceipt(unit, sources.get(unit.runId), parts));
}
