import { posix } from 'node:path';
import { isDocument, isLintable, isSource, ownerOf } from './plan.mjs';

/* The projects of the root vitest.config.mjs and the suites of .hornhoof/test-environment.json they run. */
const PROJECT_SUITES = {
  '@hornhoof/server': ['server'], '@hornhoof/node': ['node'], '@hornhoof/node:no-proc': ['node'], '@hornhoof/web': ['web'], '@hornhoof/protocol': ['protocol'],
};
const ONLY_A_NOTE = 'migration_check_unsupported';
const E2E = 'apps/web/e2e/';
const SPEC = '.spec.ts';
const SCREEN = /^apps\/web\/src\/.*\.(?:tsx|css)$/;
const CONSUMERS = 'policy_consumers';

export function adapterOf(run) {
  if (run.args.includes('vitest')) return 'vitest';
  return run.program === 'node' && run.args.includes('--test') ? 'node-test' : null;
}

export function fastSuites(manifest) {
  const required = manifest.profiles.find(profile => profile.id === manifest.defaultProfile).requiredSuiteIds;
  return manifest.suites.filter(suite => required.includes(suite.id));
}

const languageOf = suite => (adapterOf(suite.run) ? 'typescript' : suite.run.program);

export function impactEnvironment(manifest, units) {
  const suites = fastSuites(manifest), ids = new Set(suites.map(suite => suite.id));
  return {
    packages: suites.map(suite => ({ id: suite.id, root: suite.root, language: languageOf(suite), suiteIds: [suite.id] })),
    impact: manifest.impact,
    inventory: units.filter(unit => ids.has(unit.suiteId)),
  };
}

function once(work) {
  let result;
  return () => (result ??= work());
}

async function adapterSelection(environment, changes, suites, ports) {
  const known = suites.filter(suite => adapterOf(suite.run));
  const changed = changes.filter(change => change.kind !== 'deleted' && isLintable(change.path) && !opaqueOwner(suites, change.path)).map(change => change.path);
  const inventory = environment.inventory.filter(unit => known.some(suite => suite.id === unit.suiteId));
  const collection = once(() => ports.collect(changed));
  const requiredSuiteIds = known.filter(suite => adapterOf(suite.run) === 'vitest').map(suite => suite.id);
  const graph = await ports.collectVitestImpact({ inventory, projectSuites: PROJECT_SUITES, changed, requiredSuiteIds }, collection);
  const packages = environment.packages.filter(item => known.some(suite => suite.id === item.id));
  const selection = await ports.selectAffectedTests({ environment: { ...environment, packages, inventory }, changes, graphs: [graph] });
  return { ...selection, reached: graph.status === 'ready' ? graph.units : [] };
}

const opaqueOwner = (suites, path) => {
  const owner = ownerOf(suites, path);
  return owner && adapterOf(owner.run) !== 'vitest' ? owner : null;
};

function graphOrPolicy(suites, change) {
  const owner = opaqueOwner(suites, change.path);
  return !owner || adapterOf(owner.run) === 'node-test';
}

function wholeOf(environment, suites, changes) {
  const owners = new Map(changes.map(change => [opaqueOwner(suites, change.path)?.id, change]));
  return environment.packages.filter(item => owners.has(item.id)).map(item => ({
    packageId: item.id, mode: 'whole-package', units: environment.inventory.filter(unit => unit.suiteId === item.id),
    reasons: [{ code: 'unsupported_language', path: owners.get(item.id).path }],
  }));
}

function mergePackages(packages) {
  const groups = Map.groupBy(packages, item => item.packageId);
  return [...groups.keys()].sort().map(packageId => {
    const members = groups.get(packageId);
    const units = new Map(members.flatMap(item => item.units).map(unit => [`${unit.suiteId}\0${unit.file}`, unit]));
    const reasons = new Map(members.flatMap(item => item.reasons ?? []).map(reason => [JSON.stringify(reason), reason]));
    return { packageId, mode: members.some(item => item.mode === 'whole-package') ? 'whole-package' : 'related', units: [...units.values()], reasons: [...reasons.values()] };
  });
}

/* Each suite's package fully selected is the whole fast suite, which an author runs only when asked for by name. */
export function isWholeSuite(packages, suites) {
  return suites.every(suite => packages.some(item => item.packageId === suite.id && item.mode === 'whole-package'));
}

