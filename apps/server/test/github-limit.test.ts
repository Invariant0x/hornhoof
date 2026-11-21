import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubReaders, readCompare, readMerged } from '../src/modules/testruns/compare.js';
import { GitHubLimits, GitHubRateLimited, githubRateLimit, type RateLimit } from '../src/modules/testruns/github-limit.js';

/* GitHub gives each account 5000 REST requests an hour, which the whole server shares. Once they are spent, GitHub answers 403
   or 429 with x-ratelimit-remaining 0 and the time of the reset, and every request before then is lost. Its answers here are
   recorded and trimmed. */

const reset = 1_795_221_900;
const spent = (status = 403, headers: Record<string, string> = {}) => new Response('{"message":"API rate limit exceeded for user ID 1."}', {
  status, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), ...headers },
});

describe("GitHub's answer that the request limit is used up", () => {
  it.each([403, 429])('is read from a %i with no requests left, with the time of the reset', status => {
    expect(githubRateLimit(spent(status))).toEqual({ remaining: 0, resetAt: reset * 1000 });
  });

  it('has no reset time where GitHub named none', () => {
    expect(githubRateLimit(spent(403, { 'x-ratelimit-reset': '' }))).toEqual({ remaining: 0, resetAt: null });
  });

  it('is no other refusal: a 403 with requests left, a 404 or a 401', () => {
    expect(githubRateLimit(spent(403, { 'x-ratelimit-remaining': '4999' }))).toBeNull();
    expect(githubRateLimit(spent(404))).toBeNull();
    expect(githubRateLimit(new Response('{"message":"Bad credentials"}', { status: 401 }))).toBeNull();
  });
});

describe("asking GitHub's compare once the limit is used up", () => {
  const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token-never-output' };
  afterEach(() => vi.unstubAllGlobals());

  it('says the limit, and the time of its reset, instead of that GitHub cannot tell', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(spent()));
    const refused = await readMerged(repo, { base: 'main', head: 'b'.repeat(40) }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GitHubRateLimited);
    expect((refused as GitHubRateLimited).limit).toEqual({ remaining: 0, resetAt: reset * 1000 });
    expect((refused as Error).message).not.toContain(repo.token);
  });

  it('still cannot tell on a 403 that leaves requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(spent(403, { 'x-ratelimit-remaining': '12' })));
    expect(await readMerged(repo, { base: 'main', head: 'b'.repeat(40) })).toBeNull();
  });

  it('gives a comparison that names the limit and its reset, and no other refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(spent(429)));
    expect(await readCompare(repo, { base: 'a'.repeat(40), head: 'b'.repeat(40) })).toEqual({ complete: false, reason: 'github-rate-limit', rateLimit: { remaining: 0, resetAt: reset * 1000 } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(spent(403, { 'x-ratelimit-remaining': '12' })));
    expect(await readCompare(repo, { base: 'a'.repeat(40), head: 'b'.repeat(40) })).toEqual({ complete: false, reason: 'compare-unavailable' });
  });
});

describe('what the server knows of the limit of each GitHub account', () => {
  const repo = { url: 'https://github.com/acme/shop.git', token: 'token-a' };
  const limit = { remaining: 0 as const, resetAt: 1_000_000 };
  function limits(start = 0) {
    let now = start;
    const warned: unknown[] = [];
    const asked: string[] = [];
    const l = new GitHubLimits(() => now, w => warned.push(w));
    /* A request as the readers make one: what GitHub answers, or its refusal that the limit is used up. */
    const ask = (at: { url: string; token: string }, answer: RateLimit | 'ok' = 'ok') => l.request(at, async () => {
      asked.push(at.url);
      if (answer !== 'ok') throw new GitHubRateLimited(answer);
      return 'answered';
    }).catch((error: unknown) => error instanceof GitHubRateLimited ? error.limit : Promise.reject(error));
    return { ask, asked, warned, at: (t: number) => { now = t; } };
  }

  it("asks nothing with a refused account's token until its reset, for any repository the account reads, then asks", async () => {
    const { ask, asked, at } = limits(10);
    expect(await ask(repo)).toBe('answered');
    expect(await ask(repo, limit)).toEqual(limit);
    expect(asked).toHaveLength(2);
    expect(await ask(repo)).toEqual(limit);
    expect(await ask({ ...repo, url: 'https://github.com/acme/sales' })).toEqual(limit);
    at(limit.resetAt - 1);
    expect(await ask(repo)).toEqual(limit);
    expect(asked).toHaveLength(2);
    at(limit.resetAt);
    expect(await ask(repo)).toBe('answered');
    expect(asked).toHaveLength(3);
  });

  it('keeps apart accounts of other tokens, and repositories off GitHub, which it never holds back', async () => {
    const { ask, asked } = limits();
    await ask(repo, limit);
    expect(await ask({ ...repo, token: 'token-b' })).toBe('answered');
    const elsewhere = { url: 'https://gitlab.com/acme/shop.git', token: 'token-a' };
    await ask(elsewhere, limit);
    expect(await ask(elsewhere)).toBe('answered');
    expect(asked).toEqual([repo.url, repo.url, elsewhere.url, elsewhere.url]);
  });

  it('passes on any other failure and holds nothing back for it', async () => {
    const warned: unknown[] = [];
    const l = new GitHubLimits(() => 0, w => warned.push(w));
    await expect(l.request(repo, async () => { throw new Error('unavailable'); })).rejects.toThrow('unavailable');
    expect(await l.request(repo, async () => 'answered')).toBe('answered');
    expect(warned).toEqual([]);
  });

  it.each([null, 4_000])('waits a minute where GitHub named no reset still to come (reset %s)', async resetAt => {
    const { ask, asked, at } = limits(5_000);
    await ask(repo, { remaining: 0, resetAt });
    at(5_000 + 59_999);
    expect(await ask(repo)).toEqual({ remaining: 0, resetAt });
    at(5_000 + 60_000);
    expect(await ask(repo)).toBe('answered');
    expect(asked).toHaveLength(2);
  });

  it('warns once for each account and reset, however many answers said it', async () => {
    const { ask, warned, at } = limits();
    await ask(repo, limit);
    await ask({ ...repo, url: 'https://github.com/acme/sales' });
    expect(warned).toEqual([limit]);
    at(limit.resetAt);
    const next = { remaining: 0 as const, resetAt: limit.resetAt + 3_600_000 };
    await ask(repo, next);
    await ask({ ...repo, token: 'token-b' }, next);
    expect(warned).toEqual([limit, next, next]);
  });
});

describe("the server's GitHub readers under one request limit", () => {
  const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token-never-output' };
  afterEach(() => vi.unstubAllGlobals());

  it('ask nothing more of GitHub, compare, merge or tree, once one answer said the limit is used up', async () => {
    const fetcher = vi.fn().mockResolvedValue(spent());
    vi.stubGlobal('fetch', fetcher);
    const readers = githubReaders(new GitHubLimits(() => reset * 1000 - 60_000, () => {}));
    await expect(readers.readMerged(repo, { base: 'main', head: 'b'.repeat(40) })).rejects.toBeInstanceOf(GitHubRateLimited);
    expect(await readers.readCompare(repo, { base: 'a'.repeat(40), head: 'b'.repeat(40) })).toMatchObject({ complete: false, reason: 'github-rate-limit' });
    expect(await readers.readTree(repo, 'b'.repeat(40))).toEqual({ complete: false, reason: 'tree-unavailable' });
    await expect(readers.readMerged(repo, { base: 'main', head: 'c'.repeat(40) })).rejects.toBeInstanceOf(GitHubRateLimited);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
