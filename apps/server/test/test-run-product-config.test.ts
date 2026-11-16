import { existsSync, readFileSync } from 'node:fs';
import { parseTestEnvironment, type Command } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';

const manifest = () => parseTestEnvironment(readFileSync(new URL('../../../.hornhoof/test-environment.json', import.meta.url), 'utf8'));
const original = () => parseTestEnvironment(readFileSync(new URL('../../../packages/protocol/test/fixtures/hornhoof-test-environment-v1.json', import.meta.url), 'utf8'));
/* A type check as the preparation runs it: tsc in a node with room for 4 GB, since the types of the server's tests take
   2.2 GB and a node of a machine with less memory gives 2 GB by default. */
const TSC = ['--max-old-space-size=4096', 'node_modules/typescript/bin/tsc'];
const tsc = (args: string[]) => ({ program: 'node', args: [...TSC, ...args], cwd: '.' });
const asPrepared = (command: Command) => (command.program === 'npx' && command.args[0] === '--no-install' && command.args[1] === 'tsc' ? tsc(command.args.slice(2)) : command);

describe('canonical versioned product configuration', () => {
  it('declares the protocol suite and all prior static checks once before final batches', () => {
    const current = manifest(), preparation = current.execution?.oncePreparation;
    expect(current.execution?.version).toBe(2); expect(preparation?.profiles).toEqual(['final', 'full']); expect(preparation?.suiteIds).toEqual(['protocol']);
    const commands = preparation?.commands.map(command => JSON.stringify(command)) ?? [];
    const checks = original().suites.flatMap(suite => suite.finalChecks ?? []).flatMap(command => command.program === 'npm' && command.args.join(' ') === 'run typecheck:tests'
      ? ['apps/server', 'apps/node', 'packages/protocol'].map(workspace => tsc(['-p', `${workspace}/tsconfig.eslint.json`, '--noEmit'])) : [asPrepared(command)]);
    for (const command of checks) expect(commands).toContain(JSON.stringify(command));
    expect(new Set(commands).size).toBe(commands.length);
    expect(preparation?.commands).toContainEqual({ program: 'node', args: ['scripts/check-release.mjs', '--local'], cwd: '.' });
    expect(preparation?.commands).toContainEqual({ program: 'npm', args: ['run', 'lint:part', '--workspaces', '--include-workspace-root', '--'], cwd: '.' });
    expect(preparation?.commands.some(command => command.program === 'npm' && ['lint', 'typecheck:tests', 'build'].includes(command.args[1] ?? ''))).toBe(false);
    expect(current.suites.flatMap(suite => suite.finalChecks ?? [])).toEqual([]);
  });
  it('gives every type check of the preparation room for 4 GB', () => {
    const commands = manifest().execution?.oncePreparation?.commands ?? [];
    const checks = commands.filter(command => [command.program, ...command.args].some(arg => /(?:^|\/)tsc$/.test(arg)));
    expect(checks.length).toBe(7);
    for (const command of checks) expect([command.program, ...command.args.slice(0, 2)]).toEqual(['node', ...TSC]);
  });
  it('checks the installer as the GitHub build does, since a passing run of the whole product spares GitHub its own', () => {
    const commands = manifest().execution?.oncePreparation?.commands;
    expect(commands).toContainEqual({ program: 'bash', args: ['-n', 'scripts/install.sh'], cwd: '.' });
    expect(commands).toContainEqual({ program: 'shellcheck', args: ['scripts/install.sh', 'scripts/node-build.sh'], cwd: '.' });
  });
  it('uses the explicit native adapter for Vitest while retaining the other framework command', () => {
    const current = manifest(), others = ['release-scripts', 'browser', 'browser-matrix', 'mutation'];
    for (const suite of current.suites.filter(suite => !others.includes(suite.id))) {
      expect(suite.split.kind).toBe('vitest-shard'); expect(suite.run.cwd).toBe('.');
      expect(suite.run.args).toContain('vitest.product.config.mjs');
      expect(suite.run.args.some(arg => arg.startsWith('--project='))).toBe(true);
    }
    expect(current.suites.find(suite => suite.id === 'release-scripts')!.run).toEqual(original().suites.find(suite => suite.id === 'release-scripts')!.run);
    expect(existsSync(new URL('../../../vitest.product.config.mjs', import.meta.url))).toBe(true);
  });
  it('runs one look and mutation at a release, and everything in the full run of every release', () => {
    const current = manifest(), suitesOf = (profile: string) => current.profiles.find(item => item.id === profile)!.requiredSuiteIds;
    /* everyTurns stays for the servers and nodes before 0.24.0 that run this repository's checks: nothing runs by it. */
    expect(current.execution?.fullRun).toEqual({ everyTurns: 5, replaces: 'final', profile: 'full' });
    for (const heavy of ['browser', 'browser-matrix', 'mutation']) expect(suitesOf('fast')).not.toContain(heavy);
    expect(suitesOf('final')).toEqual(expect.arrayContaining(['browser', 'mutation']));
    expect(suitesOf('final')).not.toContain('browser-matrix');
    expect([...suitesOf('full')].sort()).toEqual(current.suites.map(suite => suite.id).sort());
    expect(current.suites.find(suite => suite.id === 'mutation')?.keep).toEqual(['.metrics/mutate']);
  });
  it('declares the product config and out-of-graph adapter as full-package impact inputs', () => {
    const current = manifest(), globs = current.impact.fullPackageGlobs.flatMap(entry => entry.globs);
    expect(globs).toContain('vitest.product.config.mjs'); expect(globs).toContain('apps/server/test/planned-vitest-sequencer.ts');
    expect(globs).toContain('apps/server/vitest.run-planning.config.ts');
  });
});
