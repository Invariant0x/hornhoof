import { EnvironmentSnapshot, ProductCommitSha, TestExecution, validateEnvironmentDescription, type Command, type TestUnit } from '@hornhoof/protocol';
import { planTestParts, type TestPartPlan, type TestPartPlanInput } from './plan.js';

/* Internal data consistency, not an authorization token, dispatch capability or public free-SHA input. */
export type PreparedEnvironmentPlanInput = TestPartPlanInput & {
  snapshot: EnvironmentSnapshot;
  expectedCommitSha: string;
  purpose: 'affected' | 'final';
};
export type EnvironmentPartPlan = {
  commitSha: string;
  manifestHash: string;
  profile: string;
  testPlan: TestPartPlan;
  parts: { selections: TestExecution['selection'][] }[];
  postSuiteChecks: { suiteId: string; commands: Command[] }[];
  ports: { suiteBatch: 'required' | 'not-required'; finalPreparation: 'missing' | 'not-required' };
};

const keyOf = (unit: Pick<TestUnit, 'suiteId' | 'file'>): string => `${unit.suiteId}\0${unit.file}`;

async function pinnedSnapshot(input: PreparedEnvironmentPlanInput): Promise<EnvironmentSnapshot> {
  const snapshot = EnvironmentSnapshot.parse(input.snapshot);
  if (snapshot.description.commitSha !== ProductCommitSha.parse(input.expectedCommitSha)) throw new Error('The environment commit differs from the prepared candidate commit.');
  await validateEnvironmentDescription(snapshot.description);
  return snapshot;
}
function canonicalUnits(snapshot: EnvironmentSnapshot, selected: TestUnit[]): TestUnit[] {
  const inventory = new Map(snapshot.description.inventory.map(unit => [keyOf(unit), unit]));
  return selected.map(unit => {
    const canonical = inventory.get(keyOf(unit));
    if (!canonical || canonical.selectionUnit !== unit.selectionUnit) throw new Error('The selection differs from the canonical environment inventory.');
    return canonical;
  });
}
function suiteSelections(snapshot: EnvironmentSnapshot, units: TestUnit[]): TestExecution['selection'][] {
  const suites = new Map<string, string[]>();
  for (const unit of units) {
    const files = suites.get(unit.suiteId) ?? [];
    files.push(unit.file);
    suites.set(unit.suiteId, files);
  }
  return [...suites.keys()].sort().map(suiteId => {
    const selection = { kind: 'suite' as const, suiteId, files: suites.get(suiteId)!.sort() };
    return TestExecution.parse({ snapshot, selection }).selection;
  });
}
function finalInventory(snapshot: EnvironmentSnapshot, units: TestUnit[]): void {
  const required = snapshot.description.manifest.profiles.find(profile => profile.id === snapshot.profile)!.requiredSuiteIds;
  const expected = snapshot.description.inventory.filter(unit => required.includes(unit.suiteId));
  const actual = new Set(units.map(keyOf));
  if (expected.length !== units.length || expected.some(unit => !actual.has(keyOf(unit)))) throw new Error('A final candidate needs the complete required profile inventory.');
}
function postSuiteChecks(snapshot: EnvironmentSnapshot, units: TestUnit[]): EnvironmentPartPlan['postSuiteChecks'] {
  const selected = new Set(units.map(unit => unit.suiteId));
  return snapshot.description.manifest.suites.flatMap(suite => {
    const commands = suite.finalChecks ?? [];
    return selected.has(suite.id) && commands.length ? [{ suiteId: suite.id, commands }] : [];
  });
}

/* The returned batches are a planning port, not the existing single-suite wire message. No dispatch is performed. */
export async function planEnvironmentParts(input: PreparedEnvironmentPlanInput): Promise<EnvironmentPartPlan> {
  const snapshot = await pinnedSnapshot(input), units = canonicalUnits(snapshot, input.units);
  suiteSelections(snapshot, units);
  if (input.purpose === 'final') finalInventory(snapshot, units);
  const testPlan = planTestParts({ ...input, units });
  const parts = testPlan.parts.map(part => ({ selections: suiteSelections(snapshot, part.units) }));
  return { commitSha: snapshot.description.commitSha, manifestHash: snapshot.description.manifestHash, profile: snapshot.profile,
    testPlan, parts, postSuiteChecks: postSuiteChecks(snapshot, units),
    ports: { suiteBatch: parts.some(part => part.selections.length > 1) ? 'required' : 'not-required',
      finalPreparation: input.purpose === 'final' ? 'missing' : 'not-required' } };
}
