import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import type { EnvironmentDescription, ServerMessage } from '@hornhoof/protocol';
import { readTestEnvironment } from '../src/test-environment.js';
import { runTests, syncHarness } from '../src/tests.js';
import { ids, network, registry, stopwatch, type Timing } from './measure-machines.js';

/* A real project of each language, and one repository with several, from nothing but what the repository says. One machine brings
   the harness up, another takes it and runs the tests with the network closed, and a test that fails then fails, so nothing false
   comes out of what was prepared. Lock files come from the chosen tools themselves, as they do for a new project. Start it from
   apps/node: npx --no-install vitest run --config vitest.measure.config.ts test/languages.measure.ts -t 'project: go$'.
   HH_MEASURE_OUT names the file that gets the results. */
type Files = Record<string, string>;
/* tools: what the head and the owner name in .tool-versions, before there is any code. lock: what writes the lock files with them.
   says: what a failing test prints, when its runner leaves out its message. also: a command that must pass on a machine that took
   the harness, with the network closed. */
type Project = { name: string; tools?: string; lock?: { command: string; files: string[] }; files: Files; broken: Files; says?: string; also?: string; changed?: { files: Files; rebuilds: string[] } };

const BROKEN = 'THIS TEST WAS BROKEN ON PURPOSE';
const GO: Files = {
  'go.mod': 'module shop\n\ngo 1.25.4\n\nrequire golang.org/x/text v0.20.0\n',
  'shop.go': 'package shop\n\nimport (\n\t"golang.org/x/text/cases"\n\t"golang.org/x/text/language"\n)\n\nfunc Title(s string) string { return cases.Title(language.English).String(s) }\n',
  'shop_test.go': 'package shop\n\nimport "testing"\n\nfunc TestTitle(t *testing.T) {\n\tif Title("hello") != "Hello" {\n\t\tt.Fatal(Title("hello"))\n\t}\n}\n',
};
const GO_BROKEN = { 'shop_test.go': `package shop\n\nimport "testing"\n\nfunc TestTitle(t *testing.T) { t.Fatal("${BROKEN}") }\n` };
const JAVASCRIPT: Files = {
  'package.json': JSON.stringify({ name: 'shop', private: true, scripts: { test: 'node --test' }, dependencies: { 'is-odd': '3.0.1' } }),
  'test/odd.test.js': "const test = require('node:test'), assert = require('node:assert'), isOdd = require('is-odd');\ntest('three is odd', () => { assert.equal(isOdd(3), true); });\n",
};
const JAVASCRIPT_BROKEN = { 'test/odd.test.js': `const test = require('node:test'), assert = require('node:assert');\ntest('three is odd', () => { assert.fail('${BROKEN}'); });\n` };
const PYTHON: Files = { 'requirements.txt': 'six==1.16.0\n', 'test_shop.py': 'import six\n\n\ndef test_six():\n    assert six.PY3\n' };
const PYTHON_BROKEN = { 'test_shop.py': `def test_six():\n    assert False, '${BROKEN}'\n` };
const JAVA_TEST = (body: string) => `package shop;\n\nimport static org.junit.jupiter.api.Assertions.*;\nimport org.junit.jupiter.api.Test;\n\nclass ShopTest {\n  @Test void names() { ${body} }\n}\n`;
const JAVA_SOURCES: Files = { 'src/main/java/shop/Shop.java': 'package shop;\n\npublic class Shop { public String name() { return "shop"; } }\n', 'src/test/java/shop/ShopTest.java': JAVA_TEST('assertEquals("shop", new Shop().name());') };
const JAVA_BROKEN = { 'src/test/java/shop/ShopTest.java': JAVA_TEST(`fail("${BROKEN}");`) };
const inFolder = (folder: string, files: Files): Files => Object.fromEntries(Object.entries(files).map(([path, text]) => [`${folder}/${path}`, text]));

