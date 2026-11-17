import type { TestUnit } from '@hornhoof/protocol';
import type { ImpactGraph } from './test-impact.js';

interface ImpactRow { project: string; file: string }
export interface ImpactCollection { projects: string[]; all: ImpactRow[]; selected: ImpactRow[] }
export interface VitestImpactInput { inventory: TestUnit[]; projectSuites: Record<string, string[]>; changed: string[]; requiredSuiteIds?: string[] }
type RelatedCollector = (changed: string) => Promise<ImpactCollection>;
export interface PytestImpactResult { status: string; selected: string[]; reason: string | null }

const unitKey = (unit: TestUnit): string => `${unit.suiteId}\0${unit.file}`;
const rowKey = (row: ImpactRow): string => `${row.project}\0${row.file}`;
const unavailable = (adapter: ImpactGraph['adapter']): ImpactGraph => ({ adapter, status: 'unavailable', units: [] });
const unique = (units: TestUnit[]): TestUnit[] => {
  const values = new Map(units.map(unit => [unitKey(unit), unit]));
  return structuredClone([...values.keys()].sort().map(key => values.get(key)!));
};
function mapRows(rows: ImpactRow[], input: VitestImpactInput): TestUnit[] {
  const mapping = new Map(Object.entries(input.projectSuites));
  return rows.flatMap(row => {
    const suites = mapping.get(row.project);
    const units = input.inventory.filter(unit => unit.file === row.file && suites?.includes(unit.suiteId));
    if (!units.length) throw new Error('impact_collection_unmapped');
    return units;
  });
}
function checkCollection(collection: ImpactCollection, input: VitestImpactInput): void {
  const projects = new Set(collection.projects);
  if (collection.all.some(row => !projects.has(row.project))) throw new Error('impact_collection_project_missing');
  const all = new Set(collection.all.map(rowKey));
  if (collection.selected.some(row => !all.has(rowKey(row)))) throw new Error('impact_selection_not_collected');
  const covered = new Set(mapRows(collection.all, input).map(unitKey));
  const suites = new Set(Object.values(input.projectSuites).flat());
  const required = new Set(input.requiredSuiteIds ?? input.inventory.map(unit => unit.suiteId));
  if (suites.size !== required.size || [...required].some(suite => !suites.has(suite))) throw new Error('impact_suite_mapping_incomplete');
  if (input.inventory.some(unit => required.has(unit.suiteId) && !covered.has(unitKey(unit)))) throw new Error('impact_collection_incomplete');
}
function checkChangedTest(changed: string, collection: ImpactCollection): void {
  if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(changed)) return;
  if (!collection.all.some(row => row.file === changed)) throw new Error('impact_changed_test_not_collected');
}

export async function collectVitestImpact(input: VitestImpactInput, collect: RelatedCollector): Promise<ImpactGraph> {
  try {
    const units: TestUnit[] = [];
    for (const changed of new Set(input.changed)) {
      const collection = await collect(changed);
      checkCollection(collection, input);
      checkChangedTest(changed, collection);
      units.push(...mapRows(collection.selected, input));
    }
    return { adapter: 'vitest-related', status: 'ready', units: unique(units) };
  } catch { return unavailable('vitest-related'); }
}

export function mapPytestImpact(result: PytestImpactResult, inventory: TestUnit[], suiteId: string, packageRoot: string): ImpactGraph {
  if (result.status !== 'ready') return unavailable('pytest');
  const units: TestUnit[] = [];
  for (const path of result.selected) {
    if (/^(?:\/|[a-z]:)|[\\\u0000-\u001f\u007f]|(?:^|\/)\.\.(?:\/|$)/i.test(path)) return unavailable('pytest');
    const file = packageRoot === '.' ? path : `${packageRoot}/${path}`;
    const found = inventory.filter(unit => unit.suiteId === suiteId && unit.file === file);
    if (!found.length) return unavailable('pytest');
    units.push(...found);
  }
  return { adapter: 'pytest', status: 'ready', units: unique(units) };
}
