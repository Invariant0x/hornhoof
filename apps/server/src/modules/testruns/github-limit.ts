import { createHash } from 'node:crypto';
import type { RepoAddress } from './refs.js';

/* GitHub's REST requests are counted per account: once its hour's are spent, it answers none until resetAt. */
export type RateLimit = { remaining: 0; resetAt: number | null };
export type ScopedRepo = RepoAddress & { companyId?: string };
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

const repoCompanies = new WeakMap<object, string>();
/* Records which company owns a repository handle without adding protocol fields to RepoAddress. */
export function withRepoCompany<T extends RepoAddress>(repo: T, companyId: string): T {
  repoCompanies.set(repo, companyId);
  return repo;
}

const companyOf = (repo: ScopedRepo): string | undefined => repo.companyId ?? repoCompanies.get(repo);

/* Decodes one department's GitHub repository scope, failing closed when a stored token cannot be decrypted. */
export function repoScopeOf(row: { url: string | null; tokenEnc: string | null }, companyId: string, decrypt: (enc: string) => string): ScopedRepo | null {
  if (!row.url) return null;
  if (!row.tokenEnc) return { url: row.url, token: '', companyId };
  try { return { url: row.url, token: decrypt(row.tokenEnc), companyId }; }
  catch { return null; }
}

const account = ({ token }: RepoAddress) => createHash('sha256').update(token).digest('hex');
const RETRY_WITHOUT_RESET_MS = 60_000;
type CardEntry = { repository: string; repeated: boolean };
type Window = { limit: RateLimit; until: number; repositories: Map<string, CardEntry> };
type Card = { repository: string; resetAt: number | null };
const untilOf = (limit: RateLimit, now: number) => limit.resetAt !== null && limit.resetAt > now ? limit.resetAt : now + RETRY_WITHOUT_RESET_MS;
const hasCard = (window: Window | undefined): boolean => Boolean(window && [...window.repositories.values()].some(entry => entry.repeated));
const sameWindow = (prior: Window | undefined, limit: RateLimit, now: number): prior is Window =>
  Boolean(prior && prior.limit.resetAt === limit.resetAt && prior.until > now);

/* Card entries are attributed to the requesting company when known, else only to a non-empty token.
   Unattributed tokenless refusals still enforce backoff but never create cross-company cards. */
function cardEntryOf(repo: ScopedRepo): { entry: string; repository: string } | null {
  const repository = githubName(repo.url)?.toLowerCase();
  if (!repository) return null;
  const company = companyOf(repo);
  if (company) return { entry: `c:${company}\0${repository}`, repository };
  return repo.token ? { entry: `t:${repository}`, repository } : null;
}

const laterReset = (prior: number | null, next: number | null): number | null =>
  prior === null ? next : next === null ? prior : Math.max(prior, next);

function recordCard(cards: Map<string, Card>, repository: string, resetAt: number | null): void {
  const prior = cards.get(repository);
  cards.set(repository, { repository, resetAt: prior ? laterReset(prior.resetAt, resetAt) : resetAt });
}

function allowedEntries(repos: Iterable<ScopedRepo>): Set<string> {
  const allowed = new Set<string>();
  for (const repo of repos) {
    const repository = githubName(repo.url)?.toLowerCase();
    if (!repository) continue;
    const key = account(repo), company = companyOf(repo);
    if (company) allowed.add(`${key}\0c:${company}\0${repository}`);
    if (repo.token) allowed.add(`${key}\0t:${repository}`);
  }
  return allowed;
}

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

  async request<T>(repo: ScopedRepo, read: () => Promise<T>): Promise<T> {
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

  private recordRepeated(prior: Window, item: { entry: string; repository: string }): void {
    const existing = prior.repositories.get(item.entry);
    if (existing?.repeated) return;
    const repeated = Boolean(existing);
    prior.repositories.set(item.entry, { repository: item.repository, repeated });
    if (repeated) this.changed();
  }

  refused(repo: ScopedRepo, limit: RateLimit): void {
    if (!githubName(repo.url)) return;
    const key = account(repo), prior = this.windows.get(key), now = this.now(), item = cardEntryOf(repo);
    if (sameWindow(prior, limit, now)) {
      if (item) this.recordRepeated(prior, item);
      return;
    }
    const repositories = new Map<string, CardEntry>(item ? [[item.entry, { repository: item.repository, repeated: false }]] : []);
    this.windows.set(key, { limit, until: untilOf(limit, now), repositories });
    this.warn(limit);
    if (hasCard(prior)) this.changed();
  }

  hasCards(): boolean {
    const now = this.now();
    for (const window of this.windows.values()) if (window.until > now && hasCard(window)) return true;
    return false;
  }

  private collectCards(cards: Map<string, Card>, key: string, window: Window, allowed: Set<string>): void {
    if (window.until <= this.now()) return;
    for (const [entry, item] of window.repositories) {
      if (item.repeated && allowed.has(`${key}\0${entry}`)) recordCard(cards, item.repository, window.limit.resetAt);
    }
  }

  cards(repos: Iterable<ScopedRepo>): Card[] {
    const allowed = allowedEntries(repos);
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