const PROJECTS: Project[] = [
  { name: 'javascript', tools: 'nodejs 22\n', lock: { command: 'npm install --package-lock-only --no-audit --no-fund', files: ['package-lock.json'] }, files: JAVASCRIPT, broken: JAVASCRIPT_BROKEN },
  {
    name: 'npm-workspace', tools: 'nodejs 22\n', lock: { command: 'npm install --package-lock-only --no-audit --no-fund', files: ['package-lock.json'] },
    files: { 'package.json': JSON.stringify({ name: 'shop', private: true, workspaces: ['./apps/*'] }), ...inFolder('apps/web', { ...JAVASCRIPT, 'package.json': JAVASCRIPT['package.json']!.replace('"shop"', '"web"') }), 'apps/site/package.json': JSON.stringify({ name: 'site', private: true }) },
    broken: inFolder('apps/web', JAVASCRIPT_BROKEN),
  },
  {
    name: 'pnpm-workspace', tools: 'nodejs 22\n', lock: { command: 'corepack pnpm install --lockfile-only', files: ['pnpm-lock.yaml'] },
    files: { 'package.json': JSON.stringify({ name: 'shop', private: true }), 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", ...inFolder('apps/web', { ...JAVASCRIPT, 'package.json': JAVASCRIPT['package.json']!.replace('"shop"', '"web"') }), 'apps/site/package.json': JSON.stringify({ name: 'site', private: true }) },
    broken: inFolder('apps/web', JAVASCRIPT_BROKEN),
  },
  { name: 'pnpm', tools: 'nodejs 22\n', lock: { command: 'corepack pnpm install --lockfile-only', files: ['pnpm-lock.yaml'] }, files: JAVASCRIPT, broken: JAVASCRIPT_BROKEN },
  { name: 'yarn', tools: 'nodejs 22\n', lock: { command: 'corepack yarn install --no-progress', files: ['yarn.lock'] }, files: JAVASCRIPT, broken: JAVASCRIPT_BROKEN },
  { name: 'python', files: PYTHON, broken: PYTHON_BROKEN },
  {
    name: 'pyproject', files: {
      'pyproject.toml': '[project]\nname = "shop"\nversion = "1"\ndependencies = ["six==1.16.0"]\n',
      'src/shop/__init__.py': 'import six\n\nNAME = six.ensure_str("shop")\n',
      'tests/test_shop.py': 'from shop import NAME\n\n\ndef test_name():\n    assert NAME == "shop"\n',
    },
    broken: { 'tests/test_shop.py': `def test_name():\n    assert False, '${BROKEN}'\n` },
  },
  {
    name: 'go', tools: 'golang 1.25.4\n', lock: { command: 'go mod tidy', files: ['go.mod', 'go.sum'] }, files: GO, broken: GO_BROKEN,
    // A run writes the note of the last cleaning; with it, one Go command after another finds all of the prepared cache still there.
    also: 'before="$(find "$GOCACHE" -type f | wc -l)"; date +%s > "$GOCACHE/trim.txt"; go test ./... && go vet ./... && after="$(find "$GOCACHE" -type f | wc -l)" && echo "cache files: $before, then $after" && [ "$after" -ge "$before" ]',
  },
  {
    name: 'go-workspace', tools: 'golang 1.25.4\n', lock: { command: '(cd b && go mod tidy)', files: ['b/go.mod', 'b/go.sum'] },
    files: {
      'go.work': 'go 1.25.4\n\nuse (\n\t./a\n\t./b\n)\n',
      'a/go.mod': 'module example.test/a\n\ngo 1.25.4\n',
      'a/a.go': 'package a\n\nimport "example.test/b"\n\nfunc Title(s string) string { return b.Title(s) }\n',
      'a/a_test.go': 'package a\n\nimport "testing"\n\nfunc TestTitle(t *testing.T) {\n\tif Title("hello") != "Hello" {\n\t\tt.Fatal(Title("hello"))\n\t}\n}\n',
      'b/go.mod': 'module example.test/b\n\ngo 1.25.4\n\nrequire golang.org/x/text v0.20.0\n',
      'b/b.go': GO['shop.go']!.replace('package shop', 'package b'),
    },
    broken: { 'a/a_test.go': GO_BROKEN['shop_test.go']!.replace('package shop', 'package a') },
  },
  {
    name: 'rust', tools: 'rust 1.90.0\n', lock: { command: 'cargo generate-lockfile', files: ['Cargo.lock'] },
    files: {
      'rust-toolchain.toml': '[toolchain]\nchannel = "1.90.0"\nprofile = "minimal"\n',
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
      'crates/core/Cargo.toml': '[package]\nname = "shop-core"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nserde_json = "1"\n',
      'crates/core/src/lib.rs': '#[derive(serde::Serialize)]\npub struct Item { pub name: String }\npub fn json(name: &str) -> String { serde_json::to_string(&Item { name: name.to_string() }).unwrap() }\n',
      'crates/core/tests/json.rs': '#[test]\nfn names_an_item() { assert_eq!(shop_core::json("a"), r#"{"name":"a"}"#); }\n',
      'crates/app/Cargo.toml': '[package]\nname = "shop-app"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "shop"\npath = "src/main.rs"\n\n[dependencies]\nshop-core = { path = "../core" }\n',
      'crates/app/src/main.rs': 'fn main() { println!("{}", shop_core::json("a")); }\n',
      'crates/core/tests/fixtures/bad/Cargo.toml': 'not = = toml\n',
    },
    broken: { 'crates/core/tests/json.rs': `#[test]\nfn names_an_item() { panic!("${BROKEN}"); }\n` },
  },
  {
    name: 'rust-beside', tools: 'rust 1.90.0\n', lock: { command: '(cd api && cargo generate-lockfile) && (cd shared && cargo generate-lockfile)', files: ['api/Cargo.lock', 'shared/Cargo.lock'] },
    files: {
      'rust-toolchain.toml': '[toolchain]\nchannel = "1.90.0"\nprofile = "minimal"\n',
      'api/Cargo.toml': '[package]\nname = "api"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nshared = { path = "../shared" }\n',
      'api/src/lib.rs': 'pub fn text() -> String { shared::text(7) }\n',
      'api/tests/text.rs': '#[test]\nfn writes_seven() { assert_eq!(api::text(), "7"); }\n',
      'shared/Cargo.toml': '[package]\nname = "shared"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nitoa = "1"\n',
      'shared/src/lib.rs': 'pub fn text(n: u32) -> String { itoa::Buffer::new().format(n).to_string() }\n',
    },
    broken: { 'api/tests/text.rs': `#[test]\nfn writes_seven() { panic!("${BROKEN}"); }\n` },
  },
  {
    name: 'maven', files: { ...JAVA_SOURCES, 'pom.xml': '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>a</groupId><artifactId>shop</artifactId><version>1</version><properties><maven.compiler.release>21</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.3</version><scope>test</scope></dependency></dependencies><build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><version>3.5.2</version></plugin></plugins></build></project>\n' },
    broken: JAVA_BROKEN,
  },
  {
    name: 'gradle', files: {
      ...JAVA_SOURCES, 'settings.gradle.kts': 'rootProject.name = "shop"\n',
      'build.gradle.kts': 'plugins { java }\nrepositories { mavenCentral() }\njava { toolchain { languageVersion = JavaLanguageVersion.of(21) } }\ndependencies {\n  testImplementation(platform("org.junit:junit-bom:5.11.3"))\n  testImplementation("org.junit.jupiter:junit-jupiter")\n  testRuntimeOnly("org.junit.platform:junit-platform-launcher")\n}\ntasks.test { useJUnitPlatform() }\n',
    },
    broken: JAVA_BROKEN, says: 'ShopTest > names() FAILED',
  },
  {
    name: 'php', tools: 'php 8.4\n', lock: { command: 'composer update --no-install --no-interaction --no-progress', files: ['composer.lock'] },
    files: {
      'composer.json': JSON.stringify({ name: 'a/shop', require: { php: '~8.4.0' }, 'require-dev': { 'phpunit/phpunit': '^11' }, autoload: { 'psr-4': { 'Shop\\': 'src/' } } }),
      'phpunit.xml': '<phpunit bootstrap="vendor/autoload.php"><testsuites><testsuite name="all"><directory>tests</directory></testsuite></testsuites></phpunit>\n',
      'src/Shop.php': '<?php\nnamespace Shop;\n\nfinal class Shop { public function name(): string { return "shop"; } }\n',
      'tests/ShopTest.php': '<?php\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class ShopTest extends TestCase { public function testName(): void { $this->assertSame("shop", (new Shop\\Shop())->name()); } }\n',
    },
    broken: { 'tests/ShopTest.php': `<?php\nuse PHPUnit\\Framework\\TestCase;\n\nfinal class ShopTest extends TestCase { public function testName(): void { $this->fail("${BROKEN}"); } }\n` },
  },
  {
    name: 'ruby', tools: 'ruby 4.0\n', lock: { command: 'bundle lock', files: ['Gemfile.lock'] },
    files: {
      'Gemfile': 'source "https://rubygems.org"\ngem "rake"\ngem "minitest"\ngem "racc"\n',
      'Rakefile': 'require "rake/testtask"\nRake::TestTask.new { |t| t.pattern = "test/*_test.rb" }\ntask default: :test\n',
      'test/shop_test.rb': 'require "minitest/autorun"\nrequire "openssl"\nrequire "yaml"\nrequire "zlib"\nrequire "racc/cparse"\n\nclass ShopTest < Minitest::Test\n  def test_digest = assert_equal(32, OpenSSL::Digest::SHA256.digest("a").bytesize)\nend\n',
    },
    broken: { 'test/shop_test.rb': `require "minitest/autorun"\n\nclass ShopTest < Minitest::Test\n  def test_digest = flunk("${BROKEN}")\nend\n` },
  },
  {
    name: 'gem', tools: 'ruby 4.0\n', lock: { command: 'bundle lock', files: ['Gemfile.lock'] },
    files: {
      'Gemfile': 'source "https://rubygems.org"\ngemspec\ngem "rake"\ngem "minitest"\n',
      'shop.gemspec': 'require_relative "lib/shop/version"\n\nGem::Specification.new do |spec|\n  spec.name = "shop"\n  spec.version = Shop::VERSION\n  spec.summary = "A shop"\n  spec.authors = ["A"]\n  spec.files = Dir["lib/**/*"]\nend\n',
      'lib/shop/version.rb': 'module Shop\n  VERSION = "1.0.0"\nend\n',
      'lib/shop.rb': 'require_relative "shop/version"\n',
      'Rakefile': 'require "rake/testtask"\nRake::TestTask.new { |t| t.pattern = "test/*_test.rb" }\ntask default: :test\n',
      'test/shop_test.rb': 'require "minitest/autorun"\nrequire "shop"\n\nclass ShopTest < Minitest::Test\n  def test_version = assert_equal("1.0.0", Shop::VERSION)\nend\n',
    },
    broken: { 'test/shop_test.rb': `require "minitest/autorun"\n\nclass ShopTest < Minitest::Test\n  def test_version = flunk("${BROKEN}")\nend\n` },
  },
  {
    name: 'several', tools: 'golang 1.25.4\nnodejs 22\n', lock: { command: '(cd web && npm install --package-lock-only --no-audit --no-fund) && (cd api && go mod tidy)', files: ['web/package-lock.json', 'api/go.mod', 'api/go.sum'] },
    files: { ...inFolder('web', JAVASCRIPT), ...inFolder('ml', PYTHON), ...inFolder('api', GO) },
    broken: inFolder('api', GO_BROKEN),
    changed: { files: { 'ml/requirements.txt': `${PYTHON['requirements.txt']!}# One program's lock file changes.\n` }, rebuilds: ['dependencies-python-ml'] },
  },
];

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=M', '-c', 'user.email=m@example.test', ...args], { cwd, encoding: 'utf8' }).trim();
async function write(root: string, files: Files) {
  for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
}

/* One product: its repository, its registry and two machines that share it. */
async function product(work: string, name: string) {
  const source = join(work, `${name}-source`), url = pathToFileURL(source).href;
  await mkdir(source); await mkdir(join(work, 'proc'), { recursive: true });
  git(source, 'init', '--quiet', '--initial-branch=main');
  const repo = { url, token: '' };
  const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(url).digest('hex') };
  const bundles = join(work, `${name}-bundles`); await mkdir(bundles);
  const shared = registry(bundles);
  const machine = (place: string) => ({ dir: join(work, `${name}-${place}`), proc: join(work, 'proc'), user: { uid: ids.jobUid, gid: ids.jobUid }, hidden: [], prepareRepoBrowser: async () => {}, harness: shared.remote(place) });
  const commit = async (files: Files) => { await write(source, files); git(source, 'add', '-A'); git(source, 'commit', '--quiet', '--allow-empty', '-m', 'A commit'); return git(source, 'rev-parse', 'HEAD'); };
  const asked = (commitSha: string): Extract<ServerMessage, { type: 'tests.harness' }> => ({ type: 'tests.harness', requestId: randomUUID(), repositoryScope, repo, commitSha });
  const describeAt = async (commitSha: string) => await readTestEnvironment(repo, repositoryScope, commitSha, { cacheRoot: join(work, `${name}-scratch`), deadline: Date.now() + 60_000, signal: new AbortController().signal, log: () => {} }) as EnvironmentDescription;
  const run = { type: 'tests.run' as const, repo, repositoryScope, branch: null, task: 1, part: 1, parts: 1, timeoutMs: 1_200_000 };
  const suite = (commitSha: string, description: EnvironmentDescription, suiteId: string): Extract<ServerMessage, { type: 'tests.run' }> => ({ ...run, partId: randomUUID(), commitSha, command: '', environment: { snapshot: { description, profile: 'default' }, selection: { kind: 'suite', suiteId, files: description.inventory.filter(unit => unit.suiteId === suiteId).map(unit => unit.file) } } });
  const manual = (commitSha: string, command: string): Extract<ServerMessage, { type: 'tests.run' }> => ({ ...run, partId: randomUUID(), commitSha, command });
  return { shared, machine, commit, asked, describeAt, suite, manual };
}
type Product = Awaited<ReturnType<typeof product>>;
const ready = (done: Awaited<ReturnType<typeof syncHarness>>) => { if (done.result.status !== 'ready') throw new Error(JSON.stringify(done.result)); return `${done.result.keys.length} units`; };
const passed = (done: Awaited<ReturnType<typeof runTests>>) => { if (!done.ok) throw new Error(done.log.slice(-6000)); return done; };
const suitesOf = (description: EnvironmentDescription) => description.manifest.suites.map(suite => suite.id);

