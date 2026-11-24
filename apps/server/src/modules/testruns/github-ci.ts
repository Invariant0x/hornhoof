import { z } from 'zod';
import { Absent, PER_PAGE, Sha, Unread, defaultBranchOf, everyPage, jsonOf, linkOf, runsAt, shown, type Json, type Run } from './github-api.js';
import { releaseWorkflowOf } from './github-workflow.js';
import { githubName, GitHubRateLimited, type GitHubLimits, type RateLimit } from './github-limit.js';
import type { RepoAddress } from './refs.js';

/* What the repository's own CI says of one exact commit. CI here is the GitHub Actions runs of the repository's release workflow
   on that sha, read from GitHub's API with the repository's token, and the jobs of each (github-workflow.ts says which
   workflow that is). Commit statuses, the check runs of other apps and the runs of any other workflow are never read: any token
   with write access can post a status or start another workflow, so none of them proves a thing. The server decides from this
   answer, never from a caller's word.
   green: every run of the release workflow on the commit finished, every job of each finished, no test job was skipped, none
   failed and one at least succeeded; checks counts the jobs that succeeded. red and pending name the first run or job that
   stopped it, with its link; a test job that was skipped, as Images does where a status says the tests passed, is red. idle:
   runs finished and no job succeeded, as all were skipped. absent: no run of the release workflow is on the commit yet.
   stripped: the commit keeps no workflow file while the default branch has CI, so no run can come. unnamed: the repository's
   release workflow cannot be told. none: the repository has no CI at all. unsupported: not on github.com, the only host read
   here. unread: GitHub did not answer, or answered what cannot be trusted. limited: the account's request limit is used up. */
export type CiAt =
  | { state: 'none'; why: string }
  | { state: 'green'; checks: number }
  | { state: 'red'; check: string; url: string | null; outcome: string }
  | { state: 'pending'; check: string; url: string | null; outcome: string }
  | { state: 'idle'; checks: number }
  | { state: 'absent' }
  | { state: 'stripped'; branch: string }
  | { state: 'unnamed'; why: string }
  | { state: 'unsupported'; why: string }
  | { state: 'unread'; why: string }
  | { state: 'limited'; limit: RateLimit };
export type CiReader = (repo: RepoAddress, commit: string, timeoutMs?: number) => Promise<CiAt>;

const READ_MS = 10_000;

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
const Reported = z.object({ total_count: z.number().int().nonnegative() });
const StatusReported = Reported.extend({ sha: Sha });
const Workflows = z.array(z.object({ type: z.string(), name: z.string() }));

type JobOf = z.infer<typeof Job>;
type Stopped = { check: string; url: string | null; outcome: string };
type Settled = { ok: 'yes'; jobs: number } | { ok: 'skip'; jobs: number } | ({ ok: 'red' } & Stopped) | ({ ok: 'pending' } & Stopped);

/* A conclusion that is no fault: neutral and skipped ones ran nothing that failed, and count for no success. */
const NO_FAULT = new Set(['neutral', 'skipped']);

/* The job that runs a repository's tests: named test or tests, with or without the matrix a workflow adds, as test (1). A
   workflow that skips it, as a status that says the tests passed can make it, has proved nothing of the commit's tests. */
const TEST_JOB = /^tests?(?: \(.*\))?$/i;

/* Every job of one run, the latest attempt's, each of the run and the commit asked. */
async function jobsOf(json: Json, repo: RepoAddress, name: string, run: Run, timeoutMs: number): Promise<JobOf[]> {
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

function settleJob(run: Run, job: JobOf): Settled {
  const at = { check: shown(`${runName(run)} / ${job.name}`), url: linkOf(job.html_url) };
  if (job.status !== 'completed') return { ok: 'pending', ...at, outcome: job.status };
  if (job.conclusion === 'success') return { ok: 'yes', jobs: 1 };
  if (job.conclusion === 'skipped' && TEST_JOB.test(job.name)) return { ok: 'red', ...at, outcome: 'skipped' };
  if (job.conclusion && NO_FAULT.has(job.conclusion)) return { ok: 'skip', jobs: 1 };
  return { ok: 'red', ...at, outcome: job.conclusion ?? 'no conclusion' };
}

/* What every job of a run that finished with success says: all of them finished, none failed. A run with no job listed has
   a job missing. */
function settleJobs(run: Run, jobs: JobOf[]): Settled[] {
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

/* What the release workflow's runs on a commit say, the runs of every other workflow set aside. */
async function ofReleaseWorkflow(json: Json, repo: RepoAddress, name: string, runs: Run[], timeoutMs: number): Promise<CiAt> {
  const chosen = await releaseWorkflowOf(json, repo, name, false, timeoutMs);
  if ('no' in chosen) return { state: 'unnamed', why: chosen.no };
  const own = runs.filter(run => run.workflow_id === chosen.workflow.id);
  if (!own.length) return { state: 'absent' };
  return verdict((await Promise.all(own.map(run => settleRun(json, repo, name, run, timeoutMs)))).flat());
}

async function ciAt(json: Json, repo: RepoAddress, commit: string, timeoutMs: number): Promise<CiAt> {
  if (!Sha.safeParse(commit).success) return { state: 'unread', why: 'the commit is not a full commit id' };
  const name = githubName(repo.url);
  if (!name) return { state: 'unsupported', why: 'the repository is not on github.com, the only host whose CI is read' };
  try {
    const runs = await runsAt(json, repo, name, commit, '', timeoutMs);
    return runs.length ? await ofReleaseWorkflow(json, repo, name, runs, timeoutMs) : await noRunAt(json, repo, name, commit, timeoutMs);
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
