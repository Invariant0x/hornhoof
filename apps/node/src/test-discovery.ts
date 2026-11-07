import { createHash } from 'node:crypto';
import { dirname, matchesGlob, posix } from 'node:path';
import { TEST_ENVIRONMENT_BYTES, type Command, type TestArtifact, type TestEnvironmentV1, type TestPrepare, type TestSuite } from '@hornhoof/protocol';
import type { CommitTree } from './test-mirror.js';
import { makeTool, RUBY_PACKAGES, TOOL_ORDER, type Tool, type ToolAsk, type ToolId } from './test-tools.js';

type Tracked = Pick<CommitTree, 'entries' | 'readBlob'>;

/* What a repository's own files say of how its tests run, for a repository that describes nothing itself: the system brings its
   test environment up by what it finds, and nobody has to write a manifest for it to start. A repository may hold several
   programs, in one language or many: each gets a unit of its own, so a changed lock file rebuilds that one, and a suite of its
   own. A language's tools go first, apart from any program, so a changed lock file leaves them alone. */
const FILE_LIMIT = 16 * 1024 * 1024;
const REQUIREMENTS = ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt', 'test-requirements.txt'];
/* What holds other people's code, or examples of it, and no program of this repository. */
const NOT_A_PROGRAM = /(?:^|\/)(?:node_modules|vendor|third[-_]party|testdata|fixtures|__fixtures__|examples?|samples?|templates|docs?|\.hornhoof)\//;

export class DiscoveryProblem extends Error {
  constructor(readonly code: 'environment_missing' | 'environment_invalid' | 'environment_unsupported', detail: string) { super(detail); }
}

/* One program: all paths but inputs lie under its folder. env: what it finds its downloads by, set for each of its commands.
   idle: it has nothing to test, so its run could only fail. */
type Program = {
  language: string; root: string; inputs: string[]; asks: Ask[];
  steps: string[]; shared: string[]; own?: string[]; env?: Record<string, string>; test: string[]; idle?: boolean;
};
type Ask = { tool: ToolId; version?: string | undefined; packages?: string[]; ownFile?: string };
type Seen = { tree: Tracked; tracked: Set<string>; paths: string[]; named: Map<string, string> };
type Finder = (seen: Seen) => Promise<(Program | Orphan)[]>;
type Orphan = { orphan: string };

const under = (root: string, path: string) => (root === '.' ? path : `${root}/${path}`);
const read = async (seen: Seen, path: string) => (await seen.tree.readBlob(path, FILE_LIMIT)).toString('utf8');
const within = (seen: Seen, root: string, names: string[]) => names.map(name => under(root, name)).filter(path => seen.tracked.has(path));
const folderOf = (path: string) => dirname(path);
const programPaths = (seen: Seen) => seen.paths.filter(path => !NOT_A_PROGRAM.test(`/${path}`));
const foldersWith = (seen: Seen, names: string[]): string[] => [...new Set(programPaths(seen).filter(path => names.includes(posix.basename(path))).map(folderOf))].sort();
const topMost = (folders: string[]): string[] => folders.filter(folder => !folders.some(other => other !== folder && (other === '.' || folder.startsWith(`${other}/`))));
const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const newest = (versions: string[]): string | undefined => versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
const parts = (seen: Seen, root: string, name: string) => seen.paths.filter(path => posix.basename(path) === name && (root === '.' || path.startsWith(`${root}/`)));

function readJson(text: string, path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch { /* Said below. */ }
  throw new DiscoveryProblem('environment_invalid', `${path} cannot be read.`);
}

