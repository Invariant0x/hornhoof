import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { evidence, probe, workspaces, workspaceOptions } from './related-probe.mjs';

const root = process.cwd();
const files = rows => [...new Set(rows.map(row => row.file))].sort();
const required = ['@hornhoof/node', '@hornhoof/node:no-proc', '@hornhoof/protocol', '@hornhoof/server', '@hornhoof/web'];

test('root projects retain every normal workspace file and the existing no-proc variant', { timeout: 60000 }, async () => {
  const baseline = [];
  for (const [folder, config] of workspaces) {
    const result = await probe(workspaceOptions(folder, config));
    evidence('workspace-inventory', null, result); baseline.push(...result.all);
  }
  const noProc = await probe(workspaceOptions('apps/node', 'vitest.no-proc.config.ts'));
  const actual = await probe({ root });
  evidence('root-inventory', null, actual);
  assert.deepEqual(actual.projects, required);
  assert.deepEqual(files(actual.all.filter(row => row.project !== '@hornhoof/node:no-proc')), files(baseline));
  assert.deepEqual(files(actual.all.filter(row => row.project === '@hornhoof/node:no-proc')), files(noProc.all));
});

test('an app change selects real server integration tests and leaves database-only tests out', { timeout: 60000 }, async () => {
  const changed = 'apps/server/src/app.ts';
  const baseline = await probe(workspaceOptions('apps/server', 'vitest.config.ts'), changed);
  evidence('workspace-before', changed, baseline);
  const actual = await probe({ root }, changed);
  evidence('root', changed, actual);
  const selected = files(actual.selected);
  assert.ok(selected.includes('apps/server/test/setup.test.ts'));
  assert.ok(selected.includes('apps/server/test/auth.test.ts'));
  for (const independent of ['db', 'agent-sql-permissions', 'program-operator-deliveries', 'tree-history-query']) {
    assert.ok(!selected.includes(`apps/server/test/${independent}.test.ts`), independent + ' must not import the whole app through a shared helper');
  }
});

test('protocol subpath source selects its server and web consumers from root', { timeout: 60000 }, async () => {
  const changed = 'packages/protocol/src/link.ts';
  for (const [folder, config] of workspaces) {
    const baseline = await probe(workspaceOptions(folder, config), changed);
    evidence('workspace-before', changed, baseline);
  }
  const actual = await probe({ root }, changed);
  evidence('root', changed, actual);
  const selected = files(actual.selected);
  for (const expected of ['packages/protocol/test/link.test.ts', 'apps/server/test/link.test.ts', 'apps/web/test/Setup.test.tsx']) assert.ok(selected.includes(expected), expected);
  assert.ok(!selected.includes('apps/node/test/redact.test.ts'));
});

test('node source selection stays in node projects and includes its direct test', { timeout: 60000 }, async () => {
  const changed = 'apps/node/src/redact.ts';
  const baseline = await probe(workspaceOptions('apps/node', 'vitest.config.ts'), changed);
  evidence('workspace-before', changed, baseline);
  const actual = await probe({ root }, changed);
  evidence('root', changed, actual);
  assert.ok(files(actual.selected).includes('apps/node/test/redact.test.ts'));
  assert.ok(actual.selected.every(row => row.project === '@hornhoof/node' || row.project === '@hornhoof/node:no-proc'));
});

test('root projects actually run a cwd-sensitive web test, rather than only discovering it', { timeout: 60000 }, () => {
  const cli = resolve('node_modules/vitest/vitest.mjs');
  const run = spawnSync(process.execPath, [cli, 'run', 'apps/web/test/css.test.ts', '--maxWorkers=2'], { cwd: root, encoding: 'utf8', timeout: 55000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /passed/);
  console.log('HH_ROOT_EXECUTION ' + JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    command: 'vitest run apps/web/test/css.test.ts --maxWorkers=2', code: run.status, stdout: run.stdout, stderr: run.stderr }));
});
