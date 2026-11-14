import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCompare, readMerged, readTree } from '../src/modules/testruns/compare.js';

const sha = 'a'.repeat(40);
const fixture = (files: { filename: string; previous_filename?: string; patch?: string; additions: number; deletions: number }[] = [{ filename: 'src/view.ts', patch: '+const title = "Saved";', additions: 1, deletions: 0 }]) => ({ base_commit: { sha: 'b'.repeat(40) }, commits: [{ sha }], total_commits: 1, status: 'ahead', files });
const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token-never-output' };
afterEach(() => vi.unstubAllGlobals());

describe('trusted repository comparison', () => {
  it('reads actual changed paths and patches, pinned to the returned commits, without following redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture())));
    vi.stubGlobal('fetch', fetcher);
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toMatchObject({ complete: true, baseSha: 'b'.repeat(40), headSha: sha, paths: ['src/view.ts'], diff: '+const title = "Saved";' });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/shop/compare/main...turn-8');
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

  it('pins an identical comparison and fails closed when a non-identical result names no head commit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture(), commits: [], total_commits: 0, status: 'identical', files: [] }))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: true, baseSha: 'b'.repeat(40), headSha: 'b'.repeat(40), paths: [], diff: '', omitted: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture(), commits: [], files: [] }))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'incomplete-comparison' });
  });

  it('does not claim head provenance from a capped commit inventory', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...fixture(), total_commits: 251 }))));
    expect(await readCompare(repo, { base: 'main', head: 'turn-8' })).toEqual({ complete: false, reason: 'incomplete-comparison' });
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
