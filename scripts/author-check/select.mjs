import { isDocument, isLintable, ownerOf } from './plan.mjs';

/* The projects of the root vitest.config.mjs and the suites of .hornhoof/test-environment.json they run. */
const PROJECT_SUITES = {
  '@hornhoof/server': ['server'], '@hornhoof/node': ['node'], '@hornhoof/node:no-proc': ['node'], '@hornhoof/web': ['web'], '@hornhoof/protocol': ['protocol'],
};
const ONLY_A_NOTE = 'migration_check_unsupported';

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
  const changed = changes.filter(change => change.kind !== 'deleted' && isLintable(change.path)).map(change => change.path);
  const inventory = environment.inventory.filter(unit => known.some(suite => suite.id === unit.suiteId));
  const collection = once(() => ports.collect(changed));
  const requiredSuiteIds = known.filter(suite => adapterOf(suite.run) === 'vitest').map(suite => suite.id);
  const graph = await ports.collectVitestImpact({ inventory, projectSuites: PROJECT_SUITES, changed, requiredSuiteIds }, collection);
  const packages = environment.packages.filter(item => known.some(suite => suite.id === item.id));
  return ports.selectAffectedTests({ environment: { ...environment, packages, inventory }, changes, graphs: [graph] });
}

const opaqueOwner = (suites, path) => {
  const owner = ownerOf(suites, path);
  return owner && !adapterOf(owner.run) ? owner : null;
};

function wholeOf(environment, suites, changes) {
  const owners = new Map(changes.map(change => [opaqueOwner(suites, change.path)?.id, change]));
  return environment.packages.filter(item => owners.has(item.id)).map(item => ({
    packageId: item.id, mode: 'whole-package', units: environment.inventory.filter(unit => unit.suiteId === item.id),
    reasons: [{ code: 'unsupported_language', path: owners.get(item.id).path }],
  }));
}

/* Each suite's package fully selected is the whole fast suite, which an author runs only when asked for by name. */
function isWholeSuite(packages, suites) {
  return suites.every(suite => packages.some(item => item.packageId === suite.id && item.mode === 'whole-package'));
}

export async function selectTests({ changes, manifest, tracked, allowWhole }, ports) {
  const suites = fastSuites(manifest);
  const environment = impactEnvironment(manifest, ports.listTestUnits(manifest, tracked));
  const documents = changes.filter(change => isDocument(change.path));
  const kept = changes.filter(change => !isDocument(change.path));
  const opaque = kept.filter(change => opaqueOwner(suites, change.path));
  const rest = kept.filter(change => !opaqueOwner(suites, change.path));
  const selection = await adapterSelection(environment, rest, suites, ports);
  const notes = [...documents.map(change => `document without tests: ${change.path}`), ...selection.problems.filter(problem => problem.code === ONLY_A_NOTE).map(problem => problem.code)];
  const problem = selection.problems.find(item => item.code !== ONLY_A_NOTE);
  if (problem) return { unavailable: problem.code, notes };
  const packages = [...selection.packages, ...wholeOf(environment, suites, opaque)];
  if (isWholeSuite(packages, suites) && !allowWhole) return { unavailable: 'selection_is_whole_suite', notes };
  return { packages, notes };
}
