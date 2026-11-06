import { extname, matchesGlob } from 'node:path';
import type { Command, TestEnvironmentV1, TestUnit } from '@hornhoof/protocol';

export type ImpactAdapter = 'vitest-related' | 'pytest';
export interface ImpactPackage { id: string; root: string; language?: string; suiteIds: string[] }
export interface ImpactEnvironment {
  packages: ImpactPackage[];
  impact: TestEnvironmentV1['impact'];
  inventory: TestUnit[];
}
export interface ImpactChange { path: string; kind: 'added' | 'modified' | 'deleted' | 'renamed'; previousPath?: string }
export interface ImpactGraph { adapter: ImpactAdapter; status: 'ready' | 'unavailable'; units: TestUnit[] }
export interface ImpactInput { environment: ImpactEnvironment; changes: ImpactChange[]; graphs: ImpactGraph[] }
export interface ImpactReason { code: string; path: string }
export interface ImpactPackageSelection { packageId: string; mode: 'related' | 'whole-package'; units: TestUnit[]; reasons: ImpactReason[] }
export interface ImpactSelection {
  version: 1;
  status: 'ready' | 'blocked';
  units: TestUnit[];
  packages: ImpactPackageSelection[];
  migrationChecks: { direction: 'up' | 'down'; command: Command }[];
  problems: { code: 'impact_path_invalid' | 'impact_environment_invalid' | 'new_test_unmapped' | 'migration_check_unsupported' }[];
}