async function offline<T>(run: () => Promise<T>): Promise<T> {
  network.closed = true;
  try { return await run(); } finally { network.closed = false; }
}

/* The tools come up from .tool-versions alone, and the lock files of the project come from them. */
async function lockFiles(work: string, project: Project, timed: ReturnType<typeof stopwatch>): Promise<Files> {
  if (!project.lock) return {};
  const chosen = await product(work, `${project.name}-chosen`), out = join(work, `${project.name}-locks`), machine = chosen.machine('chooser');
  await mkdir(out);
  const commitSha = await chosen.commit({ '.tool-versions': project.tools!, ...inFolder('fixtures', project.files) });
  await timed('the chosen tools come up before any code', () => syncHarness(chosen.asked(commitSha), machine), ready);
  const description = await chosen.describeAt(commitSha);
  expect(suitesOf(description)).toEqual(['tools']);
  const shown = passed(await offline(() => runTests(chosen.suite(commitSha, description, 'tools'), machine)));
  console.log(shown.log.slice(-1500));
  passed(await runTests(chosen.manual(commitSha, `cd fixtures && ${project.lock.command} && cp --parents ${project.lock.files.join(' ')} '${out}'`), machine));
  const entries = await Promise.all(project.lock.files.map(async path => [path, await readFile(join(out, path), 'utf8')]));
  return Object.fromEntries(entries) as Files;
}

