import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeOf } from '../author-check/judge.mjs';
import { runStages } from '../author-check/stages.mjs';

/* Security probe of #1445 against d877a6a4 (#1217): the record the real stages write for a source change that no test reaches,
   whose changed file holds only an untested function of complexity 12, read by the node's receipt reader. */
const { authorCrap } = await import('../../apps/node/dist/author-check.js');

const SHA = '1'.repeat(40), BASE = '2'.repeat(40);
const suite = { id: 'node', root: 'apps/node', files: ['apps/node/test/**/*.test.ts'], run: { program: 'npx', args: ['--no-install', 'vitest', 'run'], cwd: 'apps/node' }, split: { kind: 'argv-files' }, finalChecks: [] };
const CRAP = 'apps/node/.metrics/crap.edn';
const files = { [CRAP]: '{:entries [\n  {:name "route", :namespace "a", :complexity 12, :coverage 0, :crap 156}\n]}\n' };
const lines = [];
const ports = { log: line => lines.push(line), read: path => files[path] ?? null, write: () => {}, mkdir: () => {}, exec: async () => ({ code: 0, output: '' }) };

test('F2: no test ran and the only changed function has CRAP 156, so there is no green receipt', async () => {
  const input = { sha: SHA, tmp: '/tmp/check', scripts: {}, suites: [suite],
    plan: { sha: SHA, base: BASE, changes: [{ path: 'apps/node/src/a.ts', kind: 'modified' }], hunks: { 'apps/node/src/a.ts': [[1, 1]] }, grown: {} },
    selection: { packages: [], notes: [], leftToFullRun: [] } };
  const result = await runStages(input, ports);
  const seen = { exit: exitCodeOf(result.stages), tests: result.stages.find(stage => stage.name === 'tests').reason, crapper: result.stages.find(stage => stage.name === 'crapper').reason };
  const pin = { taskId: '11111111-1111-4111-8111-111111111111', agentId: '11111111-1111-4111-8111-111111111111', branch: 'task-1', baseCommit: BASE, commit: SHA, repoUrlHash: 'a'.repeat(64), paths: ['apps/node/src/a.ts'] };
  assert.deepEqual({ ...seen, receipt: authorCrap([JSON.stringify(result.record)], pin) },
    { exit: 0, tests: 'nothing_selected', crapper: 'no_new_or_grown_functions', receipt: null });
});
