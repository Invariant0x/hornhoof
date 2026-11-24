import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CONFIGS = globSync(
  ['apps/*/{vitest*.config,vite.config}.{ts,mts,mjs,js}', 'packages/*/{vitest*.config,vite.config}.{ts,mts,mjs,js}'],
  { cwd: ROOT },
).map(path => path.replaceAll('\\', '/')).sort();
const INLINE_PROBE_TESTS = [
  'apps/server/test/updater-computer.test.ts',
  'apps/server/test/updater-nodes.test.ts',
  'apps/node/test/test-services.test.ts',
];
const PG_SPECS = globSync('apps/server/test/postgres/**/*.pg.spec.ts', { cwd: ROOT })
  .map(path => path.replaceAll('\\', '/'))
  .sort();

/* A test fails on a wrong result, never because the machine running it is slow: the suites set no wall-clock limit
   on a test or a hook. A run that really hangs is ended by its job's own limit and looked at by a person. */
describe('test time limits', () => {
  it('discovers every workspace Vitest and Vite test config', () => {
    expect(CONFIGS.length).toBeGreaterThanOrEqual(11);
  });

  it.each(CONFIGS)('%s puts no time limit on a test or a hook', path => {
    const config = readFileSync(join(ROOT, path), 'utf8');
    expect(config).toMatch(/\btestTimeout: 0\b/);
    expect(config).toMatch(/\bhookTimeout: 0\b/);
  });

  it.each(INLINE_PROBE_TESTS)('%s writes inline Vitest probe configs with no time limit', path => {
    const source = readFileSync(join(ROOT, path), 'utf8');
    expect(source).toMatch(/\btestTimeout: 0\b/);
    expect(source).toMatch(/\bhookTimeout: 0\b/);
    expect(source).not.toMatch(/\b(?:testTimeout|hookTimeout):\s*[1-9]/);
  });

  it.each(PG_SPECS)('%s puts no per-call time limit on tests or hooks', path => {
    const source = readFileSync(join(ROOT, path), 'utf8');
    expect(source).not.toMatch(/\{\s*timeout:\s*[1-9]/);
  });
});
