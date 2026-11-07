import { describe, expect, it } from 'vitest';
import { parseTestEnvironment, type TestEnvironmentV1 } from '@hornhoof/protocol';
import { discoverEnvironment } from '../src/test-discovery.js';
import type { CommitTree } from '../src/test-mirror.js';

const tree = (files: Record<string, string>): Pick<CommitTree, 'entries' | 'readBlob'> => ({
  entries: Object.keys(files).map(path => ({ path, mode: '100644', oid: 'b'.repeat(40) })),
  readBlob: async (path, limit) => {
    const bytes = Buffer.from(files[path]!);
    if (bytes.length > limit) throw new Error(`${path} is larger than was asked for.`);
    return bytes;
  },
});
const pkg = (over: object = {}) => JSON.stringify({ name: 'shop', scripts: { test: 'vitest run' }, ...over });
const found = async (files: Record<string, string>): Promise<TestEnvironmentV1> => {
  const manifest = await discoverEnvironment(tree(files));
  expect(parseTestEnvironment(JSON.stringify(manifest))).toEqual(manifest);
  return manifest;
};
const script = (command: { args: string[] }) => command.args.join('\n');
const paths = (manifest: TestEnvironmentV1) => manifest.prepare.flatMap(unit => unit.artifacts.map(artifact => artifact.path));
const toolsOf = (manifest: TestEnvironmentV1) => manifest.dependencies.adapter.split('.');

