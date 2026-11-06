import { matchesGlob } from 'node:path';
import type { Command, TestEnvironmentV1, TestSuite } from '@hornhoof/protocol';
import type { CommitTree } from './test-mirror.js';

type Tracked = Pick<CommitTree, 'entries' | 'readBlob'>;

/* What a repository's own files say of how its tests run, for a repository that describes nothing itself: the system brings
   its test environment up by its language, and nobody has to write a manifest for it to start. A suite covers the whole
   package, as only the repository's own command knows what its tests are. */
const FILE_LIMIT = 1024 * 1024;
const MAX_FOLDERS = 256;
const PYTHON_TARGET = '.hornhoof/python';
const PIP_TOOL = '.hornhoof/pip';
const REQUIREMENTS = ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt', 'test-requirements.txt'];
/* These are recognized, but a machine has nothing to run them with. */
const NO_TOOLCHAIN: [string, string[]][] = [['Go', ['go.mod']], ['Rust', ['Cargo.toml']], ['PHP', ['composer.json']], ['Ruby', ['Gemfile']], ['Java', ['pom.xml', 'build.gradle', 'build.gradle.kts']]];

export class DiscoveryProblem extends Error {
  constructor(readonly code: 'environment_missing' | 'environment_invalid' | 'environment_unsupported', detail: string) { super(detail); }
}

type Language = { adapter: string; language: string; inputs: string[]; install: Command[]; paths: string[]; env?: Record<string, string>; suite: Pick<TestSuite, 'id' | 'run' | 'files'> };
type Manager = { adapter: string; lock: string; install: string[] };
type PackageFile = { scripts?: Record<string, unknown>; workspaces?: unknown };

const at = (program: string, ...args: string[]): Command => ({ program, args, cwd: '.' });

