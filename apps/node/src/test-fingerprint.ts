import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { matchesGlob, posix } from 'node:path';
import { PREPARATION_UNIT, type EnvironmentDescription, type RepositoryScope, type TestEnvironmentV1, type TestUnit, type UnitFingerprint } from '@hornhoof/protocol';
import { checkCacheContext, type CacheContext } from './test-cache.js';
import { selectAffectedTests, type ImpactEnvironment, type ImpactGraph, type ImpactPackage } from './test-impact.js';
import { readCommit, type GitEntry } from './test-mirror.js';

/* What a test file's result depends on, read from the pinned commit alone: nothing is installed and no repository code runs.
   A git object id hashes a file's content, so a fingerprint is a digest of paths and ids. Whatever this cannot follow widens
   to the whole package, because a file skipped wrongly is the one real harm here. Reads at computed paths stay unseen, as in
   any import graph; the full run catches them. */
export type FingerprintInput = {
  description: Pick<EnvironmentDescription, 'manifest' | 'inventory' | 'inputDigests' | 'runtimeCapabilities'>;
  tracked: GitEntry[];
  texts: ReadonlyMap<string, string>;
};
/* Called between batches of work: lets the node's other work through, and throws when the work must stop. */
export type Pause = () => Promise<void>;
type Manifest = TestEnvironmentV1;
type Suite = Manifest['suites'][number];
type Scan = { edges: string[]; opaque: boolean };
type Reach = { digest: string; opaque: boolean };