describe('a JavaScript project', () => {
  it('comes up from its lock file, its dependencies shared read-only and built apart from any tool', async () => {
    const manifest = await found({ 'package.json': pkg(), 'package-lock.json': '{}' });
    expect(manifest.dependencies).toMatchObject({ cache: 'link', inputs: [], install: [], paths: [] });
    expect(manifest.prepare).toMatchObject([{ id: 'dependencies-javascript', inputs: ['package.json', 'package-lock.json'], artifacts: [{ path: 'node_modules', link: true }] }]);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('npm ci --no-audit --no-fund');
    expect(manifest.suites).toMatchObject([{ id: 'javascript', root: '.', files: ['package.json'], split: { kind: 'whole-package' } }]);
    expect(script(manifest.suites[0]!.run)).toContain('npm test');
    expect(manifest.profiles).toEqual([{ id: 'default', requiredSuiteIds: ['javascript'] }]);
  });

  it('counts each workspace package, as its own dependencies and as an input', async () => {
    const manifest = await found({ 'package.json': pkg({ workspaces: ['apps/*', 'packages/*'] }), 'package-lock.json': '{}', 'apps/web/package.json': '{}', 'packages/ui/package.json': '{}', 'other/x/package.json': '{}', '.npmrc': '' });
    expect(paths(manifest)).toEqual(['node_modules', 'apps/web/node_modules', 'packages/ui/node_modules']);
    expect(manifest.prepare[0]!.inputs).toEqual(['package.json', 'package-lock.json', '.npmrc', 'apps/web/package.json', 'packages/ui/package.json']);
  });

  it('runs the tests of the workspaces when the root has none', async () => {
    const manifest = await found({ 'package.json': JSON.stringify({ workspaces: { packages: ['apps/*'] } }), 'package-lock.json': '{}', 'apps/web/package.json': '{}' });
    expect(script(manifest.suites[0]!.run)).toContain('npm test --workspaces');
  });

  it.each([
    ['pnpm-lock.yaml', '', 'corepack pnpm install --frozen-lockfile --package-import-method=copy'],
    ['yarn.lock', '# yarn lockfile v1\n', 'corepack yarn install --frozen-lockfile'],
    ['yarn.lock', '__metadata:\n  version: 8\n', 'corepack yarn install --immutable'],
  ])('uses the package manager of %s', async (lock, text, command) => {
    const manifest = await found({ 'package.json': pkg(), [lock]: text });
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain(command);
  });

  it('reads pnpm\'s own list of workspaces', async () => {
    const manifest = await found({ 'package.json': pkg(), 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - \"!apps/old\"\n", 'apps/web/package.json': '{}' });
    expect(paths(manifest)).toEqual(['node_modules', 'apps/web/node_modules']);
    expect(manifest.prepare[0]!.inputs).toContain('pnpm-workspace.yaml');
  });

  it('refuses a project with no lock file, as machines could get different dependencies', async () => {
    await expect(discoverEnvironment(tree({ 'package.json': pkg() }))).rejects.toMatchObject({ code: 'environment_unsupported', message: expect.stringContaining('lock file') as string });
  });

  it('says so when package.json cannot be read', async () => {
    await expect(discoverEnvironment(tree({ 'package.json': 'not json', 'package-lock.json': '{}' }))).rejects.toMatchObject({ code: 'environment_invalid' });
  });

  it('refuses to describe more workspace packages than fit, and says what to do', async () => {
    const files: Record<string, string> = { 'package.json': pkg({ workspaces: ['p/*'] }), 'package-lock.json': '{}' };
    for (let n = 0; n < 1000; n++) files[`p/${n}/package.json`] = '{}';
    await expect(discoverEnvironment(tree(files))).rejects.toMatchObject({ code: 'environment_unsupported', message: expect.stringContaining('.hornhoof/test-environment.json') as string });
  });

  it('takes the tests of the workspaces when the root\'s script is the one npm init writes', async () => {
    const manifest = await found({ 'package.json': pkg({ workspaces: ['apps/*'], scripts: { test: 'echo "Error: no test specified" && exit 1' } }), 'package-lock.json': '{}', 'apps/web/package.json': '{}' });
    expect(script(manifest.suites[0]!.run)).toContain('npm test --workspaces --if-present');
  });

  it('goes through pnpm\'s workspaces one by one, as npm does not know them', async () => {
    const manifest = await found({ 'package.json': JSON.stringify({ name: 'a' }), 'pnpm-lock.yaml': '', 'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n", 'apps/web/package.json': '{}', 'apps/api/package.json': '{}' });
    expect(script(manifest.suites[0]!.run)).toContain(`for folder in 'apps/web' 'apps/api'; do (cd "$folder" && npm test --if-present); done`);
  });

  it('reads a workspace pattern written from the current folder', async () => {
    const manifest = await found({ 'package.json': pkg({ workspaces: ['./apps/*'] }), 'package-lock.json': '{}', 'apps/web/package.json': '{}' });
    expect(paths(manifest)).toEqual(['node_modules', 'apps/web/node_modules']);
  });

  it('reads a large lock file', async () => {
    const manifest = await found({ 'package.json': pkg(), 'yarn.lock': `# yarn lockfile v1\n${'x'.repeat(4 * 1024 * 1024)}` });
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('--frozen-lockfile');
  });

  it('takes the tests of the workspaces that have any', async () => {
    const manifest = await found({ 'package.json': JSON.stringify({ workspaces: ['apps/*'] }), 'package-lock.json': '{}', 'apps/web/package.json': '{}' });
    expect(script(manifest.suites[0]!.run)).toContain('npm test --workspaces --if-present');
  });
});

describe('a Python project', () => {
  it('comes up from its requirements, leaving the tool that installs them behind', async () => {
    const manifest = await found({ 'requirements.txt': 'flask==3', 'requirements-dev.txt': 'pytest', 'tests/test_a.py': '' });
    expect(manifest.prepare).toMatchObject([{ id: 'dependencies-python', inputs: ['requirements.txt', 'requirements-dev.txt'], artifacts: [{ path: '.hornhoof/python', link: true, env: 'PYTHONPATH' }] }]);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('-m pip install --no-cache-dir --target .hornhoof/python -r requirements.txt -r requirements-dev.txt pytest');
    expect(script(manifest.suites[0]!.run)).toContain('python3 -m pytest');
    expect(manifest.dependencies.install).toEqual([]);
  });

  it('takes what pyproject.toml declares, without installing the project over its own checkout', async () => {
    const manifest = await found({ 'pyproject.toml': '[project]\nname="shop"\n', 'src/shop/__init__.py': '' });
    expect(manifest.prepare[0]!.inputs).toEqual(['pyproject.toml']);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('-r .hornhoof/requirements.txt pytest');
    expect(script(manifest.suites[0]!.run)).toContain('python3 -m pytest -o pythonpath=src');
  });
});

describe('a Go project', () => {
  it('brings the version of Go its go.mod names, and only that, into its harness', async () => {
    const manifest = await found({ 'go.mod': 'module shop\n\ngo 1.22.4\n', 'go.sum': '', 'a_test.go': '' });
    expect(toolsOf(manifest)).toEqual(['go']);
    expect(manifest.dependencies).toMatchObject({ cache: 'link', bin: ['.hornhoof/tools/go/bin'], env: { GOENV: '.hornhoof/tools/go.env' }, paths: ['.hornhoof/tools/go', '.hornhoof/tools/go.env'] });
    expect(script(manifest.dependencies.install[0]!)).toContain('https://go.dev/dl/');
    expect(script(manifest.dependencies.install[0]!)).toContain('sha256sum -c');
    expect(manifest.dependencies.install[0]!.args.slice(-2)).toEqual(['1.22.4', '.hornhoof/tools/go']);
    expect(manifest.prepare).toMatchObject([{ id: 'dependencies-go', inputs: ['go.mod', 'go.sum'], artifacts: [{ path: '.hornhoof/gomod', link: true, env: 'GOMODCACHE' }, { path: '.hornhoof/gocache', link: true, env: 'GOCACHE' }] }]);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('go mod download');
    expect(script(manifest.suites[0]!.run)).toContain('go test ./...');
    expect(manifest.suites[0]).toMatchObject({ id: 'go', files: ['go.mod'] });
  });

  it.each([
    ['go 1.22\n', '1.22.0'],
    ['go 1.20\n', '1.20'],
    ['go 1.22.1\ntoolchain go1.23.5\n', '1.23.5'],
    ['', '1.27.3'],
  ])('reads %j as Go %s', async (text, version) => {
    const manifest = await found({ 'go.mod': `module shop\n${text}` });
    expect(manifest.dependencies.install[0]!.args.at(-2)).toBe(version);
  });

  it('gives a program what it reaches outside its folder: a workspace, or another module it replaces a dependency with', async () => {
    const workspace = await found({ 'go.work': 'go 1.25.0\nuse (\n\t./a\n\t./b\n)\n', 'a/go.mod': 'module a\n', 'b/go.mod': 'module b\n', 'b/go.sum': '' });
    expect(workspace.prepare[0]!.inputs).toEqual(['a/go.mod', 'go.work', 'b/go.mod', 'b/go.sum']);
    expect(workspace.prepare[1]!.inputs).toEqual(['b/go.mod', 'b/go.sum', 'go.work', 'a/go.mod']);
    const replaced = await found({ 'a/go.mod': 'module a\nreplace b => ../b\n', 'b/go.mod': 'module b\n' });
    expect(replaced.prepare[0]!.inputs).toEqual(['a/go.mod', 'b/go.mod']);
    expect(replaced.prepare[1]!.inputs).toEqual(['b/go.mod']);
    const nested = await found({ 'go.mod': 'module a\nreplace x => ./libs/x\n', 'libs/x/go.mod': 'module x\n' });
    expect(nested.prepare[0]!.inputs).toEqual(['go.mod', 'libs/x/go.mod']);
    const excluded = await found({ 'go.work': 'go 1.25.0\nuse (\n\t./a\n\t./examples/b\n)\n', 'a/go.mod': 'module a\n', 'examples/b/go.mod': 'module b\n' });
    expect(excluded.prepare[0]!.inputs).toEqual(['a/go.mod', 'go.work', 'examples/b/go.mod']);
  });

  it('notes in each run that the prepared cache was just cleaned, or Go would drop it all at the first command', async () => {
    const manifest = await found({ 'go.mod': 'module shop\ngo 1.22.4\n' });
    expect(script(manifest.suites[0]!.run)).toContain('date +%s > "$GOCACHE/trim.txt"');
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('rm -f "$GOCACHE/trim.txt"');
  });

  it('counts a changed lock file for the project and leaves its tool alone', async () => {
    const before = await found({ 'go.mod': 'module shop\ngo 1.22.4\n', 'go.sum': 'a' }), after = await found({ 'go.mod': 'module shop\ngo 1.22.4\nrequire x v1\n', 'go.sum': 'b' });
    expect(after.dependencies).toEqual(before.dependencies);
  });
});

describe('a Rust project', () => {
  const cargo = { 'Cargo.toml': '[package]\nname = "shop"\n', 'Cargo.lock': '', 'src/lib.rs': '' };

  it('brings Rust and what links it into its harness, keeping what it downloaded shared and what it compiled its own', async () => {
    const manifest = await found(cargo);
    expect(toolsOf(manifest)).toEqual(['c', 'rust']);
    expect(manifest.dependencies).toMatchObject({ env: { RUSTUP_HOME: '.hornhoof/tools/rustup' }, bin: ['.hornhoof/tools/c/bin', '.hornhoof/tools/cargo/bin'] });
    expect(manifest.dependencies.install.map(script).join('\n')).toContain('rustup-init');
    expect(manifest.dependencies.install.map(command => [command.program, ...command.args].join(' '))).toContain('rustup toolchain install 1.99.1 --no-self-update --profile minimal --component rustfmt --component clippy');
    const [unit] = manifest.prepare;
    expect(unit).toMatchObject({ id: 'dependencies-rust', inputs: ['Cargo.toml', 'Cargo.lock'], artifacts: [{ path: '.hornhoof/cargo', link: true, env: 'CARGO_HOME' }, { path: 'target', format: 'directory' }] });
    expect(unit!.artifacts[1]).not.toHaveProperty('link');
    expect(script(unit!.commands[0]!)).toContain('cargo fetch --locked');
    expect(script(unit!.commands[0]!)).toContain('cargo build --locked --tests --keep-going');
    expect(script(manifest.suites[0]!.run)).toContain('cargo test --locked');
  });

  it('checks the digest of the installer it fetches, on each architecture', async () => {
    const install = (await found(cargo)).dependencies.install.map(script).join('\n');
    expect(install).toContain('b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55');
    expect(install).toContain('9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282');
  });

  it('takes its version from the repository\'s own toolchain file, which goes in as an input', async () => {
    const manifest = await found({ ...cargo, 'rust-toolchain.toml': '[toolchain]\nchannel = "1.82.0"\n' });
    expect(manifest.dependencies.inputs).toEqual(['rust-toolchain.toml']);
    expect(manifest.dependencies.install).toContainEqual({ program: 'rustup', args: ['toolchain', 'install', '--no-self-update'], cwd: '.' });
  });

  it('forgets every package of its own after compiling, so a run never takes the empty sources it compiled them from for its code', async () => {
    const manifest = await found({ 'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n', 'Cargo.lock': '', 'crates/a/Cargo.toml': '[package]\nname = "a"\n', 'crates/b/Cargo.toml': '[package]\nname = "b"\n[[bin]]\nname = "x"\n' });
    const steps = script(manifest.prepare[0]!.commands[0]!);
    expect(manifest.prepare[0]!.inputs).toEqual(['Cargo.toml', 'Cargo.lock', 'crates/a/Cargo.toml', 'crates/b/Cargo.toml']);
    expect(steps).toContain('tomllib');
    expect(steps).toContain("'Cargo.toml' 'crates/a/Cargo.toml' 'crates/b/Cargo.toml'");
    expect(steps).toContain('cargo clean --locked -p');
    expect(steps).toContain('metadata="$(cargo metadata --locked --format-version=1)"');
  });

  it('gives a project the crates it reaches outside its folder, whose sources it also needs empty ones of', async () => {
    const manifest = await found({ 'api/Cargo.toml': '[package]\nname = "api"\n[dependencies]\nshared = { path = "../shared" }\n', 'api/Cargo.lock': '', 'shared/Cargo.toml': '[package]\nname = "shared"\n', 'shared/Cargo.lock': '' });
    expect(manifest.prepare[0]!.inputs).toEqual(['api/Cargo.toml', 'api/Cargo.lock', 'shared/Cargo.toml']);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain("'Cargo.toml' '../shared/Cargo.toml'");
    expect(manifest.prepare[1]!.inputs).toEqual(['shared/Cargo.toml', 'shared/Cargo.lock']);
  });

  it('passes over a manifest it cannot read, as a repository keeps broken and templated ones for its tests', async () => {
    const manifest = await found({ ...cargo, 'tests/fixtures/bad/Cargo.toml': 'not = = toml' });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['rust']);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('except (OSError, tomllib.TOMLDecodeError):');
  });

  it('refuses a project with no lock file', async () => {
    await expect(discoverEnvironment(tree({ 'Cargo.toml': '[package]\nname = "shop"\n' }))).rejects.toMatchObject({ code: 'environment_unsupported', message: expect.stringContaining('lock file') as string });
  });
});

describe('a Java project', () => {
  const pom = (java: string) => `<project><properties><maven.compiler.release>${java}</maven.compiler.release></properties></project>`;

  it('brings the JDK its pom names and Maven into its harness, with what they download shared', async () => {
    const manifest = await found({ 'pom.xml': pom('21'), 'src/test/java/ATest.java': '' });
    expect(toolsOf(manifest)).toEqual(['java', 'maven']);
    expect(manifest.dependencies).toMatchObject({ env: { JAVA_HOME: '.hornhoof/tools/java' }, bin: ['.hornhoof/tools/java/bin', '.hornhoof/tools/maven/bin'] });
    expect(script(manifest.dependencies.install[0]!)).toContain('api.adoptium.net');
    expect(manifest.dependencies.install[0]!.args.slice(-2)).toEqual(['21', '.hornhoof/tools/java']);
    expect(manifest.prepare).toMatchObject([{ id: 'dependencies-java', inputs: ['pom.xml'], artifacts: [{ path: '.hornhoof/m2', link: true, env: 'HORNHOOF_MAVEN_REPOSITORY' }] }]);
    expect(script(manifest.suites[0]!.run)).toContain('mvn -B -ntp test');
  });

  it('counts each module of a Maven project as one program', async () => {
    const manifest = await found({ 'pom.xml': pom('17'), 'a/pom.xml': '<project/>', 'b/pom.xml': '<project/>' });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['java']);
    expect(manifest.prepare[0]!.inputs).toEqual(['pom.xml', 'a/pom.xml', 'b/pom.xml']);
  });

  it('brings the Gradle its wrapper names, and reads the Java version from the build', async () => {
    const manifest = await found({ 'build.gradle.kts': 'java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }', 'settings.gradle.kts': '', 'gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip\n' });
    expect(toolsOf(manifest)).toEqual(['java', 'gradle']);
    expect(manifest.dependencies.install[0]!.args.at(-2)).toBe('17');
    expect(manifest.dependencies.install[1]!.args.slice(-2)).toEqual(['8.10.2', '.hornhoof/tools/gradle']);
    expect(manifest.prepare[0]).toMatchObject({ artifacts: [{ path: '.hornhoof/gradle/caches', link: true, env: 'GRADLE_RO_DEP_CACHE' }] });
    expect(script(manifest.suites[0]!.run)).toContain('gradle --no-daemon test');
  });

  it('takes the newest long-term JDK when nothing names one', async () => {
    expect((await found({ 'pom.xml': '<project/>' })).dependencies.install[0]!.args.at(-2)).toBe('25');
  });

  it('reads the old way of writing a Java version', async () => {
    expect((await found({ 'pom.xml': '<project><properties><java.version>1.8</java.version></properties></project>' })).dependencies.install[0]!.args.at(-2)).toBe('8');
  });
});

