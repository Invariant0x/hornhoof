import { describe, expect, it } from 'vitest';
import { testParts, testRuns } from '../src/db/schema.js';
import { TEST_COMMIT } from './helpers.js';
import { company, gets, nextOf } from './test-runs-company.js';

const TREE = ['package.json', 'apps/api/package.json', 'apps/api/test/kept.test.ts', 'tools/check.py', 'tests/test_cart.py'];

/* The repository at the pinned commit, as GitHub lists it, and who asked for it. */
function tree(c: Awaited<ReturnType<typeof company>>, answer: Awaited<ReturnType<NonNullable<typeof c.app.ctx.readTree>>> = { complete: true, paths: TREE }) {
  const asked: unknown[] = [];
  c.app.ctx.readTree = async (repo, commitSha) => { asked.push({ url: repo.url, token: repo.token, commitSha }); return answer; };
  return asked;
}

describe('the test files a run_tests command names', () => {
  it('refuses a run that names a test file its pinned commit does not have, before any part goes out', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const asked = tree(c);
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { branch: 'main', command: 'npx vitest run apps/api/test/kept.test.ts apps/api/test/gone.test.ts' });
    expect(started.error).toBe(true);
    expect(started.text).toContain('apps/api/test/gone.test.ts');
    expect(started.text).toContain(TEST_COMMIT);
    expect(started.text).not.toContain('kept.test.ts');
    expect(asked).toEqual([{ url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789', commitSha: TEST_COMMIT }]);
    expect(await c.db.select().from(testRuns)).toEqual([]);
    expect(await c.db.select().from(testParts)).toEqual([]);
    expect(await gets(c.app.ctx, ivan.node, 'tests.run')).toBe(false);
  });

  it('runs a command whose test files the commit has, named from the folder a workspace or cd runs in', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    tree(c);
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { branch: 'main', command: "npm test -w @acme/api -- test/kept.test.ts && cd tests && python -m pytest './test_cart.py' -k 'cart and not slow'" });
    expect(started.error).toBe(false);
    expect(await nextOf(ivan.node, 'tests.run')).toMatchObject({ commitSha: TEST_COMMIT });
  });

  it('reads no tree for a command that names no test file', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    const asked = tree(c);
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { branch: 'main', command: 'npm test -- --shard={part}/{parts} && node scripts/build.mjs' })).error).toBe(false);
    expect(asked).toEqual([]);
    expect(await nextOf(ivan.node, 'tests.run')).toMatchObject({ commitSha: TEST_COMMIT });
  });

  it('runs as before where the repository cannot list its commit, and says it could not check the names', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'dev-mac');
    tree(c, { complete: false, reason: 'tree-unavailable' });
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { branch: 'main', command: 'npx vitest run apps/api/test/gone.test.ts' });
    expect(started.error).toBe(false);
    expect(started.text).toContain('could not check');
    expect(await nextOf(ivan.node, 'tests.run')).toMatchObject({ commitSha: TEST_COMMIT });
  });
});
