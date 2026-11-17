import { extname, matchesGlob, posix } from 'node:path';
import type { Command, TestEnvironmentV1, TestUnit } from '@hornhoof/protocol';

type ImpactAdapter = 'vitest-related' | 'pytest';
export interface ImpactPackage { id: string; root: string; language?: string; suiteIds: string[] }
export interface ImpactEnvironment {
  packages: ImpactPackage[];
  impact: TestEnvironmentV1['impact'];
  inventory: TestUnit[];
}
export interface ImpactChange { path: string; kind: 'added' | 'modified' | 'deleted' | 'renamed'; previousPath?: string }
export interface ImpactGraph { adapter: ImpactAdapter; status: 'ready' | 'unavailable'; units: TestUnit[] }
export interface ImpactInput { environment: ImpactEnvironment; changes: ImpactChange[]; graphs: ImpactGraph[] }
interface ImpactReason { code: string; path: string }
interface ImpactPackageSelection { packageId: string; mode: 'related' | 'whole-package'; units: TestUnit[]; reasons: ImpactReason[] }
export interface ImpactSelection {
  version: 1;
  status: 'ready' | 'blocked';
  units: TestUnit[];
  packages: ImpactPackageSelection[];
  migrationChecks: { direction: 'up' | 'down'; command: Command }[];
  problems: { code: 'impact_path_invalid' | 'impact_environment_invalid' | 'new_test_unmapped' | 'changed_test_unmapped' | 'migration_check_unsupported' }[];
}

interface FullRule { code: string; globs: string[]; global?: boolean }
type ManifestRule = TestEnvironmentV1['impact']['fullPackageGlobs'][number];
/* Why a test runs that a rule of the manifest names, beside those the graph finds. */
export const NAMED_TESTS = 'named_tests';
const DEFAULT_FULL_PACKAGE_RULES: readonly FullRule[] = [
  { code: 'migration', globs: ['**/migrations/**', '**/drizzle/**', '**/*.migration.*'] },
  { code: 'schema', globs: ['**/schema.*', '**/schema/**'] },
  { code: 'configuration', globs: ['**/*config*', '**/config/**', '**/configs/**', '**/configuration/**', '**/settings/**', '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/poetry.lock', '**/Pipfile.lock', '**/uv.lock', '**/Cargo.lock', '**/pyproject.toml', '**/pytest.ini', '**/Dockerfile', '**/.hornhoof/**', '**/.github/**'] },
  { code: 'environment', globs: ['**/.env*', '**/env.*', '**/environment.*', '**/env/**', '**/environment/**', '**/environments/**'] },
  { code: 'routes', globs: ['**/routes/**', '**/routes.*', '**/router.*'] },
  { code: 'fixtures', globs: ['**/fixtures/**', '**/fixture.*', '**/conftest.py'] },
  { code: 'strings', globs: ['**/i18n/**', '**/locales/**', '**/translations/**', '**/strings.*', '**/strings/**'] },
  { code: 'scripts', globs: ['**/scripts/**'] },
  { code: 'installation', globs: ['**/install*'] },
  { code: 'updates', globs: ['**/update*', '**/*updates.*'] },
  { code: 'templates', globs: ['templates/**'], global: true },
  { code: 'shared_package', globs: ['packages/**'], global: true },
  { code: 'api_contract', globs: ['**/contracts/**', '**/contracts.*', '**/openapi.*'], global: true },
];
const ADAPTERS = new Map<string, ImpactAdapter>([['typescript', 'vitest-related'], ['javascript', 'vitest-related'], ['python', 'pytest']]);
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
function completeGroups(state: SelectionState, units: TestUnit[]): TestUnit[] {
  const groups = new Set(units.map(unit => `${unit.suiteId}\0${unit.selectionUnit}`));
  return state.environment.inventory.filter(unit => groups.has(`${unit.suiteId}\0${unit.selectionUnit}`));
}
function add(state: SelectionState, pkg: ImpactPackage, mode: Choice['mode'], units: TestUnit[], reason: ImpactReason): void {
  const choice = state.choices.get(pkg.id) ?? { mode, units: new Map<string, TestUnit>(), reasons: new Map<string, ImpactReason>() };
  if (mode === 'whole-package') choice.mode = mode;
  for (const unit of completeGroups(state, units)) choice.units.set(unitKey(unit), unit);
  choice.reasons.set(`${reason.code}\0${reason.path}`, reason);
  state.choices.set(pkg.id, choice);
}
function whole(state: SelectionState, packages: ImpactPackage[], reason: ImpactReason): void {
  for (const pkg of packages) add(state, pkg, 'whole-package', state.environment.inventory.filter(unit => pkg.suiteIds.includes(unit.suiteId)), reason);
}
/* A file of no one package reaches everyone, unless a rule of the repository's manifest names who reads it. */
function defaultTargets(state: SelectionState, rule: FullRule, path: string, named: boolean): ImpactPackage[] {
  const owner = rule.global ? undefined : ownerOf(state.environment, path);
  if (owner) return [owner];
  return named ? [] : state.environment.packages;
}
const WILDCARD = /[?*[\]{}()!+@]/;
const UNEVEN_PATH = /(?:^|\/)\.?(?:\/|$)/;
/* A pattern of a manifest names a file, a folder or a glob. Compiling a glob for every tracked file costs more than reading them, so
   what comes before its first wildcard decides first. Only a path written unevenly, which the glob would read evenly, cannot go by that. */
