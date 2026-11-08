import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { realPorts } from '../author-check/main.mjs';
import { fastSuites, selectTests } from '../author-check/select.mjs';
import { runStages } from '../author-check/stages.mjs';
import { selectionPorts } from '../author-check/wired.mjs';
import { trackedIn } from './tracked-files.mjs';

/* The real test environment, the real selector and the real import graph: what a change of each group runs. */
const root = fileURLToPath(new URL('../..', import.meta.url));
const ALL = ['node', 'protocol', 'release-scripts', 'server', 'web'];
const BUILT = ['packages/protocol/dist/index.js', 'apps/node/dist/test-impact.js'];
let manifest, ports;

before(async () => {
  if (!BUILT.every(file => existsSync(root + file))) for (const name of ['protocol', 'node']) execFileSync('npm', ['run', '-s', 'build', '-w', `@hornhoof/${name}`], { cwd: root, stdio: 'ignore' });
  const { parseTestEnvironment } = await import('@hornhoof/protocol');
  manifest = parseTestEnvironment(readFileSync(`${root}.hornhoof/test-environment.json`, 'utf8'));
  ports = await selectionPorts(root);
});

const select = (changes, added = []) => selectTests({ changes, manifest, tracked: [...trackedIn(root), ...added], allowWhole: false }, ports);
const runs = path => select([{ path, kind: 'modified' }]);
const suites = selection => (selection.packages ?? []).map(item => item.packageId).sort();

for (const [group, path, expected] of [
  ['the backend', 'apps/server/src/modules/tasks/wait-policy.ts', ['server']],
  ['the frontend', 'apps/web/src/ui/AgentTerminal.tsx', ['web']],
  ['the node and its terminals', 'apps/node/src/terminal/input.ts', ['node']],
  ['the shared protocol', 'packages/protocol/src/index.ts', ALL],
  ['a test of the shared protocol', 'packages/protocol/test/test-environment.test.ts', ['protocol']],
  ['a fixture of the shared protocol', 'packages/protocol/test/fixtures/hornhoof-test-environment-v1.json', ['protocol', 'server']],
  ['the database', 'apps/server/drizzle/0075_internal_first_questions.sql', ['server']],
  ['the database schema', 'apps/server/src/db/schema.ts', ['server']],
  ['a test only the final profile runs', 'apps/server/test/postgres/locking.pg.spec.ts', []],
  ['the selection itself', 'apps/node/src/test-impact.ts', ['node', 'release-scripts']],
  ['the fingerprints of test files', 'apps/node/src/test-fingerprint.ts', ['node', 'release-scripts']],
  ['a risky source of the node, which mutation also lists', 'apps/node/src/redact.ts', ['node']],
  ['a risky source of the server, which mutation also lists', 'apps/server/src/auth/password.ts', ['server']],
  ['the workflow of a build', '.github/workflows/images.yml', ['release-scripts', 'server']],
  ['the installer', 'scripts/install.sh', ['release-scripts', 'server']],
  ['the updater', 'apps/updater/updater.sh', ['release-scripts', 'server']],
  ['the image of the app', 'Dockerfile', ['release-scripts', 'server']],
  ['the compose file', 'compose.yaml', ['release-scripts', 'server']],
  ['a browser scenario', 'apps/web/e2e/about.spec.ts', []],
  ['a document', 'README.md', []],
]) {
  test(`a change of ${group} runs ${expected.join(', ') || 'no suite'}`, { timeout: 60_000 }, async () => {
    const selection = await runs(path);
    assert.equal(selection.unavailable, undefined);
    assert.deepEqual(suites(selection), expected);
  });
}