export const SUPPORTED_IMPACT_ADAPTERS: readonly ImpactAdapter[] = ['vitest-related', 'pytest'];
interface FullRule { code: string; globs: string[]; global?: boolean }
export const DEFAULT_FULL_PACKAGE_RULES: readonly FullRule[] = [
  { code: 'migration', globs: ['**/migrations/**', '**/drizzle/**', '**/*.migration.*'] },
  { code: 'schema', globs: ['**/schema.*', '**/schema/**'] },
  { code: 'configuration', globs: ['**/*config*', '**/package.json', '**/*lock*', '**/pyproject.toml', '**/pytest.ini', '**/Dockerfile', '**/.hornhoof/**', '**/.github/**'] },
  { code: 'environment', globs: ['**/.env*', '**/env.*', '**/environment.*'] },
  { code: 'routes', globs: ['**/routes/**', '**/routes.*', '**/router.*'] },
  { code: 'fixtures', globs: ['**/fixtures/**', '**/fixture.*', '**/conftest.py'] },
  { code: 'strings', globs: ['**/i18n/**', '**/locales/**', '**/translations/**'] },
  { code: 'scripts', globs: ['**/scripts/**'] },
  { code: 'installation', globs: ['**/install*'] },
  { code: 'updates', globs: ['**/update*', '**/*updates.*'] },
  { code: 'templates', globs: ['templates/**'], global: true },
  { code: 'shared_package', globs: ['packages/**'], global: true },
  { code: 'api_contract', globs: ['**/contracts/**', '**/contracts.*', '**/openapi.*'], global: true },
];
const ADAPTERS: Record<string, ImpactAdapter> = { typescript: 'vitest-related', javascript: 'vitest-related', python: 'pytest' };
const EXTENSIONS: Record<ImpactAdapter, string[]> = { 'vitest-related': ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'], pytest: ['.py', '.pyi'] };
interface Choice { mode: ImpactPackageSelection['mode']; units: Map<string, TestUnit>; reasons: Map<string, ImpactReason> }
interface SelectionState {
  environment: ImpactEnvironment;
  inventory: Map<string, TestUnit>;
  choices: Map<string, Choice>;
  problems: ImpactSelection['problems'];
  migration: boolean;
}
const unitKey = (value: TestUnit): string => `${value.suiteId}\0${value.file}`;
const ordered = <T>(values: Map<string, T>): T[] => [...values.keys()].sort().map(key => values.get(key)!);
function safePath(path: string): boolean {
  return path.length > 0 && !/^(?:\/|[a-z]:)|[\\\u0000-\u001f\u007f]|(?:^|\/)\.\.(?:\/|$)/i.test(path);
}
function paths(change: ImpactChange): string[] { return change.previousPath === undefined ? [change.path] : [change.path, change.previousPath]; }
function ownerOf(environment: ImpactEnvironment, path: string): ImpactPackage | undefined {
  return environment.packages.filter(pkg => pkg.root === '.' || path === pkg.root || path.startsWith(`${pkg.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
}
function packageOfUnit(environment: ImpactEnvironment, unit: TestUnit): ImpactPackage | undefined {
  return environment.packages.find(pkg => pkg.suiteIds.includes(unit.suiteId));
}
function addProblem(state: SelectionState, code: ImpactSelection['problems'][number]['code']): void {
  if (!state.problems.some(problem => problem.code === code)) state.problems.push({ code });
}
function add(state: SelectionState, pkg: ImpactPackage, mode: Choice['mode'], units: TestUnit[], reason: ImpactReason): void {
  const choice = state.choices.get(pkg.id) ?? { mode, units: new Map<string, TestUnit>(), reasons: new Map<string, ImpactReason>() };
  if (mode === 'whole-package') choice.mode = mode;
  for (const unit of units) choice.units.set(unitKey(unit), unit);
  choice.reasons.set(`${reason.code}\0${reason.path}`, reason);
  state.choices.set(pkg.id, choice);
}
function whole(state: SelectionState, packages: ImpactPackage[], reason: ImpactReason): void {
  for (const pkg of packages) add(state, pkg, 'whole-package', state.environment.inventory.filter(unit => pkg.suiteIds.includes(unit.suiteId)), reason);
}
function broadPackages(state: SelectionState, path: string): ImpactPackage[] {
  const owner = ownerOf(state.environment, path);
  return owner ? [owner] : state.environment.packages;
}
function policy(state: SelectionState, path: string): boolean {
  const targets = state.environment.impact.fullPackageGlobs.filter(rule => rule.globs.some(glob => matchesGlob(path, glob)))
    .flatMap(rule => state.environment.packages.filter(pkg => pkg.suiteIds.some(id => rule.suiteIds.includes(id))));
  whole(state, targets, { code: 'full_package_rule', path });
  const rule = DEFAULT_FULL_PACKAGE_RULES.find(value => value.globs.some(glob => matchesGlob(path, glob)));
  if (!rule) return targets.length > 0;
  if (rule.code === 'migration') state.migration = true;
  whole(state, rule.global ? state.environment.packages : broadPackages(state, path), { code: rule.code, path });
  return true;
}
function forceNewTest(state: SelectionState, change: ImpactChange): void {
  if (change.kind !== 'added') return;
  const found = state.environment.inventory.filter(unit => unit.file === change.path);
  if (!found.length && /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/.test(change.path)) addProblem(state, 'new_test_unmapped');
  for (const unit of found) {
    const pkg = packageOfUnit(state.environment, unit);
    if (!pkg) addProblem(state, 'impact_environment_invalid');
    else add(state, pkg, 'related', [unit], { code: 'new_test', path: change.path });
  }
}
function validGraph(state: SelectionState, graph: ImpactGraph): boolean {
  return graph.units.every(unit => state.inventory.get(unitKey(unit))?.selectionUnit === unit.selectionUnit && packageOfUnit(state.environment, unit) !== undefined);
}
function related(state: SelectionState, graphs: ImpactGraph[], pkg: ImpactPackage, path: string): void {
  const adapter = ADAPTERS[pkg.language ?? state.environment.impact.adapter];
  if (!adapter) return whole(state, [pkg], { code: 'unsupported_language', path });
  if (!EXTENSIONS[adapter].includes(extname(path))) return whole(state, [pkg], { code: 'unsupported_file', path });
  const found = graphs.filter(graph => graph.adapter === adapter);
  if (found.length !== 1 || found[0]!.status !== 'ready') return whole(state, [pkg], { code: 'graph_unavailable', path });
  const graph = found[0]!;
  if (!validGraph(state, graph)) return whole(state, [pkg], { code: 'invalid_graph', path });
  for (const unit of graph.units) add(state, packageOfUnit(state.environment, unit)!, 'related', [unit], { code: 'related', path });
}
function selectPath(state: SelectionState, graphs: ImpactGraph[], change: ImpactChange, path: string): void {
  if (policy(state, path)) return;
  const pkg = ownerOf(state.environment, path);
  if (!pkg) return whole(state, state.environment.packages, { code: 'unmapped_file', path });
  if (change.kind === 'deleted' || change.kind === 'renamed') return whole(state, [pkg], { code: `${change.kind}_source`, path });
  related(state, graphs, pkg, path);
}
function migrationChecks(state: SelectionState): ImpactSelection['migrationChecks'] {
  if (!state.migration) return [];
  const check = state.environment.impact.migrationCheck;
  if (check.status === 'unsupported') { addProblem(state, 'migration_check_unsupported'); return []; }
  return [{ direction: 'up', command: check.up }, { direction: 'down', command: check.down }];
}
function finish(state: SelectionState): ImpactSelection {
  const checks = migrationChecks(state), units = new Map<string, TestUnit>();
  const packages = [...state.choices.keys()].sort().map(packageId => {
    const choice = state.choices.get(packageId)!;
    for (const [key, unit] of choice.units) units.set(key, unit);
    return { packageId, mode: choice.mode, units: ordered(choice.units), reasons: ordered(choice.reasons) };
  });
  const result: ImpactSelection = { version: 1, status: state.problems.length ? 'blocked' : 'ready', units: ordered(units), packages, migrationChecks: checks, problems: state.problems };
  return structuredClone(result);
}

/* Explicit caller port only. Environment280 and authorcheck222 integration is intentionally separate. */
export function selectAffectedTests(input: ImpactInput): ImpactSelection {
  const state: SelectionState = { environment: input.environment, inventory: new Map(input.environment.inventory.map(unit => [unitKey(unit), unit])), choices: new Map(), problems: [], migration: false };
  if (input.changes.some(change => paths(change).some(path => !safePath(path)))) {
    addProblem(state, 'impact_path_invalid'); return finish(state);
  }
  for (const change of input.changes) {
    forceNewTest(state, change);
    for (const path of paths(change)) selectPath(state, input.graphs, change, path);
  }
  return finish(state);
}
