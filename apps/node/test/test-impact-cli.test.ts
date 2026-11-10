import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImpactEnvironment } from '../src/test-impact.js';
import { runImpactReplay, replayExitCode, type ImpactReplayRequest } from '../src/test-impact-replay-cli.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() {
  const root = mkdtempSync(join(tmpdir(), 'hh-impact-cli-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '--initial-branch=fixture'); git('config', 'user.name', 'Ivan Korol'); git('config', 'user.email', 'invariant0x@icloud.com');
  writeFileSync(join(root, 'prices.py'), 'value = 7\n'); writeFileSync(join(root, 'labels.py'), "value = 'basket'\n");
  writeFileSync(join(root, 'test_prices.py'), 'from prices import value\ndef test_prices():\n    assert value >= 7\n');
  writeFileSync(join(root, 'test_labels.py'), "from labels import value\ndef test_labels():\n    assert value == 'basket'\n");
  git('add', '.'); git('commit', '-qm', 'Create Python fixture');
  for (let i = 0; i < 10; i++) { writeFileSync(join(root, 'prices.py'), `value = ${8 + i}\n`); git('add', 'prices.py'); git('commit', '-qm', `Change price ${i}`); }
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const environment: ImpactEnvironment = { packages: [{ id: 'python', root: '.', language: 'python', suiteIds: ['py'] }],
    inventory: ['test_labels.py', 'test_prices.py'].map(file => ({ suiteId: 'py', file, selectionUnit: file })),
    impact: { adapter: 'python', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No migrations' } } };
  const run = async (extra: Partial<ImpactReplayRequest> = {}) => {
    const report = await runImpactReplay(root, { environment, projectSuites: {}, ...extra });
    return { status: replayExitCode(report), report };
  };
  return { root, git, environment, run };
}

describe('standalone replay reporting with real Git and Python AST', () => {
  it('collects ten actual main diffs and runs the Python adapter without executing a full suite', async () => {
    const { git, run } = project(), output = await run();
    expect(output.status).toBe(0);
    const report = output.report;
    expect(report).toMatchObject({ candidate: git('rev-parse', 'HEAD'), scope: 'historical-diffs-at-candidate', status: 'recorded' });
    expect(report.rows).toHaveLength(10);
    for (const row of report.rows) {
      expect(row).toMatchObject({ changed: ['prices.py'], selectedCount: 1, totalCount: 2, widthPercent: 50, comparison: { status: 'unavailable' } });
      expect(row.selection.units.map(unit => unit.file)).toEqual(['test_prices.py']);
    }
  });
  it('keeps the report but exits nonzero for an unmapped newly added test', async () => {
    const { root, git, run } = project(); writeFileSync(join(root, 'test_new.py'), 'from prices import value\n');
    git('add', 'test_new.py'); git('commit', '-qm', 'Add unmapped test'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const output = await run(); expect(output.status).toBe(3);
    const report = output.report; expect(report.status).toBe('blocked');
    expect(report.rows[0].selection.problems).toEqual([{ code: 'new_test_unmapped' }]);
  });
  it('exits nonzero for an observed omitted failure from an explicit comparator port', async () => {
    const { git, environment, run } = project();
    const output = await run({ comparator: { commit: git('rev-parse', 'HEAD'), run: 50, part: 1, status: 'failed', inventory: environment.inventory, failedUnits: [environment.inventory[0]!] } });
    expect(output.status).toBe(2);
    expect(output.report.status).toBe('observed-misses');
  });
  it.each(['cancelled', 'timed_out', 'unknown', undefined])('keeps incomplete JSON comparator status %s unavailable', async status => {
    const { root, git, environment } = project();
    const request = join(root, 'request.json');
    writeFileSync(request, JSON.stringify({ environment, projectSuites: {}, comparator: {
      commit: git('rev-parse', 'HEAD'), run: 50, part: 1, status, inventory: environment.inventory, failedUnits: [environment.inventory[1]],
    } }));
    /* The replay runs to its end, however long that takes: the runner's limit for the test is the only limit. */
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/test/replay-impact.mjs', import.meta.url)), request], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { status: null as number | null, stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output.stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output.stderr += chunk; });
    [output.status] = await once(child, 'close') as [number | null];
    expect(output.status, output.stderr).toBe(0);
    const report = JSON.parse(output.stdout);
    expect(report.rows[0].comparison).toEqual({ status: 'unavailable', reason: 'full_comparator_invalid' });
  });
});
