import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectTests } from '../author-check/select.mjs';
import { tracked } from '../author-check/wired.mjs';
import { probe } from './related-probe.mjs';

/* The real test environment, the real selector and the real import graph: what a change of each group runs. */
const root = fileURLToPath(new URL('../..', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const ALL = ['node', 'protocol', 'release-scripts', 'server', 'web'];
let manifest, ports;

before(async () => {
  if (!existsSync(`${root}apps/node/dist/test-impact.js`)) for (const name of ['protocol', 'node']) execFileSync('npm', ['run', '-s', 'build', '-w', `@hornhoof/${name}`], { cwd: root, stdio: 'ignore' });
  const { parseTestEnvironment } = await import('@hornhoof/protocol');
  const { selectAffectedTests } = await import(new URL('../../apps/node/dist/test-impact.js', import.meta.url));
  const { collectVitestImpact } = await import(new URL('../../apps/node/dist/test-impact-adapters.js', import.meta.url));
  const { listTestUnits } = await import(new URL('../../apps/node/dist/test-environment.js', import.meta.url));
  manifest = parseTestEnvironment(readFileSync(`${root}.hornhoof/test-environment.json`, 'utf8'));
  ports = { selectAffectedTests, collectVitestImpact, listTestUnits, collect: changed => probe({ root }, changed) };
});

const runs = path => selectTests({ changes: [{ path, kind: 'modified' }], manifest, tracked: tracked(git), allowWhole: false }, ports);
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
  ['the templates', 'templates/roles/operations/OPS-HEAD.md', ['node', 'server']],
  ['the skills', 'templates/skills/dev-tdd.md', ['node', 'server']],
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

test('a change a person sees names the browser scenarios of its screen, and a scenario names itself alone', { timeout: 60_000 }, async () => {
  const named = async path => (await runs(path)).notes.filter(note => note.startsWith('browser '));
  assert.deepEqual(await named('apps/web/e2e/about.spec.ts'), ['browser scenario: apps/web/e2e/about.spec.ts']);
  assert.deepEqual(await named('apps/web/e2e/api.ts'), ['browser helper, its scenarios run at the release: apps/web/e2e/api.ts']);
  assert.deepEqual(await named('apps/web/src/ui/AgentTerminal.tsx'), ['browser scenario: apps/web/e2e/agent-terminal-fit.spec.ts']);
  assert.deepEqual(await named('apps/web/src/App.tsx'), []);
  assert.deepEqual(await named('apps/server/src/modules/tasks/wait-policy.ts'), []);
});
