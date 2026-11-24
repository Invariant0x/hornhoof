import { z } from 'zod';
import { bodyWithin } from './bounded.js';
import { githubName, githubRateLimit, GitHubRateLimited, type GitHubLimits, type RateLimit } from './github-limit.js';
import type { RepoAddress } from './refs.js';

/* Verification of a repository's Images workflow run on GitHub Actions, read directly from GitHub's API with the
   repository's own token: the repository, workflow path, exact commit, completed success, attempt, every test job and passed. */
export const IMAGES_WORKFLOW = '.github/workflows/images.yml';
const JOBS_PER_PAGE = 100;
const MAX_JOB_PAGES = 20;
const GITHUB_RUN_MAX_BYTES = 8 * 1024 * 1024;
const READ_MS = 10_000;

export type GitHubRunWanted = { runId: number; commit: string; attempt?: number };
export type GitHubRunCheck =
  | { ok: true; id: number; attempt: number; commit: string }
  | { ok: false; kind: 'refused'; why: string }
  | { ok: false; kind: 'rate-limit'; rateLimit: RateLimit }
  | { ok: false; kind: 'unavailable'; why: string };
export type GitHubRunReader = (repo: RepoAddress, want: GitHubRunWanted, timeoutMs?: number) => Promise<GitHubRunCheck>;

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const RepoRef = z.object({ full_name: z.string().min(1) });
const WorkflowRun = z.object({
  id: z.number().int().positive(),
  path: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  head_sha: Sha,
  run_attempt: z.number().int().positive(),
  repository: RepoRef,
  head_repository: RepoRef.nullable().optional(),
});
const WorkflowJob = z.object({
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  head_sha: Sha,
  run_attempt: z.number().int().positive(),
});
const JobsPage = z.object({
  total_count: z.number().int().nonnegative(),
  jobs: z.array(WorkflowJob),
});

type Run = z.infer<typeof WorkflowRun>;
type Job = z.infer<typeof WorkflowJob>;

class RunRefused extends Error {}
class RunUnavailable extends Error {}

async function githubRunJson(repo: RepoAddress, name: string, path: string, timeoutMs: number): Promise<unknown> {
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
    if (response.status === 404) throw new RunRefused('there is no such run in this repository');
    if (response.status === 401 || response.status === 403) throw new RunRefused(`GitHub answered ${response.status} when reading the run`);
    throw new RunUnavailable('unavailable');
  }
  const body = await bodyWithin(response, GITHUB_RUN_MAX_BYTES);
  if (!body) throw new RunRefused('its answer was too large');
  return JSON.parse(body.toString('utf8')) as unknown;
}

type JsonAt = (repo: RepoAddress, name: string, path: string, timeoutMs: number) => Promise<unknown>;

function repoProblem(run: Run, expectedRepo: string): string | null {
  const expected = expectedRepo.toLowerCase();
  if (run.repository.full_name.toLowerCase() !== expected) return `it belongs to ${run.repository.full_name}, not ${expectedRepo}`;
  if (run.head_repository?.full_name.toLowerCase() !== expected) {
    return `its head repository is ${run.head_repository?.full_name ?? 'missing'}, not ${expectedRepo}`;
  }
  return null;
}

function runProblem(run: Run, expectedRepo: string, want: GitHubRunWanted): string | null {
  if (run.id !== want.runId) return `GitHub returned run ${run.id} instead of ${want.runId}`;
  const wrongRepo = repoProblem(run, expectedRepo);
  if (wrongRepo) return wrongRepo;
  if (run.path !== IMAGES_WORKFLOW) return `it ran ${run.path}, not ${IMAGES_WORKFLOW}`;
  if (run.head_sha !== want.commit) return `it checked ${run.head_sha} rather than ${want.commit}`;
  if (want.attempt !== undefined && run.run_attempt !== want.attempt) return `it is on attempt ${run.run_attempt}, not attempt ${want.attempt}`;
  if (run.status !== 'completed') return `it is ${run.status}, not completed`;
  if (run.conclusion !== 'success') return `it ended with ${run.conclusion ?? 'no conclusion'}, not success`;
  return null;
}

const isTestJob = (name: string): boolean => name === 'test' || /^test \(\d+\)$/.test(name);
const succeeded = (job: Job): boolean => job.status === 'completed' && job.conclusion === 'success';
const jobOutcome = (job: Job): string => (job.status === 'completed' ? (job.conclusion ?? 'no conclusion') : job.status);

