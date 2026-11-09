import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCompare, readTree, treePaths } from '../src/modules/testruns/compare.js';
import { missingFrom, namedTestFiles } from '../src/modules/testruns/named-files.js';

describe('the test files a command names', () => {
  it('takes the words a runner reads as one test file, with a selection inside it left off', () => {
    expect(namedTestFiles("npx vitest run ./apps/api/test/cart.test.ts ../web/src/a.spec.tsx \"tests/test_cart.py::test_add\" pkg/cart_test.go src/x.test.mjs:12")).toEqual(['apps/api/test/cart.test.ts', 'web/src/a.spec.tsx', 'tests/test_cart.py', 'pkg/cart_test.go', 'src/x.test.mjs']);
  });

  it('names no file with a wildcard, a variable, a part, a flag value, an absolute path or no test name', () => {
    expect(namedTestFiles('vitest run test/*.test.ts $FILE.test.ts {part}.test.ts --dir=a.test.ts /abs/a.test.ts scripts/build.mjs src/cart.ts -k test_cart')).toEqual([]);
  });

  it('names each file once, across the steps of a shell line', () => {
    expect(namedTestFiles('cd apps/api && npm test -- a.test.ts; (vitest run a.test.ts) | tee log')).toEqual(['a.test.ts']);
  });

  it('finds a named file as the commit has it, or below the folder a workspace runs in', () => {
    const paths = ['apps/api/test/a.test.ts', 'tests/test_cart.py'];
    expect(missingFrom(paths, ['apps/api/test/a.test.ts', 'test/a.test.ts', 'test_cart.py', 'pi/test/a.test.ts', 'b.test.ts'])).toEqual(['pi/test/a.test.ts', 'b.test.ts']);
  });
});

describe("a commit's files as GitHub lists them", () => {
  it('lists the files and leaves out folders', () => {
    expect(treePaths({ truncated: false, tree: [{ path: 'apps', type: 'tree' }, { path: 'apps/a.test.ts', type: 'blob' }, { path: 'vendor/lib', type: 'commit' }] })).toEqual({ complete: true, paths: ['apps/a.test.ts'] });
  });

  it('takes a list GitHub cut short, or one it cannot read, for no list', () => {
    expect(treePaths({ truncated: true, tree: [] })).toEqual({ complete: false, reason: 'incomplete-tree' });
    expect(treePaths({ message: 'Not Found' })).toEqual({ complete: false, reason: 'incomplete-tree' });
  });
});

describe('what GitHub answers about a repository', () => {
  const REPO = { url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789' };
  const SHA = 'a'.repeat(40);
  afterEach(() => { vi.unstubAllGlobals(); });
  const answering = (response: () => Response | Promise<Response>) => {
    const asked: { url: string; headers: Record<string, string>; redirect: string | undefined }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { asked.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect }); return response(); });
    return asked;
  };

  it("reads a commit's files with the repository's token, following no redirect", async () => {
    const asked = answering(() => Response.json({ truncated: false, tree: [{ path: 'a.test.ts', type: 'blob' }] }));
    expect(await readTree(REPO, SHA)).toEqual({ complete: true, paths: ['a.test.ts'] });
    expect(asked).toEqual([{ url: `https://api.github.com/repos/acme/shop/git/trees/${SHA}?recursive=1`, headers: expect.objectContaining({ authorization: 'Bearer ghp_shop0123456789' }), redirect: 'manual' }]);
  });

  it('asks nothing for a repository off GitHub or a commit that is no commit, and says why', async () => {
    const asked = answering(() => Response.json({}));
    expect(await readTree({ url: 'https://gitlab.com/acme/shop.git', token: '' }, SHA)).toEqual({ complete: false, reason: 'unsupported-repository' });
    expect(await readTree(REPO, 'main')).toEqual({ complete: false, reason: 'incomplete-tree' });
    expect(await readCompare({ url: 'http://github.com/acme/shop', token: '' }, { base: SHA, head: SHA })).toEqual({ complete: false, reason: 'unsupported-repository' });
    expect(asked).toEqual([]);
  });

  it('takes a refusal or a broken connection for no answer, without the words GitHub sent', async () => {
    answering(() => new Response('Bad credentials ghp_shop0123456789', { status: 401 }));
    expect(await readTree(REPO, SHA)).toEqual({ complete: false, reason: 'tree-unavailable' });
    expect(await readCompare(REPO, { base: SHA, head: SHA })).toEqual({ complete: false, reason: 'compare-unavailable' });
    answering(() => { throw new TypeError('fetch failed'); });
    expect(await readTree(REPO, SHA)).toEqual({ complete: false, reason: 'tree-unavailable' });
  });

  it('compares two commits of the repository', async () => {
    const asked = answering(() => Response.json({ base_commit: { sha: SHA }, commits: [], total_commits: 0, status: 'identical', files: [] }));
    expect(await readCompare({ url: 'https://github.com/acme/shop', token: '' }, { base: SHA, head: SHA })).toEqual({ complete: true, baseSha: SHA, headSha: SHA, paths: [], diff: '', omitted: [] });
    expect(asked[0]!.url).toBe(`https://api.github.com/repos/acme/shop/compare/${SHA}...${SHA}`);
    expect(asked[0]!.headers).not.toHaveProperty('authorization');
  });
});
