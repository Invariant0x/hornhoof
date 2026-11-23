import { afterEach, describe, expect, it, vi } from 'vitest';
import { heldLineage, readCompare, readMerged, readTree, readTreeSha, treePaths } from '../src/modules/testruns/compare.js';
import { GitHubRateLimited } from '../src/modules/testruns/github-limit.js';
import { exactComparison } from '../src/modules/tasks/review-context.js';
import { branchHolds } from '../src/modules/tasks/turn-integration.js';

const sha = 'a'.repeat(40);
const fixture = (files: { filename: string; previous_filename?: string; patch?: string; additions: number; deletions: number }[] = [{ filename: 'src/view.ts', patch: '+const title = "Saved";', additions: 1, deletions: 0 }]) => ({ base_commit: { sha: 'b'.repeat(40) }, commits: [{ sha }], total_commits: 1, status: 'ahead', files });
const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token-never-output' };
afterEach(() => vi.unstubAllGlobals());

describe('trusted repository comparison', () => {
  it('reads actual changed paths and patches, pinned to the returned commits, without following redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture())));
    vi.stubGlobal('fetch', fetcher);
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toMatchObject({ complete: true, baseSha: 'b'.repeat(40), headSha: sha, paths: ['src/view.ts'], diff: '+const title = "Saved";' });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/shop/compare/main...turn-8?per_page=250');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', headers: { authorization: `Bearer ${repo.token}` } });
  });

  it.each(['https://gitlab.com/acme/shop', 'https://github.com.evil.test/acme/shop', 'https://user:password@github.com/acme/shop', 'not a URL'])('fails closed without requesting unsupported address %s', async url => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await readCompare({ ...repo, url }, { base: 'main', head: 'turn-8' })).toMatchObject({ complete: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('includes both names of a renamed sensitive path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture([{ filename: 'ordinary.ts', previous_filename: 'auth/session.ts', patch: '+x', additions: 1, deletions: 0 }])))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toMatchObject({ complete: true, paths: ['ordinary.ts', 'auth/session.ts'] });
  });

  it('names a file GitHub shows no patch of, a binary or a large one, instead of taking the comparison for unknown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture([{ filename: 'binary.png', additions: 0, deletions: 0 }])))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toMatchObject({ complete: true, paths: ['binary.png'], diff: 'GitHub shows no patch of binary.png: 0 lines added, 0 removed.', omitted: [{ path: 'binary.png', additions: 0, deletions: 0 }] });
  });

  it.each([{}, { files: [{ filename: 'a.ts', patch: '+cut', additions: 10, deletions: 0 }] }, { files: Array.from({ length: 300 }, (_, i) => ({ filename: `${i}.ts`, patch: '+x', additions: 1, deletions: 0 })) }])('treats malformed, truncated or capped patches as incomplete', async change => {
    const body = Object.keys(change).length ? { ...fixture(), ...change } : {};
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toMatchObject({ complete: false });
  });

  it('never reads a file list GitHub capped at 300 as clean, yet proves by its status and commits that the head holds the base', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/${i}.ts`, patch: '+x', additions: 1, deletions: 0 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture(files)))));
    const read = await readCompare(repo, { base: 'main', head: 'turn-8' });
    expect(read).toEqual({ complete: false, reason: 'too-many-files', lineage: { baseSha: 'b'.repeat(40), headSha: sha, commits: [{ sha, parents: [] }] } });
    expect(exactComparison(read, 'b'.repeat(40), sha)).toBe(false);
    expect(heldLineage(read, 'b'.repeat(40), sha)).toEqual({ baseSha: 'b'.repeat(40), headSha: sha, commits: [{ sha, parents: [] }] });
    /* The commits it proves are those of the two named commits, never of others. */
    expect(heldLineage(read, sha, sha)).toBeNull();
    expect(heldLineage(read, 'b'.repeat(40), 'c'.repeat(40))).toBeNull();
  });

  it('reads every commit of a long comparison whose files GitHub capped, and proves nothing where the commits are short', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/${i}.ts`, patch: '+x', additions: 1, deletions: 0 }));
    const page1 = Array.from({ length: 250 }, () => ({ sha: '1'.repeat(40), parents: [{ sha: 'b'.repeat(40) }] }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('&page=2')
      ? { commits: [{ sha, parents: [{ sha: '1'.repeat(40) }] }], total_commits: 251 }
      : { ...fixture(files), commits: page1, total_commits: 251 }))));
    const read = await readCompare(repo, { base: 'main', head: 'turn-8' });
    expect(read).toMatchObject({ complete: false, reason: 'too-many-files', lineage: { baseSha: 'b'.repeat(40), headSha: sha } });
    expect(!read.complete && read.lineage?.commits?.length).toBe(251);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...fixture(files), commits: page1, total_commits: 251 }))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'incomplete-comparison' });
  });

  it('proves the line of a comparison whose patch GitHub cut short, but takes none of its files', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture([{ filename: 'a.ts', patch: '+cut', additions: 10, deletions: 0 }])))));
    const read = await readCompare(repo, { base: 'main', head: 'turn-8' });
    expect(read).toEqual({ complete: false, reason: 'incomplete-comparison', lineage: { baseSha: 'b'.repeat(40), headSha: sha, commits: [{ sha, parents: [] }] } });
    expect('paths' in read).toBe(false);
  });

  it.each(['behind', 'diverged'])('proves no line for a %s comparison with a capped file list', async status => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/${i}.ts`, patch: '+x', additions: 1, deletions: 0 }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture(files), status }))));
    const read = await readCompare(repo, { base: 'main', head: 'turn-8' });
    expect(read).toEqual({ complete: false, reason: 'not-an-ancestor' });
    expect(heldLineage(read, 'b'.repeat(40), sha)).toBeNull();
  });

  it('pins an identical comparison and fails closed when a non-identical result names no head commit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture(), commits: [], total_commits: 0, status: 'identical', files: [] }))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: true, baseSha: 'b'.repeat(40), headSha: 'b'.repeat(40), paths: [], diff: '', omitted: [], commits: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture(), commits: [], files: [] }))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'incomplete-comparison' });
  });

  it('reads every commit of a long comparison page by page, with its parents, and takes the head from the last page', async () => {
    const [first, second, third] = ['1', '2', '3'].map(c => c.repeat(40));
    const page1 = Array.from({ length: 250 }, () => ({ sha: first, parents: [{ sha: 'b'.repeat(40) }] }));
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('&page=2')
      ? { commits: [{ sha: second, parents: [{ sha: first }] }, { sha: third, parents: [{ sha: second }] }], total_commits: 252 }
      : { ...fixture(), commits: page1, total_commits: 252 })));
    vi.stubGlobal('fetch', fetcher);
    const read = await readCompare(repo, { base: 'main', head: 'turn-8' });
    expect(read).toMatchObject({ complete: true, headSha: third, paths: ['src/view.ts'] });
    expect(read.complete && read.commits!.slice(-3)).toEqual([{ sha: first, parents: ['b'.repeat(40)] }, { sha: second, parents: [first] }, { sha: third, parents: [second] }]);
    expect(read.complete && read.commits!.length).toBe(252);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['', '&page=2'].map(page => `https://api.github.com/repos/acme/shop/compare/main...turn-8?per_page=250${page}`));
  });

  it('does not claim head provenance from a commit inventory it cannot read whole', async () => {
    const page = Array.from({ length: 250 }, () => ({ sha }));
    /* A short first page that counts more, a later page that lists nothing, or another count than the first, leaves the
       inventory short. */
    const short = vi.fn(async () => new Response(JSON.stringify({ ...fixture(), total_commits: 251 })));
    vi.stubGlobal('fetch', short);
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'incomplete-comparison' });
    expect(short).toHaveBeenCalledTimes(1);
    for (const later of [{ commits: [], total_commits: 251 }, { commits: [{ sha: '2'.repeat(40) }], total_commits: 252 }]) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('&page=') ? later : { ...fixture(), commits: page, total_commits: 251 }))));
      expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'incomplete-comparison' });
    }
    /* Past 20 pages of 250 the comparison is too long to read. */
    const full = { commits: page, total_commits: 5001 };
    const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('&page=') ? full : { ...fixture(), commits: page, total_commits: 5001 })));
    vi.stubGlobal('fetch', fetcher);
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'incomplete-comparison' });
    expect(fetcher).toHaveBeenCalledTimes(20);
  });

  it.each(['behind', 'diverged'])('does not certify ancestor inclusion for %s source', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture(), status }))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toMatchObject({ complete: false });
  });

  it('handles timeout, HTTP error, redirect and private error text without leaking credentials or failing submit', async () => {
    for (const status of [302, 401, 403, 404, 500]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(repo.token, { status })));
      const result = await readCompare(repo, { base: 'main', head: 'turn-8' });
      expect(result).toMatchObject({ complete: false });
      expect(JSON.stringify(result)).not.toContain(repo.token);
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(repo.token)));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'compare-unavailable' });
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('timeout')))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' }, 5)).toEqual({ complete: false, reason: 'compare-unavailable' });
  });
});

