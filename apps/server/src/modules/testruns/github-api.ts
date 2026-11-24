import { z } from 'zod';
import { bodyWithin } from './bounded.js';
import { githubRateLimit, GitHubRateLimited, type GitHubLimits } from './github-limit.js';
import type { RepoAddress } from './refs.js';

/* What every reader of GitHub's API here shares: one request with the repository's token, the text it lets into what an agent
   reads, and the pages of a list. */

export const MAX_BYTES = 8 * 1024 * 1024;
export const PER_PAGE = 100;
/* The most jobs of one run read: a thousand. A run with more is not read whole. */
const MAX_PAGES = 10;
const SHOWN = 160;

export const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Repository = z.object({ full_name: z.string().min(1) });
export const WorkflowRun = z.object({
  id: z.number().int().positive(),
  workflow_id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  head_sha: Sha,
  event: z.string().optional(),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable().optional(),
  run_attempt: z.number().int().positive(),
  created_at: z.string().optional(),
  run_started_at: z.string().nullable().optional(),
  updated_at: z.string().optional(),
  repository: Repository,
  head_repository: Repository.nullable().optional(),
});
export type Run = z.infer<typeof WorkflowRun>;
const RunsPage = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(WorkflowRun) });
const Commits = z.array(z.object({ sha: Sha })).min(1);
const Repo = z.object({ default_branch: z.string().min(1).max(250) });

export class Unread extends Error {}
export class Absent extends Error {}

/* Text from GitHub that goes into what an agent reads: short, one line, and a link only if it is a plain https address. */
export const shown = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, SHOWN);
export function linkOf(url: string | null | undefined): string | null {
  if (!url || url.length > 300) return null;
  try {
    const at = new URL(url);
    return at.protocol === 'https:' && !at.username && !at.password ? at.href : null;
  } catch { return null; }
}

/* A conclusion that is no fault: neutral and skipped ones ran nothing that failed, and count for no success. */
export type Json = (repo: RepoAddress, name: string, path: string, timeoutMs: number) => Promise<unknown>;
export type Sent = { method: 'GET' } | { method: 'POST'; body: unknown };

const headersOf = (repo: RepoAddress, sent: Sent): Record<string, string> => ({
  accept: 'application/vnd.github+json',
  'user-agent': 'hornhoof',
  'x-github-api-version': '2022-11-28',
  ...(sent.method === 'POST' ? { 'content-type': 'application/json' } : {}),
  ...(repo.token ? { authorization: `Bearer ${repo.token}` } : {}),
});

/* What a request GitHub did not take says: the account's request limit, a missing thing (404), or a refusal with its words. */
async function failure(response: Response): Promise<Error> {
  const limit = githubRateLimit(response);
  const said = (await bodyWithin(response, 64 * 1024).catch(() => null))?.toString('utf8') ?? '';
  if (limit) return new GitHubRateLimited(limit);
  return response.status === 404 ? new Absent(said) : new Refused(response.status, said);
}

/* One request to GitHub's API for the repository, with its token, to api.github.com only and with no redirect followed. The
   answer's body: a JSON value, or null where GitHub answered with none (204). */
export async function githubRequest(repo: RepoAddress, name: string, path: string, sent: Sent, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${name}${path ? `/${path}` : ''}`, {
    method: sent.method,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: headersOf(repo, sent),
    ...(sent.method === 'POST' ? { body: JSON.stringify(sent.body) } : {}),
  });
  if (!response.ok) throw await failure(response);
  if (response.status === 204) return null;
  const body = await bodyWithin(response, MAX_BYTES);
  if (!body) throw new Unread('its answer was too large');
  return JSON.parse(body.toString('utf8')) as unknown;
}

/* A request GitHub refused: its status, and what it said of why. */
export class Refused extends Error {
  constructor(readonly status: number, readonly said: string) {
    super(`GitHub answered ${status}`);
  }
}

export type Send = (repo: RepoAddress, name: string, path: string, sent: Sent, timeoutMs: number) => Promise<unknown>;

/* Requests that share the request limit of the server's account, where a limit is kept. */
export const sendOf = (limits?: GitHubLimits): Send => (repo, name, path, sent, timeout) =>
  limits ? limits.request(repo, () => githubRequest(repo, name, path, sent, timeout)) : githubRequest(repo, name, path, sent, timeout);

/* The reads of a reader: a refusal of GitHub is an answer that cannot be read, not one that says what CI is. */
export const jsonOf = (limits?: GitHubLimits): Json => {
  const send = sendOf(limits);
  return (repo, name, path, timeout) => send(repo, name, path, { method: 'GET' }, timeout).catch((error: unknown) => {
    if (error instanceof Refused) throw new Unread(`GitHub answered ${error.status} when reading the checks`);
    throw error;
  });
};

/* A page-by-page list: what each page holds, until the total is in; a page that comes back empty, a total that changes under
   the reading or more than the pages allow is a list that cannot be read whole. */
export async function everyPage<T>(what: string, load: (page: number) => Promise<{ total: number; items: T[] } | null>): Promise<T[]> {
  const all: T[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await load(page);
    if (!got || (page > 1 && got.total !== total)) throw new Unread(`its list of ${what} was incomplete`);
    total = got.total;
    all.push(...got.items);
    if (all.length >= total) return all;
    if (!got.items.length) throw new Unread(`its list of ${what} was incomplete`);
  }
  throw new Unread(`it has more ${what} than are read`);
}

/* The workflow runs of the exact commit that are this repository's own, the latest attempt of each, narrowed by filter (a query
   string part such as &status=success). A run of a fork, or one that names another commit than the one asked, is not read as
   the commit's. */
export async function runsAt(json: Json, repo: RepoAddress, name: string, commit: string, filter: string, timeoutMs: number): Promise<Run[]> {
  const parsed = RunsPage.safeParse(await json(repo, name, `actions/runs?head_sha=${commit}${filter}&per_page=${PER_PAGE}&page=1`, timeoutMs));
  if (!parsed.success) throw new Unread('its list of workflow runs was incomplete');
  if (parsed.data.total_count > PER_PAGE) throw new Unread('it has more workflow runs than are read');
  if (parsed.data.workflow_runs.length !== parsed.data.total_count) throw new Unread('its list of workflow runs was incomplete');
  const own = (r: z.infer<typeof Repository> | null | undefined) => r?.full_name.toLowerCase() === name.toLowerCase();
  const runs = parsed.data.workflow_runs.filter(run => own(run.repository) && (!run.head_repository || own(run.head_repository)));
  if (runs.some(run => run.head_sha !== commit)) throw new Unread(`a workflow run of it names another commit than ${commit}`);
  return runs;
}

/* The default branch of the repository and where it stands now: its name and the commit at its head. */
export async function defaultBranchOf(json: Json, repo: RepoAddress, name: string, timeoutMs: number): Promise<{ branch: string; head: string }> {
  const info = Repo.safeParse(await json(repo, name, '', timeoutMs));
  const head = Commits.safeParse(await json(repo, name, 'commits?per_page=1', timeoutMs));
  if (!info.success || !head.success) throw new Unread('its default branch was not readable');
  return { branch: info.data.default_branch, head: head.data[0]!.sha };
}