function lockedManager(tracked: Set<string>, yarnLock: () => Promise<string>): Promise<Manager | null> {
  if (tracked.has('package-lock.json')) return Promise.resolve({ adapter: 'npm', lock: 'package-lock.json', install: ['npm', 'ci', '--no-audit', '--no-fund'] });
  if (tracked.has('pnpm-lock.yaml')) return Promise.resolve({ adapter: 'pnpm', lock: 'pnpm-lock.yaml', install: ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--package-import-method=copy'] });
  if (!tracked.has('yarn.lock')) return Promise.resolve(null);
  return yarnLock().then(text => ({ adapter: 'yarn', lock: 'yarn.lock', install: ['corepack', 'yarn', 'install', text.includes('yarn lockfile v1') ? '--frozen-lockfile' : '--immutable'] }));
}

function workspacePatterns(pkg: PackageFile, pnpm: string | null): string[] {
  if (pnpm !== null) return [...pnpm.matchAll(/^\s*-\s*['"]?([^'"#\s]+)/gm)].map(found => found[1]!);
  const { workspaces } = pkg, list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

function workspaceFolders(tree: Tracked, patterns: string[]): string[] {
  const positive = patterns.filter(pattern => !pattern.startsWith('!')).map(pattern => pattern.replace(/\/$/, ''));
  const folders = tree.entries.flatMap(entry => (entry.path.endsWith('/package.json') && !entry.path.includes('node_modules/') ? [entry.path.slice(0, -'/package.json'.length)] : []))
    .filter(folder => positive.some(pattern => matchesGlob(folder, pattern)));
  if (folders.length > MAX_FOLDERS) throw new DiscoveryProblem('environment_unsupported', `This repository has ${folders.length} workspace packages, more than can be described by itself. Describe it in .hornhoof/test-environment.json.`);
  return folders;
}

async function readJson(tree: Tracked, path: string): Promise<PackageFile> {
  try {
    const value: unknown = JSON.parse((await tree.readBlob(path, FILE_LIMIT)).toString('utf8'));
    if (value && typeof value === 'object') return value as PackageFile;
  } catch { /* Said below. */ }
  throw new DiscoveryProblem('environment_invalid', `${path} cannot be read.`);
}

async function nodeLanguage(tree: Tracked, tracked: Set<string>): Promise<Language | null> {
  if (!tracked.has('package.json')) return null;
  const read = async (path: string) => (await tree.readBlob(path, FILE_LIMIT)).toString('utf8');
  const manager = await lockedManager(tracked, () => read('yarn.lock'));
  if (!manager) throw new DiscoveryProblem('environment_unsupported', 'This repository has package.json and no lock file, so what it installs could change from one machine to the next. Commit a lock file.');
  const pkg = await readJson(tree, 'package.json');
  const folders = workspaceFolders(tree, workspacePatterns(pkg, manager.adapter === 'pnpm' && tracked.has('pnpm-workspace.yaml') ? await read('pnpm-workspace.yaml') : null));
  const paths = ['node_modules', ...folders.map(folder => `${folder}/node_modules`)];
  const [program, ...args] = manager.install as [string, ...string[]];
  const optional = ['.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml'].filter(path => tracked.has(path));
  return {
    adapter: manager.adapter, language: 'javascript',
    inputs: ['package.json', manager.lock, ...optional, ...folders.map(folder => `${folder}/package.json`)],
    /* An install leaves no folder where a package needs nothing of its own; a tree stores what is declared. */
    install: [at(program, ...args), at('mkdir', '-p', ...paths)],
    paths,
    suite: { id: 'javascript', files: ['package.json'], run: at('npm', 'test', ...(typeof pkg.scripts?.test !== 'string' && folders.length ? ['--workspaces'] : [])) },
  };
}

const PYPROJECT_REQUIREMENTS = String.raw`import tomllib
p = tomllib.load(open('pyproject.toml', 'rb')).get('project', {})
wanted = p.get('dependencies', []) + sum(p.get('optional-dependencies', {}).values(), [])
open('.hornhoof/requirements.txt', 'w').write('\n'.join(wanted))`;

function pythonLanguage(tree: Tracked, tracked: Set<string>): Language | null {
  const files = REQUIREMENTS.filter(path => tracked.has(path)), pyproject = tracked.has('pyproject.toml');
  if (!files.length && !pyproject) return null;
  const inputs = files.length ? files : ['pyproject.toml'];
  const wanted = files.length ? files.flatMap(path => ['-r', path]) : ['-r', '.hornhoof/requirements.txt'];
  const src = tree.entries.some(entry => entry.path.startsWith('src/') && entry.path.endsWith('.py'));
  return {
    adapter: 'pip', language: 'python', inputs,
    /* pip comes from a tool folder that is left behind, and packages go where any path can find them. */
    install: [at('python3', '-m', 'venv', PIP_TOOL), ...(files.length ? [] : [at('python3', '-c', PYPROJECT_REQUIREMENTS)]), at(`${PIP_TOOL}/bin/python`, '-m', 'pip', 'install', '--no-cache-dir', '--target', PYTHON_TARGET, ...wanted, 'pytest')],
    paths: [PYTHON_TARGET],
    env: { PYTHONPATH: PYTHON_TARGET },
    suite: { id: 'python', files: inputs.slice(0, 1), run: at('python3', '-m', 'pytest', ...(src ? ['-o', 'pythonpath=src'] : [])) },
  };
}

function manifestOf(languages: Language[]): TestEnvironmentV1 {
  const suites = languages.map((language): TestSuite => ({ ...language.suite, root: '.', split: { kind: 'whole-package' }, profiles: ['default'] }));
  const env = Object.assign({}, ...languages.map(language => language.env ?? {})) as Record<string, string>;
  return {
    version: 1, defaultProfile: 'default', runtimes: [],
    profiles: [{ id: 'default', requiredSuiteIds: suites.map(suite => suite.id) }],
    dependencies: { adapter: languages.map(language => language.adapter).join('.'), inputs: languages.flatMap(language => language.inputs), install: languages.flatMap(language => language.install), paths: languages.flatMap(language => language.paths), cache: 'link', ...(Object.keys(env).length ? { env } : {}) },
    services: [], prepare: [], reset: null, suites,
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'The system found this environment by itself and knows of no migration check.' } },
    mutation: { status: 'unsupported', language: languages[0]!.language, reason: 'The system found this environment by itself and names no mutation tool.' },
  };
}

export async function discoverEnvironment(tree: Tracked): Promise<TestEnvironmentV1> {
  const tracked = new Set(tree.entries.map(entry => entry.path));
  const languages = [await nodeLanguage(tree, tracked), pythonLanguage(tree, tracked)].filter((language): language is Language => language !== null);
  if (languages.length) return manifestOf(languages);
  const unsupported = NO_TOOLCHAIN.find(([, files]) => files.some(file => tracked.has(file)));
  if (unsupported) throw new DiscoveryProblem('environment_unsupported', `This repository is in ${unsupported[0]}, and machines have no ${unsupported[0]} tools yet. They need adding to the machines' image, or the repository can describe its own environment in .hornhoof/test-environment.json.`);
  throw new DiscoveryProblem('environment_missing', 'No test environment exists at the pinned commit: it describes none in .hornhoof/test-environment.json, and no language Hornhoof knows was found in it.');
}