/* GitHub's answer, read no further than 32 MiB: past that it is too large, whatever follows. The body is made as it is pulled
   and counts what was pulled; an endless answer would otherwise fill the server's memory. */
const CAP = 32 * 1024 * 1024;
function endless(head: string): { response: Response; pulled: () => number } {
  const space = new Uint8Array(1024 * 1024).fill(0x20);
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(head)); },
    pull(controller) {
      if (pulled > CAP * 2) { controller.enqueue(new TextEncoder().encode('}')); controller.close(); return; }
      pulled += space.length;
      controller.enqueue(space);
    },
  });
  return { response: new Response(body), pulled: () => pulled };
}

describe('a GitHub answer past its size', () => {
  it('stops reading at 32 MiB: the comparison and the tree are too large, and whether a branch is in main is unknown', async () => {
    const cases = [
      { head: '{"status":"behind","ahead_by":0,"behind_by":3', read: () => readMerged(repo, { base: 'main', head: sha }), want: null },
      { head: JSON.stringify(fixture()).slice(0, -1), read: () => readCompare(repo, { base: 'main', head: 'turn-8' }), want: { complete: false, reason: 'compare-too-large' } },
      { head: '{"truncated":false,"tree":[]', read: () => readTree(repo, sha), want: { complete: false, reason: 'tree-too-large' } },
    ];
    for (const { head, read, want } of cases) {
      const answer = endless(head);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer.response));
      expect(await read()).toEqual(want);
      expect(answer.pulled()).toBeLessThanOrEqual(CAP + 4 * 1024 * 1024);
    }
  });
});

