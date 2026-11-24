import { createHash } from 'node:crypto';
import type { RepoAddress } from './refs.js';

export type RateLimit = { remaining: 0; resetAt: number | null };
export const resetTime = (limit: RateLimit): string | null => limit.resetAt === null ? null : new Date(limit.resetAt).toISOString().slice(11, 16);
export const resetIso = (limit: RateLimit): string | null => limit.resetAt === null ? null : new Date(limit.resetAt).toISOString();

export class GitHubRateLimited extends Error {
  constructor(readonly limit: RateLimit) {
    super(limit.resetAt === null
      ? "GitHub didn't answer. The account's request limit is used up. Try again later."
      : `GitHub didn't answer. The account's request limit is used up until ${resetTime(limit)} UTC. Try again after that.`);
  }
}

export function githubRateLimit(response: Response): RateLimit | null {
  if ((response.status !== 403 && response.status !== 429) || response.headers.get('x-ratelimit-remaining') !== '0') return null;
  const reset = response.headers.get('x-ratelimit-reset') ?? '';
  const at = /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).getTime() : NaN;
  return { remaining: 0, resetAt: Number.isFinite(at) ? at : null };
}

function trustedHost(at: URL): boolean {
  return at.protocol === 'https:' && at.host === 'github.com' && !at.username && !at.password && !at.search && !at.hash;
}

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
/* Until when a limit holds requests back: its reset, or a minute where GitHub named none or one this clock has passed. */
const untilOf = (limit: RateLimit, now: number): number => limit.resetAt !== null && limit.resetAt > now ? limit.resetAt : now + RETRY_WITHOUT_RESET_MS;
type Window = { limit: RateLimit; until: number; repositories: Map<string, boolean> };
type Card = { repository: string; resetAt: number | null };
const hasCards = (window: Window): boolean => [...window.repositories.values()].includes(true);

/* One warning per credential and reset window. A second refusal puts the repository in Failures. */
export class GitHubLimits {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly now: () => number, private readonly warn: (limit: RateLimit) => void, private readonly changed: () => void) {}

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

  refused(repo: RepoAddress, limit: RateLimit): void {
    const name = githubName(repo.url)?.toLowerCase();
    if (!name) return;
    const key = account(repo), prior = this.windows.get(key);
    if (prior && this.holds(prior, limit)) this.again(prior, name);
    else this.open(key, limit, name, prior);
  }

  /* The window this refusal belongs to: the same reset, not yet over. */
  private holds(window: Window, limit: RateLimit): boolean {
    return window.limit.resetAt === limit.resetAt && window.until > this.now();
  }

  /* A new window warns once. The cards of the one it replaces go. */
  private open(key: string, limit: RateLimit, name: string, prior: Window | undefined): void {
    this.windows.set(key, { limit, until: untilOf(limit, this.now()), repositories: new Map([[name, false]]) });
    this.warn(limit);
    if (prior && hasCards(prior)) this.changed();
  }

  /* A repository refused again in its window gets its card. */
  private again(window: Window, name: string): void {
    if (window.repositories.get(name) === true) return;
    const repeated = window.repositories.has(name);
    window.repositories.set(name, repeated);
    if (repeated) this.changed();
  }

  cards(): Card[] {
    const cards = new Map<string, Card>();
    for (const window of this.windows.values()) {
      if (window.until <= this.now()) continue;
      for (const [repository, repeated] of window.repositories) if (repeated) cards.set(repository, { repository, resetAt: window.limit.resetAt });
    }
    return [...cards.values()];
  }

  expire(): void {
    let changed = false;
    for (const [key, window] of this.windows) {
      if (window.until > this.now()) continue;
      this.windows.delete(key);
      changed ||= hasCards(window);
    }
    if (changed) this.changed();
  }
}