/* A shared package reaches everyone who uses it, so its whole selection needs no asking. Another path that takes every suite by itself still asks; one that only found the consumers of the change does not. */
function reachesEveryone(packages) {
  const own = item => (item.reasons ?? []).filter(reason => reason.code !== CONSUMERS);
  const everywhere = own(packages[0] ?? {}).filter(reason => packages.every(item => own(item).some(other => other.path === reason.path)));
  const shared = new Set(everywhere.filter(reason => reason.code === 'shared_package').map(reason => reason.path));
  return shared.size > 0 && everywhere.every(reason => shared.has(reason.path));
}

/* What a change a person sees asks of a browser: a scenario that changed, and the scenarios named after a screen that changed. */
function browserNote(path, specs, namedAfter) {
  const scenario = spec => `browser scenario: ${spec}`;
  if (specs.includes(path)) return [scenario(path)];
  if (path.startsWith(E2E)) return path.endsWith(SPEC) || isDocument(path) ? [] : [`browser helper, its scenarios run at the release: ${path}`];
  if (!SCREEN.test(path)) return [];
  const named = specs.filter(spec => namedAfter(spec, path));
  return named.length ? named.map(scenario) : [`browser scenario by hand, none is named after: ${path}`];
}

function browserNotes(changes, tracked, namedAfter) {
  const specs = tracked.map(file => file.path).filter(path => path.startsWith(E2E) && path.endsWith(SPEC));
  return [...new Set(changes.flatMap(change => [change.path, change.previousPath ?? change.path]).flatMap(path => browserNote(path, specs, namedAfter)))];
}

/* The tests only a later profile than this one runs. What a suite of mutation lists are sources, which keep their own tests here. */
function laterTests(environment, units, mutation) {
  const fast = new Set(environment.inventory.map(unit => unit.file)), sources = new Set(mutation.sourcePaths ?? []);
  return new Set(units.map(unit => unit.file).filter(file => !fast.has(file) && !sources.has(file)));
}

/* A file moved here from where the fast suites run still counts for where it was. */
const outsideFast = (change, later) => [change.path, change.previousPath ?? change.path].every(path => path.startsWith(E2E) || later.has(path));

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*)['"]([^'"]+)['"]/g;
/* The files a test names by a relative path, each under the names it may have: as written, its source for a built name, an index. */
export function directImports(file, text) {
  const named = [...text.matchAll(SPECIFIER)].map(match => match[1]).filter(specifier => specifier.startsWith('.'));
  return named.flatMap(specifier => {
    const path = posix.join(posix.dirname(file), specifier), bare = path.replace(/\.[cm]?jsx?$/, '');
    return [path, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '/index.ts', '/index.tsx'].map(end => `${bare}${end}`)];
  });
}

const changePaths = change => (change.previousPath ? [change.path, change.previousPath] : [change.path]);

function nearChecker(changes, ports) {
  const changed = new Set(changes.filter(change => change.kind !== 'deleted').map(change => change.path));
  const touched = new Set(changes.flatMap(changePaths));
  const sources = [...touched].filter(isSource), cache = new Map();
  const imports = file => { const text = ports.read(file); return text === null ? [] : directImports(file, text); };
  return unit => {
    if (!cache.has(unit.file)) {
      cache.set(unit.file, changed.has(unit.file) || sources.some(source => ports.namedAfter(unit.file, source)) || imports(unit.file).some(path => touched.has(path)));
    }
    return cache.get(unit.file);
  };
}

function relatedNear(item, inGraph, isNear, left) {
  const far = item.units.filter(unit => inGraph(unit) && !isNear(unit));
  if (!far.length || !item.units.some(unit => inGraph(unit) && isNear(unit))) return [item];
  const farSet = new Set(far);
  for (const unit of far) left.add(unit.file);
  return [{ ...item, units: item.units.filter(unit => !farSet.has(unit)) }];
}

function wholeNear(item, isNear, left) {
  const kept = item.units.filter(isNear), far = item.units.filter(unit => !isNear(unit));
  for (const unit of far) left.add(unit.file);
  if (!kept.length) return [];
  return far.length ? [{ ...item, mode: 'related', units: kept }] : [item];
}

/* The tests an author runs of what the import graph or a package rule reaches: those that import a changed file themselves, are
   named after a changed source, or changed. The rest is left to the full run, which runs again every file whose fingerprint
   changed. A test a rule names is no test of the graph and always runs. A related package none of whose tests reaches the change
   directly runs all the graph reaches there; a whole-package rule without --allow-whole keeps only near tests locally. */