describe("a commit's files with what each holds", () => {
  it('names the mode, kind and content of every file and submodule, and only where GitHub names them all', () => {
    const tree = [{ path: 'apps', type: 'tree', mode: '040000', sha: '1'.repeat(40) }, { path: 'apps/a.ts', type: 'blob', mode: '100644', sha: '2'.repeat(40) }, { path: 'vendor/lib', type: 'commit', mode: '160000', sha: '3'.repeat(40) }];
    expect(treePaths({ truncated: false, tree })).toEqual({ complete: true, paths: ['apps/a.ts'],
      entries: [{ path: 'apps/a.ts', type: 'blob', mode: '100644', sha: '2'.repeat(40) }, { path: 'vendor/lib', type: 'commit', mode: '160000', sha: '3'.repeat(40) }] });
    expect(treePaths({ truncated: false, tree: [{ path: 'apps/a.ts', type: 'blob' }] })).toEqual({ complete: true, paths: ['apps/a.ts'] });
    expect(treePaths({ truncated: true, tree })).toEqual({ complete: false, reason: 'incomplete-tree' });
  });
});

describe('a branch holds a commit, however many files lie between them', () => {
  const at = { url: 'https://github.com/acme/shop.git', branch: 'main', token: '' };
  const capped = (base: string, head: string) => ({ complete: false as const, reason: 'too-many-files', lineage: { baseSha: base, headSha: head, commits: [] } });
  it('takes the line of a capped comparison where GitHub could not say by status, and nothing else', async () => {
    const head = 'c'.repeat(40);
    expect(await branchHolds({ readMerged: async () => null, readCompare: async (_repo, refs) => capped(refs.base, refs.head) }, at, head, sha)).toBe(true);
    expect(await branchHolds({ readMerged: async () => null, readCompare: async () => capped(sha, 'd'.repeat(40)) }, at, head, sha)).toBe(false);
    expect(await branchHolds({ readMerged: async () => null, readCompare: async () => ({ complete: false, reason: 'not-an-ancestor' }) }, at, head, sha)).toBe(false);
  });
});

describe('the tree a commit holds, by the id git gives it', () => {
  const tree = 'e'.repeat(40);
  it('reads the id of the tree of the commit, pinned to the commit and without following redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sha: tree, tree: [] })));
    vi.stubGlobal('fetch', fetcher);
    expect(await readTreeSha(repo, sha)).toBe(tree);
    expect(fetcher.mock.calls[0][0]).toBe(`https://api.github.com/repos/acme/shop/git/trees/${sha}`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual', headers: { authorization: `Bearer ${repo.token}` } });
  });

  it.each([
    ['a name that is no commit id', async () => { vi.stubGlobal('fetch', vi.fn()); return readTreeSha(repo, 'main'); }],
    ['an address that is not GitHub\'s', async () => { vi.stubGlobal('fetch', vi.fn()); return readTreeSha({ ...repo, url: 'https://gitlab.com/acme/shop' }, sha); }],
    ['an answer with no tree id', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ tree: [] })))); return readTreeSha(repo, sha); }],
    ['an answer that is not a commit id', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sha: 'not-a-tree' })))); return readTreeSha(repo, sha); }],
    ['a refusal', async () => { vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 }))); return readTreeSha(repo, sha); }],
    ['a request that fails', async () => { vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up'))); return readTreeSha(repo, sha); }],
  ])('says none for %s, so no commit is taken for one that holds the same files', async (_name, read) => {
    expect(await read()).toBeNull();
  });

  it('stops at a used-up request limit instead of taking it for a tree it could not read', async () => {
    const reset = String(Math.floor(Date.parse('2026-11-23T20:00:00Z') / 1000));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })));
    await expect(readTreeSha(repo, sha)).rejects.toBeInstanceOf(GitHubRateLimited);
  });
});