/* Templates are text the server and the node read while they run, which no import graph sees: a rule names the tests that read them. */
const READS_TEMPLATES = /\.\.\/templates\b|\bctx\.templates\b|\btemplates\s*\}\s*=\s*[\w.]*ctx\b|\bloadTemplates\(/;
const fastFiles = () => {
  const fast = new Set(fastSuites(manifest).map(suite => suite.id));
  return [...new Set(ports.listTestUnits(manifest, trackedIn(root)).filter(unit => fast.has(unit.suiteId)).map(unit => unit.file))].sort();
};
const chosen = selection => (selection.packages ?? []).map(item => [item.packageId, item.mode]);
const filesOf = selection => (selection.packages ?? []).flatMap(item => item.units.map(unit => unit.file)).sort();

test('a change of the templates or the skills runs every test that reads them and no other', { timeout: 60_000 }, async () => {
  const readers = fastFiles().filter(file => READS_TEMPLATES.test(readFileSync(root + file, 'utf8')));
  assert.ok(readers.length >= 20, readers.join('\n'));
  for (const path of ['templates/roles/operations/OPS-HEAD.md', 'templates/skills/dev-tdd.md']) {
    const selection = await runs(path);
    assert.equal(selection.unavailable, undefined);
    assert.deepEqual(chosen(selection), [['node', 'related'], ['server', 'related']], path);
    assert.deepEqual(filesOf(selection), readers, path);
  }
});

test('a change of the templates beside a test runs that test and the readers of the templates, not the whole suite', { timeout: 60_000 }, async () => {
  const test = 'apps/server/test/test-tool-text.test.ts';
  const selection = await select([{ path: 'templates/skills/hh-run-checks.md', kind: 'modified' }, { path: test, kind: 'modified' }]);
  assert.deepEqual(chosen(selection), [['node', 'related'], ['server', 'related']]);
  assert.ok(filesOf(selection).includes(test) && filesOf(selection).includes('apps/server/test/templates.test.ts'));
});

test('a fixture of the shared protocol runs its own package and only the server test that reads it', { timeout: 60_000 }, async () => {
  const selection = await runs('packages/protocol/test/fixtures/hornhoof-test-environment-v1.json');
  assert.deepEqual(chosen(selection), [['protocol', 'whole-package'], ['server', 'related']]);
  assert.deepEqual(selection.packages[1].units.map(unit => unit.file), ['apps/server/test/test-run-product-config.test.ts']);
});

test('a change a person sees names the browser scenarios of its screen, says when it has none, and a scenario names itself alone', { timeout: 60_000 }, async () => {
  const named = async path => (await runs(path)).notes.filter(note => note.startsWith('browser '));
  assert.deepEqual(await named('apps/web/e2e/about.spec.ts'), ['browser scenario: apps/web/e2e/about.spec.ts']);
  assert.deepEqual(await named('apps/web/e2e/gone.spec.ts'), []);
  assert.deepEqual(await named('apps/web/e2e/README.md'), []);
  assert.deepEqual(await named('apps/web/e2e/api.ts'), ['browser helper, its scenarios run at the release: apps/web/e2e/api.ts']);
  assert.deepEqual(await named('apps/web/src/ui/AgentTerminal.tsx'), ['browser scenario: apps/web/e2e/agent-terminal-fit.spec.ts']);
  assert.deepEqual(await named('apps/web/src/screens/TreeView.tsx'), ['browser scenario: apps/web/e2e/tree.spec.ts']);
  assert.deepEqual(await named('apps/web/src/App.tsx'), ['browser scenario by hand, none is named after: apps/web/src/App.tsx']);
  assert.deepEqual(await named('apps/web/src/theme.css'), ['browser scenario by hand, none is named after: apps/web/src/theme.css']);
  assert.deepEqual(await named('apps/server/src/modules/tasks/wait-policy.ts'), []);
});

test('a scenario that changed says so once', { timeout: 60_000 }, async () => {
  assert.deepEqual((await runs('apps/web/e2e/about.spec.ts')).notes, ['browser scenario: apps/web/e2e/about.spec.ts']);
});

test('a file moved into the scenarios still runs the tests of where it was', { timeout: 60_000 }, async () => {
  const selection = await select([{ kind: 'renamed', previousPath: 'apps/web/src/ui/AgentTerminal.tsx', path: 'apps/web/e2e/moved.ts' }]);
  assert.deepEqual(suites(selection), ['web']);
});

test('a renamed screen still names the scenarios of its old name', { timeout: 60_000 }, async () => {
  const selection = await select([{ kind: 'renamed', previousPath: 'apps/web/src/ui/AgentTerminal.tsx', path: 'apps/web/src/ui/Console.tsx' }]);
  assert.ok(selection.notes.includes('browser scenario: apps/web/e2e/agent-terminal-fit.spec.ts'), selection.notes.join('\n'));
});

test('a new test only the final profile runs does not stop the check, and says where it runs', { timeout: 60_000 }, async () => {
  const path = 'apps/server/test/postgres/new.pg.spec.ts';
  const selection = await select([{ path, kind: 'added' }], [{ path, mode: '100644', oid: 'a'.repeat(40) }]);
  assert.equal(selection.unavailable, undefined);
  assert.deepEqual(suites(selection), []);
  assert.deepEqual(selection.notes, [`runs in the final profile: ${path}`]);
});

test('the shared protocol takes every suite without being asked, unless another path asks for everything by itself', { timeout: 60_000 }, async () => {
  const modified = path => ({ path, kind: 'modified' });
  assert.deepEqual(suites(await select(['packages/protocol/src/index.ts', 'apps/server/drizzle/0075_internal_first_questions.sql'].map(modified))), ALL);
  for (const paths of [['Dockerfile', 'packages/protocol/src/index.ts'], ['packages/protocol/src/index.ts', 'Dockerfile'], ['apps/node/src/test-impact.ts', 'packages/protocol/src/index.ts']]) {
    assert.deepEqual(suites(await select(paths.map(modified))), ALL, paths.join(' + '));
  }
  assert.equal((await select(['package.json', 'packages/protocol/package.json'].map(modified))).unavailable, 'selection_is_whole_suite');
  assert.equal((await runs('package.json')).unavailable, 'selection_is_whole_suite');
});

/* The real command of a real suite: the fake ports of the check's own tests cannot tell that its config asks for more. */
async function ranFiles(t, selection) {
  const tmp = mkdtempSync(join(tmpdir(), 'hh-groups-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  let output = '';
  const real = { ...realPorts(root, text => { output += text; }), mkdir: () => {} };
  const plan = { sha: 'a'.repeat(40), base: 'b'.repeat(40), changes: [], hunks: {}, grown: {} };
  const result = await runStages({ sha: plan.sha, tmp, scripts: {}, suites: fastSuites(manifest).map(suite => ({ ...suite, finalChecks: [] })), plan, selection }, real);
  assert.equal(result.stages.find(stage => stage.name === 'tests').status, 'passed', output);
  return JSON.parse(readFileSync(join(tmp, 'tests-protocol.json'), 'utf8')).testResults.map(item => relative(root, item.name)).sort();
}

/* One file and not its whole suite: a test of that suite writes scratch test files, which the lint test running beside this one would list. */
test('the tests chosen run through the command of their real suite, and only they', { timeout: 120_000 }, async t => {
  const file = 'packages/protocol/test/test-environment.test.ts';
  assert.deepEqual(await ranFiles(t, { packages: [{ packageId: 'protocol', mode: 'related', units: [{ file }] }], notes: [] }), [file]);
});
