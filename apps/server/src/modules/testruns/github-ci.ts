import { z } from 'zod';
import { bodyWithin } from './bounded.js';
import { githubName, githubRateLimit, GitHubRateLimited, type GitHubLimits, type RateLimit } from './github-limit.js';
import type { RepoAddress } from './refs.js';

/* What the repository's own CI says of one exact commit. CI here is the repository's GitHub Actions: the workflow runs of that
   sha, read from GitHub's API with the repository's token, and the jobs of each. Commit statuses and the check runs of other
   apps are never read: any token with write access can post one, so none of them proves a thing. The server decides from this
   answer, never from a caller's word.
   green: every run of the commit finished, every job of each finished, none failed and one at least succeeded; checks counts the
   jobs that succeeded. red and pending name the first run or job that stopped it, with its link. idle: runs finished and no job
   succeeded, as all were skipped. absent: the commit keeps workflow files but no run of them is on it yet. stripped: the
   commit keeps no workflow file while the default branch has CI, so no run can come. none: the repository has no CI at all.
   unsupported: not on github.com, the only host read here. unread: GitHub did not answer, or answered what cannot be trusted.
   limited: the account's request limit is used up. */
export type CiAt =
  | { state: 'none'; why: string }
  | { state: 'green'; checks: number }
  | { state: 'red'; check: string; url: string | null; outcome: string }
  | { state: 'pending'; check: string; url: string | null; outcome: string }
  | { state: 'idle'; checks: number }
  | { state: 'absent' }
  | { state: 'stripped'; branch: string }
  | { state: 'unsupported'; why: string }
  | { state: 'unread'; why: string }
  | { state: 'limited'; limit: RateLimit };
export type CiReader = (repo: RepoAddress, commit: string, timeoutMs?: number) => Promise<CiAt>;

const READ_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const PER_PAGE = 100;
/* The most jobs of one run read: a thousand. A run with more is not read whole. */
const MAX_PAGES = 10;
/* The most workflow runs of one commit read: one page. */
const MAX_RUNS = PER_PAGE;
const SHOWN = 160;

export const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Repository = z.object({ full_name: z.string().min(1) });
const WorkflowRun = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  head_sha: Sha,
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable().optional(),
  run_attempt: z.number().int().positive(),
  repository: Repository,
  head_repository: Repository.nullable().optional(),
});
const RunsPage = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(WorkflowRun) });
const Job = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  run_attempt: z.number().int().positive().optional(),
  name: z.string().min(1),
  head_sha: Sha,
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable().optional(),
});
const JobsPage = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(Job) });
const Commits = z.array(z.object({ sha: Sha })).min(1);
const Repo = z.object({ default_branch: z.string().min(1).max(250) });
const Reported = z.object({ total_count: z.number().int().nonnegative() });
const StatusReported = Reported.extend({ sha: Sha });
const Workflows = z.array(z.object({ type: z.string(), name: z.string() }));

