import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* A test fails on a wrong result, never because the machine running it is slow: the suites set no wall-clock limit
   on a test or a hook. A run that really hangs is ended by its job's own limit and looked at by a person. */
describe('test time limits', () => {
  it.each(['apps/server/vitest.config.ts', 'apps/node/vitest.config.ts', 'apps/web/vite.config.ts'])('%s puts no time limit on a test or a hook', path => {
    const config = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
    expect(config).toMatch(/\btestTimeout: 0\b/);
    expect(config).toMatch(/\bhookTimeout: 0\b/);
  });
});