function nearTests(packages, changes, reached, { suites, allowWhole }, ports) {
  const keyOf = unit => `${unit.suiteId}\0${unit.file}`, graph = new Set(reached.map(keyOf));
  const adapted = new Set(suites.filter(suite => adapterOf(suite.run)).map(suite => suite.id));
  const isNear = nearChecker(changes, ports), left = new Set();
  const kept = packages.flatMap(item => {
    if (item.mode === 'related') return relatedNear(item, unit => graph.has(keyOf(unit)), isNear, left);
    return allowWhole || !adapted.has(item.packageId) ? [item] : wholeNear(item, isNear, left);
  });
  return { packages: kept, leftToFullRun: [...left].sort() };
}

/* A document leads nowhere in an import graph, but a test may read one by its path, as a fingerprint sees. The tests that name a
   changed document themselves run, and those that reach it through the code they run are left to the full run. */
async function documentReaders(documents, environment, { manifest, tracked }, ports) {
  const paths = [...new Set(documents.flatMap(change => [change.path, change.previousPath ?? change.path]))];
  if (!paths.length) return { packages: [], left: [], unread: [] };
  const found = await ports.readers({ manifest, tracked, paths, tests: [...new Set(environment.inventory.map(unit => unit.file))] });
  const packages = paths.flatMap(path => {
    const named = new Set(found.get(path)?.named ?? []), units = environment.inventory.filter(unit => named.has(unit.file));
    return [...new Set(units.map(unit => unit.suiteId))].map(packageId => ({ packageId, mode: 'related', units: units.filter(unit => unit.suiteId === packageId), reasons: [{ code: 'reads_document', path }] }));
  });
  const left = paths.flatMap(path => found.get(path)?.reached ?? []);
  const unread = documents.filter(change => [change.path, change.previousPath ?? change.path].every(path => !found.get(path)?.reached.length)).map(change => change.path);
  return { packages, left, unread };
}

const isBlockedWhole = (reached, suites, { allowWhole, everyReached }) => (
  everyReached && !allowWhole && isWholeSuite(reached, suites) && !reachesEveryone(reached)
);

/* everyReached keeps every test the import graph reaches, for a check no full run follows, such as GitHub's tests of a commit. */
export async function selectTests({ changes, manifest, tracked, allowWhole, everyReached = false }, ports) {
  const suites = fastSuites(manifest);
  const units = ports.listTestUnits(manifest, tracked);
  const environment = impactEnvironment(manifest, units);
  const later = laterTests(environment, units, manifest.mutation);
  const document = change => [change.path, change.previousPath ?? change.path].every(isDocument);
  const documents = changes.filter(document);
  const kept = changes.filter(change => !document(change) && !outsideFast(change, later));
  const opaque = kept.filter(change => opaqueOwner(suites, change.path));
  const rest = kept.filter(change => graphOrPolicy(suites, change));
  const selection = await adapterSelection(environment, rest, suites, ports);
  const read = await documentReaders(documents, environment, { manifest, tracked }, ports);
  const notes = [...read.unread.map(path => `document without tests: ${path}`), ...browserNotes(changes, tracked, ports.namedAfter), ...changes.filter(change => later.has(change.path) && !change.path.startsWith(E2E)).map(change => `runs in the final profile: ${change.path}`), ...selection.problems.filter(problem => problem.code === ONLY_A_NOTE).map(problem => problem.code)];
  const problem = selection.problems.find(item => item.code !== ONLY_A_NOTE);
  if (problem) return { unavailable: problem.code, notes };
  const reached = mergePackages([...selection.packages, ...wholeOf(environment, suites, opaque)]);
  if (isBlockedWhole(reached, suites, { allowWhole, everyReached })) return { unavailable: 'selection_is_whole_suite', notes };
  const near = everyReached ? { packages: reached, leftToFullRun: [] } : nearTests(reached, changes, selection.reached ?? [], { suites, allowWhole }, ports);
  const packages = mergePackages([...near.packages, ...read.packages]);
  const selected = new Set(packages.flatMap(item => item.units.map(unit => unit.file)));
  const leftToFullRun = [...new Set([...near.leftToFullRun, ...read.left])].filter(file => !selected.has(file)).sort();
  if (leftToFullRun.length) notes.push(`left to the full run: ${leftToFullRun.length} test files the import graph reaches, listed in the record`);
  return { packages, notes, leftToFullRun };
}