async function runSuites(on: Product, commitSha: string, machine: ReturnType<Product['machine']>, timed: ReturnType<typeof stopwatch>) {
  const description = await on.describeAt(commitSha);
  for (const suiteId of suitesOf(description)) {
    const done = await timed(`${suiteId}: a run with the network closed`, () => offline(() => runTests(on.suite(commitSha, description, suiteId), machine)), run => `${run.ok ? 'passed' : 'failed'}; to its first test ${Math.round(Object.entries(run.environmentReceipt?.phases ?? {}).filter(([phase]) => phase !== 'commandMs').reduce((sum, [, ms]) => sum + (ms as number), 0))} ms`);
    passed(done);
    expect(done.environmentReceipt?.dependencies.hit).toBe(true);
  }
}

async function proveProject(project: Project) {
  const work = await mkdtemp(join(tmpdir(), `hh-language-${project.name}-`)), results: Timing[] = [], timed = stopwatch(results);
  try {
    const on = await product(work, project.name), a = on.machine('a'), b = on.machine('b');
    const commitSha = await on.commit({ ...project.files, ...await lockFiles(work, project, timed) });
    await timed('the first machine builds its harness', () => syncHarness(on.asked(commitSha), a), ready);
    await timed('another machine takes it', () => syncHarness(on.asked(commitSha), b), ready);
    expect([...on.shared.builds.values()].filter(build => build.builder !== 'a')).toEqual([]);
    await runSuites(on, commitSha, b, timed);
    if (project.also) console.log(passed(await offline(() => runTests(on.manual(commitSha, project.also!), b))).log.slice(-800));
    let head = commitSha;
    if (project.changed) {
      const before = new Set(on.shared.builds.keys());
      head = await on.commit(project.changed.files);
      await timed('one lock file changed: the first machine updates', () => syncHarness(on.asked(head), a), ready);
      await timed('one lock file changed: another machine takes it', () => syncHarness(on.asked(head), b), ready);
      expect([...on.shared.builds].filter(([key]) => !before.has(key)).map(([, build]) => build.unit)).toEqual(project.changed.rebuilds);
      await runSuites(on, head, b, timed);
    }
    const broken = await on.commit(project.broken), description = await on.describeAt(broken);
    const outcomes = await Promise.all(suitesOf(description).map(async suiteId => [suiteId, await offline(() => runTests(on.suite(broken, description, suiteId), b))] as const));
    const failing = outcomes.filter(([, done]) => !done.ok);
    expect(failing.length, 'One suite holds the broken test.').toBe(1);
    expect(failing[0]![1].log).toContain(project.says ?? BROKEN);
    console.log(`${project.name}: the broken test fails in ${failing[0]![0]}`);
    console.log(`bundles: ${[...on.shared.builds.values()].map(build => `${build.unit} ${Math.round((build.size ?? 0) / 1024 / 1024)} MB`).join(', ')}`);
    if (process.env.HH_MEASURE_OUT) await appendFile(process.env.HH_MEASURE_OUT, `${JSON.stringify({ project: project.name, arch: process.arch, results, bundles: [...on.shared.builds.values()].map(build => ({ unit: build.unit, mb: Math.round((build.size ?? 0) / 1024 / 1024) })) })}\n`);
  } finally {
    execFileSync('sh', ['-c', `chmod -R u+w '${work}' && rm -rf '${work}'`]);
  }
}

