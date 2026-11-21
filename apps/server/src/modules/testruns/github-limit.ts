import { createHash } from 'node:crypto';
import type { RepoAddress } from './refs.js';

/* GitHub's REST requests are counted per account: once its hour's are spent, it answers none until resetAt. */
export type RateLimit = { remaining: 0; resetAt: number | null };
export const resetTime = (limit: RateLimit): string | null => limit.resetAt === null ? null : new Date(limit.resetAt).toISOString().slice(11, 16);
/* The server log's words for a used-up limit: how many requests are left and when they come back. */
export const limitRecord = (limit: RateLimit) => ({ remaining: limit.remaining, resetAt: limit.resetAt === null ? null : new Date(limit.resetAt).toISOString() });

/* A request GitHub refused as the account's limit is used up, which says so and when it ends rather than what it asked. */
export class GitHubRateLimited extends Error {
  constructor(readonly limit: RateLimit) {
    super(limit.resetAt === null
      ? "GitHub didn't answer. The account's request limit is used up. Try again later."
      : `GitHub didn't answer. The account's request limit is used up until ${resetTime(limit)} UTC. Try again after that.`);
  }
}

/* A 403 or 429 with no requests left is the limit; any other refusal is not. */
export function githubRateLimit(response: Response): RateLimit | null {
  if ((response.status !== 403 && response.status !== 429) || response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const reset = response.headers.get('x-ratelimit-reset') ?? '';
  const at = /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).getTime() : NaN;
  return { remaining: 0, resetAt: Number.isFinite(at) ? at : null };
}

function trustedHost(at: URL): boolean {
  return at.protocol === 'https:' && at.host === 'github.com' && !at.username && !at.password && !at.search && !at.hash;
}

/* owner/name of a repository on github.com, or null for any other address. */
export function githubName(url: string): string | null {
  try {
    const at = new URL(url);
    if (!trustedHost(at)) return null;
    const parts = at.pathname.replace(/^\/|\/$/g, '').replace(/\.git$/i, '').split('/');
    return parts.length === 2 && parts.every(p => /^[a-z0-9][a-z0-9_.-]*$/i.test(p)) ? parts.join('/') : null;
  } catch { return null; }
}

const account = ({ token }: RepoAddress) => createHash('sha256').update(token).digest('hex');
const RETRY_WITHOUT_RESET_MS = 60_000;
type Window = { limit: RateLimit; until: number; repositories: Map<string, boolean> };
type Card = { repository: string; resetAt: number | null };
const untilOf = (limit: RateLimit, now: number) => limit.resetAt !== null && limit.resetAt > now ? limit.resetAt : now + RETRY_WITHOUT_RESET_MS;
const hasCard = (window: Window | undefined): boolean => Boolean(window && [...window.repositories.values()].includes(true));
const sameWindow = (prior: Window | undefined, limit: RateLimit, now: number): prior is Window =>
  Boolean(prior && prior.limit.resetAt === limit.resetAt && prior.until > now);

const repoKey = (repo: RepoAddress): string | null => {
  const name = githubName(repo.url)?.toLowerCase();
  return name ? `${account(repo)}\0${name}` : null;
};

const laterReset = (prior: number | null, next: number | null): number | null =>
  prior === null ? next : next === null ? prior : Math.max(prior, next);

function recordCard(cards: Map<string, Card>, repository: string, resetAt: number | null): void {
  const prior = cards.get(repository);
  cards.set(repository, { repository, resetAt: prior ? laterReset(prior.resetAt, resetAt) : resetAt });
}

function allowedRepos(repos: Iterable<RepoAddress>): Set<string> {
  const allowed = new Set<string>();
  for (const repo of repos) {
    const key = repoKey(repo);
    if (key) allowed.add(key);
  }
  return allowed;
}

const matchesScope = (allowed: Set<string> | null, key: string, repository: string): boolean =>
  !allowed || allowed.has(`${key}\0${repository}`);

/* What GitHub said last of each account's request limit, by a hash of its token. While one is used up, no request goes to
   GitHub with that token, for any repository, until its reset, or for a minute where GitHub named no reset still to come: it
   is refused here as GitHub would. One warning per account and reset; a second refusal puts the repository in Failures. */
export class GitHubLimits {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly now: () => number,
    private readonly warn: (limit: RateLimit) => void,
    private readonly changed: () => void = () => {},
  ) {}

  async request<T>(repo: RepoAddress, read: () => Promise<T>): Promise<T> {
    try {
      const limit = this.known(repo);
      if (limit) throw new GitHubRateLimited(limit);
      return await read();
    } catch (error) {
      if (error instanceof GitHubRateLimited) this.refused(repo, error.limit);
      throw error;
    }
  }

  private known(repo: RepoAddress): RateLimit | null {
    if (!githubName(repo.url)) return null;
    const window = this.windows.get(account(repo));
    return window && window.until > this.now() ? window.limit : null;
  }

  private recordRepeated(prior: Window, name: string): void {
    if (prior.repositories.get(name) === true) return;
    const repeated = prior.repositories.has(name);
    prior.repositories.set(name, repeated);
    if (repeated) this.changed();
  }

  refused(repo: RepoAddress, limit: RateLimit): void {
    const name = githubName(repo.url)?.toLowerCase();
    if (!name) return;
    const key = account(repo), prior = this.windows.get(key), now = this.now();
    if (sameWindow(prior, limit, now)) return this.recordRepeated(prior, name);
    this.windows.set(key, { limit, until: untilOf(limit, now), repositories: new Map([[name, false]]) });
    this.warn(limit);
    if (hasCard(prior)) this.changed();
  }

  private collectCards(cards: Map<string, Card>, key: string, window: Window, allowed: Set<string> | null): void {
    if (window.until <= this.now()) return;
    for (const [repository, repeated] of window.repositories) {
      if (repeated && matchesScope(allowed, key, repository)) recordCard(cards, repository, window.limit.resetAt);
    }
  }

  cards(repos?: Iterable<RepoAddress>): Card[] {
    const allowed = repos ? allowedRepos(repos) : null;
    const cards = new Map<string, Card>();
    for (const [key, window] of this.windows) this.collectCards(cards, key, window, allowed);
    return [...cards.values()];
  }

  expire(): void {
    let changed = false;
    for (const [key, window] of this.windows) {
      if (window.until > this.now()) continue;
      this.windows.delete(key);
      changed ||= hasCard(window);
    }
    if (changed) this.changed();
  }
}
