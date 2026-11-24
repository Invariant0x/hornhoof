import { z } from 'zod';
import { bodyWithin } from './bounded.js';
import { githubName, githubRateLimit, GitHubRateLimited, type GitHubLimits, type RateLimit } from './github-limit.js';
import type { RepoAddress } from './refs.js';

/* What the repository's own CI says of one exact commit, read from GitHub's API with the repository's token: the check runs and
   the combined commit status of that sha, every one of them. The server decides from this answer, never from a caller's word.
   none: the repository has no CI at all (no check, no status, no workflow file at that commit), or is not on GitHub, which has
   no reader here. green: every check passed and one at least succeeded. red and pending name the first check that stopped it,
   with its link. idle: checks ran and none succeeded, as all were skipped. unread: GitHub did not answer, or answered what
   cannot be trusted. limited: the account's request limit is used up. */
export type CiAt =
  | { state: 'none'; why: string }
  | { state: 'green'; checks: number }
  | { state: 'red'; check: string; url: string | null; outcome: string }
  | { state: 'pending'; check: string; url: string | null; outcome: string }
  | { state: 'idle'; checks: number }
  | { state: 'unread'; why: string }
  | { state: 'limited'; limit: RateLimit };
export type CiReader = (repo: RepoAddress, commit: string, timeoutMs?: number) => Promise<CiAt>;

const READ_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const PER_PAGE = 100;
/* The most checks and statuses of one commit read: a thousand of each. A commit with more is not read whole. */
const MAX_PAGES = 10;
const SHOWN = 160;

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const CheckRun = z.object({
  name: z.string().min(1),
  head_sha: Sha,
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable().optional(),
});
const CheckRunsPage = z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(CheckRun) });
const CommitStatus = z.object({ context: z.string().min(1), state: z.string().min(1), target_url: z.string().nullable().optional() });
const StatusPage = z.object({ sha: Sha, total_count: z.number().int().nonnegative(), statuses: z.array(CommitStatus) });
const Workflows = z.array(z.object({ type: z.string(), name: z.string() }));

type Stopped = { check: string; url: string | null; outcome: string };
type Settled = { ok: 'yes' } | { ok: 'skip' } | ({ ok: 'red' } & Stopped) | ({ ok: 'pending' } & Stopped);

class Unread extends Error {}
class Absent extends Error {}

/* Text from GitHub that goes into what an agent reads: short, one line, and a link only if it is a plain https address. */
const shown = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, SHOWN);
function linkOf(url: string | null | undefined): string | null {
  if (!url || url.length > 300) return null;
  try {
    const at = new URL(url);
    return at.protocol === 'https:' && !at.username && !at.password ? at.href : null;
  } catch { return null; }
}

/* A conclusion that is no fault: neutral and skipped checks ran nothing that failed, and count for no success. */
const NO_FAULT = new Set(['neutral', 'skipped']);

function settleRun(run: z.infer<typeof CheckRun>): Settled {
  const at = { check: shown(run.name), url: linkOf(run.html_url) };
  if (run.status !== 'completed') return { ok: 'pending', ...at, outcome: run.status };
  if (run.conclusion === 'success') return { ok: 'yes' };
  if (run.conclusion && NO_FAULT.has(run.conclusion)) return { ok: 'skip' };
  return { ok: 'red', ...at, outcome: run.conclusion ?? 'no conclusion' };
}

function settleStatus(status: z.infer<typeof CommitStatus>): Settled {
  const at = { check: shown(status.context), url: linkOf(status.target_url) };
  if (status.state === 'success') return { ok: 'yes' };
  if (status.state === 'pending') return { ok: 'pending', ...at, outcome: 'pending' };
  return { ok: 'red', ...at, outcome: status.state };
}

async function githubCiJson(repo: RepoAddress, name: string, path: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/${name}/${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'hornhoof',
      'x-github-api-version': '2022-11-28',
      ...(repo.token ? { authorization: `Bearer ${repo.token}` } : {}),
    },
  });
  if (!response.ok) {
    const limit = githubRateLimit(response);
    await response.body?.cancel().catch(() => {});
    if (limit) throw new GitHubRateLimited(limit);
    if (response.status === 404) throw new Absent();
    throw new Unread(`GitHub answered ${response.status} when reading the checks`);
  }
  const body = await bodyWithin(response, MAX_BYTES);
  if (!body) throw new Unread('its answer was too large');
  return JSON.parse(body.toString('utf8')) as unknown;
}

type JsonAt = (repo: RepoAddress, name: string, path: string, timeoutMs: number) => Promise<unknown>;

