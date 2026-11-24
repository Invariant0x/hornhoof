import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { matchesGlob, posix } from 'node:path';
import { PREPARATION_UNIT, runtimeClass, type EnvironmentDescription, type RepositoryScope, type TestEnvironmentV1, type TestUnit, type UnitFingerprint } from '@hornhoof/protocol';
import { checkCacheContext, type CacheContext } from './test-cache.js';
import { matchesPattern, NAMED_TESTS, selectAffectedTests, type ImpactEnvironment, type ImpactGraph, type ImpactPackage } from './test-impact.js';
import { readCommit, readMutationDelta, type GitEntry } from './test-mirror.js';
import type { MutationDelta, MutationSelection } from './test-impact-mutation.js';

/* What a test file's result depends on, read from the pinned commit alone: nothing is installed and no repository code runs.
   A git object id hashes a file's content, so a fingerprint is a digest of paths, modes and ids. Whatever this cannot follow widens
   to the whole package, because a file skipped wrongly is the one real harm here. Reads at computed paths stay unseen, as in
   any import graph; the full run catches them. */
export type FingerprintInput = {
  description: Pick<EnvironmentDescription, 'manifest' | 'inventory' | 'inputDigests' | 'runtimeCapabilities'>;
  tracked: GitEntry[];
  texts: ReadonlyMap<string, string>;
};
/* Called between batches of work: lets the node's other work through, and throws when the work must stop. */
type Pause = () => Promise<void>;
type Manifest = TestEnvironmentV1;
type Suite = Manifest['suites'][number];
/* edges: all a file may read. runs: what it imports and the files it names one by one. */
type Scan = { edges: string[]; runs: string[]; opaque: boolean };
/* opaque: the packages of what it reaches and cannot follow. */
type Reach = { digest: string; opaque: string[] };

const FORMAT = 'hornhoof-fingerprint-v3';
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const REGULAR = new Set(['100644', '100755']);
const DOCUMENT = /^(?!templates\/|(?:AGENTS|CONTRIBUTING|CHANGELOG)\.md$)(?!.*(?:^|\/)(?:test|tests|__tests__)\/).*\.md$/;
/* What holds data leads nowhere, as a file with no extension does unless it may run. Anything else this cannot read may be a program,
   and a program may load anything. */
