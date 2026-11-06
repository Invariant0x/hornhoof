import { createHash } from 'node:crypto';
import type { EnvironmentDescription, TestEnvironmentV1, TestUnit } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { codeFilesOf, fingerprintUnits, testGraph, type FingerprintInput } from '../src/test-fingerprint.js';

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

  it('changes everywhere with the dependency inputs or a runtime version, but not with the machine', async () => {
    const everyone = ['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts', 'b:apps/b/test/b.test.ts'];
    expect(await changed(base(), edit('package-lock.json', '{"new":1}'))).toEqual(everyone);
    expect(await changed(base(), input(app, manifest(suites), { runtimeCapabilities: [{ id: 'node', version: '22.2.0', fingerprint: 'a'.repeat(64) }] }))).toEqual(everyone);
    expect(await changed(base(), input(app, manifest(suites), { runtimeCapabilities: [{ id: 'node', version: '22.1.0', fingerprint: 'b'.repeat(64) }] }))).toEqual([]);
  });

  it('changes everywhere with the suite command of its own, not of another suite', async () => {
    expect(await changed(base(), input(app, manifest([suite('a', 'apps/a', { run: { ...run, args: ['vitest', 'run', '--bail'] } }), suite('b', 'apps/b')])))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
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

describe('when the graph cannot tell', () => {
  it('a computed import makes a file depend on its whole package', async () => {
    const files = { ...app, 'apps/a/src/used.ts': `${app['apps/a/src/used.ts']}export const load = (name: string) => import(name);\n` };
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/other.ts': 'export const other = 3;\n' }, manifest(suites)))).toEqual(['a:apps/a/test/other.test.ts', 'a:apps/a/test/used.test.ts']);
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
    for (const name of ['one.tsx', 'two/index.ts', 'three.mts', 'four.css', 'five.json', 'six.ts', 'seven.ts', 'eight.ts']) expect(found).toContain(`apps/a/src/${name}`);
  });

  it('files named by a path in the code, relative, from the package or from the repository', async () => {
    const files: Files = { ...app, 'apps/a/data/one.txt': '1', 'apps/a/two.txt': '2', 'shared/three.txt': '3', 'apps/a/folder/four.txt': '4', 'apps/a/folder/deep/five.txt': '5',
      'apps/a/test/used.test.ts': "const one = new URL('../data/one.txt', import.meta.url);\nconst two = readFileSync('two.txt');\nconst three = readFileSync('shared/three.txt');\nconst folder = new URL('../folder', import.meta.url);\nexport { one, two, three, folder };\n" };
    const found = reaching(files, 'apps/a/test/used.test.ts');
    for (const name of ['apps/a/data/one.txt', 'apps/a/two.txt', 'shared/three.txt', 'apps/a/folder/four.txt', 'apps/a/folder/deep/five.txt']) expect(found).toContain(name);
  });

  it('a path to a built folder leads to what it is built from', async () => {
    const value = manifest(suites, { prepare: [{ id: 'build', profiles: ['fast'], serviceIds: [], inputs: ['apps/b/src/**'], commands: [], artifacts: [{ path: 'apps/b/dist', format: 'directory' }] }] });
    const files = { ...app, 'apps/a/test/other.test.ts': "import { b } from '../../b/dist/b.js';\nimport { it } from 'vitest';\nit('b', () => b);\n" };
    expect(await changed(input(files, value), input({ ...files, 'apps/b/src/b.ts': 'export const b = 4;\n' }, value))).toEqual(['a:apps/a/test/other.test.ts', 'b:apps/b/test/b.test.ts']);
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
    const files = { ...app, 'apps/a/src/deep.ts': "import { used } from './used.js';\nexport const deep = used;\n" };
    expect(reaching(files, 'apps/a/test/used.test.ts')).toContain('apps/a/src/deep.ts');
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/deep.ts': `${files['apps/a/src/deep.ts']}// more\n` }, manifest(suites)))).toEqual(['a:apps/a/test/used.test.ts']);
    expect(await changed(input(files, manifest(suites)), input({ ...files, 'apps/a/src/used.ts': `${files['apps/a/src/used.ts']}// more\n` }, manifest(suites)))).toEqual(['a:apps/a/test/used.test.ts']);
  });
});

describe('scenarios that drive a screen', () => {
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

  it('a scenario named after a screen follows that screen, and all it imports', async () => {
    expect(await after('apps/web/src/screens/TreeView.tsx', 'export const TreeView = 2;\n')).toEqual(['browser:apps/web/e2e/about.spec.ts', 'browser:apps/web/e2e/tree.spec.ts']);
    expect(await after('apps/web/src/ui/dot.ts', 'export const dot = 2;\n')).toEqual(['browser:apps/web/e2e/about.spec.ts', 'browser:apps/web/e2e/agent-card-long.spec.ts']);
  });

  it('a scenario named after no screen follows them all', async () => {
    expect(await after('apps/web/src/App.tsx', 'export const App = 2;\n')).toEqual(['browser:apps/web/e2e/about.spec.ts']);
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

  it('follow their own code and the fast tests that reach it', async () => {
    expect(await after('apps/a/src/deep.ts', 'export const deep = 2;\n')).toEqual([key]);
    expect(await after('apps/a/test/used.test.ts', `${app['apps/a/test/used.test.ts']}// more\n`)).toEqual([key]);
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