describe('a PHP project', () => {
  const lock = JSON.stringify({ packages: [], 'packages-dev': [{ name: 'phpunit/phpunit' }] });

  it('brings PHP and Composer into its harness, and its packages shared', async () => {
    const manifest = await found({ 'composer.json': JSON.stringify({ name: 'a/shop', require: { php: '^8.2' } }), 'composer.lock': lock });
    expect(toolsOf(manifest)).toEqual(['php']);
    expect(manifest.dependencies).toMatchObject({ bin: ['.hornhoof/tools/php'] });
    expect(manifest.dependencies.install[0]!.args.at(-2)).toBe('8.5');
    expect(manifest.prepare).toMatchObject([{ id: 'dependencies-php', inputs: ['composer.json', 'composer.lock'], artifacts: [{ path: 'vendor', link: true }] }]);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('composer install --no-interaction --no-progress --no-scripts');
    expect(script(manifest.suites[0]!.run)).toContain('vendor/bin/phpunit');
  });

  it('takes the version the repository names, and the test script it declares', async () => {
    const manifest = await found({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' }, config: { platform: { php: '8.3.12' } } }), 'composer.lock': lock });
    expect(manifest.dependencies.install[0]!.args.at(-2)).toBe('8.3.12');
    expect(script(manifest.suites[0]!.run)).toContain('composer test');
  });

  it.each([
    ['^8.2', '8.5'], ['>=8.0', '8.5'], ['~8.2', '8.5'], ['^8.2 || ^7.4', '7.4'], ['^7.4 || ^8.0', '8.5'],
    ['~8.2.0', '8.2'], ['8.2.*', '8.2'], ['8.3.1', '8.3'],
    ['^7.4', '7.4'], ['~7.4', '7.4'], ['>=8.0 <8.3', '8.2'], ['>=8.0 <9.0', '8.5'], ['>=7.4 <8.0', '7.4'],
  ])('takes %s to mean PHP %s', async (constraint, series) => {
    const manifest = await found({ 'composer.json': JSON.stringify({ require: { php: constraint } }), 'composer.lock': lock });
    expect(manifest.dependencies.install[0]!.args.at(-2)).toBe(series);
  });

  it('takes a test script written as a list of steps', async () => {
    const manifest = await found({ 'composer.json': JSON.stringify({ scripts: { test: ['@lint', 'codecept run'] } }), 'composer.lock': JSON.stringify({ packages: [] }) });
    expect(script(manifest.suites[0]!.run)).toContain('composer test');
    const beside = await found({ 'go.mod': 'module a\n', 'php/composer.json': JSON.stringify({ scripts: { test: ['codecept run'] } }), 'php/composer.lock': '{}' });
    expect(beside.suites.map(suite => suite.id)).toEqual(['go', 'php-php']);
  });

  it('writes the class map again before a run when the project keeps one, as its classes were not there at install', async () => {
    const manifest = await found({ 'composer.json': JSON.stringify({ autoload: { classmap: ['database/'] } }), 'composer.lock': lock });
    expect(script(manifest.suites[0]!.run)).toContain('composer dump-autoload');
  });

  it('refuses a project with no lock file', async () => {
    await expect(discoverEnvironment(tree({ 'composer.json': '{}' }))).rejects.toMatchObject({ code: 'environment_unsupported', message: expect.stringContaining('lock file') as string });
  });
});

describe('a Ruby project', () => {
  const lock = (more = '') => `GEM\n  specs:\n    rake (13.0.0)\n${more}\nPLATFORMS\n  ruby\n`;

  it('builds the Ruby it names once from Ruby\'s own source, with what that takes, and its gems shared', async () => {
    const manifest = await found({ Gemfile: "source 'https://rubygems.org'\n", 'Gemfile.lock': lock(), '.ruby-version': 'ruby-3.3.5\n' });
    expect(toolsOf(manifest)).toEqual(['c', 'ruby']);
    expect(manifest.dependencies.install.map(script).join('\n')).toContain('cache.ruby-lang.org');
    expect(script(manifest.dependencies.install[0]!)).toContain('libssl-dev');
    expect(manifest.dependencies.install[1]!.args.slice(-2)).toEqual(['3.3.5', '.hornhoof/tools/ruby']);
    expect(manifest.dependencies).toMatchObject({ env: { LD_LIBRARY_PATH: '.hornhoof/tools/c/lib' } });
    expect(manifest.prepare).toMatchObject([{ id: 'dependencies-ruby', inputs: ['Gemfile', 'Gemfile.lock', '.ruby-version'], artifacts: [{ path: '.hornhoof/gems', link: true, env: 'BUNDLE_PATH' }] }]);
    expect(script(manifest.prepare[0]!.commands[0]!)).toContain('bundle install');
    expect(script(manifest.suites[0]!.run)).toContain('bundle exec rake test');
  });

  it('gives a gem what its gemspec commonly loads', async () => {
    const manifest = await found({ Gemfile: 'gemspec\n', 'Gemfile.lock': lock(), 'shop.gemspec': '', 'lib/shop/version.rb': '', 'lib/shop.rb': '', VERSION: '1' });
    expect(manifest.prepare[0]!.inputs).toEqual(['Gemfile', 'Gemfile.lock', 'shop.gemspec', 'lib/shop/version.rb', 'VERSION']);
  });

  it('runs rspec when the project has it', async () => {
    expect(script((await found({ Gemfile: '', 'Gemfile.lock': lock('    rspec (3.0.0)\n') })).suites[0]!.run)).toContain('bundle exec rspec');
  });

  it.each([
    ['Gemfile.lock', 'RUBY VERSION\n   ruby 3.2.2p53\n', '3.2.2'],
    ['Gemfile', "ruby '3.1.4'\n", '3.1.4'],
  ])('reads its version from %s', async (file, text, version) => {
    const manifest = await found({ Gemfile: '', 'Gemfile.lock': lock(), [file]: file === 'Gemfile.lock' ? `${lock()}\n${text}` : text });
    expect(manifest.dependencies.install[1]!.args.at(-2)).toBe(version);
  });

  it('refuses a project with no lock file', async () => {
    await expect(discoverEnvironment(tree({ Gemfile: '' }))).rejects.toMatchObject({ code: 'environment_unsupported', message: expect.stringContaining('lock file') as string });
  });
});

describe('what the head and the owner chose', () => {
  it('brings the tools named in .tool-versions up before there is any code, and nothing else', async () => {
    const manifest = await found({ '.tool-versions': 'java temurin-21.0.5+11\n# a note\nrust 1.90.0\nnodejs 22.11.0\n' });
    expect(toolsOf(manifest)).toEqual(['c', 'rust', 'java']);
    expect(manifest.prepare).toEqual([]);
    expect(manifest.dependencies.inputs).toEqual([]);
    expect(manifest.dependencies.install.map(command => [command.program, ...command.args].join(' '))).toContain('rustup toolchain install 1.90.0 --no-self-update --profile minimal --component rustfmt --component clippy');
    expect(manifest.suites).toMatchObject([{ id: 'tools', files: ['.tool-versions'] }]);
    for (const prints of ['cargo --version', 'java -version', 'node --version']) expect(script(manifest.suites[0]!.run)).toContain(prints);
  });

  it.each([
    ['ruby 3.4.1', ['c', 'ruby']],
    ['rust 1.90.0', ['c', 'rust']],
    ['maven 3.9.9', ['java', 'maven']],
    ['gradle 8.10.2', ['java', 'gradle']],
  ])('brings what %s cannot work without', async (line, tools) => {
    expect(toolsOf(await found({ '.tool-versions': `${line}\n` }))).toEqual(tools);
  });

  it('lets what it names win over what a project\'s own files say', async () => {
    const manifest = await found({ '.tool-versions': 'golang 1.25.1\n', 'go.mod': 'module shop\ngo 1.22.4\n' });
    expect(manifest.dependencies.install[0]!.args.at(-2)).toBe('1.25.1');
  });

  it.each([
    ['rust nightly-2025-01-01', 'toolchain install nightly-2025-01-01'],
    ['rust stable', 'toolchain install stable'],
  ])('takes %s as it is written', async (line, command) => {
    const installs = (await found({ '.tool-versions': `${line}\n` })).dependencies.install.map(item => item.args.join(' '));
    expect(installs.some(text => text.startsWith(command))).toBe(true);
  });

  it('also brings what a Rust toolchain file names, as Rust obeys that file in its project whatever else was chosen', async () => {
    const manifest = await found({ '.tool-versions': 'rust 1.90.0\n', 'Cargo.toml': '[package]\nname = "a"\n', 'Cargo.lock': '', 'rust-toolchain.toml': '[toolchain]\nchannel = "1.82.0"\n' });
    expect(manifest.dependencies.inputs).toEqual(['rust-toolchain.toml']);
    const installs = manifest.dependencies.install.map(command => command.args.join(' '));
    expect(installs).toContain('toolchain install 1.90.0 --no-self-update --profile minimal --component rustfmt --component clippy');
    expect(installs).toContain('toolchain install --no-self-update');
  });

  it('adds a C compiler to a project only when it is named, as most need none', async () => {
    expect(toolsOf(await found({ '.tool-versions': 'gcc 12\n', 'package.json': pkg(), 'package-lock.json': '{}' }))).toEqual(['c']);
    expect(toolsOf(await found({ 'package.json': pkg(), 'package-lock.json': '{}' }))).toEqual(['none']);
  });

  it('gets the tools of one language only for a project of that language', async () => {
    for (const files of [{ 'package.json': pkg(), 'package-lock.json': '{}' }, { 'requirements.txt': '' }] as Record<string, string>[]) {
      const { install } = (await found(files)).dependencies;
      expect(install).toEqual([]);
    }
    expect(toolsOf(await found({ 'go.mod': 'module a\n' }))).toEqual(['go']);
  });

  it('says where to name them when it finds nothing at all', async () => {
    await expect(discoverEnvironment(tree({ 'README.md': 'Notes' }))).rejects.toMatchObject({ code: 'environment_missing', message: expect.stringContaining('.tool-versions') as string });
  });
});

describe('several programs in one repository', () => {
  const three = { 'api/go.mod': 'module api\ngo 1.24.0\n', 'api/a_test.go': '', 'web/package.json': pkg(), 'web/package-lock.json': '{}', 'ml/requirements.txt': 'flask==3', 'ml/test_a.py': '' };

  it('finds each, with a suite and a unit of its own in its own folder', async () => {
    const manifest = await found(three);
    expect(manifest.suites.map(suite => [suite.id, suite.root, suite.run.cwd, suite.files])).toEqual([
      ['javascript-web', 'web', 'web', ['web/package.json']],
      ['python-ml', 'ml', 'ml', ['ml/requirements.txt']],
      ['go-api', 'api', 'api', ['api/go.mod']],
    ]);
    expect(manifest.profiles[0]!.requiredSuiteIds).toEqual(['javascript-web', 'python-ml', 'go-api']);
    expect(manifest.prepare.map(unit => unit.id)).toEqual(['dependencies-javascript-web', 'dependencies-python-ml', 'dependencies-go-api']);
    expect(paths(manifest)).toEqual(['web/node_modules', 'ml/.hornhoof/python', 'api/.hornhoof/gomod', 'api/.hornhoof/gocache']);
    expect(toolsOf(manifest)).toEqual(['go']);
  });

  it('rebuilds only the program whose lock file changed', async () => {
    const before = await found(three), after = await found({ ...three, 'ml/requirements.txt': 'flask==4' });
    expect(after.prepare).toEqual(before.prepare);
    expect(after.dependencies).toEqual(before.dependencies);
    expect(before.prepare[1]!.inputs).toEqual(['ml/requirements.txt']);
  });

  it('brings one tool per language, the newest any program asks for', async () => {
    const manifest = await found({ 'a/go.mod': 'module a\ngo 1.22.1\n', 'b/go.mod': 'module b\ngo 1.24.2\n', 'c/go.mod': 'module c\ngo 1.9\n' });
    expect(manifest.dependencies.install[0]!.args.at(-2)).toBe('1.24.2');
    expect(manifest.suites.map(suite => suite.id)).toEqual(['go-a', 'go-b', 'go-c']);
  });

  it('names a variable for a whole run only when one program sets it; each program always sets its own', async () => {
    const manifest = await found({ 'a/requirements.txt': '', 'b/requirements.txt': '' });
    expect(manifest.prepare[0]!.artifacts[0]).toEqual({ path: 'a/.hornhoof/python', format: 'directory', link: true });
    expect(script(manifest.suites[1]!.run)).toContain('export PYTHONPATH="$PWD/.hornhoof/python"');
    expect(manifest.suites[1]!.run.cwd).toBe('b');
  });

  it('leaves out what has nothing to test while another program has, as its run could only fail', async () => {
    const manifest = await found({
      'go.mod': 'module a\n', 'a_test.go': '', 'package.json': JSON.stringify({ devDependencies: { husky: '9' } }), 'package-lock.json': '{}', 'scripts/requirements.txt': 'requests',
      'tools/package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), 'tools/package-lock.json': '{}',
      'php/composer.json': '{}', 'php/composer.lock': '{}', 'rb/Gemfile': '', 'rb/Gemfile.lock': 'GEM\n',
    });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['go']);
    expect(manifest.prepare.map(unit => unit.id)).toEqual(['dependencies-go']);
    expect(toolsOf(manifest)).toEqual(['go']);
  });

  it('keeps a program with nothing to test when no other has tests, and its run says so', async () => {
    const manifest = await found({ 'package.json': JSON.stringify({ name: 'new' }), 'package-lock.json': '{}' });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['javascript']);
  });

  it('takes tests in the ways each language keeps them', async () => {
    const ids = async (files: Record<string, string>) => (await found({ 'go.mod': 'module a\n', ...files })).suites.map(suite => suite.id);
    expect(await ids({ 'py/requirements.txt': '', 'py/tests/test_a.py': '' })).toEqual(['python-py', 'go']);
    expect(await ids({ 'py/requirements.txt': '', 'py/a_test.py': '' })).toEqual(['python-py', 'go']);
    expect(await ids({ 'py/requirements.txt': '', 'py/conftest.py': '' })).toEqual(['python-py', 'go']);
    expect(await ids({ 'rb/Gemfile': '', 'rb/Gemfile.lock': '    rspec (3.0.0)\n' })).toEqual(['go', 'ruby-rb']);
    expect(await ids({ 'rb/Gemfile': '', 'rb/Gemfile.lock': '    rake (13.0.0)\n', 'rb/Rakefile': '' })).toEqual(['go', 'ruby-rb']);
    expect(await ids({ 'php/composer.json': '{"scripts":{"test":"x"}}', 'php/composer.lock': '{}' })).toEqual(['go', 'php-php']);
    expect(await ids({ 'php/composer.json': '{}', 'php/composer.lock': '{"packages-dev":[{"name":"phpunit/phpunit"}]}' })).toEqual(['go', 'php-php']);
  });

  it('takes no program for a file it cannot read as one: a link is not a manifest', async () => {
    const links = tree({ 'go.mod': 'module a\n', 'package.json': 'not read', 'package-lock.json': '{}' });
    links.entries = links.entries.map(entry => (entry.path === 'package.json' ? { ...entry, mode: '120000' } : entry));
    expect((await discoverEnvironment(links)).suites.map(suite => suite.id)).toEqual(['go']);
  });

  it('takes both a root project and one in a folder', async () => {
    const manifest = await found({ 'package.json': pkg(), 'package-lock.json': '{}', 'worker/Cargo.toml': '[package]\nname = "w"\n', 'worker/Cargo.lock': '' });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['javascript', 'rust-worker']);
    expect(paths(manifest)).toEqual(['node_modules', 'worker/.hornhoof/cargo', 'worker/target']);
  });

  it('counts a workspace package as part of its project, not as a program', async () => {
    const manifest = await found({ 'package.json': pkg({ workspaces: ['apps/*'] }), 'package-lock.json': '{}', 'apps/web/package.json': '{}' });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['javascript']);
  });

  it('counts a nested manifest under a Rust or Java project as part of it', async () => {
    const manifest = await found({ 'Cargo.toml': '[workspace]\n', 'Cargo.lock': '', 'fuzz/Cargo.toml': '[package]\nname = "f"\n', 'fuzz/Cargo.lock': '', 'jvm/pom.xml': '<project/>', 'jvm/m/pom.xml': '<project/>' });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['rust', 'java-jvm']);
  });

  it('skips what is not a program of this repository: vendored code, fixtures and examples', async () => {
    const manifest = await found({ 'go.mod': 'module a\n', 'vendor/x/go.mod': 'module x\n', 'testdata/y/package.json': pkg(), 'testdata/y/package-lock.json': '{}', 'test/fixtures/z/requirements.txt': '', 'examples/w/Cargo.toml': '', 'examples/w/Cargo.lock': '' });
    expect(manifest.suites.map(suite => suite.id)).toEqual(['go']);
    expect(toolsOf(manifest)).toEqual(['go']);
  });

  it('skips a folder with a manifest and no lock when other programs stand, and refuses when none does', async () => {
    expect((await found({ 'go.mod': 'module a\n', 'site/package.json': pkg() })).suites.map(suite => suite.id)).toEqual(['go']);
    await expect(discoverEnvironment(tree({ 'site/package.json': pkg() }))).rejects.toMatchObject({ code: 'environment_unsupported' });
  });

  it.each([
    ['one folder holding both Maven and Gradle', { 'pom.xml': '<project/>', 'build.gradle': '' }],
    ['folders that read alike', { 'services/api-v2/go.mod': 'module a\n', 'services/api/v2/go.mod': 'module b\n' }],
    ['folders that differ by case', { 'Api/go.mod': 'module a\n', 'api/go.mod': 'module b\n' }],
  ])('tells apart %s', async (_what, files) => {
    const { suites, prepare } = await found(files);
    expect(new Set(suites.map(suite => suite.id)).size).toBe(2);
    expect(new Set(prepare.map(unit => unit.id)).size).toBe(2);
  });

  it('keeps ids within what the schema allows however deep a folder lies', async () => {
    const deep = `${'very-long-folder-name/'.repeat(6)}x`, other = `${'very-long-folder-name/'.repeat(6)}y`;
    const manifest = await found({ [`${deep}/go.mod`]: 'module a\n', [`${other}/go.mod`]: 'module b\n' });
    expect(new Set(manifest.suites.map(suite => suite.id)).size).toBe(2);
  });
});