export function matchesPattern(path: string, pattern: string): boolean {
  if (path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`)) return true;
  if (UNEVEN_PATH.test(pattern)) return matchesGlob(path, pattern);
  const wildcard = pattern.search(WILDCARD);
  return wildcard >= 0 && path.startsWith(pattern.slice(0, wildcard)) && matchesGlob(path, pattern);
}
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
/* A scenario of a screen is named after it: one of the two names starts the other, word by word. It imports no screen, so this is all
   that ties them, for what an author is told to look at first. A release runs every scenario again when any screen changed. */
export function namedAfter(scenario: string, screen: string): boolean {
  const own = `${posix.basename(scenario).replace(/\.[^.]+\.[^.]+$/, '')}-`, other = `${kebab(posix.basename(screen).replace(/\.[^.]+$/, ''))}-`;
  return own.startsWith(other) || other.startsWith(own);
}
function packageGraphs(state: SelectionState, graphs: ImpactGraph[], pkg?: ImpactPackage): ImpactGraph[] | undefined {
  if (!pkg) return new Set(graphs.map(graph => graph.adapter)).size === graphs.length ? graphs : undefined;
  const adapter = ADAPTERS.get(pkg.language ?? state.environment.impact.adapter);
  const found = graphs.filter(graph => graph.adapter === adapter);
  return adapter && found.length === 1 ? found : undefined;
}
function graphPackages(state: SelectionState, graphs: ImpactGraph[], pkg?: ImpactPackage): ImpactPackage[] {
  const found = packageGraphs(state, graphs, pkg);
  if (!found?.length || found.some(graph => graph.status !== 'ready' || !validGraph(state, graph))) return state.environment.packages;
  const affected = new Set(found.flatMap(graph => graph.units.map(unit => packageOfUnit(state.environment, unit)!.id)));
  return state.environment.packages.filter(value => affected.has(value.id));
}
function widen(state: SelectionState, graphs: ImpactGraph[], pkg: ImpactPackage, reason: ImpactReason): void {
  whole(state, [pkg, ...graphPackages(state, graphs, pkg)], reason);
}
const packagesNamed = (state: SelectionState, rule: ManifestRule): ImpactPackage[] => state.environment.packages.filter(pkg => pkg.suiteIds.some(id => rule.suiteIds.includes(id)));
function readable(state: SelectionState, pkg: ImpactPackage, path: string): boolean {
  const adapter = ADAPTERS.get(pkg.language ?? state.environment.impact.adapter);
  return adapter !== undefined && EXTENSIONS[adapter].includes(extname(path));
}
/* A rule that names its tests runs only those test files of its suites. */
function namedTests(state: SelectionState, rule: ManifestRule & { tests: string[] }, path: string): void {
  for (const pkg of packagesNamed(state, rule)) {
    const units = state.environment.inventory.filter(unit => pkg.suiteIds.includes(unit.suiteId) && rule.suiteIds.includes(unit.suiteId) && rule.tests.some(glob => matchesPattern(unit.file, glob)));
    add(state, pkg, 'related', units, { code: NAMED_TESTS, path });
  }
}
function policy(state: SelectionState, graphs: ImpactGraph[], path: string): boolean {
  const matched = state.environment.impact.fullPackageGlobs.filter(rule => rule.globs.some(glob => matchesPattern(path, glob)));
  const targets = matched.filter(rule => !rule.tests).flatMap(rule => packagesNamed(state, rule));
  whole(state, targets, { code: 'full_package_rule', path });
  for (const rule of matched) if (rule.tests) namedTests(state, { ...rule, tests: rule.tests }, path);
  const rules = DEFAULT_FULL_PACKAGE_RULES.filter(value => value.globs.some(glob => matchesPattern(path, glob)));
  let taken = targets.length > 0;
  for (const rule of rules) {
    if (rule.code === 'migration') state.migration = true;
    const found = defaultTargets(state, rule, path, matched.length > 0);
    whole(state, found, { code: rule.code, path });
    taken ||= found.length > 0;
  }
  if (!matched.length && !rules.length) return false;
  /* Tests named by a rule are all who read the file without importing it, so the graph adds no one whole for it; what the
     graph sees of a code file still runs, as for any other. */
  const owner = ownerOf(state.environment, path);
  if (!taken) {
    if (owner && readable(state, owner, path)) related(state, graphs, owner, path);
    return true;
  }
  const consumers = graphPackages(state, graphs, owner).filter(pkg => state.choices.get(pkg.id)?.mode !== 'whole-package');
  whole(state, consumers, { code: 'policy_consumers', path });
  return true;
}
function forceChangedTest(state: SelectionState, change: ImpactChange): void {
  if (change.kind === 'deleted') return;
  const found = state.environment.inventory.filter(unit => unit.file === change.path);
  const added = change.kind === 'added';
  if (!found.length && /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/.test(change.path)) addProblem(state, added ? 'new_test_unmapped' : 'changed_test_unmapped');
  for (const unit of found) {
    const pkg = packageOfUnit(state.environment, unit);
    if (!pkg) addProblem(state, 'impact_environment_invalid');
    else add(state, pkg, 'related', [unit], { code: added ? 'new_test' : 'changed_test', path: change.path });
  }
}
function validGraph(state: SelectionState, graph: ImpactGraph): boolean {
  return graph.units.every(unit => state.inventory.get(unitKey(unit))?.selectionUnit === unit.selectionUnit && packageOfUnit(state.environment, unit) !== undefined);
}
function related(state: SelectionState, graphs: ImpactGraph[], pkg: ImpactPackage, path: string): void {
  const adapter = ADAPTERS.get(pkg.language ?? state.environment.impact.adapter);
  if (!adapter) return whole(state, state.environment.packages, { code: 'unsupported_language', path });
  if (!EXTENSIONS[adapter].includes(extname(path))) return widen(state, graphs, pkg, { code: 'unsupported_file', path });
  const found = graphs.filter(graph => graph.adapter === adapter);
  if (found.length !== 1 || found[0]!.status !== 'ready') return whole(state, state.environment.packages, { code: 'graph_unavailable', path });
  const graph = found[0]!;
  if (!validGraph(state, graph)) return whole(state, state.environment.packages, { code: 'invalid_graph', path });
  for (const unit of graph.units) add(state, packageOfUnit(state.environment, unit)!, 'related', [unit], { code: 'related', path });
}
function selectPath(state: SelectionState, graphs: ImpactGraph[], change: ImpactChange, path: string): void {
  if (policy(state, graphs, path)) return;
  const pkg = ownerOf(state.environment, path);
  if (!pkg) return whole(state, state.environment.packages, { code: 'unmapped_file', path });
  if (change.kind === 'deleted' || change.kind === 'renamed') return widen(state, graphs, pkg, { code: `${change.kind}_source`, path });
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
function validEnvironment(environment: ImpactEnvironment): boolean {
  const owners = new Map<string, number>();
  for (const pkg of environment.packages) for (const suite of pkg.suiteIds) owners.set(suite, (owners.get(suite) ?? 0) + 1);
  return new Set(environment.packages.map(pkg => pkg.id)).size === environment.packages.length && environment.inventory.every(unit => owners.get(unit.suiteId) === 1);
}

/* Called by the fingerprints (what the import graph cannot see) and by the author check; it runs and decides nothing itself. */
export function selectAffectedTests(input: ImpactInput): ImpactSelection {
  const state: SelectionState = { environment: input.environment, inventory: new Map(input.environment.inventory.map(unit => [unitKey(unit), unit])), choices: new Map(), problems: [], migration: false };
  if (!validEnvironment(input.environment)) { addProblem(state, 'impact_environment_invalid'); return finish(state); }
  if (input.changes.some(change => paths(change).some(path => !safePath(path)))) {
    addProblem(state, 'impact_path_invalid'); return finish(state);
  }
  for (const change of input.changes) {
    forceChangedTest(state, change);
    for (const path of paths(change)) selectPath(state, input.graphs, change, path);
  }
  return finish(state);
}
