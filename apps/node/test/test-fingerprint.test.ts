import { createHash } from 'node:crypto';
import type { EnvironmentDescription, TestEnvironmentV1, TestUnit } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { codeFilesOf, fastTestsOf, fingerprintUnits, testGraph, type FingerprintInput } from '../src/test-fingerprint.js';
import * as fingerprint from '../src/test-fingerprint.js';

type Suite = TestEnvironmentV1['suites'][number];
const run = { program: 'npx', args: ['vitest', 'run'], cwd: '.' };
const suite = (id: string, root: string, extra: Partial<Suite> = {}): Suite => ({ id, root, files: [`${root}/test/**/*.test.ts`], run, split: { kind: 'vitest-shard' }, profiles: ['fast'], ...extra });
const manifest = (suites: Suite[], extra: Partial<TestEnvironmentV1> = {}): TestEnvironmentV1 => ({
  version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }], profiles: [{ id: 'fast', requiredSuiteIds: suites.map(item => item.id) }],
  dependencies: { adapter: 'npm', inputs: ['package-lock.json'], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null, suites,
  impact: { adapter: 'typescript', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } }, mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' }, ...extra,
});

/* A small repository: its paths and what each code file says; oids follow the text, as git's do. */
type Files = Record<string, string>;
const oidOf = (text: string): string => createHash('sha1').update(text).digest('hex');
function input(files: Files, value: TestEnvironmentV1, change: Partial<EnvironmentDescription> = {}): FingerprintInput {
  const paths = Object.keys(files);
  const tracked = paths.map(path => ({ path, mode: '100644', oid: oidOf(files[path]!) }));
  const inventory: TestUnit[] = value.suites.flatMap(item => paths.filter(path => item.files.some(pattern => path.match(new RegExp(`^${pattern.replace(/\*\*\//g, '(.*/)?').replace(/\*/g, '[^/]*')}$`)))).map(file => ({ suiteId: item.id, file, selectionUnit: item.split.kind === 'whole-package' ? item.root : file })));
  return {
    description: { manifest: value, inventory, inputDigests: paths.filter(path => path === 'package-lock.json').map(path => ({ path, digest: oidOf(files[path]!).padEnd(64, '0') })), runtimeCapabilities: [{ id: 'node', version: '22.1.0', fingerprint: 'a'.repeat(64) }], ...change },
    tracked,
    texts: new Map(codeFilesOf(tracked).map(path => [path, files[path]!])),
  };
}
const prints = async (given: FingerprintInput) => new Map((await fingerprintUnits(given)).map(unit => [`${unit.suiteId}:${unit.file}`, unit.fingerprint]));
async function changed(before: FingerprintInput, after: FingerprintInput): Promise<string[]> {
  const was = await prints(before), now = await prints(after);
  return [...now.keys()].filter(key => was.get(key) !== now.get(key)).sort();
}

const app: Files = {
  'package-lock.json': '{}',
  'package.json': '{"name":"root","devDependencies":{"vitest":"5"},"workspaces":["packages/*","apps/*"]}',
  'README.md': 'Hello',
  'apps/a/package.json': '{"name":"@x/a","dependencies":{"zod":"4"}}',
  'apps/a/src/used.ts': "import { deep } from './deep.js';\nexport const used = deep;\n",
  'apps/a/src/deep.ts': 'export const deep = 1;\n',
  'apps/a/src/other.ts': 'export const other = 2;\n',
  'apps/a/test/used.test.ts': "import { used } from '../src/used.js';\nimport { z } from 'zod';\nimport { readFileSync } from 'node:fs';\nimport { it } from 'vitest';\nit('uses', () => [used, z, readFileSync]);\n",
  'apps/a/test/other.test.ts': "import { other } from '../src/other.js';\nimport { it } from 'vitest';\nit('other', () => other);\n",
  'apps/b/package.json': '{"name":"@x/b"}',
  'apps/b/src/b.ts': 'export const b = 3;\n',
  'apps/b/test/b.test.ts': "import { b } from '../src/b.js';\nimport { it } from 'vitest';\nit('b', () => b);\n",
};
const suites = [suite('a', 'apps/a'), suite('b', 'apps/b')];
const base = () => input(app, manifest(suites));
const edit = (path: string, text: string, value = manifest(suites)) => input({ ...app, [path]: text }, value);

describe('git modes in cached results', () => {
  const value = manifest(suites, { execution: { version: 2, oncePreparation: { profiles: ['fast'], suiteIds: ['a'], commands: [run] } } });
  const preparation = 'hornhoof-preparation:.hornhoof/test-environment.json';
  const modes = (files: Files, path: string, mode: string) => {
    const given = input(files, value);
    given.tracked = given.tracked.map(entry => entry.path === path ? { ...entry, mode } : entry);
    return given;
  };

  it.each(['apps/a/test/fixtures/tool.sh', 'scripts/tool.sh'])('invalidates executable mode changes at %s without changing its blob', async path => {
    const files = { ...app, [path]: 'echo fixture\n' };
    expect(await changed(modes(files, path, '100755'), modes(files, path, '100644'))).toContain(preparation);
    expect(await changed(modes(files, path, '100755'), modes(files, path, '100644'))).toContain('a:apps/a/test/used.test.ts');
    expect(await changed(modes(files, path, '100755'), modes(files, path, '100755'))).toEqual([]);
  });

  it('invalidates a data fixture replaced by a symlink with the same blob', async () => {
    const path = 'apps/a/test/fixtures/tool.sh', files = { ...app, [path]: 'target' };
    const before = modes(files, path, '100644'), after = modes(files, path, '120000');
    expect(await changed(before, after)).toContain('a:apps/a/test/used.test.ts');
    expect(await changed(before, after)).toContain(preparation);
  });
});

