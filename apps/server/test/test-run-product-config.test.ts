import { existsSync, readFileSync } from 'node:fs';
import { parseTestEnvironment } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';

const manifest = () => parseTestEnvironment(readFileSync(new URL('../../../.hornhoof/test-environment.json', import.meta.url), 'utf8'));
const original = () => parseTestEnvironment(readFileSync(new URL('../../../packages/protocol/test/fixtures/hornhoof-test-environment-v1.json', import.meta.url), 'utf8'));

describe('canonical versioned product configuration', () => {
  it('declares the protocol suite and all prior static checks once before final batches', () => {
    const current = manifest(), preparation = current.execution?.oncePreparation;
    expect(current.execution?.version).toBe(2); expect(preparation?.profiles).toEqual(['final', 'full']); expect(preparation?.suiteIds).toEqual(['protocol']);
    const commands = preparation?.commands.map(command => JSON.stringify(command)) ?? [];
    const checks = original().suites.flatMap(suite => suite.finalChecks ?? []).flatMap(command => command.program === 'npm' && command.args.join(' ') === 'run typecheck:tests'
      ? ['apps/server', 'apps/node', 'packages/protocol'].map(workspace => ({ program: 'npx', args: ['--no-install', 'tsc', '-p', `${workspace}/tsconfig.eslint.json`, '--noEmit'], cwd: '.' })) : [command]);
    for (const command of checks) expect(commands).toContain(JSON.stringify(command));
    expect(new Set(commands).size).toBe(commands.length);
    expect(preparation?.commands).toContainEqual({ program: 'node', args: ['scripts/check-release.mjs', '--local'], cwd: '.' });
    expect(preparation?.commands).toContainEqual({ program: 'npm', args: ['run', 'lint:part', '--workspaces', '--include-workspace-root', '--'], cwd: '.' });
    expect(preparation?.commands.some(command => command.program === 'npm' && ['lint', 'typecheck:tests', 'build'].includes(command.args[1] ?? ''))).toBe(false);
    expect(current.suites.flatMap(suite => suite.finalChecks ?? [])).toEqual([]);
  });
  it('checks the installer as the GitHub build does, since a passing run of the whole product spares GitHub its own', () => {
    const commands = manifest().execution?.oncePreparation?.commands;
    expect(commands).toContainEqual({ program: 'bash', args: ['-n', 'scripts/install.sh'], cwd: '.' });
    expect(commands).toContainEqual({ program: 'shellcheck', args: ['scripts/install.sh', 'scripts/node-build.sh'], cwd: '.' });
  });
  it('uses the explicit native adapter for Vitest while retaining the other framework command', () => {
    const current = manifest(), others = ['release-scripts', 'browser', 'browser-matrix', 'browser-engines', 'mutation'];
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
    for (const heavy of ['browser', 'browser-matrix', 'browser-engines', 'mutation']) expect(suitesOf('fast')).not.toContain(heavy);
    expect(suitesOf('final')).toEqual(expect.arrayContaining(['browser', 'mutation']));
    expect(suitesOf('final')).not.toContain('browser-matrix');
    expect(suitesOf('final')).not.toContain('browser-engines');
    expect([...suitesOf('full')].sort()).toEqual(current.suites.map(suite => suite.id).sort());
    expect(current.suites.find(suite => suite.id === 'mutation')?.keep).toEqual(['.metrics/mutate']);
  });
  /* The shell's bars during an update were checked in three engines only on the machine of whoever ran their config by hand.
     Chromium runs the spec in the browser suites, as playwright.config.ts takes every spec; Firefox and WebKit run it in the
     full run of every release, by the spec's own config. */
  it('runs the bars of the shell in Firefox and WebKit in the full run of a release, by the config of their spec', () => {
    const current = manifest(), engines = current.suites.find(suite => suite.id === 'browser-engines');
    const config = readFileSync(new URL('../../web/e2e/maintenance-error-bar.config.ts', import.meta.url), 'utf8');
    expect(engines).toMatchObject({ root: 'apps/web/e2e', files: ['apps/web/e2e/maintenance-error-bar.spec.ts'], split: { kind: 'argv-files' }, profiles: ['full'], scenarioSources: 'apps/web/src' });
    expect(engines!.run).toEqual({
      program: 'npx', args: ['--no-install', 'playwright', 'test', '--config=e2e/maintenance-error-bar.config.ts', '--project=bars-firefox', '--project=bars-webkit', '--workers=2', '--pass-with-no-tests'], cwd: 'apps/web',
    });
    for (const project of ['bars-chromium', 'bars-firefox', 'bars-webkit']) expect(config).toContain(`name: '${project}'`);
    expect(config).toContain("testMatch: 'maintenance-error-bar.spec.ts'");
    expect(config).toContain('fullyParallel: true');
    expect(current.suites.find(suite => suite.id === 'browser')!.files).toEqual(['apps/web/e2e/**/*.spec.ts']);
    expect(current.profiles.find(item => item.id === 'full')!.requiredSuiteIds).toContain('browser-engines');
    /* What reruns the browser suites reruns this one too, and a change of its config reruns it alone. */
    const rules = current.impact.fullPackageGlobs;
    for (const rule of rules.filter(rule => rule.suiteIds.includes('browser-matrix'))) expect(rule.suiteIds).toContain('browser-engines');
    expect(rules.filter(rule => rule.globs.includes('apps/web/e2e/maintenance-error-bar.config.ts'))).toEqual([{ globs: ['apps/web/e2e/maintenance-error-bar.config.ts'], suiteIds: ['browser-engines'] }]);
  });

  it('declares the product config and out-of-graph adapter as full-package impact inputs', () => {
    const current = manifest(), globs = current.impact.fullPackageGlobs.flatMap(entry => entry.globs);
    expect(globs).toContain('vitest.product.config.mjs'); expect(globs).toContain('apps/server/test/planned-vitest-sequencer.ts');
    expect(globs).toContain('apps/server/vitest.run-planning.config.ts');
  });
});