/* JavaScript: a folder with a lock file is a project; a package of its workspaces is part of it. */
type PackageFile = { scripts?: Record<string, unknown>; workspaces?: unknown };
const LOCKS: [string, string, (text: string) => string][] = [
  ['package-lock.json', 'npm', () => 'npm ci --no-audit --no-fund'],
  ['pnpm-lock.yaml', 'pnpm', () => 'corepack pnpm install --frozen-lockfile --package-import-method=copy'],
  ['yarn.lock', 'yarn', text => `corepack yarn install ${text.includes('yarn lockfile v1') ? '--frozen-lockfile' : '--immutable'}`],
];
function workspacePatterns(pkg: PackageFile, pnpm: string | null): string[] {
  if (pnpm !== null) return [...pnpm.matchAll(/^\s*-\s*['"]?([^'"#\s]+)/gm)].map(found => found[1]!);
  const { workspaces } = pkg, list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}
function workspaceFolders(seen: Seen, root: string, patterns: string[]): string[] {
  const positive = patterns.filter(pattern => !pattern.startsWith('!')).map(pattern => pattern.replace(/\/$/, ''));
  return parts(seen, root, 'package.json').map(path => posix.relative(root, folderOf(path))).filter(folder => folder && !folder.includes('node_modules/') && positive.some(pattern => matchesGlob(folder, pattern)));
}
/* What npm init writes for a project with no tests says so and fails. */
const testScript = (pkg: PackageFile) => (typeof pkg.scripts?.test === 'string' && !pkg.scripts.test.includes('no test specified') ? pkg.scripts.test : null);
async function javascriptProject(seen: Seen, root: string): Promise<Program | Orphan> {
  const lock = LOCKS.find(([file]) => seen.tracked.has(under(root, file)));
  if (!lock) return { orphan: under(root, 'package.json') };
  const pkg = readJson(await read(seen, under(root, 'package.json')), under(root, 'package.json')) as PackageFile;
  const pnpm = lock[1] === 'pnpm' && seen.tracked.has(under(root, 'pnpm-workspace.yaml')) ? await read(seen, under(root, 'pnpm-workspace.yaml')) : null;
  const folders = workspaceFolders(seen, root, workspacePatterns(pkg, pnpm));
  const install = lock[2](lock[1] === 'yarn' ? await read(seen, under(root, lock[0])) : '');
  return {
    language: 'javascript', root, asks: [], steps: [install], shared: ['node_modules', ...folders.map(folder => `${folder}/node_modules`)],
    inputs: [under(root, 'package.json'), under(root, lock[0]), ...within(seen, root, ['.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml']), ...folders.map(folder => under(root, `${folder}/package.json`))],
    test: [`npm test${typeof pkg.scripts?.test !== 'string' && folders.length ? ' --workspaces --if-present' : ''}`], idle: !testScript(pkg) && !folders.length,
  };
}
const javascript: Finder = seen => Promise.all(foldersWith(seen, ['package.json']).map(root => javascriptProject(seen, root))).then(found => {
  /* A workspace package has no lock of its own, and is no project of its own when another holds it. */
  const held = new Set(found.flatMap(item => ('orphan' in item ? [] : item.shared.map(path => folderOf(under(item.root, path))))));
  return found.filter(item => !('orphan' in item) || !held.has(folderOf(item.orphan)));
});

/* Python: pip comes from a tool folder that is left behind, and packages go where any path can find them. */
const PYTHON_TARGET = '.hornhoof/python';
const PYPROJECT_REQUIREMENTS = `mkdir -p .hornhoof
python3 - <<'PYTHON'
import tomllib
p = tomllib.load(open('pyproject.toml', 'rb')).get('project', {})
wanted = p.get('dependencies', []) + sum(p.get('optional-dependencies', {}).values(), [])
open('.hornhoof/requirements.txt', 'w').write('\\n'.join(wanted))
PYTHON`;
const python: Finder = async seen => foldersWith(seen, [...REQUIREMENTS, 'pyproject.toml']).map(root => {
  const files = within(seen, root, REQUIREMENTS), wanted = files.length ? files.flatMap(path => ['-r', posix.relative(root, path)]) : ['-r', '.hornhoof/requirements.txt'];
  const src = seen.paths.some(path => path.startsWith(`${under(root, 'src')}/`) && path.endsWith('.py'));
  const ownPaths = seen.paths.filter(path => (root === '.' || path.startsWith(`${root}/`))).map(path => posix.basename(path));
  return {
    language: 'python', root, asks: [], inputs: files.length ? files : [under(root, 'pyproject.toml')], shared: [PYTHON_TARGET], env: { PYTHONPATH: PYTHON_TARGET },
    steps: ['python3 -m venv "$TMPDIR/pip"', ...(files.length ? [] : [PYPROJECT_REQUIREMENTS]), `"$TMPDIR/pip/bin/python" -m pip install --no-cache-dir --target ${PYTHON_TARGET} ${wanted.join(' ')} pytest`],
    test: [`python3 -m pytest${src ? ' -o pythonpath=src' : ''}`], idle: !ownPaths.some(name => /^(?:test_.*|.*_test|conftest)\.py$/.test(name)),
  };
});

/* Go: 1.21 made the first release of a line its .0; go.mod may name only the line. */
function goVersion(text: string): string | undefined {
  const toolchain = /^toolchain\s+go(\d+\.\d+(?:\.\d+)?)/m.exec(text)?.[1], go = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(text)?.[1];
  const version = toolchain ?? go;
  if (!version || version.split('.').length === 3) return version;
  return Number(version.split('.')[1]) >= 21 ? `${version}.0` : version;
}
const GO_MODULES = String.raw`go list -m -f '{{if not .Main}}{{.Path}}{{end}}' all | while read -r module; do [ -z "$module" ] || go build "$module/..." > /dev/null 2>&1 || true; done`;
const go: Finder = seen => Promise.all(foldersWith(seen, ['go.mod']).map(async root => {
  const file = under(root, 'go.mod'), text = await read(seen, file);
  /* A workspace reads all its modules, and a module can replace a dependency with one beside it. */
  const reaches = seen.tracked.has('go.work') || /=>\s*\.\.\//.test(text), others = reaches ? foldersWith(seen, ['go.mod']).map(folder => under(folder, 'go.mod')).filter(path => path !== file) : [];
  return {
    language: 'go', root, asks: [{ tool: 'go' as const, version: goVersion(text) }],
    inputs: [...within(seen, root, ['go.mod', 'go.sum']), ...within(seen, '.', ['go.work', 'go.work.sum']), ...others],
    env: { GOMODCACHE: '.hornhoof/gomod', GOCACHE: '.hornhoof/gocache' }, shared: ['.hornhoof/gomod', '.hornhoof/gocache'],
    /* What it has compiled stays, with no note of when it last cleaned up: that file is rewritten, and each part gets a new one. */
    steps: ['go mod download', 'go build std', GO_MODULES, 'rm -f "$GOCACHE/trim.txt"'], test: ['go test ./...'],
  };
}));

/* Rust: cargo reads every package before it does anything, and a package needs a source to read, so each gets an empty one. What
   is compiled from those is forgotten at the end, or a run would take it for its code. */
const CARGO_SOURCES = `python3 - "$@" <<'PYTHON'
import os, sys, tomllib
folders = {'bin': 'src/bin', 'example': 'examples', 'test': 'tests', 'bench': 'benches'}
for manifest in sys.argv[1:]:
    top = os.path.dirname(manifest) or '.'
    data = tomllib.load(open(manifest, 'rb'))
    wanted = [target.get('path') or f"{folder}/{target['name']}.rs" for kind, folder in folders.items() for target in data.get(kind, [])]
    if data.get('lib', {}).get('path'): wanted.append(data['lib']['path'])
    if 'package' in data: wanted.append('src/lib.rs')
    for path in wanted:
        full = os.path.join(top, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        open(full, 'a').close()
PYTHON`;
const RUST_STEPS = (manifests: string[]) => [
  `set -- ${manifests.map(quoted).join(' ')}`, CARGO_SOURCES, 'cargo fetch --locked',
  'cargo build --locked --tests --keep-going || echo "Some packages did not compile yet: a run compiles them itself."',
  'metadata="$(cargo metadata --locked --format-version=1)"',
  String.raw`printf '%s' "$metadata" | jq -r '.packages[] | select(.source == null) | "\(.name)@\(.version)"' | while read -r own; do cargo clean --locked -p "$own"; done`,
  'rm -f "$CARGO_HOME/.package-cache" "$CARGO_HOME/.package-cache-mutate" "$CARGO_HOME/.global-cache"', 'rm -rf "$CARGO_HOME/git/checkouts"',
];
const rustFiles = ['rust-toolchain.toml', 'rust-toolchain'];
const rust: Finder = seen => Promise.all(topMost(foldersWith(seen, ['Cargo.toml'])).map(async root => {
  const lock = under(root, 'Cargo.lock'), own = parts(seen, root, 'Cargo.toml'), ownFile = within(seen, root, rustFiles)[0];
  if (!seen.tracked.has(lock)) return { orphan: under(root, 'Cargo.toml') };
  /* A crate outside its folder is read like its own, by every project that reaches for one. */
  const reaches = root !== '.' && (await Promise.all(own.map(path => read(seen, path)))).some(text => /path\s*=\s*"\.\.\//.test(text));
  const manifests = reaches ? parts(seen, '.', 'Cargo.toml') : own, local = manifests.map(path => posix.relative(root, path));
  return {
    language: 'rust', root, asks: [{ tool: 'rust' as const, ...(ownFile ? { ownFile } : {}) }],
    inputs: [under(root, 'Cargo.toml'), lock, ...within(seen, root, ['.cargo/config.toml']), ...manifests.filter(path => path !== under(root, 'Cargo.toml'))],
    env: { CARGO_HOME: '.hornhoof/cargo' }, shared: ['.hornhoof/cargo'], own: ['target'], steps: RUST_STEPS(local), test: ['cargo test --locked'],
  };
}));

/* Java: the newest version any file of the project names, in whichever way it is written. */
const JAVA_NAMES = [/<maven\.compiler\.(?:release|source)>([\d.]+)</g, /<java\.version>([\d.]+)</g, /<release>([\d.]+)</g, /JavaLanguageVersion\.of\((\d+)\)/g, /(?:source|target)Compatibility\s*=\s*(?:JavaVersion\.VERSION_|["']?)([\d._]+)/g];
function javaFeature(text: string): string | undefined {
  const found = /(\d+)(?:\.(\d+))?/.exec(text);
  return found?.[1] === '1' ? found[2] : found?.[1];
}
const javaIn = (texts: string[]) => newest(texts.flatMap(text => JAVA_NAMES.flatMap(name => [...text.matchAll(name)].map(found => javaFeature(found[1]!.replaceAll('_', '.')))).filter((version): version is string => !!version)));
const javaAsk = async (seen: Seen, paths: string[], root: string) => {
  const files = [...paths, ...within(seen, root, ['.java-version'])], versionFile = within(seen, root, ['.java-version'])[0];
  const own = versionFile ? javaFeature(await read(seen, versionFile)) : undefined;
  return own ?? javaIn(await Promise.all(files.map(path => read(seen, path))));
};
const MAVEN_STEPS = [
  /* A test of nothing, so what runs tests is downloaded too: Maven asks for it only when it finds a test folder. */
  `find . -name pom.xml -not -path './.hornhoof/*' | while read -r pom; do folder="$(dirname "$pom")/src/test/java"; mkdir -p "$folder"; echo 'class HornhoofPreparedTest {}' > "$folder/HornhoofPreparedTest.java"; done`,
  'mvn -B -ntp -q -Dmaven.test.failure.ignore=true test || echo "Some of it did not come down: a run takes it itself."',
];
const maven: Finder = seen => Promise.all(topMost(foldersWith(seen, ['pom.xml'])).map(async root => {
  const poms = parts(seen, root, 'pom.xml'), wrapper = under(root, '.mvn/wrapper/maven-wrapper.properties');
  const version = seen.tracked.has(wrapper) ? /apache-maven-(\d+\.\d+\.\d+)-bin/.exec(await read(seen, wrapper))?.[1] : undefined;
  return {
    language: 'java', root, asks: [{ tool: 'java' as const, version: await javaAsk(seen, poms, root) }, { tool: 'maven' as const, version }],
    inputs: [under(root, 'pom.xml'), ...poms.filter(path => path !== under(root, 'pom.xml')), ...seen.paths.filter(path => path.startsWith(`${under(root, '.mvn')}/`))],
    env: { HORNHOOF_MAVEN_REPOSITORY: '.hornhoof/m2' }, shared: ['.hornhoof/m2'], steps: MAVEN_STEPS, test: ['mvn -B -ntp test'],
  };
}));
const GRADLE_FILES = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
const GRADLE_RESOLVE = `cat > "$TMPDIR/resolve.gradle" <<'GRADLE'
allprojects { tasks.register('hornhoofResolve') { doLast { project.configurations.findAll { it.canBeResolved }.each { try { it.resolve() } catch (Exception e) { logger.warn(e.message) } } } } }
GRADLE`;
const GRADLE_STEPS = [
  /* It builds with a folder of its own, and every part reads what came down from it, read-only, as Gradle provides for. */
  'unset GRADLE_RO_DEP_CACHE', 'export GRADLE_USER_HOME="$PWD/.hornhoof/gradle"', GRADLE_RESOLVE,
  'gradle --no-daemon --no-configuration-cache --init-script "$TMPDIR/resolve.gradle" hornhoofResolve || echo "Some of it did not come down: a run takes it itself."',
  'mkdir -p .hornhoof/gradle/caches/modules-2', "find .hornhoof/gradle/caches -mindepth 1 -maxdepth 1 ! -name modules-2 -exec rm -rf {} +", "find .hornhoof/gradle/caches -name '*.lock' -delete", 'rm -f .hornhoof/gradle/caches/modules-2/gc.properties',
];
const gradle: Finder = seen => Promise.all(topMost(foldersWith(seen, GRADLE_FILES)).map(async root => {
  const builds = GRADLE_FILES.flatMap(name => parts(seen, root, name)), wrapper = under(root, 'gradle/wrapper/gradle-wrapper.properties');
  const version = seen.tracked.has(wrapper) ? /gradle-([\d.]+)-(?:bin|all)\.zip/.exec(await read(seen, wrapper))?.[1] : undefined;
  return {
    language: 'java', root, asks: [{ tool: 'java' as const, version: await javaAsk(seen, builds, root) }, { tool: 'gradle' as const, version }],
    inputs: [...builds, ...within(seen, root, ['gradle.properties']), ...seen.paths.filter(path => path.startsWith(`${under(root, 'gradle')}/`) || path.startsWith(`${under(root, 'buildSrc')}/`))],
    env: { GRADLE_RO_DEP_CACHE: '.hornhoof/gradle/caches' }, shared: ['.hornhoof/gradle/caches'], steps: GRADLE_STEPS, test: ['gradle --no-daemon test'],
  };
}));

/* PHP: a class map names classes that are not there at install, so a project that keeps one writes it again before a run. */
type ComposerFile = { scripts?: Record<string, unknown>; config?: { platform?: { php?: unknown } }; require?: Record<string, unknown>; autoload?: { classmap?: unknown[] }; 'autoload-dev'?: { classmap?: unknown[] } };
function phpVersion(composer: ComposerFile, own: string | null): string | undefined {
  const platform = composer.config?.platform?.php;
  if (typeof platform === 'string') return platform;
  if (own) return own.trim();
  return /^(?:~|=)?(\d+\.\d+)(?:\.\*|\.\d+)$/.exec(typeof composer.require?.php === 'string' ? composer.require.php : '')?.[1];
}
const CLASS_MAP = 'rm -f vendor/autoload.php vendor/composer/autoload_*.php vendor/composer/installed.php vendor/composer/platform_check.php && composer dump-autoload --no-scripts --quiet';
const keepsClassMap = (composer: ComposerFile) => [composer.autoload, composer['autoload-dev']].some(autoload => autoload?.classmap?.length);
function phpTests(composer: ComposerFile, locked: string): Pick<Program, 'test' | 'idle'> {
  const script = typeof composer.scripts?.test === 'string', phpunit = locked.includes('phpunit/phpunit');
  return { test: [...(keepsClassMap(composer) ? [CLASS_MAP] : []), script || !phpunit ? 'composer test' : 'vendor/bin/phpunit'], idle: !script && !phpunit };
}
async function phpProject(seen: Seen, root: string): Promise<Program | Orphan> {
  const file = under(root, 'composer.json'), lock = under(root, 'composer.lock');
  if (!seen.tracked.has(lock)) return { orphan: file };
  const composer = readJson(await read(seen, file), file) as ComposerFile, ownVersion = within(seen, root, ['.php-version']);
  return {
    language: 'php', root, asks: [{ tool: 'php', version: phpVersion(composer, ownVersion[0] ? await read(seen, ownVersion[0]) : null) }], inputs: [file, lock, ...ownVersion], shared: ['vendor'],
    steps: ['composer install --no-interaction --no-progress --no-scripts'], ...phpTests(composer, await read(seen, lock)),
  };
}
const php: Finder = seen => Promise.all(foldersWith(seen, ['composer.json']).map(root => phpProject(seen, root)));

/* Ruby: a lock file written elsewhere may not name this machine's platform, and bundler adds it to its own copy. */
const RUBY_PLATFORM = `bundle lock --add-platform "$(ruby -e 'print Gem::Platform.local')" ${'--local'} > /dev/null 2>&1 || true`;
async function rubyVersion(seen: Seen, root: string): Promise<string | undefined> {
  const own = within(seen, root, ['.ruby-version'])[0];
  if (own) return /(\d+\.\d+(?:\.\d+)?)/.exec(await read(seen, own))?.[1];
  const locked = /^RUBY VERSION\s+ruby (\d+\.\d+\.\d+)/m.exec(await read(seen, under(root, 'Gemfile.lock')))?.[1];
  return locked ?? /^\s*ruby\s+['"](\d+\.\d+(?:\.\d+)?)['"]/m.exec(await read(seen, under(root, 'Gemfile')))?.[1];
}
async function rubyProject(seen: Seen, root: string): Promise<Program | Orphan> {
  const file = under(root, 'Gemfile'), lock = under(root, 'Gemfile.lock');
  if (!seen.tracked.has(lock)) return { orphan: file };
  const gemspecs = seen.paths.filter(path => folderOf(path) === root && path.endsWith('.gemspec')), locked = await read(seen, lock);
  const rspec = /^\s+rspec \(/m.test(locked), rake = /^\s+rake \(/m.test(locked) && seen.tracked.has(under(root, 'Rakefile'));
  return {
    language: 'ruby', root, asks: [{ tool: 'ruby', version: await rubyVersion(seen, root) }],
    inputs: [file, lock, ...within(seen, root, ['.ruby-version']), ...gemspecs], env: { BUNDLE_PATH: '.hornhoof/gems' }, shared: ['.hornhoof/gems'],
    steps: [`bundle lock --add-platform "$(ruby -e 'print Gem::Platform.local')" > /dev/null 2>&1 || true`, 'bundle install'],
    test: [RUBY_PLATFORM, `bundle exec ${rspec ? 'rspec' : 'rake test'}`], idle: !rspec && !rake,
  };
}
const ruby: Finder = seen => Promise.all(foldersWith(seen, ['Gemfile']).map(root => rubyProject(seen, root)));

const FINDERS: Finder[] = [javascript, python, go, rust, maven, gradle, php, ruby];

/* .tool-versions is where the head and the owner write what they chose, before there need be any code. Its names are asdf's. */
const NAMED_TOOLS: Record<string, ToolId> = { go: 'go', golang: 'go', rust: 'rust', java: 'java', maven: 'maven', gradle: 'gradle', php: 'php', ruby: 'ruby', c: 'c', gcc: 'c' };
const MACHINE_TOOLS: Record<string, string> = { nodejs: 'node --version', node: 'node --version', python: 'python3 --version' };
const PRINTS: Record<ToolId, string> = { c: 'gcc --version', go: 'go version', rust: 'cargo --version', java: 'java -version', maven: 'mvn -version', gradle: 'gradle --version', php: 'php --version', ruby: 'ruby --version' };
function readNamed(text: string): Map<string, string> {
  return new Map(text.split('\n').map(line => line.replace(/#.*/, '').trim().split(/\s+/)).filter(([name, version]) => name && version).map(([name, version]) => [name!, version!]));
}
function namedVersion(tool: ToolId, version: string): string | undefined {
  if (tool === 'java') return javaFeature(version);
  return tool === 'c' ? undefined : version;
}
/* What a tool cannot work without, chosen or not: what links or builds it, what runs it. */
const NEEDS: Partial<Record<ToolId, Ask[]>> = { rust: [{ tool: 'c' }], ruby: [{ tool: 'c', packages: RUBY_PACKAGES }], maven: [{ tool: 'java' }], gradle: [{ tool: 'java' }] };
function namedAsks(named: Map<string, string>): Ask[] {
  return [...named].flatMap(([name, version]) => {
    const tool = NAMED_TOOLS[name];
    return tool ? [{ tool, version: namedVersion(tool, version) }] : [];
  });
}

function toolAsk(asks: Ask[], named: Map<string, string>, id: ToolId, programs: Program[]): ToolAsk {
  const ofTool = asks.filter(ask => ask.tool === id), chosen = Object.entries(NAMED_TOOLS).find(([name, tool]) => tool === id && named.has(name))?.[0];
  const version = chosen ? namedVersion(id, named.get(chosen)!) : newest(ofTool.flatMap(ask => (ask.version ? [ask.version] : [])));
  const packages = [...new Set(ofTool.flatMap(ask => ask.packages ?? []))];
  if (chosen) return { version, chosen: true, packages, ownFile: [], noDefault: false };
  const ownFile = programs.flatMap(program => program.asks.flatMap(ask => (ask.tool === id && ask.ownFile ? [{ root: program.root, path: ask.ownFile }] : [])));
  return { version, chosen: false, packages, ownFile, noDefault: ownFile.length === programs.filter(program => program.asks.some(ask => ask.tool === id)).length };
}

const ID_LIMIT = 50;
function slug(program: Program): string {
  if (program.root === '.') return program.language;
  const name = `${program.language}-${program.root.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return name.length <= ID_LIMIT ? name : `${name.slice(0, ID_LIMIT - 9)}-${createHash('sha256').update(program.root).digest('hex').slice(0, 8)}`;
}
const inProgram = (root: string, env: Record<string, string>, lines: string[]): Command => ({
  program: 'sh', args: ['-c', ['set -e', ...Object.entries(env).map(([name, path]) => `export ${name}="$PWD/${path}"`), ...lines].join('\n')], cwd: root,
});
function unitOf(program: Program, id: string, sharedNames: Set<string>): TestPrepare {
  const env = program.env ?? {}, nameOf = (path: string) => Object.entries(env).find(([name, value]) => value === path && !sharedNames.has(name))?.[0];
  const artifact = (path: string, link: boolean): TestArtifact => {
    const name = nameOf(path);
    return { path: under(program.root, path), format: 'directory', ...(name ? { env: name } : {}), ...(link ? { link: true as const } : {}) };
  };
  const all = [...program.shared, ...(program.own ?? [])];
  return {
    id: `dependencies-${id}`, profiles: ['default'], serviceIds: [], inputs: program.inputs,
    commands: [inProgram(program.root, env, [...program.steps, `mkdir -p ${all.map(quoted).join(' ')}`])],
    artifacts: [...program.shared.map(path => artifact(path, true)), ...(program.own ?? []).map(path => artifact(path, false))],
  };
}
const suiteOf = (program: Program, id: string): TestSuite => ({ id, root: program.root, files: [program.inputs[0]!], split: { kind: 'whole-package' }, profiles: ['default'], run: inProgram(program.root, program.env ?? {}, program.test) });

/* With no program yet, a run shows the tools that were chosen are there and work. */
function toolsSuite(named: Map<string, string>, tools: Tool[]): TestSuite {
  const prints = [...tools.map(tool => PRINTS[tool.id]), ...[...named.keys()].flatMap(name => (MACHINE_TOOLS[name] ? [MACHINE_TOOLS[name]] : []))];
  return { id: 'tools', root: '.', files: ['.tool-versions'], split: { kind: 'whole-package' }, profiles: ['default'], run: inProgram('.', {}, prints) };
}

function toolsUnit(tools: Tool[]): TestEnvironmentV1['dependencies'] {
  const env = Object.assign({}, ...tools.map(tool => tool.env ?? {})) as Record<string, string>, bin = tools.flatMap(tool => tool.bin);
  return { adapter: tools.map(tool => tool.id).join('.') || 'none', inputs: tools.flatMap(tool => tool.inputs ?? []), install: tools.flatMap(tool => tool.install), paths: tools.flatMap(tool => tool.paths), cache: 'link', ...(Object.keys(env).length ? { env } : {}), ...(bin.length ? { bin } : {}) };
}
function manifestOf(programs: Program[], tools: Tool[], named: Map<string, string>): TestEnvironmentV1 {
  const ids = programs.map(slug), names = programs.flatMap(program => Object.keys(program.env ?? {}));
  const sharedNames = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  const suites = programs.length ? programs.map((program, index) => suiteOf(program, ids[index]!)) : [toolsSuite(named, tools)];
  return {
    version: 1, defaultProfile: 'default', runtimes: [],
    profiles: [{ id: 'default', requiredSuiteIds: suites.map(suite => suite.id) }],
    dependencies: toolsUnit(tools),
    services: [], prepare: programs.map((program, index) => unitOf(program, ids[index]!, sharedNames)), reset: null, suites,
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'The system found this environment by itself and knows of no migration check.' } },
    mutation: { status: 'unsupported', language: programs[0]?.language ?? 'none', reason: 'The system found this environment by itself and names no mutation tool.' },
  };
}

function nothingFound(orphans: Orphan[], named: Map<string, string>): DiscoveryProblem {
  if (orphans[0]) return new DiscoveryProblem('environment_unsupported', `This repository has ${orphans[0].orphan} and no lock file, so what it installs could change from one machine to the next. Commit a lock file.`);
  if (named.size) return new DiscoveryProblem('environment_unsupported', `Hornhoof does not bring ${[...named.keys()].join(', ')} by itself yet. The repository can describe its own environment in .hornhoof/test-environment.json.`);
  return new DiscoveryProblem('environment_missing', 'No test environment exists at the pinned commit: it describes none in .hornhoof/test-environment.json, and no language Hornhoof knows was found in it. Name the languages that were chosen in .tool-versions, or commit their project files.');
}

const REGULAR_FILE = /^100/;
export async function discoverEnvironment(tree: Tracked): Promise<TestEnvironmentV1> {
  const paths = tree.entries.filter(entry => REGULAR_FILE.test(entry.mode)).map(entry => entry.path), tracked = new Set(paths);
  const seen: Seen = { tree, tracked, paths, named: tracked.has('.tool-versions') ? readNamed((await tree.readBlob('.tool-versions', FILE_LIMIT)).toString('utf8')) : new Map() };
  const found = (await Promise.all(FINDERS.map(finder => finder(seen)))).flat();
  const all = found.filter((item): item is Program => !('orphan' in item)), orphans = found.filter((item): item is Orphan => 'orphan' in item);
  const tested = all.filter(program => !program.idle), programs = tested.length ? tested : all;
  const asks = [...programs.flatMap(program => program.asks), ...namedAsks(seen.named)];
  asks.push(...asks.flatMap(ask => NEEDS[ask.tool] ?? []));
  const machineTools = [...seen.named.keys()].some(name => MACHINE_TOOLS[name]);
  if (!programs.length && !asks.length && !machineTools) throw nothingFound(orphans, seen.named);
  const tools = TOOL_ORDER.filter(id => asks.some(ask => ask.tool === id)).map(id => makeTool(id, toolAsk(asks, seen.named, id, programs)));
  const manifest = manifestOf(programs, tools, seen.named);
  if (JSON.stringify(manifest).length > TEST_ENVIRONMENT_BYTES) throw new DiscoveryProblem('environment_unsupported', `This repository holds more programs and packages than Hornhoof can describe by itself. Describe it in .hornhoof/test-environment.json, which can leave out what its tests do not need.`);
  return manifest;
}