describe('the fingerprint of a test file', () => {
  it('stays the same when nothing changed, in whatever order git lists the files', async () => {
    const shuffled = base(); shuffled.tracked = [...shuffled.tracked].reverse();
    expect(await prints(shuffled)).toEqual(await prints(base()));
    expect((await prints(base())).size).toBe(3);
  });

  it('changes for the file itself and for no other', async () => {
    expect(await changed(base(), edit('apps/a/test/used.test.ts', `${app['apps/a/test/used.test.ts']}// more\n`))).toEqual(['a:apps/a/test/used.test.ts']);
  });

  it('changes when a dependency changes, however deep, and only for those who reach it', async () => {
    expect(await changed(base(), edit('apps/a/src/used.ts', `${app['apps/a/src/used.ts']}// more\n`))).toEqual(['a:apps/a/test/used.test.ts']);
    expect(await changed(base(), edit('apps/a/src/deep.ts', 'export const deep = 2;\n'))).toEqual(['a:apps/a/test/used.test.ts']);
  });

  it('does not change for a document', async () => {
    expect(await changed(base(), edit('README.md', 'Other'))).toEqual([]);
    expect(await changed(base(), input({ ...app, 'docs/new.md': 'New' }, manifest(suites)))).toEqual([]);
  });

  const linux = { os: 'linux', arch: 'x64', libc: 'glibc' };
  const on = (version: string, fingerprint: string, platform = linux) => input(app, manifest(suites), { runtimeCapabilities: [{ id: 'node', version, fingerprint, platform }] });
  it('changes everywhere with dependency inputs, and with the major version, system or libc of a runtime', async () => {
    const everyone = ['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts', 'b:apps/b/test/b.test.ts'];
    expect(await changed(base(), edit('package-lock.json', '{"new":1}'))).toEqual(everyone);
    expect(await changed(on('22.1.0', 'a'.repeat(64)), on('24.0.0', 'a'.repeat(64)))).toEqual(everyone);
    expect(await changed(on('22.1.0', 'a'.repeat(64)), on('22.1.0', 'a'.repeat(64), { ...linux, os: 'darwin' }))).toEqual(everyone);
    expect(await changed(on('22.1.0', 'a'.repeat(64)), on('22.1.0', 'a'.repeat(64), { ...linux, libc: 'musl' }))).toEqual(everyone);
  });

  /* Our tests come out the same on every machine of a class, so a file proved on one of them need not run again on another. */
  it('stays the same on another build, processor or minor version of a runtime of the same class', async () => {
    expect(await changed(on('22.1.0', 'a'.repeat(64)), on('22.3.4', 'b'.repeat(64), { ...linux, arch: 'arm64' }))).toEqual([]);
  });

  it('counts the version and build of a runtime that does not name its system', async () => {
    const everyone = ['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts', 'b:apps/b/test/b.test.ts'];
    expect(await changed(base(), input(app, manifest(suites), { runtimeCapabilities: [{ id: 'node', version: '22.2.0', fingerprint: 'a'.repeat(64) }] }))).toEqual(everyone);
    expect(await changed(base(), input(app, manifest(suites), { runtimeCapabilities: [{ id: 'node', version: '22.1.0', fingerprint: 'b'.repeat(64) }] }))).toEqual(everyone);
  });

  it('changes everywhere with what a harness names for tests to find', async () => {
    const everyone = ['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts', 'b:apps/b/test/b.test.ts'];
    const naming = (named: Partial<TestEnvironmentV1['dependencies']>) => input(app, manifest(suites, { dependencies: { ...manifest(suites).dependencies, ...named } }));
    expect(await changed(base(), naming({ bin: ['.tools/bin'] }))).toEqual(everyone);
    expect(await changed(base(), naming({ env: { TOOL_HOME: '.tools' } }))).toEqual(everyone);
  });

  it('changes with how what a suite starts from is made, and not with what only another profile or suite gets', async () => {
    const everyone = ['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts', 'b:apps/b/test/b.test.ts'];
    const build = (profiles: string[], program: string): TestEnvironmentV1['prepare'][number] => ({ id: 'build', profiles, serviceIds: [], inputs: [], commands: [{ program, args: [], cwd: '.' }], artifacts: [] });
    const made = (extra: Partial<TestEnvironmentV1>) => input(app, manifest(suites, extra));
    expect(await changed(made({ prepare: [build(['fast'], 'one')] }), made({ prepare: [build(['fast'], 'two')] }))).toEqual(everyone);
    expect(await changed(made({ prepare: [build(['full'], 'one')] }), made({ prepare: [build(['full'], 'two')] }))).toEqual([]);
    const postgres = (profiles: string[], database: string): TestEnvironmentV1['services'][number] => ({ id: 'db', runtime: 'node', profiles, driver: 'postgres', options: { database } });
    expect(await changed(made({ services: [postgres(['fast'], 'one')] }), made({ services: [postgres(['fast'], 'two')] }))).toEqual(everyone);
    expect(await changed(made({ services: [postgres(['full'], 'one')] }), made({ services: [postgres(['full'], 'two')] }))).toEqual([]);
    const reset = (program: string): TestEnvironmentV1['reset'] => [{ suiteIds: ['a'], scope: 'file', command: { program, args: [], cwd: '.' }, inputs: [] }];
    expect(await changed(made({ reset: reset('one') }), made({ reset: reset('two') }))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('changes everywhere with the suite command of its own, not of another suite', async () => {
    expect(await changed(base(), input(app, manifest([suite('a', 'apps/a', { run: { ...run, args: ['vitest', 'run', '--bail'] } }), suite('b', 'apps/b')])))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });
});

describe('changed pure function mutation selection', () => {
  const source = 'apps/a/src/pure.ts', test = 'apps/a/test/pure.test.ts';
  const code = 'export function changed(value: number): number {\n  return value > 0 ? value : 0;\n}\nexport function untouched(value: number): number {\n  return value + 1;\n}\n';
  const mutation = { status: 'supported' as const, language: 'typescript', tool: 'mutator', command: run, sourcePaths: [source], fastTestPaths: [test], coverageCommands: [run], coverageFiles: ['coverage/lcov.info'] };
  const delta = { baseCommit: '1'.repeat(40), commit: '2'.repeat(40), changes: [{ path: source, ranges: [[2, 1] as [number, number]] }] };
  const select = (files: Files, change = delta) => fingerprint.selectPureMutations(input(files, manifest(suites, { mutation })), mutation, change);
  const files = () => ({ [source]: code, [test]: `import { changed } from '../src/pure.js';\nimport { it, expect } from 'vitest';\nit('clamps', () => expect(changed(-1)).toBe(0));` });

  it('selects only the changed pure function and its fast tests with visible line bounds', async () => {
    const result = await select(files());
    expect(result).toMatchObject({ status: 'ready', baseCommit: delta.baseCommit, commit: delta.commit, problems: [], selected: [{ file: source, name: 'changed', startLine: 1, endLine: 3, lines: [1, 2, 3], tests: [test], reason: 'changed_pure_function' }] });
    expect(result.selected).toHaveLength(1);
    expect(await select(files(), { ...delta, changes: [] })).toMatchObject({ status: 'ready', selected: [] });
  });

  it.each(['(value: number) => value + offset', 'function (value: number) { return value + offset; }'])('selects a pure function expression %s using a literal module constant', async expression => {
    const result = await select({ ...files(), [source]: `const offset = 1; let unused: number;\nexport const changed = ${expression};\n` });
    expect(result).toMatchObject({ status: 'ready', problems: [], selected: [{ file: source, name: 'changed', startLine: 2, endLine: 2, lines: [2], tests: [test] }] });
    expect(result.selected).toHaveLength(1);
  });

  it('does not treat a mutable module variable as a constant of a pure function', async () => {
    const result = await select({ ...files(), [source]: 'let offset = 1;\nexport const changed = (value: number) => value + offset;\n' });
    expect(result).toMatchObject({ selected: [], excluded: [{ file: source, name: 'changed', reason: 'purity_unproven' }] });
  });

  it.each(['node:child_process', 'node:fs', 'node:http', 'pg'])('excludes a source module importing %s', async dependency => {
    const result = await select({ ...files(), [source]: `import * as effect from '${dependency}';\n${code}` });
    expect(result.selected).toEqual([]);
    expect(result.excluded).toContainEqual(expect.objectContaining({ file: source, reason: 'unsafe_module' }));
  });

  it.each(['process.env.KEY', 'fetch("https://example.test")', 'Date.now()', 'Math.random()', '(globalThis.value = value)', 'unknown(value)'])('excludes an effectful or unknown function using %s', async expression => {
    const result = await select({ ...files(), [source]: `export function changed(value: number) {\n return ${expression};\n}` });
    expect(result.selected).toEqual([]);
    expect(result.excluded).toContainEqual(expect.objectContaining({ file: source, name: 'changed', reason: 'purity_unproven' }));
  });

  it('excludes a fast test with a transitive process or database helper', async () => {
    const result = await select({ ...files(), [test]: `${files()[test]}\nimport './helper.js';`, 'apps/a/test/helper.ts': "import { spawn } from 'node:child_process';" });
    expect(result.status).toBe('blocked'); expect(result.selected).toEqual([]);
    expect(result.problems).toContainEqual({ file: source, code: 'no_safe_fast_tests' });
  });

  it('blocks a selected function without tests and an unpinned or invalid delta', async () => {
    expect(await select({ [source]: code })).toMatchObject({ status: 'blocked', selected: [], problems: [{ file: source, code: 'no_safe_fast_tests' }] });
    expect(await select(files(), { ...delta, commit: '' })).toMatchObject({ status: 'blocked', selected: [], problems: [{ code: 'invalid_mutation_delta' }] });
    expect(await select(files(), { ...delta, changes: [{ path: source, ranges: [[0, 1]] }] })).toMatchObject({ status: 'blocked', selected: [], problems: [{ code: 'invalid_mutation_delta' }] });
  });

  it('excludes fixtures even when a manifest lists them and deduplicates replayed changes', async () => {
    const fixture = 'apps/a/test/fixtures/pure.ts';
    const result = await fingerprint.selectPureMutations(input({ [fixture]: code }, manifest(suites)), { ...mutation, sourcePaths: [fixture] }, { ...delta, changes: [{ path: fixture, ranges: [[2, 1]] }] });
    expect(result.selected).toEqual([]); expect(result.excluded).toContainEqual({ file: fixture, reason: 'fixture_or_test' });
    const once = await select(files()), twice = await select(files(), { ...delta, changes: [...delta.changes, ...delta.changes] });
    expect(twice).toEqual(once);
  });

  it('excludes a function sharing a mutation line with an unchanged effectful function', async () => {
    const result = await select({ ...files(), [source]: 'export function changed(value: number) { return value > 0; } export function untouched() { return fetch("/"); }' }, { ...delta, changes: [{ path: source, ranges: [[1, 1]] }] });
    expect(result.selected).toEqual([]);
    expect(result.excluded).toContainEqual({ file: source, name: 'changed', reason: 'shared_function_line' });
  });

  it('excludes unknown module initialization and shadowed builtin calls', async () => {
    expect(await select({ ...files(), [source]: `const state = initializeExternal();\n${code}` })).toMatchObject({ selected: [], excluded: [{ file: source, reason: 'unsafe_module' }] });
    expect(await select({ ...files(), [source]: 'export function changed(Math: { abs(): number }) {\n return Math.abs();\n}' })).toMatchObject({ selected: [], excluded: [{ file: source, name: 'changed', reason: 'purity_unproven' }] });
  });

  it('blocks a computed import in the tests whose effects cannot be followed', async () => {
    const result = await select({ ...files(), [test]: `${files()[test]}\nconst helper = './runtime.js'; await import(helper);` });
    expect(result).toMatchObject({ status: 'blocked', selected: [], problems: [{ file: source, code: 'no_safe_fast_tests' }] });
  });

  it('does not confuse a module variable called Math with the builtin', async () => {
    const result = await select({ ...files(), [source]: `const Math = { abs: customEffect };\nexport function changed(value: number) {\n return Math.abs(value);\n}` });
    expect(result.selected).toEqual([]);
  });

  it('blocks unsupported mutation languages instead of treating an empty TypeScript parse as a proof', async () => {
    const result = await fingerprint.selectPureMutations(input(files(), manifest(suites)), { ...mutation, language: 'python' }, delta);
    expect(result).toMatchObject({ status: 'blocked', selected: [], problems: [{ code: 'unsupported_mutation_language' }] });
  });
});

describe('what the graph does not see', () => {
  it('a configuration of a package changes all of that package and nothing else', async () => {
    const files = { ...app, 'apps/a/vitest.config.ts': "export default { setupFiles: ['./test/setup.ts'] };\n", 'apps/a/test/setup.ts': 'export {};\n' };
    const before = input(files, manifest(suites));
    const whole = ['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts'];
    expect(await changed(before, input({ ...files, 'apps/a/vitest.config.ts': `${files['apps/a/vitest.config.ts']}// more\n` }, manifest(suites)))).toEqual(whole);
    expect(await changed(before, input({ ...files, 'apps/a/test/setup.ts': 'export const set = 1;\n' }, manifest(suites)))).toEqual(whole);
  });

  it('a fixture changes its package, and the rules of the manifest name who else reads it', async () => {
    const files = { ...app, 'apps/a/test/fixtures/x.json': '{}', 'shared/data.json': '{}' };
    const rule = manifest(suites, { impact: { adapter: 'typescript', fullPackageGlobs: [{ globs: ['shared/**'], suiteIds: ['b'] }], migrationCheck: { status: 'unsupported', reason: 'None.' } } });
    expect(await changed(input(files, rule), input({ ...files, 'apps/a/test/fixtures/x.json': '{"more":1}' }, rule))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
    expect(await changed(input(files, rule), input({ ...files, 'shared/data.json': '{"more":1}' }, rule))).toEqual(['b:apps/b/test/b.test.ts']);
  });

  it('a rule that names the tests reading a file still counts that file for the whole of their suites', async () => {
    const files = { ...app, 'shared/data.json': '{}' };
    const rule = manifest(suites, { impact: { adapter: 'typescript', fullPackageGlobs: [{ globs: ['shared/**'], suiteIds: ['a'], tests: ['apps/a/test/used.test.ts'] }], migrationCheck: { status: 'unsupported', reason: 'None.' } } });
    expect(await changed(input(files, rule), input({ ...files, 'shared/data.json': '{"more":1}' }, rule))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('a file of no package reaches everyone', async () => {
    const files = { ...app, 'Dockerfile': 'FROM node' };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'Dockerfile': 'FROM other' }, manifest(suites)))).toHaveLength(3);
  });

  it('a migration changes its package even where the manifest has no check for migrations', async () => {
    const files = { ...app, 'apps/a/drizzle/0001_first.sql': 'create table a();' };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/drizzle/0001_first.sql': 'create table b();' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('what a named file imports counts as much as the file, as for a setup a rule of the manifest names', async () => {
    const rule = manifest(suites, { impact: { adapter: 'typescript', fullPackageGlobs: [{ globs: ['shared/setup.ts'], suiteIds: ['b'] }], migrationCheck: { status: 'unsupported', reason: 'None.' } } });
    const files = { ...app, 'shared/setup.ts': "import { helper } from './helper.js';\nexport const setup = helper;\n", 'shared/helper.ts': 'export const helper = 1;\n' };
    expect(await changed(input(files, rule), input({ ...files, 'shared/helper.ts': 'export const helper = 2;\n' }, rule))).toContain('b:apps/b/test/b.test.ts');
  });

  it('a test matching a rule by its name changes only itself', async () => {
    const files = { ...app, 'apps/a/test/install-script.test.ts': "import { it } from 'vitest';\nit('x', async () => {});\n" };
    const after = { ...files, 'apps/a/test/install-script.test.ts': `${files['apps/a/test/install-script.test.ts']}// more\n` };
    expect(await changed(input(files, manifest(suites)), input(after, manifest(suites)))).toEqual(['a:apps/a/test/install-script.test.ts']);
  });
});

describe('checked Markdown inputs', () => {
  it.each(['AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md'])('does not discard the checked root %s', async path => {
    const files = { ...app, [path]: 'Before', 'apps/a/test/used.test.ts': `readFileSync('${path}');` };
    expect(await changed(input(files, manifest(suites)), input({ ...files, [path]: 'After' }, manifest(suites)))).toContain('a:apps/a/test/used.test.ts');
  });

  it('includes Markdown fixtures in the package fallback', async () => {
    const path = 'apps/a/test/fixtures/deep/README.md', files = { ...app, [path]: 'Before' };
    expect(await changed(input(files, manifest(suites)), input({ ...files, [path]: 'After' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });
});

describe('a type', () => {
  const files: Files = { ...app, 'apps/a/src/types.ts': 'export type T = number;\n', 'apps/a/test/typed.test.ts': "import type { T } from '../src/types.js';\nimport type Other from '../src/other.js';\nexport type { T as U } from '../src/types.js';\nimport { type T as V, used } from '../src/used.js';\nimport { it } from 'vitest';\nit('x', () => [used] as (T | Other | V)[]);\n" };
  const after = (path: string, text: string) => changed(input(files, manifest(suites)), input({ ...files, [path]: text }, manifest(suites)));

  it('imported on its own leaves no trace when the test runs', async () => {
    expect(await after('apps/a/src/types.ts', 'export type T = string;\n')).toEqual([]);
    expect(await after('apps/a/src/other.ts', 'export const other = 3;\n')).toEqual(['a:apps/a/test/other.test.ts']);
  });

  it('imported beside a value keeps the import', async () => {
    expect(await after('apps/a/src/used.ts', `${app['apps/a/src/used.ts']}// more\n`)).toContain('a:apps/a/test/typed.test.ts');
  });

  it('is told from a default import named type', async () => {
    const named = { ...app, 'apps/a/test/named.test.ts': "import type from '../src/other.js';\nimport { it } from 'vitest';\nit('x', () => type);\n" };
    expect(await changed(input(named, manifest(suites)), input({ ...named, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toContain('a:apps/a/test/named.test.ts');
  });
});

describe('a configuration that names test files', () => {
  it('does not run what those tests import around the others', async () => {
    const files: Files = { ...app, 'apps/a/vitest.other.config.ts': "export default { test: { include: ['test/used.test.ts'], setupFiles: ['test/setup.ts'] } };\n", 'apps/a/test/setup.ts': 'export {};\n' };
    const after = (path: string, text: string) => changed(input(files, manifest(suites)), input({ ...files, [path]: text }, manifest(suites)));
    expect(await after('apps/a/src/deep.ts', 'export const deep = 2;\n')).toEqual(['a:apps/a/test/used.test.ts']);
    expect(await after('apps/a/test/setup.ts', 'export const more = 1;\n')).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });
});

describe('a rule that gives a package a file of another package', () => {
  const files: Files = { ...app, 'apps/b/test/tool.ts': "import { b } from '../src/b.js';\nexport const tool = b;\n" };
  const value = manifest(suites, { impact: { adapter: 'typescript', fullPackageGlobs: [{ globs: ['apps/b/test/tool.ts'], suiteIds: ['a', 'b'] }], migrationCheck: { status: 'unsupported', reason: 'None.' } } });
  const after = (path: string, text: string) => changed(input(files, value), input({ ...files, [path]: text }, value));

  it('takes that file', async () => {
    expect(await after('apps/b/test/tool.ts', `${files['apps/b/test/tool.ts']}// more\n`)).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts', 'b:apps/b/test/b.test.ts']);
  });

  it('and not all it imports from there', async () => {
    expect(await after('apps/b/src/b.ts', 'export const b = 4;\n')).toEqual(['b:apps/b/test/b.test.ts']);
  });
});

describe('a configuration around the tests of several packages', () => {
  const config = "import './apps/b/src/imported.js';\nexport default { reporter: './apps/b/src/named.ts', projects: [{ name: '@x/a', root: './apps/a' }, { name: '@x/b', root: './apps/b' }], ignores: ['./apps/a/src/*.ts'], about: './README.md' };\n";
  const files: Files = { ...app, 'vitest.config.mjs': config, 'apps/b/src/imported.ts': 'export const imported = 1;\n', 'apps/b/src/named.ts': 'export const named = 1;\n' };
  const value = manifest(suites, { impact: { adapter: 'typescript', fullPackageGlobs: [{ globs: ['vitest.config.mjs'], suiteIds: ['a', 'b'] }], migrationCheck: { status: 'unsupported', reason: 'None.' } } });
  const after = (path: string, text: string) => changed(input(files, value), input({ ...files, [path]: text }, value));
  const everyone = ['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts', 'b:apps/b/test/b.test.ts'];

  it('changes them all, with what it imports and each file it names', async () => {
    expect(await after('vitest.config.mjs', `${config}// more\n`)).toEqual(everyone);
    expect(await after('apps/b/src/imported.ts', 'export const imported = 2;\n')).toEqual(everyone);
    expect(await after('apps/b/src/named.ts', 'export const named = 2;\n')).toEqual(everyone);
  });

  it('does not tie one package to another by naming its folder, its name or a pattern of its files', async () => {
    expect(await after('apps/b/src/b.ts', 'export const b = 4;\n')).toEqual(['b:apps/b/test/b.test.ts']);
    expect(await after('apps/a/src/deep.ts', 'export const deep = 2;\n')).toEqual(['a:apps/a/test/used.test.ts']);
  });

  it('changes nothing for a document it names', async () => {
    expect(await after('README.md', 'Other')).toEqual([]);
  });
});

describe('when the graph cannot tell', () => {
  it('a computed import makes a file depend on its whole package', async () => {
    const files = { ...app, 'apps/a/src/used.ts': `${app['apps/a/src/used.ts']}export const load = (name: string) => import(name);\n` };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('a computed import in another package makes it depend on that whole package too', async () => {
    const files = { ...app, 'apps/a/src/loader.ts': 'export const load = (name: string) => import(`${name}.js`);\n', 'apps/a/src/pages/one.ts': 'export const one = 1;\n', 'apps/b/test/b.test.ts': "import { load } from '../../a/src/loader.js';\nimport { it } from 'vitest';\nit('b', () => load);\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/pages/one.ts': 'export const one = 2;\n' }, manifest(suites)))).toEqual(['b:apps/b/test/b.test.ts']);
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toContain('b:apps/b/test/b.test.ts');
  });

  /* A language file is loaded as import(`./${id}.js`): it can only load what its own folder holds. */
  it('a computed import under a fixed folder depends on that folder only, not on its whole package', async () => {
    const files = { ...app, 'apps/a/src/pages/loader.ts': 'export const load = (name: string) => import(`./${name}.js`);\n', 'apps/a/src/pages/one.ts': 'export const one = 1;\n', 'apps/b/test/b.test.ts': "import { load } from '../../a/src/pages/loader.js';\nimport { it } from 'vitest';\nit('b', () => load);\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/pages/one.ts': 'export const one = 2;\n' }, manifest(suites)))).toEqual(['b:apps/b/test/b.test.ts']);
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts']);
    const deeper = { ...files, 'apps/a/src/pages/loader.ts': 'export const load = (name: string) => import(`../pages/${name}.js`);\n' };
    expect(await changed(input(deeper, manifest(suites)), input({ ...deeper, 'apps/a/src/pages/one.ts': 'export const one = 2;\n' }, manifest(suites)))).toEqual(['b:apps/b/test/b.test.ts']);
    expect(await changed(input(deeper, manifest(suites)), input({ ...deeper, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts']);
  });

  it('a computed import under a folder that holds nothing, or beside a bare computed one, still depends on the whole package', async () => {
    const empty = { ...app, 'apps/a/src/loader.ts': 'export const load = (name: string) => import(`./nowhere/${name}.js`);\n', 'apps/b/test/b.test.ts': "import { load } from '../../a/src/loader.js';\nimport { it } from 'vitest';\nit('b', () => load);\n" };
    expect(await changed(input(empty, manifest(suites)), input({ ...empty, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toContain('b:apps/b/test/b.test.ts');
    const mixed = { ...empty, 'apps/a/src/pages/one.ts': 'export const one = 1;\n', 'apps/a/src/loader.ts': 'export const load = (name: string) => [import(`./pages/${name}.js`), import(name)];\n' };
    expect(await changed(input(mixed, manifest(suites)), input({ ...mixed, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toContain('b:apps/b/test/b.test.ts');
  });

  it('a program in a language it does not read can lead anywhere in its package', async () => {
    const files = { ...app, 'apps/a/tools/run.sh': 'source ./lib.sh\n', 'apps/a/tools/lib.sh': 'echo 1\n', 'apps/b/test/b.test.ts': "import { it } from 'vitest';\nconst script = new URL('../../a/tools/run.sh', import.meta.url);\nit('b', () => script);\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/tools/lib.sh': 'echo 2\n' }, manifest(suites)))).toContain('b:apps/b/test/b.test.ts');
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toContain('b:apps/b/test/b.test.ts');
  });

  /* The updater's script lies in a folder of its own that no suite holds: it can lead anywhere in that folder, not in every package. */
  it('a program in no package can lead anywhere in its own folder, and no further', async () => {
    const files = { ...app, 'tools/update/run.sh': 'source ./lib.sh\n', 'tools/update/lib.sh': 'echo 1\n', 'apps/b/test/b.test.ts': "import { it } from 'vitest';\nconst script = new URL('../../../tools/update/run.sh', import.meta.url);\nit('b', () => script);\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'tools/update/lib.sh': 'echo 2\n' }, manifest(suites)))).toContain('b:apps/b/test/b.test.ts');
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts']);
  });

  it('a log is data, as a text is', async () => {
    const files = { ...app, 'docs/evidence/red.log': 'not ok 1\n', 'apps/b/test/b.test.ts': "import { it } from 'vitest';\nconst log = new URL('../../../docs/evidence/red.log', import.meta.url);\nit('b', () => log);\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'docs/evidence/red.log': 'ok 1\n' }, manifest(suites)))).toContain('b:apps/b/test/b.test.ts');
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts']);
  });

  it('data leads nowhere, and neither does a fixture of a test folder, which changes its package anyway', async () => {
    const test = (name: string) => `import { it } from 'vitest';\nconst data = new URL('${name}', import.meta.url);\nit('b', () => data);\n`;
    for (const named of ['../../a/data/values.json', '../../a/data/page.css', '../../a/LICENSE', '../../a/test/fakes/program']) {
      const files = { ...app, 'apps/a/data/values.json': '{}', 'apps/a/data/page.css': 'a {}', 'apps/a/LICENSE': 'Yours', 'apps/a/test/fakes/program': 'echo 1', 'apps/b/test/b.test.ts': test(named) };
      expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).not.toContain('b:apps/b/test/b.test.ts');
    }
  });

  it('a file with no extension that may run is a program', async () => {
    const files = { ...app, 'apps/a/tools/run': 'echo 1\n', 'apps/b/test/b.test.ts': "import { it } from 'vitest';\nconst script = new URL('../../a/tools/run', import.meta.url);\nit('b', () => script);\n" };
    const executable = (given: FingerprintInput): FingerprintInput => ({ ...given, tracked: given.tracked.map(entry => entry.path === 'apps/a/tools/run' ? { ...entry, mode: '100755' } : entry) });
    const after = { ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' };
    expect(await changed(executable(input(files, manifest(suites))), executable(input(after, manifest(suites))))).toContain('b:apps/b/test/b.test.ts');
    expect(await changed(input(files, manifest(suites)), input(after, manifest(suites)))).not.toContain('b:apps/b/test/b.test.ts');
  });

  it('an import of a package nobody declares does too, such as a path alias', async () => {
    const files = { ...app, 'apps/a/src/used.ts': "import { x } from '@/deep';\nexport const used = x;\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('a relative import that leads to no tracked file does too', async () => {
    const files = { ...app, 'apps/a/src/used.ts': "import { x } from './generated.js';\nexport const used = x;\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('a link or a submodule it reaches does too', async () => {
    const files = { ...app, 'apps/a/src/used.ts': "import { x } from './linked.js';\nexport const used = x;\n", 'apps/a/src/linked.ts': '../../b/src/b.ts' };
    const linked = (given: Files) => { const value = input(given, manifest(suites)); value.tracked = value.tracked.map(entry => entry.path === 'apps/a/src/linked.ts' ? { ...entry, mode: '120000' } : entry); value.texts = new Map(codeFilesOf(value.tracked).map(path => [path, given[path]!])); return value; };
    expect(await changed(linked(files), linked({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('a code file left out of what was read does too', async () => {
    const without = (given: Files) => { const value = input(given, manifest(suites)); value.texts = new Map([...value.texts].filter(([path]) => path !== 'apps/a/src/deep.ts')); return value; };
    expect(await changed(without(app), without({ ...app, 'apps/a/src/other.ts': 'export const other = 3;\n' }))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });

  it('a suite of another language depends on its whole package, without reading a line', async () => {
    const files = { ...app, 'py/app.py': 'x = 1\n', 'py/tests/test_a.py': 'def test(): pass\n', 'py/tests/test_b.py': 'def test(): pass\n' };
    const value = manifest([...suites, suite('py', 'py', { files: ['py/tests/*.py'], split: { kind: 'argv-files' } })]);
    const given = input(files, value);
    expect([...given.texts.keys()].filter(path => path.startsWith('py/'))).toEqual([]);
    expect(await changed(given, input({ ...files, 'py/app.py': 'x = 2\n' }, value))).toEqual(['py:py/tests/test_a.py', 'py:py/tests/test_b.py']);
  });

  it('a suite that cannot be split shares its package', async () => {
    const value = manifest([suite('a', 'apps/a', { split: { kind: 'whole-package' } }), suite('b', 'apps/b')]);
    expect(await changed(input(app, value), input({ ...app, 'apps/a/src/other.ts': 'export const other = 3;\n' }, value))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
  });
});

describe('what the scanner follows', () => {
  const reaching = (files: Files, from: string) => testGraph(input(files, manifest(suites))).closure(from);

  it('a workspace package by its name, and not the root by its own', async () => {
    const files = { ...app, 'apps/a/src/used.ts': "import { b } from '@x/b';\nexport const used = b;\n" };
    expect(reaching(files, 'apps/a/test/used.test.ts')).toContain('apps/b/src/b.ts');
    const word = { ...app, 'apps/a/src/used.ts': "export const used = 'root';\n" };
    expect(reaching(word, 'apps/a/test/used.test.ts')).not.toContain('apps/b/src/b.ts');
  });

  it('every way of importing', async () => {
    const files: Files = { ...app, 'apps/a/src/one.tsx': '', 'apps/a/src/two/index.ts': '', 'apps/a/src/three.mts': '', 'apps/a/src/four.css': '', 'apps/a/src/five.json': '{}', 'apps/a/src/six.ts': '', 'apps/a/src/seven.ts': '', 'apps/a/src/eight.ts': '',
      'apps/a/src/used.ts': "import './one.js';\nexport * from './two';\nconst x = await import('./three.mjs');\nimport './four.css?raw';\nimport data from './five.json' with { type: 'json' };\nimport type { A } from './six';\nvi.mock('./seven.js');\nconst y = require('./eight');\nexport { x, y, data };\n" };
    const found = reaching(files, 'apps/a/test/used.test.ts');
    for (const name of ['one.tsx', 'two/index.ts', 'three.mts', 'four.css', 'five.json', 'seven.ts', 'eight.ts']) expect(found).toContain(`apps/a/src/${name}`);
    expect(found).not.toContain('apps/a/src/six.ts');
  });

  it('files named by a path in the code, relative, from the package or from the repository', async () => {
    const files: Files = { ...app, 'apps/a/data/one.txt': '1', 'apps/a/two.txt': '2', 'shared/three.txt': '3', 'apps/a/folder/four.txt': '4', 'apps/a/folder/deep/five.txt': '5',
      'apps/a/test/used.test.ts': "const one = new URL('../data/one.txt', import.meta.url);\nconst two = readFileSync('two.txt');\nconst three = readFileSync('shared/three.txt');\nconst folder = new URL('../folder', import.meta.url);\nexport { one, two, three, folder };\n" };
    const found = reaching(files, 'apps/a/test/used.test.ts');
    for (const name of ['apps/a/data/one.txt', 'apps/a/two.txt', 'shared/three.txt', 'apps/a/folder/four.txt', 'apps/a/folder/deep/five.txt']) expect(found).toContain(name);
  });

  it('a folder or a pattern named from the package or from the repository', async () => {
    const reader = (named: string) => `import { it } from 'vitest';\nconst at = '${named}';\nit('reads', () => at);\n`;
    for (const [test, named] of [['apps/a/test/reads.test.ts', 'src/pages'], ['apps/a/test/reads.test.ts', 'src/pages/'], ['apps/a/test/reads.test.ts', 'src/**/*.ts'], ['apps/a/test/reads.test.ts', '/src/pages/*.ts'], ['apps/b/test/reads.test.ts', 'apps/a/src/pages'], ['apps/b/test/reads.test.ts', 'apps/a/src/pages/*.ts']] as const) {
      const files: Files = { ...app, 'apps/a/src/pages/one.ts': 'export const one = 1;\n', [test]: reader(named) };
      expect(reaching(files, test), named).toContain('apps/a/src/pages/one.ts');
    }
  });

  it('a word, an address, a package by its folder or a pattern without a folder is not a folder it reads', async () => {
    const reader = (named: string) => `import { it } from 'vitest';\nconst at = '${named}';\nit('reads', () => at);\n`;
    for (const named of ['src', '/', '/src', '*', '*.ts', '*/*', 'text/plain', 'apps/a']) {
      const files: Files = { ...app, 'apps/a/src/one.ts': 'export const one = 1;\n', 'apps/a/test/reads.test.ts': reader(named), 'apps/b/test/reads.test.ts': reader(named) };
      expect(reaching(files, 'apps/a/test/reads.test.ts'), named).not.toContain('apps/a/src/one.ts');
      expect(reaching(files, 'apps/b/test/reads.test.ts'), named).not.toContain('apps/a/src/one.ts');
    }
  });

  it('a pattern in the code under test is a rule about paths, unless it imports what it names', async () => {
    const files: Files = { ...app, 'apps/a/src/pages/one.ts': 'export const one = 1;\n', 'apps/a/src/pages/two.ts': 'export const two = 2;\n',
      'apps/a/src/rules.ts': "export const rules = ['src/pages/*.ts', 'apps/a/src/pages/*.ts'];\n", 'apps/a/src/glob.ts': "export const pages = import.meta.glob('/src/pages/*.ts');\n" };
    expect(reaching(files, 'apps/a/src/rules.ts')).not.toContain('apps/a/src/pages/one.ts');
    expect(reaching(files, 'apps/a/src/glob.ts')).toContain('apps/a/src/pages/two.ts');
  });

  it('follows each typed Vite import glob relative to the importing file', async () => {
    const from = 'apps/a/src/packs/load.ts';
    const files: Files = {
      ...app,
      [from]: "export const files = import.meta.glob<Record<string, string>>(['../locales/??.ts', './*/locales/??-*.ts', '!../locales/zz.ts'], { eager: true });\n",
      'apps/a/src/locales/ru.ts': '',
      'apps/a/src/locales/zz.ts': '',
      'apps/a/src/locales/guide.ts': '',
      'apps/a/src/packs/one/locales/pt-BR.ts': '',
      'apps/a/src/packs/one/locales/ru.ts': '',
    };

    expect([...reaching(files, from)].sort()).toEqual([
      'apps/a/src/locales/ru.ts',
      from,
      'apps/a/src/packs/one/locales/pt-BR.ts',
    ]);
  });

  it('a pattern leaves out documents unless it asks for them', async () => {
    const files: Files = { ...app, 'apps/a/docs/one.md': '1', 'apps/a/docs/one.txt': '1', 'apps/a/test/a.test.ts': "const a = 'docs/*';\n", 'apps/a/test/b.test.ts': "const b = 'docs/*.md';\n" };
    expect([...reaching(files, 'apps/a/test/a.test.ts')].sort()).toEqual(['apps/a/docs/one.txt', 'apps/a/test/a.test.ts']);
    expect([...reaching(files, 'apps/a/test/b.test.ts')].sort()).toEqual(['apps/a/docs/one.md', 'apps/a/test/b.test.ts']);
  });

  it('a path to a built folder leads to what it is built from', async () => {
    const value = manifest(suites, { prepare: [{ id: 'build', profiles: ['fast'], serviceIds: [], inputs: ['apps/b/src/**'], commands: [], artifacts: [{ path: 'apps/b/dist', format: 'directory' }] }] });
    const files = { ...app, 'apps/a/test/other.test.ts': "import { b } from '../../b/dist/b.js';\nimport { it } from 'vitest';\nit('b', () => b);\n" };
    expect(await changed(input(files, value), input({ ...files, 'apps/b/src/b.ts': 'export const b = 4;\n' }, value))).toEqual(['a:apps/a/test/other.test.ts', 'b:apps/b/test/b.test.ts']);
  });

  /* The node's output capture loads the built mask by its file: it read as the whole build, and any test that reached the
     terminal ran again for any change of the node. */
  it('a built file leads to its own source, and a built file of no source of its name or the built folder to all it is built from', async () => {
    const value = manifest(suites, { prepare: [{ id: 'build', profiles: ['fast'], serviceIds: [], inputs: ['apps/b/src/**'], commands: [], artifacts: [{ path: 'apps/b/dist', format: 'directory' }] }] });
    const files: Files = { ...app, 'apps/b/src/c.ts': 'export const c = 5;\n',
      'apps/a/test/file.test.ts': "const { b } = require('../../b/dist/b.js');\nexport { b };\n",
      'apps/a/test/asset.test.ts': "const { b } = require('../../b/dist/b.json');\nexport { b };\n",
      'apps/a/test/folder.test.ts': "const built = '../../b/dist';\nexport { built };\n" };
    const other = 'apps/b/src/c.ts';
    expect(await changed(input(files, value), input({ ...files, [other]: 'export const c = 6;\n' }, value))).toEqual(['a:apps/a/test/asset.test.ts', 'a:apps/a/test/folder.test.ts']);
    expect(await changed(input(files, value), input({ ...files, 'apps/b/src/b.ts': 'export const b = 4;\n' }, value))).toEqual(['a:apps/a/test/asset.test.ts', 'a:apps/a/test/file.test.ts', 'a:apps/a/test/folder.test.ts', 'b:apps/b/test/b.test.ts']);
  });

  it('a dotted folder of its own never takes the whole repository', async () => {
    const files = { ...app, 'apps/a/test/used.test.ts': "const root = new URL('../..', import.meta.url);\nconst here = new URL('./', import.meta.url);\nexport { root, here };\n" };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/b/src/b.ts': 'export const b = 4;\n' }, manifest(suites)))).toEqual(['b:apps/b/test/b.test.ts']);
  });

  it('text that only reads like an import, as SQL, leaves a file readable', async () => {
    const text = `const rows = await sql\`select * from "tasks"\`;\nconst note = 'taken from "somewhere"';\nexport { rows, note };\n`;
    const files = { ...app, 'apps/a/src/used.ts': text };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts']);
  });

  it('an import over several lines', async () => {
    const files = { ...app, 'apps/a/src/used.ts': "import {\n  deep,\n  type Deep,\n} from './deep.js';\nexport const used = deep;\n" };
    expect(reaching(files, 'apps/a/test/used.test.ts')).toContain('apps/a/src/deep.ts');
  });

  it('a package of the repository named only in a string', async () => {
    const files = { ...app, 'apps/a/test/used.test.ts': "const name = '@x/b';\nawait import(name);\n" };
    expect(reaching(files, 'apps/a/test/used.test.ts')).toContain('apps/b/src/b.ts');
  });

  it('files that import each other change together, and what imports them with them', async () => {
    const files: Files = { ...app, 'apps/a/src/deep.ts': "import { used } from './used.js';\nexport const deep = used;\n" };
    expect(reaching(files, 'apps/a/test/used.test.ts')).toContain('apps/a/src/deep.ts');
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/deep.ts': `${files['apps/a/src/deep.ts']}// more\n` }, manifest(suites)))).toEqual(['a:apps/a/test/used.test.ts']);
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/used.ts': `${files['apps/a/src/used.ts']}// more\n` }, manifest(suites)))).toEqual(['a:apps/a/test/used.test.ts']);
  });
});

describe('scenarios that drive the app', () => {
  const browser = suite('browser', 'apps/web', { files: ['apps/web/e2e/**/*.spec.ts'], split: { kind: 'argv-files' }, scenarioSources: 'apps/web/src' });
  const web: Files = {
    'package.json': '{"name":"root","devDependencies":{"@playwright/test":"1"}}',
    'apps/web/e2e/agent-card-long.spec.ts': "import { test } from '@playwright/test';\nimport { open } from './api';\ntest('x', () => open);\n",
    'apps/web/e2e/tree.spec.ts': "import { test } from '@playwright/test';\ntest('x', () => {});\n",
    'apps/web/e2e/about.spec.ts': "import { test } from '@playwright/test';\ntest('x', () => {});\n",
    'apps/web/e2e/api.ts': 'export const open = 1;\n',
    'apps/web/src/ui/AgentCard.tsx': "import { dot } from './dot';\nexport const AgentCard = dot;\n",
    'apps/web/src/ui/dot.ts': 'export const dot = 1;\n',
    'apps/web/src/screens/TreeView.tsx': 'export const TreeView = 1;\n',
    'apps/web/src/screens/Tree.tsx': "import { TreeView } from './TreeView';\nexport const Tree = TreeView;\n",
    'apps/web/src/App.tsx': 'export const App = 1;\n',
  };
  const value = manifest([browser]);
  const after = (path: string, text: string) => changed(input(web, value), input({ ...web, [path]: text }, value));
  const every = ['browser:apps/web/e2e/about.spec.ts', 'browser:apps/web/e2e/agent-card-long.spec.ts', 'browser:apps/web/e2e/tree.spec.ts'];

  /* A scenario opens the app, and the app may show any screen on the way: one that reads another route breaks a scenario of another name. */
  it('a scenario follows every screen of the app it opens, and all they import, whatever it is named after', async () => {
    expect(await after('apps/web/src/screens/TreeView.tsx', 'export const TreeView = 2;\n')).toEqual(every);
    expect(await after('apps/web/src/ui/dot.ts', 'export const dot = 2;\n')).toEqual(every);
    expect(await after('apps/web/src/App.tsx', 'export const App = 2;\n')).toEqual(every);
  });

  it('a source a rule gives to every scenario changes every scenario and no other test', async () => {
    const files = { ...web, 'apps/web/src/App.tsx': "import { Tree } from './screens/Tree';\nexport const App = Tree;\n", 'apps/web/test/app.test.ts': "import { it } from 'vitest';\nit('x', () => {});\n" };
    const rule = manifest([browser, suite('web', 'apps/web/test', { files: ['apps/web/test/**/*.test.ts'] })], { impact: { adapter: 'typescript', fullPackageGlobs: [{ globs: ['apps/web/src/App.tsx'], suiteIds: ['browser'] }], migrationCheck: { status: 'unsupported', reason: 'None.' } } });
    expect(await changed(input(files, rule), input({ ...files, 'apps/web/src/App.tsx': `${files['apps/web/src/App.tsx']}// more\n` }, rule))).toEqual(every);
  });

  it('a helper of a scenario changes those who import it', async () => {
    expect(await after('apps/web/e2e/api.ts', 'export const open = 2;\n')).toEqual(['browser:apps/web/e2e/agent-card-long.spec.ts']);
  });
});

describe('source files mutation checks', () => {
  const mutation: TestEnvironmentV1['mutation'] = { status: 'supported', language: 'typescript', tool: 'mutator', command: { program: 'mutator', args: [], cwd: '.' }, sourcePaths: ['apps/a/src/used.ts'], fastTestPaths: ['apps/a/test/used.test.ts', 'apps/a/test/other.test.ts'], coverageCommands: [{ program: 'x', args: [], cwd: '.' }], coverageFiles: ['coverage/lcov.info'] };
  const value = manifest([...suites, suite('mutation', 'scripts/mutation', { files: ['apps/a/src/used.ts'], run: { program: 'node', args: ['mutate.mjs'], cwd: '.' }, split: { kind: 'json-file' } })], { mutation });
  const key = 'mutation:apps/a/src/used.ts';
  const after = async (path: string, text: string) => (await changed(input(app, value), input({ ...app, [path]: text }, value))).filter(item => item === key);

  it('run against the fast tests that reach them, and only those', () => {
    if (mutation.status !== 'supported') throw new Error('The fixture supports mutation.');
    const reached = fastTestsOf(input(app, value), mutation, ['apps/a/src/used.ts', 'apps/a/src/deep.ts']);
    expect(reached.get('apps/a/src/used.ts')).toEqual(['apps/a/test/used.test.ts']);
    expect(reached.get('apps/a/src/deep.ts')).toEqual(['apps/a/test/used.test.ts']);
  });

  it('follow their own text and the fast tests that reach it', async () => {
    expect(await after('apps/a/src/used.ts', `${app['apps/a/src/used.ts']}// more\n`)).toEqual([key]);
    expect(await after('apps/a/test/used.test.ts', `${app['apps/a/test/used.test.ts']}// more\n`)).toEqual([key]);
  });

  it('follow what their source imports because it can change the judges outcome', async () => {
    expect(await after('apps/a/src/deep.ts', 'export const deep = 2;\n')).toEqual([key]);
  });

  it.each(['apps/a/test/helper.ts', 'apps/a/test/deep-helper.ts', 'apps/b/src/config-helper.ts'])('follow transitive judges input %s', async path => {
    const files = { ...app,
      'apps/a/test/used.test.ts': `${app['apps/a/test/used.test.ts']}\nimport './helper.js';`,
      'apps/a/test/helper.ts': "import './deep-helper.js';\nexport {};",
      'apps/a/test/deep-helper.ts': 'export {};',
      'scripts/mutation/vitest.config.mjs': "import '../../apps/b/src/config-helper.js';\nexport default {};",
      'apps/b/src/config-helper.ts': 'export {};',
    };
    expect(await changed(input(files, value), input({ ...files, [path]: 'export const weakened = true;' }, value))).toContain(key);
  });

  it('cannot reuse mutation judges when an opaque config may load a changed file outside its package', async () => {
    const files = { ...app,
      'scripts/mutation/vitest.config.mjs': 'const config = process.env.JUDGE_CONFIG;\nexport default await import(config);',
      'apps/b/judge-options.json': '{"strict":true}',
    };
    expect(await changed(input(files, value), input({ ...files, 'apps/b/judge-options.json': '{"strict":false}' }, value))).toContain(key);
  });

  it('follows the mode of an imported helper with identical bytes', async () => {
    const files = { ...app, 'apps/a/test/used.test.ts': `${app['apps/a/test/used.test.ts']}\nimport './helper.js';`, 'apps/a/test/helper.ts': 'export {};' };
    const before = input(files, value), after = input(files, value);
    after.tracked = after.tracked.map(entry => entry.path === 'apps/a/test/helper.ts' ? { ...entry, mode: '100755' } : entry);
    expect(await changed(before, after)).toContain(key);
  });

  it('follow what runs them', async () => {
    const files = { ...app, 'scripts/mutation/run.mjs': 'export {};\n' };
    expect(await changed(input(files, value), input({ ...files, 'scripts/mutation/run.mjs': 'export const x = 1;\n' }, value))).toEqual([key]);
  });

  it('not a fast test that does not reach them, a configuration or another source', async () => {
    expect(await after('apps/a/test/other.test.ts', `${app['apps/a/test/other.test.ts']}// more\n`)).toEqual([]);
    expect(await after('apps/a/src/other.ts', 'export const other = 3;\n')).toEqual([]);
    expect(await changed(input({ ...app, 'apps/a/vitest.config.ts': '' }, value), input({ ...app, 'apps/a/vitest.config.ts': '// more' }, value))).not.toContain(key);
  });
});

describe('the one explicit preparation', () => {
  const value = manifest(suites, { execution: { version: 2, oncePreparation: { profiles: ['fast'], suiteIds: ['a'], commands: [{ program: 'npm', args: ['run', 'lint'], cwd: '.' }] } } });
  const key = 'hornhoof-preparation:.hornhoof/test-environment.json';

  it('has a fingerprint of the whole tree, documents apart', async () => {
    expect((await prints(input(app, value))).has(key)).toBe(true);
    expect(await changed(input(app, value), input({ ...app, 'apps/b/src/b.ts': 'export const b = 4;\n' }, value))).toContain(key);
    expect(await changed(input(app, value), input({ ...app, 'README.md': 'Other' }, value))).toEqual([]);
  });

  it.each(['CHANGELOG.md', 'AGENTS.md', 'CONTRIBUTING.md', 'apps/a/test/fixtures/README.md'])('includes checked Markdown %s in preparation', async path => {
    const files = { ...app, [path]: 'Before' };
    expect(await changed(input(files, value), input({ ...files, [path]: 'After' }, value))).toContain(key);
  });

  it('is absent where a manifest declares none', async () => {
    expect((await prints(base())).has(key)).toBe(false);
  });
});

describe('while it works', () => {
  it('lets other work through', async () => {
    const files: Files = { ...app };
    for (let index = 0; index < 100; index += 1) files[`apps/a/src/f${index}.ts`] = 'export {};\n';
    let pauses = 0;
    await fingerprintUnits(input(files, manifest(suites)), async () => { pauses += 1; });
    expect(pauses).toBeGreaterThan(0);
  });

  it('stops when its pause says so', async () => {
    const files: Files = { ...app };
    for (let index = 0; index < 100; index += 1) files[`apps/a/src/f${index}.ts`] = 'export {};\n';
    await expect(fingerprintUnits(input(files, manifest(suites)), () => Promise.reject(new Error('stopped')))).rejects.toThrow('stopped');
  });
});
