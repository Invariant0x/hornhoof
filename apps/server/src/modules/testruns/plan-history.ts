import { RepositoryPath, type TestFileTiming, type TestUnit } from '@hornhoof/protocol';
import { posix } from 'node:path';
import type { FileDuration, TestPartPlanInput } from './plan.js';
import { median } from './plan-statistics.js';

/* Scope must come from the private canonical repository binding, not a cache owner or an agent claim. */
export type PlanningHistoryScope = { companyId: string; repositoryId: string; manifestHash: string; profile: string };
export type PlanningHistoryPart = {
  scope: PlanningHistoryScope;
  runId: string;
  partId: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'stopped';
  suiteId: string | null;
  files: TestFileTiming[];
  setupMs: number | null;
  /* Actual result collection observation; cleanupMs alone is not this measurement. */
  collectMs: number | null;
};
export type PlanningHistoryInput = {
  scope: PlanningHistoryScope;
  inventory: TestUnit[];
  suiteWorkingDirectories: Record<string, string>;
  parts: PlanningHistoryPart[];
  fallbackCosts: TestPartPlanInput['costs'];
};
export type PlanningHistory = {
  durations: FileDuration[];
  costs: TestPartPlanInput['costs'];
  costBasis: { setup: 'historical' | 'fallback'; collection: 'historical' | 'fallback' };
  usedPartIds: string[];
  unmatchedFiles: number;
  /* How long each computer takes for the same work against the middle one, from what its parts took. */
  paces?: Map<string, number>;
  /* What a file no part measured counts for, in the time of these durations. */
  unknownFileMs?: number;
};

type InventoryIndex = Map<string, TestUnit[]>;
type CostSample = { ms: number; basis: 'historical' | 'fallback' };
const validDuration = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;

function sameScope(a: PlanningHistoryScope, b: PlanningHistoryScope): boolean {
  return a.companyId === b.companyId && a.repositoryId === b.repositoryId && a.manifestHash === b.manifestHash && a.profile === b.profile;
}
function eligibleParts(input: PlanningHistoryInput): PlanningHistoryPart[] {
  const seen = new Map<string, PlanningHistoryPart>();
  for (const part of input.parts) {
    if (part.status !== 'passed' || !sameScope(part.scope, input.scope)) continue;
    if (!seen.has(part.partId)) seen.set(part.partId, part);
  }
  return [...seen.values()];
}
function inventoryIndex(units: TestUnit[]): InventoryIndex {
  const index: InventoryIndex = new Map();
  for (const unit of units) {
    const values = index.get(unit.file) ?? [];
    values.push(unit);
    index.set(unit.file, values);
  }
  return index;
}
function candidatePaths(file: TestFileTiming, cwd: string | undefined): Set<string> {
  if (!RepositoryPath.safeParse(file.file).success || !RepositoryPath.safeParse(file.package).success) return new Set();
  const paths = new Set([file.file, posix.join(file.package, file.file)]);
  if (cwd && RepositoryPath.safeParse(cwd).success) paths.add(posix.join(cwd, file.file));
  return paths;
}
function fileDuration(file: TestFileTiming, part: PlanningHistoryPart, input: PlanningHistoryInput, index: InventoryIndex): FileDuration | null {
  if (!validDuration(file.totalMs)) return null;
  const cwd = part.suiteId === null ? undefined : input.suiteWorkingDirectories[part.suiteId];
  const candidates = [...candidatePaths(file, cwd)].flatMap(path => index.get(path) ?? [])
    .filter(unit => part.suiteId === null || unit.suiteId === part.suiteId);
  if (candidates.length !== 1) return null;
  const unit = candidates[0]!;
  return { suiteId: unit.suiteId, file: unit.file, ms: file.totalMs };
}
function timingSamples(parts: PlanningHistoryPart[], input: PlanningHistoryInput): Pick<PlanningHistory, 'durations' | 'unmatchedFiles'> {
  const index = inventoryIndex(input.inventory), durations: FileDuration[] = [];
  let unmatchedFiles = 0;
  for (const part of parts) for (const file of part.files) {
    const value = fileDuration(file, part, input, index);
    if (value) durations.push(value);
    else unmatchedFiles++;
  }
  durations.sort((a, b) => a.suiteId.localeCompare(b.suiteId) || a.file.localeCompare(b.file) || a.ms - b.ms);
  return { durations, unmatchedFiles };
}
function costSample(parts: PlanningHistoryPart[], key: 'setupMs' | 'collectMs', fallback: number): CostSample {
  const values = parts.map(part => part[key]).filter(validDuration);
  return values.length ? { ms: median(values), basis: 'historical' } : { ms: fallback, basis: 'fallback' };
}

/* Converts server-owned observations; it neither queries unbound task logs nor establishes repository authority. */
export function planningHistory(input: PlanningHistoryInput): PlanningHistory {
  const parts = eligibleParts(input), samples = timingSamples(parts, input);
  const setup = costSample(parts, 'setupMs', input.fallbackCosts.setupMs);
  const collection = costSample(parts, 'collectMs', input.fallbackCosts.collectMs);
  return { ...samples, costs: { setupMs: setup.ms, collectMs: collection.ms },
    costBasis: { setup: setup.basis, collection: collection.basis }, usedPartIds: parts.map(part => part.partId).sort() };
}