const FORMAT = 'hornhoof-fingerprint-v1';
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const REGULAR = new Set(['100644', '100755']);
const DOCUMENT = /^(?!templates\/).*\.md$/;
const TEST_FOLDER = /(?:^|\/)(?:test|tests|__tests__)\//;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const SOURCE_OF_BUILT: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
/* Statements start a line, so text that reads like one elsewhere, as SQL's from "tasks", is not taken for an import. */
const STATEMENT = /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
const BARE_IMPORT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;
const CALLED = /\b(?:import|require|import\.meta\.resolve|(?:vi|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual|requireMock))\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const COMPUTED = /\b(?:import|require|import\.meta\.resolve)\s*\(\s*(?:[^'"`\s)]|`[^`]*\$\{)/;
const STRING = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const SCREEN = /([^/]+)\.[jt]sx$/;
const LONGEST_PATH = 300;
/* What takes a package whole because it runs around its tests, so what it imports does too. */
const RUNS_AROUND_TESTS = new Set(['configuration', 'full_package_rule']);
const VERDICTS_BETWEEN_PAUSES = 16;
const SCANS_BETWEEN_PAUSES = 64;
const READ_BYTES = 64 * 1024 * 1024;

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const isDocument = (path: string): boolean => DOCUMENT.test(path);
const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const relativeLike = (literal: string): boolean => literal.startsWith('./') || literal.startsWith('../');
const bare = (literal: string): string => literal.replace(/[?#].*$/, '');
const isInside = (path: string, folder: string): boolean => folder === '.' || path === folder || path.startsWith(`${folder}/`);
const matches = (path: string, pattern: string): boolean => isInside(path, pattern.replace(/\/$/, '')) || matchesGlob(path, pattern);
const nextTurn: Pause = () => new Promise(done => setImmediate(done));

/* The files a fingerprint reads; the rest it knows by their object ids. */
export function codeFilesOf(tracked: GitEntry[]): string[] {
  return tracked.filter(entry => REGULAR.has(entry.mode) && (CODE.test(entry.path) || posix.basename(entry.path) === 'package.json')).map(entry => entry.path);
}

type PackageJson = { name?: string; dependencies?: object; devDependencies?: object; peerDependencies?: object; optionalDependencies?: object };
function packageJson(text: string | undefined): PackageJson {
  try {
    const value: unknown = JSON.parse(text ?? '{}');
    return typeof value === 'object' && value !== null ? value : {};
  } catch { return {}; }
}
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/* The paths of the pinned commit and what its package files declare. */
class Tree {
  readonly oids: Map<string, string>;
  readonly paths: string[];
  readonly workspaces = new Map<string, string>();
  readonly declared = new Set<string>(builtinModules);
  private readonly modes: Map<string, string>;
  private readonly roots: string[];
  private readonly artifacts: { path: string; inputs: string[] }[];
  private readonly folders = new Map<string, string[]>();
  private readonly folderDigests = new Map<string, string>();
  private readonly built = new Map<string, string[]>();

  constructor(readonly input: FingerprintInput) {
    this.oids = new Map(input.tracked.map(entry => [entry.path, entry.oid]));
    this.modes = new Map(input.tracked.map(entry => [entry.path, entry.mode]));
    this.paths = [...this.oids.keys()].sort(lexical);
    const { manifest } = input.description;
    this.roots = manifest.suites.map(suite => suite.root).sort((a, b) => b.length - a.length);
    this.artifacts = manifest.prepare.flatMap(unit => unit.artifacts.flatMap(artifact => 'service' in artifact ? [] : [{ path: artifact.path, inputs: unit.inputs }]));
    for (const path of this.paths) if (posix.basename(path) === 'package.json') this.readPackage(path);
  }
  private readPackage(path: string): void {
    const value = packageJson(this.input.texts.get(path));
    /* The root's name is no package to import: it would stand for everything, and it reads as an ordinary word. */
    if (value.name && path !== 'package.json') this.workspaces.set(value.name, posix.dirname(path));
    for (const group of [value.dependencies, value.devDependencies, value.peerDependencies, value.optionalDependencies]) for (const name of Object.keys(group ?? {})) this.declared.add(name);
  }
  isRegular(path: string): boolean { return REGULAR.has(this.modes.get(path) ?? ''); }
  under(folder: string): string[] {
    let found = this.folders.get(folder);
    if (!found) { found = this.paths.filter(path => isInside(path, folder) && !isDocument(path)); this.folders.set(folder, found); }
    return found;
  }
  folderDigest(folder: string): string {
    let found = this.folderDigests.get(folder);
    if (!found) { found = this.pairsDigest(this.under(folder)); this.folderDigests.set(folder, found); }
    return found;
  }
  pairsDigest(files: Iterable<string>): string {
    return digest([...new Set(files)].sort(lexical).map(path => [path, this.oids.get(path) ?? '']));
  }
  /* A workspace package as what imports it reaches: its code and not its tests. */
  packageCode(root: string): string[] { return this.under(root).filter(path => !TEST_FOLDER.test(path)); }
  matching(patterns: string[]): string[] { return this.paths.filter(path => patterns.some(pattern => matches(path, pattern))); }
  rootOf(path: string): string { return this.roots.find(root => isInside(path, root)) ?? '.'; }
  /* What a path that may lack its extension names: a file, the source of a built one, or a folder's index. */
  resolve(path: string): string | undefined {
    if (this.oids.has(path)) return path;
    const extension = posix.extname(path), stem = extension ? path.slice(0, -extension.length) : path;
    for (const source of SOURCE_OF_BUILT[extension] ?? []) if (this.oids.has(stem + source)) return stem + source;
    for (const next of EXTENSIONS) {
      if (this.oids.has(path + next)) return path + next;
      if (this.oids.has(`${path}/index${next}`)) return `${path}/index${next}`;
    }
    return undefined;
  }
  /* A built path leads to what it is built from. */
  builtFrom(path: string): string[] | undefined {
    const artifact = this.artifacts.find(item => isInside(path, item.path));
    if (!artifact) return undefined;
    let found = this.built.get(artifact.path);
    if (!found) { found = this.matching(artifact.inputs); this.built.set(artifact.path, found); }
    return found;
  }
}

/* An import names a file, a package of the repository or a package installed from its lockfile. Anything else, as a path
   alias, is something this cannot follow. */
function importedBy(tree: Tree, from: string, literal: string): string[] | null {
  const specifier = bare(literal);
  if (relativeLike(specifier) || specifier === '.' || specifier === '..') {
    const target = posix.join(posix.dirname(from), specifier), found = tree.resolve(target);
    return found ? [found] : tree.builtFrom(target) ?? null;
  }
  if (specifier.startsWith('node:')) return [];
  if (specifier.startsWith('/') || specifier.includes(':')) return null;
  const name = packageName(specifier), root = tree.workspaces.get(name);
  if (root) return tree.packageCode(root);
  return tree.declared.has(name) ? [] : null;
}

function relativeNamed(tree: Tree, from: string, literal: string): string[] {
  const target = posix.join(posix.dirname(from), literal);
  if (literal.includes('*')) return tree.paths.filter(path => matchesGlob(path, target));
  const found = tree.resolve(target);
  if (found) return [found];
  const built = tree.builtFrom(target);
  if (built) return built;
  /* A folder by name. A path of dots alone is where a file is, not what it reads. */
  return /(?:^|\/)\.\.?\/?$/.test(literal) ? [] : tree.under(target);
}

/* A path named in the code, as for a file read from disk: relative, from the package or from the repository. */
function namedBy(tree: Tree, from: string, literal: string): string[] {
  const text = bare(literal);
  if (!text || text.length > LONGEST_PATH || text.includes('${') || text.includes(' ') || text.includes('\n')) return [];
  if (relativeLike(text)) return relativeNamed(tree, from, text);
  const workspace = tree.workspaces.get(packageName(text));
  if (workspace) return tree.packageCode(workspace);
  const inPackage = posix.join(tree.rootOf(from), text), found = [text, inPackage].filter(path => tree.oids.has(path));
  return found.length ? found : tree.builtFrom(inPackage) ?? [];
}

function scanCode(tree: Tree, from: string, text: string): Scan {
  const edges = new Set<string>();
  let opaque = COMPUTED.test(text);
  for (const pattern of [STATEMENT, BARE_IMPORT, CALLED]) for (const [, , literal] of text.matchAll(pattern)) {
    const found = importedBy(tree, from, literal!);
    if (found) for (const path of found) edges.add(path);
    else opaque = true;
  }
  for (const [, , literal] of text.matchAll(STRING)) for (const path of namedBy(tree, from, literal!)) edges.add(path);
  edges.delete(from);
  return { edges: [...edges], opaque };
}
function scanFile(tree: Tree, path: string): Scan {
  if (!tree.isRegular(path)) return { edges: [], opaque: true };
  if (!CODE.test(path)) return { edges: [], opaque: false };
  const text = tree.input.texts.get(path);
  return text === undefined ? { edges: [], opaque: true } : scanCode(tree, path, text);
}

/* Groups of files that import each other, what they import first: Tarjan's algorithm, on its own stack as imports run deep. */
function components(starts: string[], edgesOf: (path: string) => string[]): string[][] {
  const order = new Map<string, number>(), low = new Map<string, number>(), open = new Set<string>(), stack: string[] = [], found: string[][] = [];
  const work: { path: string; edges: string[]; next: number }[] = [];
  const enter = (path: string): void => { order.set(path, order.size); low.set(path, order.get(path)!); stack.push(path); open.add(path); work.push({ path, edges: edgesOf(path), next: 0 }); };
  const lower = (path: string, value: number): void => { low.set(path, Math.min(low.get(path)!, value)); };
  const close = (path: string): void => {
    const group: string[] = [];
    let member: string;
    do { member = stack.pop()!; open.delete(member); group.push(member); } while (member !== path);
    found.push(group);
  };
  const leave = (path: string): void => {
    work.pop();
    if (work.length) lower(work.at(-1)!.path, low.get(path)!);
    if (low.get(path) === order.get(path)) close(path);
  };
  for (const start of starts) {
    if (order.has(start)) continue;
    enter(start);
    while (work.length) {
      const top = work.at(-1)!, edge = top.edges[top.next++];
      if (edge === undefined) leave(top.path);
      else if (!order.has(edge)) enter(edge);
      else if (open.has(edge)) lower(top.path, order.get(edge)!);
    }
  }
  return found;
}

/* The import graph of the pinned tree. One digest stands for all a file reaches, built from what it imports, so a change of
   any file reached changes it, at the cost of one pass over the graph instead of one per test. */
class Graph {
  private readonly scans = new Map<string, Scan>();
  private readonly reaches = new Map<string, Reach>();
  constructor(readonly tree: Tree) {}
  private scan(path: string): Scan {
    let scan = this.scans.get(path);
    if (!scan) { scan = scanFile(this.tree, path); this.scans.set(path, scan); }
    return scan;
  }
  async scanAll(pause: Pause): Promise<void> {
    for (const [index, path] of this.tree.paths.entries()) {
      this.scan(path);
      if ((index + 1) % SCANS_BETWEEN_PAUSES === 0) await pause();
    }
  }
  private addGroup(group: string[]): void {
    const members = new Set(group), imported = new Set<string>();
    let opaque = false;
    for (const member of group) {
      const scan = this.scan(member);
      opaque ||= scan.opaque;
      for (const edge of scan.edges) {
        if (members.has(edge)) continue;
        const reach = this.reaches.get(edge)!;
        imported.add(reach.digest); opaque ||= reach.opaque;
      }
    }
    const reach = { digest: digest([this.tree.pairsDigest(group), [...imported].sort(lexical)]), opaque };
    for (const member of group) this.reaches.set(member, reach);
  }
  /* What these files reach together. */
  reachOf(starts: string[]): Reach {
    if (!this.reaches.size) for (const group of components(this.tree.paths, path => this.scan(path).edges)) this.addGroup(group);
    const reaches = starts.map(path => this.reaches.get(path)!);
    return { digest: digest([...new Set(reaches.map(reach => reach.digest))].sort(lexical)), opaque: reaches.some(reach => reach.opaque) };
  }
  /* The files reached, for the few places that need them by name. */
  closure(starts: string | string[]): Set<string> {
    const files = new Set<string>([starts].flat()), pending = [...files];
    while (pending.length) for (const path of this.scan(pending.pop()!).edges) if (!files.has(path)) { files.add(path); pending.push(path); }
    return files;
  }
}

export function testGraph(input: FingerprintInput): { closure: (starts: string | string[]) => Set<string> } {
  return new Graph(new Tree(input));
}

/* Suites of one folder share a package: what #309 takes whole for it, it takes whole for each of them. */
function packagesOf(manifest: Manifest): ImpactPackage[] {
  const packages = new Map<string, ImpactPackage>();
  for (const suite of manifest.suites) {
    const known = packages.get(suite.root) ?? { id: suite.root, root: suite.root, suiteIds: [] };
    known.suiteIds.push(suite.id);
    packages.set(suite.root, known);
  }
  return [...packages.values()];
}

type Verdict = { packages: string[]; expands: boolean };
const READY_GRAPHS: ImpactGraph[] = [{ adapter: 'vitest-related', status: 'ready', units: [] }, { adapter: 'pytest', status: 'ready', units: [] }];
/* The answer depends on the path and the rules alone and costs milliseconds per path, so a node keeps it between runs. */
const KEPT_VERDICTS = new Map<string, Map<string, Verdict>>();
function keptVerdicts(key: string): Map<string, Verdict> {
  let kept = KEPT_VERDICTS.get(key);
  if (!kept) {
    if (KEPT_VERDICTS.size >= 8) KEPT_VERDICTS.clear();
    kept = new Map(); KEPT_VERDICTS.set(key, kept);
  }
  return kept;
}
function verdictOn(environment: ImpactEnvironment, path: string): Verdict {
  const selection = selectAffectedTests({ environment, changes: [{ path, kind: 'modified' }], graphs: READY_GRAPHS });
  if (selection.problems.some(problem => problem.code !== 'migration_check_unsupported')) return { packages: environment.packages.map(item => item.id), expands: false };
  const taken = selection.packages.filter(item => item.mode === 'whole-package');
  return { packages: taken.map(item => item.packageId), expands: taken.some(item => item.reasons.some(reason => RUNS_AROUND_TESTS.has(reason.code))) };
}

/* What #309 says the graph cannot see, per package: for each tracked file, whether it takes a package whole. A file that is a
   test itself changes only itself, and a document changes nothing. */
async function outOfGraph(graph: Graph, pause: Pause): Promise<Map<string, string>> {
  const { tree } = graph, { manifest, inventory } = tree.input.description, packages = packagesOf(manifest);
  const units = new Set(inventory.map(unit => unit.file)), kept = keptVerdicts(digest([packages, manifest.impact]));
  const environment: ImpactEnvironment = { packages, impact: manifest.impact, inventory: [] };
  const found = new Map<string, string[]>(packages.map(item => [item.id, []]));
  let asked = 0;
  for (const path of tree.paths) {
    if (isDocument(path) || units.has(path)) continue;
    let verdict = kept.get(path);
    if (!verdict) {
      verdict = verdictOn(environment, path); kept.set(path, verdict);
      if (++asked % VERDICTS_BETWEEN_PAUSES === 0) await pause();
    }
    const files = verdict.expands ? [...graph.closure(path)] : [path];
    for (const id of verdict.packages) found.get(id)!.push(...files);
  }
  return new Map([...found].map(([id, files]) => [id, tree.pairsDigest(files)]));
}

function versionOf(description: FingerprintInput['description'], id: string): [string, string | null] {
  return [id, description.runtimeCapabilities.find(runtime => runtime.id === id)?.version ?? null];
}
/* The runtimes' versions and not the machines, and what is installed. A service counts for a suite only where they share
   every profile, so a suite that may run without it keeps its results. */
function runtimesOf(description: FingerprintInput['description'], suite: Suite | null): unknown {
  const { manifest } = description, services = new Set(manifest.services.map(service => service.runtime));
  const needed = manifest.services.filter(service => suite === null || suite.profiles.every(profile => service.profiles.includes(profile))).map(service => service.runtime);
  const own = manifest.runtimes.filter(runtime => !services.has(runtime.id)).map(runtime => runtime.id);
  const ids = [...new Set([...own, ...needed, ...(manifest.execution ? ['hornhoof-test-execution'] : [])])].sort(lexical);
  return ids.map(id => versionOf(description, id));
}

function screensFor(tree: Tree, sources: string, spec: string): string[] {
  const name = posix.basename(spec).replace(/\.[^.]+\.[^.]+$/, ''), screens = tree.under(sources).filter(path => SCREEN.test(path));
  const named = screens.filter(path => `${name}-`.startsWith(`${kebab(SCREEN.exec(path)![1]!)}-`));
  return named.length ? named : tree.under(sources);
}

/* What a test file and its package read, in one digest each. */
function inputsOf(graph: Graph, suite: Suite, starts: string[]): unknown {
  const { digest: reached, opaque } = graph.reachOf(starts);
  return opaque ? [reached, graph.tree.folderDigest(suite.root)] : reached;
}
function testInputs(graph: Graph, suite: Suite, file: string): unknown {
  const { tree } = graph;
  if (!CODE.test(file) || suite.split.kind === 'whole-package') return tree.folderDigest(suite.root);
  return inputsOf(graph, suite, suite.scenarioSources ? [file, ...screensFor(tree, suite.scenarioSources, file)] : [file]);
}

type Supported = Extract<Manifest['mutation'], { status: 'supported' }>;
/* A source file mutation checks depends on its code, on the fast tests that reach it and on what runs them, the suite's own
   folder; a configuration around other tests changes nothing about its mutants. */
function mutationPrint(graph: Graph, mutation: Supported, suite: Suite, environment: string, file: string): string {
  const fast = graph.tree.matching(mutation.fastTestPaths).filter(test => graph.closure(test).has(file));
  return digest([FORMAT, environment, mutation.tool, graph.tree.folderDigest(suite.root), inputsOf(graph, suite, [file, ...fast])]);
}

function preparationPrint(tree: Tree, description: FingerprintInput['description'], installed: unknown): UnitFingerprint[] {
  const preparation = description.manifest.execution?.oncePreparation;
  if (!preparation) return [];
  const inputs = tree.pairsDigest(tree.paths.filter(path => !isDocument(path)));
  return [{ ...PREPARATION_UNIT, fingerprint: digest([FORMAT, runtimesOf(description, null), installed, preparation, inputs]) }];
}

/* One fingerprint per unit of the inventory, and one for the explicit preparation if the manifest declares one. */
export async function fingerprintUnits(input: FingerprintInput, pause: Pause = nextTurn): Promise<UnitFingerprint[]> {
  const { description } = input, { manifest, inventory, inputDigests } = description, tree = new Tree(input), graph = new Graph(tree);
  await graph.scanAll(pause);
  const outside = await outOfGraph(graph, pause), suites = new Map(manifest.suites.map(suite => [suite.id, suite])), { mutation } = manifest;
  const sources = new Set(mutation.status === 'supported' ? mutation.sourcePaths : []);
  const installed = { inputs: inputDigests.filter(item => manifest.dependencies.inputs.some(pattern => matches(item.path, pattern))), commands: manifest.dependencies.install };
  const environments = new Map(manifest.suites.map(suite => [suite.id, digest([runtimesOf(description, suite), installed, suite.id, suite.run, suite.split])]));
  const printOf = (unit: TestUnit): UnitFingerprint => {
    const suite = suites.get(unit.suiteId)!, environment = environments.get(suite.id)!;
    const fingerprint = mutation.status === 'supported' && sources.has(unit.file)
      ? mutationPrint(graph, mutation, suite, environment, unit.file)
      : digest([FORMAT, environment, outside.get(suite.root), testInputs(graph, suite, unit.file)]);
    return { suiteId: unit.suiteId, file: unit.file, fingerprint };
  };
  return [...preparationPrint(tree, description, installed), ...inventory.map(printOf)];
}

/* The fingerprints of a commit a node has just described. Reading code that does not fit fails, and so leaves the run without reuse. */
export async function readTestFingerprints(source: Parameters<typeof readCommit>[0], scope: RepositoryScope, description: EnvironmentDescription, context: CacheContext): Promise<UnitFingerprint[]> {
  const tree = await readCommit(source, scope, description.commitSha, context);
  const texts = await tree.readTexts(codeFilesOf(tree.entries), READ_BYTES);
  return fingerprintUnits({ description, tracked: tree.entries, texts }, async () => { checkCacheContext(context); await nextTurn(); });
}