/* Every check run of the sha, the latest of each, however many pages. */
async function checkRunsAt(json: JsonAt, repo: RepoAddress, name: string, commit: string, timeoutMs: number): Promise<z.infer<typeof CheckRun>[]> {
  const base = `commits/${commit}/check-runs?filter=latest&per_page=${PER_PAGE}`;
  const runs: z.infer<typeof CheckRun>[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const parsed = CheckRunsPage.safeParse(await json(repo, name, `${base}&page=${page}`, timeoutMs));
    if (!parsed.success || (page > 1 && parsed.data.total_count !== total)) throw new Unread('its list of check runs was incomplete');
    total = parsed.data.total_count;
    runs.push(...parsed.data.check_runs);
    if (runs.length >= total) break;
    if (!parsed.data.check_runs.length) throw new Unread('its list of check runs was incomplete');
  }
  if (runs.length < total) throw new Unread('it has more check runs than are read');
  if (runs.some(run => run.head_sha !== commit)) throw new Unread(`a check run of it names another commit than ${commit}`);
  return runs;
}

/* Every status of the sha's combined status, the latest of each context. */
async function statusesAt(json: JsonAt, repo: RepoAddress, name: string, commit: string, timeoutMs: number): Promise<z.infer<typeof CommitStatus>[]> {
  const base = `commits/${commit}/status?per_page=${PER_PAGE}`;
  const statuses: z.infer<typeof CommitStatus>[] = [];
  let total = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const parsed = StatusPage.safeParse(await json(repo, name, `${base}&page=${page}`, timeoutMs));
    if (!parsed.success || parsed.data.sha !== commit || (page > 1 && parsed.data.total_count !== total)) throw new Unread('its commit status was incomplete');
    total = parsed.data.total_count;
    statuses.push(...parsed.data.statuses);
    if (statuses.length >= total) break;
    if (!parsed.data.statuses.length) throw new Unread('its commit status was incomplete');
  }
  if (statuses.length < total) throw new Unread('it has more statuses than are read');
  return statuses;
}

/* Whether the repository keeps workflow files at the commit: a commit with no check yet, in a repository whose workflows have
   not run on it, is not a commit with no CI. */
async function hasWorkflows(json: JsonAt, repo: RepoAddress, name: string, commit: string, timeoutMs: number): Promise<boolean> {
  try {
    const parsed = Workflows.safeParse(await json(repo, name, `contents/.github/workflows?ref=${commit}`, timeoutMs));
    if (!parsed.success) throw new Unread('its list of workflows was not readable');
    return parsed.data.some(file => file.type === 'file' && /\.ya?ml$/i.test(file.name));
  } catch (error) {
    if (error instanceof Absent) return false;
    throw error;
  }
}

function verdict(settled: Settled[]): CiAt {
  const red = settled.find((s): s is { ok: 'red' } & Stopped => s.ok === 'red');
  if (red) return { state: 'red', check: red.check, url: red.url, outcome: red.outcome };
  const pending = settled.find((s): s is { ok: 'pending' } & Stopped => s.ok === 'pending');
  if (pending) return { state: 'pending', check: pending.check, url: pending.url, outcome: pending.outcome };
  return settled.some(s => s.ok === 'yes') ? { state: 'green', checks: settled.length } : { state: 'idle', checks: settled.length };
}

async function ciAt(json: JsonAt, repo: RepoAddress, commit: string, timeoutMs: number): Promise<CiAt> {
  if (!Sha.safeParse(commit).success) return { state: 'unread', why: 'the commit is not a full commit id' };
  const name = githubName(repo.url);
  if (!name) return { state: 'none', why: 'the repository is not on github.com, which is the only host whose CI is read' };
  try {
    const runs = await checkRunsAt(json, repo, name, commit, timeoutMs);
    const statuses = await statusesAt(json, repo, name, commit, timeoutMs);
    const settled = [...runs.map(settleRun), ...statuses.map(settleStatus)];
    if (settled.length) return verdict(settled);
    if (await hasWorkflows(json, repo, name, commit, timeoutMs)) {
      return { state: 'pending', check: 'the workflows of the repository', url: null, outcome: 'no check of them has reported on this commit' };
    }
    return { state: 'none', why: 'no check, no status and no workflow file belongs to this commit' };
  } catch (error) {
    if (error instanceof GitHubRateLimited) return { state: 'limited', limit: error.limit };
    if (error instanceof Unread) return { state: 'unread', why: error.message };
    return { state: 'unread', why: "GitHub didn't answer while its checks were read" };
  }
}

/* The reader of a server: its request limit is shared with every other GitHub reader of the server. */
export function githubCiReader(limits?: GitHubLimits): CiReader {
  const json: JsonAt = limits
    ? (repo, name, path, timeout) => limits.request(repo, () => githubCiJson(repo, name, path, timeout))
    : githubCiJson;
  return (repo, commit, timeout = READ_MS) => ciAt(json, repo, commit, timeout);
}

export const readCi = githubCiReader();