type Run = z.infer<typeof WorkflowRun>;
type Stopped = { check: string; url: string | null; outcome: string };
type Settled = { ok: 'yes'; jobs: number } | { ok: 'skip'; jobs: number } | ({ ok: 'red' } & Stopped) | ({ ok: 'pending' } & Stopped);

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
const NO_FAULT = new Set(['neutral', 'skipped']);

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
async function everyPage<T>(what: string, load: (page: number) => Promise<{ total: number; items: T[] } | null>): Promise<T[]> {
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

/* The workflow runs of the exact commit that are this repository's own, the latest attempt of each. A run of a fork, or one
   that names another commit than the one asked, is not read as the commit's. */
async function runsOf(json: Json, repo: RepoAddress, name: string, commit: string, timeoutMs: number): Promise<Run[]> {
  const parsed = RunsPage.safeParse(await json(repo, name, `actions/runs?head_sha=${commit}&per_page=${PER_PAGE}&page=1`, timeoutMs));
  if (!parsed.success) throw new Unread('its list of workflow runs was incomplete');
  if (parsed.data.total_count > MAX_RUNS) throw new Unread('it has more workflow runs than are read');
  if (parsed.data.workflow_runs.length !== parsed.data.total_count) throw new Unread('its list of workflow runs was incomplete');
  const own = (r: z.infer<typeof Repository> | null | undefined) => r?.full_name.toLowerCase() === name.toLowerCase();
  const runs = parsed.data.workflow_runs.filter(run => own(run.repository) && (!run.head_repository || own(run.head_repository)));
  if (runs.some(run => run.head_sha !== commit)) throw new Unread(`a workflow run of it names another commit than ${commit}`);
  return runs;
}

/* Every job of one run, the latest attempt's, each of the run and the commit asked. */
async function jobsOf(json: Json, repo: RepoAddress, name: string, run: Run, timeoutMs: number): Promise<z.infer<typeof Job>[]> {
  const jobs = await everyPage('jobs', async page => {
    const parsed = JobsPage.safeParse(await json(repo, name, `actions/runs/${run.id}/jobs?filter=latest&per_page=${PER_PAGE}&page=${page}`, timeoutMs));
    return parsed.success ? { total: parsed.data.total_count, items: parsed.data.jobs } : null;
  });
  if (jobs.some(job => job.run_id !== run.id || job.head_sha !== run.head_sha || (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt))) {
    throw new Unread(`a job of the workflow run ${run.id} is of another run or commit`);
  }
  return jobs;
}

const runName = (run: Run): string => shown(run.name || run.path || `workflow run ${run.id}`);

function settleJob(run: Run, job: z.infer<typeof Job>): Settled {
  const at = { check: shown(`${runName(run)} / ${job.name}`), url: linkOf(job.html_url) };
  if (job.status !== 'completed') return { ok: 'pending', ...at, outcome: job.status };
  if (job.conclusion === 'success') return { ok: 'yes', jobs: 1 };
  if (job.conclusion && NO_FAULT.has(job.conclusion)) return { ok: 'skip', jobs: 1 };
  return { ok: 'red', ...at, outcome: job.conclusion ?? 'no conclusion' };
}

/* What every job of a run that finished with success says: all of them finished, none failed. A run with no job listed has
   a job missing. */
function settleJobs(run: Run, jobs: z.infer<typeof Job>[]): Settled[] {
  if (!jobs.length) return [{ ok: 'pending', check: runName(run), url: linkOf(run.html_url), outcome: 'no job of it has reported' }];
  return jobs.map(job => settleJob(run, job));
}

/* A run on its own: pending until it finished, red unless it ended with success, skipped or neutral. Only a run that ended
   with success is read job by job. */
async function settleRun(json: Json, repo: RepoAddress, name: string, run: Run, timeoutMs: number): Promise<Settled[]> {
  const at = { check: runName(run), url: linkOf(run.html_url) };
  if (run.status !== 'completed') return [{ ok: 'pending', ...at, outcome: run.status }];
  if (run.conclusion === 'success') return settleJobs(run, await jobsOf(json, repo, name, run, timeoutMs));
  if (run.conclusion && NO_FAULT.has(run.conclusion)) return [{ ok: 'skip', jobs: 1 }];
  return [{ ok: 'red', ...at, outcome: run.conclusion ?? 'no conclusion' }];
}

function verdict(settled: Settled[]): CiAt {
  const red = settled.find((s): s is { ok: 'red' } & Stopped => s.ok === 'red');
  if (red) return { state: 'red', check: red.check, url: red.url, outcome: red.outcome };
  const pending = settled.find((s): s is { ok: 'pending' } & Stopped => s.ok === 'pending');
  if (pending) return { state: 'pending', check: pending.check, url: pending.url, outcome: pending.outcome };
  const passed = settled.reduce((sum, s) => sum + (s.ok === 'yes' ? s.jobs : 0), 0);
  return passed > 0 ? { state: 'green', checks: passed } : { state: 'idle', checks: settled.length };
}

/* Whether the repository keeps workflow files at the commit: a commit with no run yet, in a repository whose workflows have
   not run on it, is not a commit with no CI. */
async function hasWorkflows(json: Json, repo: RepoAddress, name: string, commit: string, timeoutMs: number): Promise<boolean> {
  try {
    const parsed = Workflows.safeParse(await json(repo, name, `contents/.github/workflows?ref=${commit}`, timeoutMs));
    if (!parsed.success) throw new Unread('its list of workflows was not readable');
    return parsed.data.some(file => file.type === 'file' && /\.ya?ml$/i.test(file.name));
  } catch (error) {
    if (error instanceof Absent) return false;
    throw error;
  }
}

/* The default branch of the repository and where it stands now: its name and the commit at its head. */
export async function defaultBranchOf(json: Json, repo: RepoAddress, name: string, timeoutMs: number): Promise<{ branch: string; head: string }> {
  const info = Repo.safeParse(await json(repo, name, '', timeoutMs));
  const head = Commits.safeParse(await json(repo, name, 'commits?per_page=1', timeoutMs));
  if (!info.success || !head.success) throw new Unread('its default branch was not readable');
  return { branch: info.data.default_branch, head: head.data[0]!.sha };
}

/* Whether the default branch has CI of any kind: workflow files at its head, or a check or a status ever reported on it. Any
   sign of CI there, even one that proves nothing, means the repository is not one with no CI. */
async function defaultHasCi(json: Json, repo: RepoAddress, name: string, head: string, timeoutMs: number): Promise<boolean> {
  if (await hasWorkflows(json, repo, name, head, timeoutMs)) return true;
  const checks = Reported.safeParse(await json(repo, name, `commits/${head}/check-runs?filter=latest&per_page=1`, timeoutMs));
  const statuses = StatusReported.safeParse(await json(repo, name, `commits/${head}/status?per_page=1`, timeoutMs));
  if (!checks.success || !statuses.success || statuses.data.sha !== head) throw new Unread('what was reported on its default branch was not readable');
  return checks.data.total_count > 0 || statuses.data.total_count > 0;
}

/* A commit no workflow run is on: absent where it keeps workflow files, so a run can still come; otherwise the repository's
   default branch says whether the commit took its workflows away (stripped) or the repository has no CI at all. */
async function noRunAt(json: Json, repo: RepoAddress, name: string, commit: string, timeoutMs: number): Promise<CiAt> {
  if (await hasWorkflows(json, repo, name, commit, timeoutMs)) return { state: 'absent' };
  const main = await defaultBranchOf(json, repo, name, timeoutMs);
  if (await defaultHasCi(json, repo, name, main.head, timeoutMs)) return { state: 'stripped', branch: shown(main.branch) };
  return { state: 'none', why: 'no workflow file, no check and no status belongs to this commit or to the default branch' };
}

async function ciAt(json: Json, repo: RepoAddress, commit: string, timeoutMs: number): Promise<CiAt> {
  if (!Sha.safeParse(commit).success) return { state: 'unread', why: 'the commit is not a full commit id' };
  const name = githubName(repo.url);
  if (!name) return { state: 'unsupported', why: 'the repository is not on github.com, the only host whose CI is read' };
  try {
    const runs = await runsOf(json, repo, name, commit, timeoutMs);
    if (!runs.length) return await noRunAt(json, repo, name, commit, timeoutMs);
    return verdict((await Promise.all(runs.map(run => settleRun(json, repo, name, run, timeoutMs)))).flat());
  } catch (error) {
    if (error instanceof GitHubRateLimited) return { state: 'limited', limit: error.limit };
    if (error instanceof Unread) return { state: 'unread', why: error.message };
    return { state: 'unread', why: "GitHub didn't answer while its checks were read" };
  }
}

/* The reader of a server: its request limit is shared with every other GitHub reader of the server. */
export function githubCiReader(limits?: GitHubLimits): CiReader {
  const json = jsonOf(limits);
  return (repo, commit, timeout = READ_MS) => ciAt(json, repo, commit, timeout);
}

export const readCi = githubCiReader();