const DATA = /\.(?:json|jsonl|md|txt|log|csv|sql|ya?ml|toml|ini|css|svg|png|jpe?g|gif|webp|ico|ttf|otf|woff2?|pdf|ansi|patch|snap|lock)$/;
const TEST_FOLDER = /(?:^|\/)(?:test|tests|__tests__)\//;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const SOURCE_OF_BUILT: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
/* Statements start a line, so text that reads like one elsewhere, as SQL's from "tasks", is not taken for an import. */
const STATEMENT = /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/gm;
const BARE_IMPORT = /^[ \t]*import\s*(['"])([^'"\n]+)\1/gm;
const CALLED = /\b(?:import|require|import\.meta\.resolve|(?:vi|jest)\.(?:mock|doMock|unmock|doUnmock|importActual|importMock|requireActual|requireMock))\s*\(\s*(['"`])([^'"`\n]+)\1/g;
const COMPUTED = /\b(?:import|require|import\.meta\.resolve)\s*\(\s*(?:[^'"`\s)]|`[^`]*\$\{)/;
const COMPUTED_CALLS = new RegExp(COMPUTED.source, 'g');
/* A computed import whose text starts with a fixed relative folder, as import(`./${id}.js`): it can only load what that folder holds. */
const FOLDER_TEMPLATE = /^(?:import|require|import\.meta\.resolve)\s*\(\s*`(\.{1,2}\/(?:[^`$]*\/)?)\$\{/;
const STRING = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const GLOB_IMPORT = /\bimport\.meta\.glob\s*\(\s*\[?\s*(['"`])([^'"`\n]+)\1/g;
/* A type alone is gone before anything runs, as Vitest's graph knows too. */
const TYPE_ONLY = /^[ \t]*(?:import|export)\s+type\s*(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?=\s+from\b))\s*from\s*(['"])[^'"\n]+\1;?/gm;
const LONGEST_PATH = 300;
/* What takes a package whole because it runs around its tests, so what it imports does too. */
const RUNS_AROUND_TESTS = new Set(['configuration', 'full_package_rule', NAMED_TESTS]);
const VERDICTS_BETWEEN_PAUSES = 16;
const SCANS_BETWEEN_PAUSES = 64;
const READ_BYTES = 64 * 1024 * 1024;

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const isDocument = (path: string): boolean => DOCUMENT.test(path);
const relativeLike = (literal: string): boolean => literal.startsWith('./') || literal.startsWith('../');
const bare = (literal: string): string => literal.replace(/[?#].*$/, '');
const isInside = (path: string, folder: string): boolean => folder === '.' || path === folder || path.startsWith(`${folder}/`);
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
  holdsData(path: string): boolean { return DATA.test(path) || (posix.extname(path) === '' && this.modes.get(path) !== '100755'); }
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
    return digest([...new Set(files)].sort(lexical).map(path => [path, this.modes.get(path) ?? '', this.oids.get(path) ?? '']));
  }
  /* A workspace package as what imports it reaches: its code and not its tests. */
  packageCode(root: string): string[] { return this.under(root).filter(path => !TEST_FOLDER.test(path)); }
  matching(patterns: string[]): string[] { return this.paths.filter(path => patterns.some(pattern => matchesPattern(path, pattern))); }
  rootOf(path: string): string { return this.roots.find(root => isInside(path, root)) ?? '.'; }
  /* Where a file this cannot follow may lead: its package, or the folder of its own of a file no package holds, as the updater's
     script, which would otherwise tie whatever reaches it to every file of the repository. A file at the top may lead anywhere. */
  reachableFrom(path: string): string { return this.roots.find(root => isInside(path, root)) ?? posix.dirname(path); }
  isRoot(folder: string): boolean { return this.roots.includes(folder); }
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
  /* A built path leads to what it is built from. A built file of code comes from the source of its name in src beside the built
     folder, as TypeScript builds src into dist, when the build reads that source; the built folder, and a built file of no such
     source, come from all the build reads. */
  builtFrom(path: string): string[] | undefined {
    const artifact = this.artifacts.find(item => isInside(path, item.path));
    if (!artifact) return undefined;
    let found = this.built.get(artifact.path);
    if (!found) { found = this.matching(artifact.inputs); this.built.set(artifact.path, found); }
    const named = path !== artifact.path && SOURCE_OF_BUILT[posix.extname(path)];
    const source = named ? this.resolve(posix.join(posix.dirname(artifact.path), 'src', posix.relative(artifact.path, path))) : undefined;
    return source && found.includes(source) ? [source] : found;
  }
}

/* An import names a file, a package of the repository or a package installed from its lockfile. Anything else, as a path
   alias, is something this cannot follow. */
function importedFile(tree: Tree, from: string, specifier: string): string[] | null {
  const target = posix.join(posix.dirname(from), specifier), found = tree.resolve(target);
  return found ? [found] : tree.builtFrom(target) ?? null;
}
function importedPackage(tree: Tree, specifier: string): string[] | null {
  const name = packageName(specifier), root = tree.workspaces.get(name);
  if (root) return tree.packageCode(root);
  return tree.declared.has(name) ? [] : null;
}
function importedBy(tree: Tree, from: string, literal: string): string[] | null {
  const specifier = bare(literal);
  if (relativeLike(specifier) || specifier === '.' || specifier === '..') return importedFile(tree, from, specifier);
  if (specifier.startsWith('node:')) return [];
  if (specifier.startsWith('/') || specifier.includes(':')) return null;
  return importedPackage(tree, specifier);
}

/* One file a piece of code reads by name, or the many that a folder, a pattern or a package's name stands for. */
type Named = { file: string[]; many: string[] };
const oneFile = (file: string[]): Named => ({ file, many: [] });
const manyFiles = (many: string[]): Named => ({ file: [], many });

function relativeNamed(tree: Tree, from: string, literal: string): Named {
  const target = posix.join(posix.dirname(from), literal);
  if (literal.includes('*')) return manyFiles(tree.paths.filter(path => matchesGlob(path, target)));
  const found = tree.resolve(target);
  if (found) return oneFile([found]);
  const built = tree.builtFrom(target);
  if (built) return manyFiles(built);
  /* A folder by name. A path of dots alone is where a file is, not what it reads. */
  return manyFiles(/(?:^|\/)\.\.?\/?$/.test(literal) ? [] : tree.under(target));
}

const couldBePath = (text: string): boolean => text.length > 0 && text.length <= LONGEST_PATH && !/\$\{| |\n/.test(text);
/* A folder has a folder in its path, and a package's own folder says which package, as its name does. A word, an address like /x
   and a type like text/plain say no folder of the tree. */
const FOLDER = /^[^/*]+(?:\/[^/*]+)+\/?$/;
const PATTERN = /^(?=.*\/)(?=.*\*)(?=.*[^/*]).*$/;
function namedFolder(tree: Tree, text: string, inPackage: string): string[] {
  if (!FOLDER.test(text)) return [];
  return [text, inPackage].map(folder => folder.replace(/\/$/, '')).filter(folder => !tree.isRoot(folder)).flatMap(folder => tree.under(folder));
}
/* A pattern outside a test is mostly a rule about paths, as the selector's rules are, and only a test reads what it names. */
function namedPattern(tree: Tree, text: string, inPackage: string): string[] {
  const patterns = text.startsWith('*') ? [inPackage] : [text, inPackage];
  return tree.paths.filter(path => (!isDocument(path) || text.endsWith('.md')) && patterns.some(pattern => matchesGlob(path, pattern)));
}
/* A path named in the code, as for a file read from disk: relative, from the package or from the repository. */
function namedBy(tree: Tree, from: string, literal: string): Named {
  const text = bare(literal);
  if (!couldBePath(text)) return oneFile([]);
  if (relativeLike(text)) return relativeNamed(tree, from, text);
  const workspace = tree.workspaces.get(packageName(text));
  if (workspace) return manyFiles(tree.packageCode(workspace));
  const inPackage = posix.join(tree.rootOf(from), text), found = [text, inPackage].filter(path => tree.oids.has(path));
  if (found.length) return oneFile(found);
  if (PATTERN.test(text)) return manyFiles(TEST_FOLDER.test(from) ? namedPattern(tree, text, inPackage) : []);
  return manyFiles(tree.builtFrom(inPackage) ?? namedFolder(tree, text, inPackage));
}

function globImports(tree: Tree, from: string, text: string): string[] {
  return [...text.matchAll(GLOB_IMPORT)].flatMap(([, , literal]) => namedPattern(tree, literal!, posix.join(tree.rootOf(from), literal!)));
}
function scanCode(tree: Tree, from: string, source: string): Scan {
  const runs = new Set<string>(), many = new Set<string>(), text = source.replace(TYPE_ONLY, '');
  let opaque = false;
  for (const call of text.matchAll(COMPUTED_CALLS)) {
    const prefix = FOLDER_TEMPLATE.exec(text.slice(call.index!))?.[1];
    const held = prefix ? tree.under(posix.join(posix.dirname(from), prefix).replace(/\/$/, '')) : [];
    /* A folder with nothing in it tells nothing about what the call loads, so it stays unreadable as any computed import. */
    if (held.length) for (const path of held) many.add(path);
    else opaque = true;
  }
  for (const pattern of [STATEMENT, BARE_IMPORT, CALLED]) for (const [, , literal] of text.matchAll(pattern)) {
    /* A template with a hole is a computed import, read above. */
    if (literal!.includes('${')) continue;
    const found = importedBy(tree, from, literal!);
    if (found) for (const path of found) runs.add(path);
    else opaque = true;
  }
  for (const [, , literal] of text.matchAll(STRING)) {
    const named = namedBy(tree, from, literal!);
    for (const path of named.file) runs.add(path);
    for (const path of named.many) many.add(path);
  }
  for (const path of globImports(tree, from, text)) many.add(path);
  runs.delete(from); many.delete(from);
  return { edges: [...new Set([...runs, ...many])], runs: [...runs], opaque };
}
function scanFile(tree: Tree, path: string): Scan {
  if (!tree.isRegular(path)) return { edges: [], runs: [], opaque: true };
  /* A fixture of a test folder may be a program too, and the selector takes its package whole whenever it changes. */
  if (!CODE.test(path)) return { edges: [], runs: [], opaque: !tree.holdsData(path) && !TEST_FOLDER.test(path) };
  const text = tree.input.texts.get(path);
  return text === undefined ? { edges: [], runs: [], opaque: true } : scanCode(tree, path, text);
}

/* Groups of files that import each other, what they import first: Tarjan's algorithm, on its own stack as imports run deep. */
class Components {
  readonly found: string[][] = [];
  private readonly order = new Map<string, number>();
  private readonly low = new Map<string, number>();
  private readonly open = new Set<string>();
  private readonly stack: string[] = [];
  private readonly work: { path: string; edges: string[]; next: number }[] = [];
  constructor(private readonly edgesOf: (path: string) => string[]) {}
  private enter(path: string): void {
    this.order.set(path, this.order.size); this.low.set(path, this.order.get(path)!);
    this.stack.push(path); this.open.add(path);
    this.work.push({ path, edges: this.edgesOf(path), next: 0 });
  }
  private lower(path: string, value: number): void { this.low.set(path, Math.min(this.low.get(path)!, value)); }
  private close(path: string): void {
    const group: string[] = [];
    let member: string;
    do { member = this.stack.pop()!; this.open.delete(member); group.push(member); } while (member !== path);
    this.found.push(group);
  }
  private leave(path: string): void {
    this.work.pop();
    if (this.work.length) this.lower(this.work.at(-1)!.path, this.low.get(path)!);
    if (this.low.get(path) === this.order.get(path)) this.close(path);
  }
  private step(): void {
    const top = this.work.at(-1)!, edge = top.edges[top.next++];
    if (edge === undefined) this.leave(top.path);
    else if (!this.order.has(edge)) this.enter(edge);
    else if (this.open.has(edge)) this.lower(top.path, this.order.get(edge)!);
  }
  walkFrom(start: string): void {
    if (this.order.has(start)) return;
    this.enter(start);
    while (this.work.length) this.step();
  }
}
function components(starts: string[], edgesOf: (path: string) => string[]): string[][] {
  const groups = new Components(edgesOf);
  for (const start of starts) groups.walkFrom(start);
  return groups.found;
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
  /* What a file reads itself. */
  reads(path: string): string[] { return this.scan(path).edges; }
  async scanAll(pause: Pause): Promise<void> {
    for (const [index, path] of this.tree.paths.entries()) {
      this.scan(path);
      if ((index + 1) % SCANS_BETWEEN_PAUSES === 0) await pause();
    }
  }
  private addGroup(group: string[]): void {
    const members = new Set(group), imported = new Set<string>(), opaque = new Set<string>();
    for (const member of group) {
      const scan = this.scan(member);
      if (scan.opaque) opaque.add(this.tree.reachableFrom(member));
      for (const edge of scan.edges) {
        if (members.has(edge)) continue;
        const reach = this.reaches.get(edge)!;
        imported.add(reach.digest);
        for (const root of reach.opaque) opaque.add(root);
      }
    }
    const reach = { digest: digest([this.tree.pairsDigest(group), [...imported].sort(lexical)]), opaque: [...opaque] };
    for (const member of group) this.reaches.set(member, reach);
  }
  /* What these files reach together. */
  reachOf(starts: string[]): Reach {
    if (!this.reaches.size) for (const group of components(this.tree.paths, path => this.scan(path).edges)) this.addGroup(group);
    const reaches = starts.map(path => this.reaches.get(path)!);
    return { digest: digest([...new Set(reaches.map(reach => reach.digest))].sort(lexical)), opaque: [...new Set(reaches.flatMap(reach => reach.opaque))] };
  }
  private walk(starts: string[], next: (scan: Scan) => string[]): Set<string> {
    const files = new Set<string>(starts), pending = [...files];
    while (pending.length) for (const path of next(this.scan(pending.pop()!))) if (!files.has(path)) { files.add(path); pending.push(path); }
    return files;
  }
  /* The files reached, for the few places that need them by name. */
  closure(starts: string | string[]): Set<string> {
    return this.walk([starts].flat(), scan => scan.edges);
  }
  /* What a configuration runs. It also names folders, packages and test files, to say where tests are, and that ties none of them to the others. */
  ranBy(start: string, tests: ReadonlySet<string> = new Set()): Set<string> {
    return this.walk([start], scan => scan.runs.filter(path => !tests.has(path)));
  }
}

export function testGraph(input: FingerprintInput): { closure: (starts: string | string[]) => Set<string> } {
  return new Graph(new Tree(input));
}

export type Readers = { named: string[]; reached: string[] };
/* The tests that read each of these files, as a fingerprint follows them: those that name it themselves, and all that reach it
   through what they run. A document leads nowhere, but a test that names one by its path reads it. */
export function readersOf(input: FingerprintInput, paths: string[], tests: string[]): Map<string, Readers> {
  const graph = new Graph(new Tree(input)), found = new Map(paths.map(path => [path, { named: [], reached: [] } as Readers]));
  for (const test of tests) {
    const named = graph.reads(test), reached = graph.closure(test);
    for (const [path, readers] of found) {
      if (named.includes(path)) readers.named.push(test);
      if (reached.has(path)) readers.reached.push(test);
    }
  }
  return found;
}

/* Suites of one folder share a package: what the selector takes whole for it, it takes whole for each of them. */
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
  /* A rule that names the tests reading a file narrows what a check of a change runs. A kept result still counts the file for
     the whole of their suites: other tests may read it through the code they run, and the whole suite is what catches them. */
  const taken = selection.packages.filter(item => item.mode === 'whole-package' || item.reasons.some(reason => reason.code === NAMED_TESTS));
  return { packages: taken.map(item => item.packageId), expands: taken.some(item => item.reasons.some(reason => RUNS_AROUND_TESTS.has(reason.code))) };
}

/* What runs around a package's tests counts with what it runs: a file of the repository's own, or of that package. A rule may also
   give a package a file of another one, and that file then counts by itself, or a tool of one package would tie all the others to
   what it imports. So does a source given to every scenario: the scenarios follow every screen already, and all the screens that
   source imports would tie any other suite of its folder to all of them. */
function countsWith(graph: Graph, units: ReadonlySet<string>): (path: string, verdict: Verdict, id: string) => string[] {
  const { tree } = graph, scenarios = tree.input.description.manifest.suites.flatMap(suite => suite.scenarioSources ?? []);
  return (path, verdict, id) => {
    const owner = tree.rootOf(path), around = verdict.expands && !scenarios.some(folder => isInside(path, folder)) && (owner === '.' || owner === id);
    return around ? [...graph.ranBy(path, units)].filter(file => !isDocument(file)) : [path];
  };
}
function verdictsBy(environment: ImpactEnvironment, kept: Map<string, Verdict>, pause: Pause): (path: string) => Promise<Verdict> {
  let asked = 0;
  return async path => {
    const known = kept.get(path);
    if (known) return known;
    const verdict = verdictOn(environment, path);
    kept.set(path, verdict);
    if (++asked % VERDICTS_BETWEEN_PAUSES === 0) await pause();
    return verdict;
  };
}
/* What the selector says the graph cannot see, per package: for each tracked file, whether it takes a package whole. A file that is a
   test itself changes only itself, and a document changes nothing. */
async function outOfGraph(graph: Graph, pause: Pause): Promise<Map<string, string>> {
  const { tree } = graph, { manifest, inventory } = tree.input.description, packages = packagesOf(manifest);
  const units = new Set(inventory.map(unit => unit.file)), counted = countsWith(graph, units);
  const verdictOf = verdictsBy({ packages, impact: manifest.impact, inventory: [] }, keptVerdicts(digest([packages, manifest.impact])), pause);
  const found = new Map<string, string[]>(packages.map(item => [item.id, []]));
  for (const path of tree.paths) {
    if (isDocument(path) || units.has(path)) continue;
    const verdict = await verdictOf(path);
    for (const id of verdict.packages) found.get(id)!.push(...counted(path, verdict, id));
  }
  return new Map([...found].map(([id, files]) => [id, tree.pairsDigest(files)]));
}

/* A runtime counts by its class, which any machine of that class shares; one that does not name its system, by its very build. */
function versionOf(description: FingerprintInput['description'], id: string): unknown[] {
  const runtime = description.runtimeCapabilities.find(runtime => runtime.id === id);
  const kind = runtime && runtimeClass(runtime);
  return kind ? [id, kind] : [id, runtime?.version ?? null, runtime?.fingerprint ?? null];
}
/* A service counts for a suite only where they share every profile, so a suite that may run without it keeps its results. */
const servicesOf = (manifest: Manifest, suite: Suite | null) => manifest.services.filter(service => suite === null || suite.profiles.every(profile => service.profiles.includes(profile)));
/* The classes of the runtimes and not the machines. */
function runtimesOf(description: FingerprintInput['description'], suite: Suite | null): unknown {
  const { manifest } = description, services = new Set(manifest.services.map(service => service.runtime));
  const needed = servicesOf(manifest, suite).map(service => service.runtime);
  const own = manifest.runtimes.filter(runtime => !services.has(runtime.id)).map(runtime => runtime.id);
  const ids = [...new Set([...own, ...needed, ...(manifest.execution ? ['hornhoof-test-execution'] : [])])].sort(lexical);
  return ids.map(id => versionOf(description, id));
}

/* How what a suite starts from is made: a preparation of any profile it runs in, its services and a reset that names it. */
function madeFor(manifest: Manifest, suite: Suite): unknown {
  return {
    prepare: manifest.prepare.filter(unit => unit.profiles.some(profile => suite.profiles.includes(profile))),
    services: servicesOf(manifest, suite),
    reset: (manifest.reset ?? []).filter(reset => reset.suiteIds.includes(suite.id)),
  };
}

/* What a test file reads, and where it reaches something it cannot follow, the whole of its package and of that file's. */
function inputsOf(graph: Graph, suite: Suite, starts: string[]): unknown {
  const { digest: reached, opaque } = graph.reachOf(starts);
  return opaque.length ? [reached, [...new Set([suite.root, ...opaque])].sort(lexical).map(root => graph.tree.folderDigest(root))] : reached;
}
function testInputs(graph: Graph, suite: Suite, file: string): unknown {
  const { tree } = graph;
  if (!CODE.test(file) || suite.split.kind === 'whole-package') return tree.folderDigest(suite.root);
  /* A scenario opens the app and drives it, so whatever screen the app may show on the way can break it, whatever it is named after. */
  return inputsOf(graph, suite, suite.scenarioSources ? [file, ...tree.under(suite.scenarioSources)] : [file]);
}

type Supported = Extract<Manifest['mutation'], { status: 'supported' }>;
const reachingTests = (graph: Graph, mutation: Supported, file: string): string[] => graph.tree.matching(mutation.fastTestPaths).filter(test => graph.closure(test).has(file));
/* What each source file's mutants run against. The fingerprint below reads the same tests, so it changes when what judges them does. */
export function fastTestsOf(input: FingerprintInput, mutation: Supported, files: string[]): Map<string, string[]> {
  const graph = new Graph(new Tree(input));
  return new Map(files.map(file => [file, reachingTests(graph, mutation, file)]));
}

/* The parser is needed only by a mutation planner in the prepared check environment. Ordinary descriptions do not load it. */
export async function selectPureMutations(input: FingerprintInput, mutation: Supported, delta: MutationDelta): Promise<MutationSelection> {
  const { selectMutationFunctions } = await import('./test-impact-mutation.js');
  return selectMutationFunctions(input, mutation, delta, testGraph(input), fastTestsOf(input, mutation, mutation.sourcePaths));
}
/* The same transitive judges for the server's result cache and the mutator's saved snapshot. An unreadable input widens
   through inputsOf to the repository: an unknown helper or executable configuration may read across package boundaries. */
function mutationJudges(graph: Graph, mutation: Supported, suite: Suite, file: string): string {
  const { tree } = graph, config = `${suite.root}/vitest.config.mjs`;
  const starts = [file, ...reachingTests(graph, mutation, file), ...(tree.oids.has(config) ? [config] : [])];
  const installed = tree.pairsDigest(tree.matching(tree.input.description.manifest.dependencies.inputs));
  return digest([FORMAT, mutation.tool, suite.run, installed, tree.folderDigest(suite.root), inputsOf(graph, { ...suite, root: '.' }, starts)]);
}
export function mutationJudgesOf(input: FingerprintInput, mutation: Supported, suite: Suite, files: string[]): Map<string, string> {
  const graph = new Graph(new Tree(input));
  return new Map(files.map(file => [file, mutationJudges(graph, mutation, suite, file)]));
}
function mutationPrint(graph: Graph, mutation: Supported, suite: Suite, environment: string, file: string): string {
  return digest([environment, mutationJudges(graph, mutation, suite, file)]);
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
  const installed = { inputs: inputDigests.filter(item => manifest.dependencies.inputs.some(pattern => matchesPattern(item.path, pattern))), commands: manifest.dependencies.install, env: manifest.dependencies.env ?? {}, bin: manifest.dependencies.bin ?? [] };
  const environments = new Map(manifest.suites.map(suite => [suite.id, digest([runtimesOf(description, suite), installed, madeFor(manifest, suite), suite.id, suite.run, suite.split])]));
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

/* Mutation applicability comes from changed source lines and safe fast judges, not from a file-level fingerprint. */
export async function readCandidateMutations(source: Parameters<typeof readCommit>[0], scope: RepositoryScope, description: EnvironmentDescription, baseCommit: string, context: CacheContext): Promise<{ delta: MutationDelta; selection: MutationSelection } | undefined> {
  const { mutation } = description.manifest;
  if (mutation.status !== 'supported') return undefined;
  const delta = await readMutationDelta(source, scope, baseCommit, description.commitSha, mutation.sourcePaths, context);
  const tree = await readCommit(source, scope, description.commitSha, context);
  const texts = await tree.readTexts(codeFilesOf(tree.entries), READ_BYTES);
  const selection = await selectPureMutations({ description, tracked: tree.entries, texts }, mutation, delta);
  return { delta, selection };
}