it.each(PROJECTS.map(project => [project.name, project] as const))('project: %s', async (_name, project) => { await proveProject(project); });

it('project: chosen', async () => {
  const work = await mkdtemp(join(tmpdir(), 'hh-language-chosen-')), results: Timing[] = [], timed = stopwatch(results);
  try {
    const on = await product(work, 'chosen'), a = on.machine('a'), b = on.machine('b');
    const commitSha = await on.commit({ '.tool-versions': 'java 21\nmaven 3.9.11\ngradle 9.9.0\nphp 8.4\nnodejs 22\npython 3\nsomething-else 1\n' });
    await timed('the first machine brings the chosen tools', () => syncHarness(on.asked(commitSha), a), ready);
    await timed('another machine takes them', () => syncHarness(on.asked(commitSha), b), ready);
    const description = await on.describeAt(commitSha);
    const shown = passed(await offline(() => runTests(on.suite(commitSha, description, 'tools'), b)));
    for (const seen of ['21.', 'Apache Maven 3.9.11', 'Gradle 9.9.0', 'PHP 8.4', 'v2', 'Python 3']) expect(shown.log).toContain(seen);
  } finally {
    execFileSync('sh', ['-c', `chmod -R u+w '${work}' && rm -rf '${work}'`]);
  }
});
