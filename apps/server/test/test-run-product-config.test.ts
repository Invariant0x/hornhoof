import { existsSync, readFileSync } from 'node:fs';
import { parseTestEnvironment } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';

const manifest = () => parseTestEnvironment(readFileSync(new URL('../../../.hornhoof/test-environment.json', import.meta.url), 'utf8'));
const original = () => parseTestEnvironment(readFileSync(new URL('../../../packages/protocol/test/fixtures/hornhoof-test-environment-v1.json', import.meta.url), 'utf8'));

describe('canonical versioned product configuration', () => {
  it('declares the protocol suite and all prior static checks once before final batches', () => {
    const current = manifest(), preparation = current.execution?.oncePreparation;
    expect(current.execution?.version).toBe(2); expect(preparation?.profiles).toEqual(['final']); expect(preparation?.suiteIds).toEqual(['protocol']);
    const commands = preparation?.commands.map(command => JSON.stringify(command)) ?? [];
    for (const command of original().suites.flatMap(suite => suite.finalChecks ?? [])) expect(commands).toContain(JSON.stringify(command));
    expect(new Set(commands).size).toBe(commands.length);
    expect(preparation?.commands).toContainEqual({ program: 'node', args: ['scripts/check-release.mjs', '--local'], cwd: '.' });
    expect(preparation?.commands).toContainEqual({ program: 'npm', args: ['run', 'lint'], cwd: '.' });
    expect(current.suites.flatMap(suite => suite.finalChecks ?? [])).toEqual([]);
  });
  it('uses the explicit native adapter for Vitest while retaining the other framework command', () => {
    const current = manifest();
    for (const suite of current.suites.filter(suite => suite.id !== 'release-scripts')) {
      expect(suite.split.kind).toBe('vitest-shard'); expect(suite.run.cwd).toBe('.');
      expect(suite.run.args).toContain('vitest.product.config.mjs');
      expect(suite.run.args.some(arg => arg.startsWith('--project='))).toBe(true);
    }
    expect(current.suites.find(suite => suite.id === 'release-scripts')!.run).toEqual(original().suites.find(suite => suite.id === 'release-scripts')!.run);
    expect(existsSync(new URL('../../../vitest.product.config.mjs', import.meta.url))).toBe(true);
  });
  it('declares the product config and out-of-graph adapter as full-package impact inputs', () => {
    const current = manifest(), globs = current.impact.fullPackageGlobs.flatMap(entry => entry.globs);
    expect(globs).toContain('vitest.product.config.mjs'); expect(globs).toContain('apps/server/test/planned-vitest-sequencer.ts');
    expect(globs).toContain('apps/server/vitest.run-planning.config.ts');
  });
});