function realTestProblem(jobs: Job[]): string | null {
  const bad = jobs.find(j => j.name === 'test-real' && !(j.status === 'completed' && (j.conclusion === 'success' || j.conclusion === 'skipped')));
  return bad ? `job test-real ended with ${jobOutcome(bad)}, not success` : null;
}

function jobsProblem(jobs: Job[], commit: string, attempt: number): string | null {
  if (jobs.some(j => j.head_sha !== commit || j.run_attempt !== attempt)) return `not every job ran on ${commit} in attempt ${attempt}`;
  const tests = jobs.filter(j => isTestJob(j.name));
  if (!tests.length) return 'it has no test jobs';
  const failedTest = tests.find(j => !succeeded(j));
  if (failedTest) return `test job ${failedTest.name} ended with ${jobOutcome(failedTest)}, not success`;
  const realProblem = realTestProblem(jobs);
  if (realProblem) return realProblem;
  const passed = jobs.filter(j => j.name === 'passed');
  if (passed.length !== 1) return passed.length === 0 ? 'it has no passed job' : 'it has more than one passed job';
  return succeeded(passed[0]!) ? null : `job passed ended with ${jobOutcome(passed[0]!)}, not success`;
}

async function readAttemptJobs(json: JsonAt, repo: RepoAddress, name: string, runId: number, attempt: number, timeoutMs: number): Promise<Job[]> {
  const base = `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${JOBS_PER_PAGE}`;
  const first = JobsPage.safeParse(await json(repo, name, base, timeoutMs));
  if (!first.success || (first.data.total_count > 0 && !first.data.jobs.length)) throw new RunRefused('its job list was incomplete');
  const jobs = [...first.data.jobs];
  for (let page = 2; jobs.length < first.data.total_count; page++) {
    if (page > MAX_JOB_PAGES) throw new RunRefused('its job list exceeded the page limit');
    const more = JobsPage.safeParse(await json(repo, name, `${base}&page=${page}`, timeoutMs));
    if (!more.success || !more.data.jobs.length || more.data.total_count !== first.data.total_count) {
      throw new RunRefused('its job list was incomplete');
    }
    jobs.push(...more.data.jobs);
  }
  if (jobs.length !== first.data.total_count) throw new RunRefused('its job list was incomplete');
  return jobs;
}

function classifiedFailure(error: unknown): GitHubRunCheck {
  if (error instanceof GitHubRateLimited) return { ok: false, kind: 'rate-limit', rateLimit: error.limit };
  if (error instanceof RunRefused) return { ok: false, kind: 'refused', why: error.message };
  return { ok: false, kind: 'unavailable', why: "GitHub didn't answer while checking the workflow run. Try again." };
}

async function checkRunAt(json: JsonAt, repo: RepoAddress, want: GitHubRunWanted, timeoutMs: number): Promise<GitHubRunCheck> {
  if (!Number.isSafeInteger(want.runId) || want.runId <= 0) return { ok: false, kind: 'refused', why: 'the run id is invalid' };
  if (!Sha.safeParse(want.commit).success) return { ok: false, kind: 'refused', why: 'the commit is invalid' };
  const name = githubName(repo.url);
  if (!name) return { ok: false, kind: 'refused', why: 'the repository is not on github.com' };
  try {
    const parsed = WorkflowRun.safeParse(await json(repo, name, `actions/runs/${want.runId}`, timeoutMs));
    if (!parsed.success) return { ok: false, kind: 'refused', why: 'its workflow run record was incomplete' };
    const problem = runProblem(parsed.data, name, want);
    if (problem) return { ok: false, kind: 'refused', why: problem };
    const jobs = await readAttemptJobs(json, repo, name, want.runId, parsed.data.run_attempt, timeoutMs);
    const badJobs = jobsProblem(jobs, want.commit, parsed.data.run_attempt);
    if (badJobs) return { ok: false, kind: 'refused', why: badJobs };
    return { ok: true, id: parsed.data.id, attempt: parsed.data.run_attempt, commit: parsed.data.head_sha };
  } catch (error) {
    return classifiedFailure(error);
  }
}

export function githubRunReader(limits?: GitHubLimits): GitHubRunReader {
  const json: JsonAt = limits
    ? (repo, name, path, timeout) => limits.request(repo, () => githubRunJson(repo, name, path, timeout))
    : githubRunJson;
  return (repo, want, timeout = READ_MS) => checkRunAt(json, repo, want, timeout);
}

export const readGitHubRun = githubRunReader();
