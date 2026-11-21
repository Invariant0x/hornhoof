import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCompare, readMerged } from '../src/modules/testruns/compare.js';
import { GitHubLimits, GitHubRateLimited, githubRateLimit } from '../src/modules/testruns/github-limit.js';

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
    return { limits: new GitHubLimits(() => now, l => warned.push(l)), warned, at: (t: number) => { now = t; } };
  }

  it('holds a refused account until its reset, for every repository the account reads, and no longer', () => {
    const { limits: l, at } = limits(10);
    expect(l.known(repo)).toBeNull();
    l.refused(repo, limit);
    expect(l.known(repo)).toEqual(limit);
    expect(l.known({ ...repo, url: 'https://github.com/acme/sales' })).toEqual(limit);
    at(limit.resetAt - 1);
    expect(l.known(repo)).toEqual(limit);
    at(limit.resetAt);
    expect(l.known(repo)).toBeNull();
  });

  it('keeps apart accounts of other tokens, and repositories off GitHub, which it never holds', () => {
    const { limits: l } = limits();
    l.refused(repo, limit);
    expect(l.known({ ...repo, token: 'token-b' })).toBeNull();
    const elsewhere = { url: 'https://gitlab.com/acme/shop.git', token: 'token-a' };
    l.refused(elsewhere, limit);
    expect(l.known(elsewhere)).toBeNull();
  });

  it.each([null, 4_000])('waits a minute where GitHub named no reset still to come (reset %s)', resetAt => {
    const { limits: l, at } = limits(5_000);
    l.refused(repo, { remaining: 0, resetAt });
    at(5_000 + 59_999);
    expect(l.known(repo)).toEqual({ remaining: 0, resetAt });
    at(5_000 + 60_000);
    expect(l.known(repo)).toBeNull();
  });

  it('warns once for each account and reset, however many answers said it', () => {
    const { limits: l, warned, at } = limits();
    l.refused(repo, limit);
    l.refused({ ...repo, url: 'https://github.com/acme/sales' }, limit);
    expect(warned).toEqual([limit]);
    at(limit.resetAt);
    const next = { remaining: 0 as const, resetAt: limit.resetAt + 3_600_000 };
    l.refused(repo, next);
    l.refused({ ...repo, token: 'token-b' }, next);
    expect(warned).toEqual([limit, next, next]);
  });
});
