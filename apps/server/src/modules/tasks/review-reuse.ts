import { EnvironmentSnapshot, type TestUnit } from '@hornhoof/protocol';
import type { testRuns } from '../../db/schema.js';
import { unitKey } from '../testruns/plan-environment.js';
import { planProductParts } from '../testruns/plan-product.js';
import { chooseRunMode } from '../testruns/reuse.js';

type Run = typeof testRuns.$inferSelect;

function sameSource(run: Run, snapshot: EnvironmentSnapshot): boolean {
  const request = run.environmentRequest!, description = snapshot.description, scope = description.repositoryScope;
  return description.commitSha === run.commitSha && description.manifestHash === run.environmentHash
    && scope.companyId === run.companyId && scope.repositoryOwnerId === run.departmentId
    && scope.companyId === request.repositoryScope.companyId && scope.repositoryOwnerId === request.repositoryScope.repositoryOwnerId
    && scope.repoUrlHash === request.repositoryScope.repoUrlHash;
}

function selectedUnits(run: Run, snapshot: EnvironmentSnapshot): TestUnit[] {
  const request = run.environmentRequest!, { manifest, inventory } = snapshot.description;
  const mode = chooseRunMode(manifest, request, false, true);
  if (mode?.mode !== 'cached' || mode.profile !== snapshot.profile) return [];
  const ids = request.suite ? [request.suite] : manifest.profiles.find(profile => profile.id === snapshot.profile)!.requiredSuiteIds;
  const units = inventory.filter(unit => ids.includes(unit.suiteId));
  return ids.every(id => units.some(unit => unit.suiteId === id)) ? units : [];
}

/* A completed server reuse decision is evidence even after its temporary fingerprints are cleared. Check the pinned source
   and complete selection, then ask the real planner whether that receipt leaves any work, including preparation or final checks. */
export async function verifiedReuse(run: Run): Promise<boolean> {
  const cache = run.fileCache, request = run.environmentRequest, parsed = EnvironmentSnapshot.safeParse(run.environmentSnapshot);
  if (cache?.mode !== 'cached' || !request || request.version !== 1 || request.problem || !parsed.success) return false;
  const snapshot = parsed.data;
  if (!sameSource(run, snapshot)) return false;
  const units = selectedUnits(run, snapshot);
  if (!units.length || cache.reused !== units.length) return false;
  try {
    const plan = await planProductParts({ snapshot, expectedCommitSha: run.commitSha!, purpose: 'affected', units,
      reuse: { reused: new Set(units.map(unitKey)), preparation: cache.preparationReused },
      availableMachines: 0, durations: [], costs: { setupMs: 0, collectMs: 0 }, unknownFileMs: 1 });
    return plan.leaves.length === 0;
  } catch { return false; }
}
