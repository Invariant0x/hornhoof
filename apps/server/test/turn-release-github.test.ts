import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { approvalPolicies, autonomousReleases, departments, turnReleases, waitNotices } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { BASE } from './development-echelons-fixture.js';
import { as } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { releasing } from './turn-release-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

const GITHUB_RUN_ID = 45_292_644_380;
const EXTRA = '7'.repeat(40);
const REPO_URL = 'https://github.com/invariant0x/hornhoof.git';
const REPO_TOKEN = 'ghp_repo_secret_token_never_expose_1234';
const RESET_UNIX = 1_795_529_400; // 2026-11-24T14:10:00.000Z -> 14:10 UTC

type JobStub = {
  name: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  run_attempt?: number;
};

type RunStub = {
  id?: number;
  name?: string;
  path?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
  head_branch?: string;
  run_attempt?: number;
  repository?: { full_name: string };
  head_repository?: { full_name: string } | null;
  jobs?: JobStub[];
  totalJobs?: number;
};

function defaultJobs(commit: string, attempt = 2): JobStub[] {
  return [
    { name: 'mark', status: 'completed', conclusion: 'success', head_sha: commit, run_attempt: attempt },
    { name: 'test (1)', status: 'completed', conclusion: 'success', head_sha: commit, run_attempt: attempt },
    { name: 'test (2)', status: 'completed', conclusion: 'success', head_sha: commit, run_attempt: attempt },
    { name: 'test (3)', status: 'completed', conclusion: 'success', head_sha: commit, run_attempt: attempt },
    { name: 'test (4)', status: 'completed', conclusion: 'success', head_sha: commit, run_attempt: attempt },
    { name: 'test-real', status: 'completed', conclusion: 'skipped', head_sha: commit, run_attempt: attempt },
    { name: 'passed', status: 'completed', conclusion: 'success', head_sha: commit, run_attempt: attempt },
    { name: 'images (hornhoof, Dockerfile)', status: 'completed', conclusion: 'success', head_sha: commit, run_attempt: attempt },
    { name: 'publish', status: 'completed', conclusion: 'skipped', head_sha: commit, run_attempt: attempt },
    { name: 'release', status: 'completed', conclusion: 'skipped', head_sha: commit, run_attempt: attempt },
  ];
}

function runPayload(commit: string, overrides: RunStub = {}) {
  const attempt = overrides.run_attempt ?? 2;
  return {
    id: overrides.id ?? GITHUB_RUN_ID,
    name: overrides.name ?? 'Images',
    path: overrides.path ?? '.github/workflows/images.yml',
    event: overrides.event ?? 'workflow_dispatch',
    status: overrides.status ?? 'completed',
    conclusion: overrides.conclusion === undefined ? 'success' : overrides.conclusion,
    head_sha: overrides.head_sha ?? commit,
    head_branch: overrides.head_branch ?? 'release-0.43.0',
    run_attempt: attempt,
    repository: overrides.repository ?? { full_name: 'Invariant0x/hornhoof' },
    head_repository: overrides.head_repository === undefined ? { full_name: 'Invariant0x/hornhoof' } : overrides.head_repository,
  };
}

function jobsPayload(commit: string, overrides: RunStub = {}, page = 1) {
  const attempt = overrides.run_attempt ?? 2;
  const all = (overrides.jobs ?? defaultJobs(commit, attempt)).map(job => ({
    name: job.name,
    status: job.status ?? 'completed',
    conclusion: job.conclusion === undefined ? 'success' : job.conclusion,
    head_sha: job.head_sha ?? commit,
    run_attempt: job.run_attempt ?? attempt,
  }));
  const slice = all.slice((page - 1) * 100, page * 100);
  return { total_count: overrides.totalJobs ?? all.length, jobs: slice };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const rateLimitedResponse = (status = 403, reset: string | null = String(RESET_UNIX)) =>
  new Response('{"message":"API rate limit exceeded"}', {
    status,
    headers: {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      ...(reset !== null ? { 'x-ratelimit-reset': reset } : {}),
    },
  });

function stubGitHubApi(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const realFetch = globalThis.fetch;
  const calls: { url: string; auth: string | null; redirect: RequestInit['redirect'] }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!raw.startsWith('https://api.github.com/')) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    calls.push({ url: raw, auth: headers.get('authorization'), redirect: init?.redirect });
    return handler(new URL(raw), init);
  });
  return calls;
}

async function releasingOnGitHub() {
  const f = await releasing();
  await f.db.update(departments).set({
    repoUrl: REPO_URL,
    repoTokenEnc: encryptSecret(REPO_TOKEN, f.ctx.config.secret),
    repoTokenLast4: REPO_TOKEN.slice(-4),
  }).where(eq(departments.id, f.task.departmentId!));
  return f;
}

const recorded = (text: string) => JSON.parse(text) as Record<string, unknown>;

type StoredReleaseRow = {
  run_id: string | null;
  github_run_id: string | number | null;
  github_run_attempt: number | null;
  github_run_commit: string | null;
  commit: string;
};

async function storedReleases(f: Awaited<ReturnType<typeof releasing>>): Promise<StoredReleaseRow[]> {
  const { rows } = await f.db.execute<StoredReleaseRow>(
    sql`SELECT run_id, github_run_id, github_run_attempt, github_run_commit, commit FROM turn_releases WHERE turn_id = ${f.turn.id}`,
  );
  return rows;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('release_turn with a GitHub Actions Images whole run', () => {
  it('accepts a passed GitHub Images run of the exact commit on its current attempt, sends the repository token, and stores id, attempt and commit', async () => {
    const f = await releasingOnGitHub();
    await f.approve();
    const calls = stubGitHubApi(url => {
      if (url.pathname === `/repos/invariant0x/hornhoof/actions/runs/${GITHUB_RUN_ID}`) {
        return jsonResponse(runPayload(f.R, { run_attempt: 2 }));
      }
      /* Attempt 1 had failed jobs; the server must check attempt 2, the run's attempt. */
      if (url.pathname === `/repos/invariant0x/hornhoof/actions/runs/${GITHUB_RUN_ID}/attempts/1/jobs`) {
        return jsonResponse(jobsPayload(f.R, {
          run_attempt: 1,
          jobs: [
            { name: 'test (1)', conclusion: 'failure', run_attempt: 1 },
            { name: 'passed', conclusion: 'skipped', run_attempt: 1 },
          ],
        }));
      }
      if (url.pathname === `/repos/invariant0x/hornhoof/actions/runs/${GITHUB_RUN_ID}/attempts/2/jobs`) {
        return jsonResponse(jobsPayload(f.R, { run_attempt: 2 }, Number(url.searchParams.get('page') ?? '1')));
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await f.recordRelease({ githubRunId: GITHUB_RUN_ID });
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({
      turn: f.turn.number,
      commit: f.R,
      baseCommit: BASE,
      runId: null,
      githubRunId: GITHUB_RUN_ID,
      githubRunAttempt: 2,
      covered: true,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.auth).toBe(`Bearer ${REPO_TOKEN}`);
      expect(call.redirect).toBe('manual');
    }
    expect(calls.map(c => new URL(c.url).pathname)).toContain(`/repos/invariant0x/hornhoof/actions/runs/${GITHUB_RUN_ID}/attempts/2/jobs`);
    expect(calls.map(c => new URL(c.url).pathname)).not.toContain(`/repos/invariant0x/hornhoof/actions/runs/${GITHUB_RUN_ID}/attempts/1/jobs`);

    const rows = await storedReleases(f);
    expect(rows).toHaveLength(1);
    expect({
      ...rows[0],
      github_run_id: Number(rows[0]!.github_run_id),
    }).toEqual({
      run_id: null,
      github_run_id: GITHUB_RUN_ID,
      github_run_attempt: 2,
      github_run_commit: f.R,
      commit: f.R,
    });
  });

  it('pages through all job pages of the checked attempt before accepting', async () => {
    const f = await releasingOnGitHub();
    await f.approve();
    const fillers: JobStub[] = Array.from({ length: 99 }, (_, i) => ({ name: `lint-${i + 1}`, conclusion: 'success' }));
    const allJobs: JobStub[] = [
      ...fillers,
      { name: 'test (1)', conclusion: 'success' },
      { name: 'passed', conclusion: 'success' },
    ];
    stubGitHubApi(url => {
      if (url.pathname.endsWith(`/runs/${GITHUB_RUN_ID}`)) return jsonResponse(runPayload(f.R));
      if (url.pathname.endsWith('/attempts/2/jobs')) {
        return jsonResponse(jobsPayload(f.R, { jobs: allJobs }, Number(url.searchParams.get('page') ?? '1')));
      }
      return new Response('Not Found', { status: 404 });
    });

    const result = await f.recordRelease({ githubRunId: GITHUB_RUN_ID });
    expect(result.isError).toBe(false);
  });

  it('never trusts caller claims and refuses when neither or both of runId and githubRunId are given', async () => {
    const f = await releasingOnGitHub();
    const run = await f.fullRun();
    await f.approve();
    stubGitHubApi(() => jsonResponse(runPayload(f.R, { conclusion: 'failure' })));

    expect(await f.recordRelease({})).toMatchObject({ isError: true });
    expect(await f.recordRelease({ runId: run.id, githubRunId: GITHUB_RUN_ID })).toMatchObject({ isError: true });
    expect(await f.recordRelease({
      githubRunId: GITHUB_RUN_ID,
      conclusion: 'success',
      status: 'completed',
      workflow: '.github/workflows/images.yml',
      head_sha: f.R,
      attempt: 1,
    })).toMatchObject({ isError: true });
    expect(await f.db.select().from(turnReleases).where(eq(turnReleases.turnId, f.turn.id))).toEqual([]);
  });

  it.each<[string, RunStub | '404' | '401' | '502' | 'non-github']>([
    ['a mismatched run id in the API answer', { id: 123 }],
    ['a wrong commit on the run', { head_sha: EXTRA }],
    ['a wrong commit on a job', { jobs: [...defaultJobs('b'.repeat(40)).slice(0, 1), { name: 'test (1)', head_sha: EXTRA }, { name: 'passed' }] }],
    ['a job from another attempt', { run_attempt: 2, jobs: [{ name: 'test (1)', run_attempt: 1 }, { name: 'passed', run_attempt: 2 }] }],
    ['a failed run', { conclusion: 'failure' }],
    ['a cancelled run', { conclusion: 'cancelled' }],
    ['an incomplete run', { status: 'in_progress', conclusion: null }],
    ['a missing run (404)', '404'],
    ['a rejected repository token (401)', '401'],
    ['an unavailable GitHub API (502)', '502'],
    ['another repository in the API answer', { repository: { full_name: 'other/hornhoof' } }],
    ['a fork head_repository', { head_repository: { full_name: 'attacker/hornhoof' } }],
    ['a missing head_repository (deleted fork)', { head_repository: null }],
    ['a non-GitHub department repository', 'non-github'],
    ['another workflow file', { path: '.github/workflows/installer-site.yml', name: 'Images' }],
    ['a skipped test job in the matrix', {
      jobs: [
        { name: 'test (1)', conclusion: 'success' },
        { name: 'test (2)', conclusion: 'skipped' },
        { name: 'passed', conclusion: 'success' },
      ],
    }],
    ['a skipped test job when proved skipped tests', {
      jobs: [
        { name: 'mark', conclusion: 'success' },
        { name: 'test', conclusion: 'skipped' },
        { name: 'passed', conclusion: 'skipped' },
      ],
    }],
    ['a run with no test jobs', { jobs: [{ name: 'mark', conclusion: 'success' }, { name: 'passed', conclusion: 'success' }] }],
    ['a skipped passed job (such as a pull request)', {
      jobs: [
        { name: 'test (1)', conclusion: 'success' },
        { name: 'passed', conclusion: 'skipped' },
      ],
    }],
    ['a missing passed job', { jobs: [{ name: 'test (1)', conclusion: 'success' }] }],
    ['duplicate passed jobs', { jobs: [{ name: 'test (1)', conclusion: 'success' }, { name: 'passed', conclusion: 'success' }, { name: 'passed', conclusion: 'success' }] }],
    ['a failed test-real job', {
      jobs: [
        { name: 'test (1)', conclusion: 'success' },
        { name: 'test-real', conclusion: 'failure' },
        { name: 'passed', conclusion: 'success' },
      ],
    }],
  ])('refuses %s and records nothing', async (_case, spec) => {
    const f = await releasingOnGitHub();
    if (spec === 'non-github') {
      await f.db.update(departments).set({ repoUrl: 'https://user:secret@gitlab.com/invariant0x/hornhoof.git' }).where(eq(departments.id, f.task.departmentId!));
    }
    await f.approve();
    stubGitHubApi(url => {
      if (spec === '404' || spec === 'non-github') return new Response('Not Found', { status: 404 });
      if (spec === '401') return new Response('{"message":"Bad credentials"}', { status: 401 });
      if (spec === '502') return new Response('Bad Gateway', { status: 502 });
      const stub: RunStub = {
        ...spec,
        ...(spec.jobs ? { jobs: spec.jobs.map(j => ({ ...j, head_sha: j.head_sha ?? spec.head_sha ?? f.R })) } : {}),
      };
      if (url.pathname.endsWith(`/runs/${GITHUB_RUN_ID}`)) return jsonResponse(runPayload(f.R, stub));
      if (url.pathname.includes('/attempts/')) return jsonResponse(jobsPayload(f.R, stub));
      return new Response('Not Found', { status: 404 });
    });

    const result = await f.recordRelease({ githubRunId: GITHUB_RUN_ID });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(REPO_TOKEN);
    expect(result.text).not.toContain('user:secret');
    expect(await f.db.select().from(turnReleases).where(eq(turnReleases.turnId, f.turn.id))).toEqual([]);
  });

  it.each([
    ['on the run lookup (403)', 403, 'run'],
    ['on the attempt jobs lookup (429)', 429, 'jobs'],
  ] as const)('says plainly when the GitHub REST limit is hit %s and records nothing', async (_where, status, step) => {
    const f = await releasingOnGitHub();
    f.ctx.clock = () => RESET_UNIX * 1000 - 120_000;
    await f.approve();
    const calls = stubGitHubApi(url => {
      if (step === 'jobs' && url.pathname.endsWith(`/runs/${GITHUB_RUN_ID}`)) return jsonResponse(runPayload(f.R));
      return rateLimitedResponse(status);
    });

    const first = await f.recordRelease({ githubRunId: GITHUB_RUN_ID });
    expect(first.isError).toBe(true);
    expect(first.text).toBe("GitHub didn't answer. The account's request limit is used up until 14:10 UTC. Try again after that.");
    expect(first.text).not.toContain(REPO_TOKEN);
    expect(await f.db.select().from(turnReleases).where(eq(turnReleases.turnId, f.turn.id))).toEqual([]);
    expect(await f.db.select().from(autonomousReleases)).toEqual([]);

    const countAfterFirst = calls.length;
    const second = await f.recordRelease({ githubRunId: GITHUB_RUN_ID });
    expect(second.isError).toBe(true);
    expect(second.text).toBe(first.text);
    expect(calls).toHaveLength(countAfterFirst);
  });

  it('says plainly when the GitHub REST limit is hit on commit comparison and records nothing', async () => {
    const f = await releasingOnGitHub();
    await f.approve();
    stubGitHubApi(url => {
      if (url.pathname.endsWith(`/runs/${GITHUB_RUN_ID}`)) return jsonResponse(runPayload(f.R));
      if (url.pathname.endsWith('/attempts/2/jobs')) return jsonResponse(jobsPayload(f.R));
      return new Response('Not Found', { status: 404 });
    });
    f.ctx.readCompare = async () => ({ complete: false, reason: 'github-rate-limit', rateLimit: { remaining: 0, resetAt: RESET_UNIX * 1000 } });

    const result = await f.recordRelease({ githubRunId: GITHUB_RUN_ID });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("GitHub didn't answer. The account's request limit is used up until 14:10 UTC. Try again after that.");
    expect(await f.db.select().from(turnReleases).where(eq(turnReleases.turnId, f.turn.id))).toEqual([]);
  });

  it('stands after tagging and closes the turn, including under autonomous release', async () => {
    const f = await releasingOnGitHub();
    await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
    await f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!));
    f.repo.tags['v0.42.0'] = BASE;
    await minuteRound(f.ctx, new Date(), () => () => undefined);

    stubGitHubApi(url => {
      if (url.pathname.endsWith(`/runs/${GITHUB_RUN_ID}`)) return jsonResponse(runPayload(f.R));
      if (url.pathname.endsWith('/attempts/2/jobs')) return jsonResponse(jobsPayload(f.R));
      return new Response('Not Found', { status: 404 });
    });

    const recordedResult = await f.recordRelease({ githubRunId: GITHUB_RUN_ID });
    expect(recordedResult.isError).toBe(false);
    const body = recorded(recordedResult.text);
    expect(body).toMatchObject({
      githubRunId: GITHUB_RUN_ID,
      githubRunAttempt: 2,
      runId: null,
      autonomousReleaseId: expect.any(String),
    });

    const entries = (await f.app.inject({ method: 'GET', url: '/api/autonomous-releases', ...as(f.ceoToken) })).json().entries as Record<string, unknown>[];
    expect(entries).toEqual([expect.objectContaining({
      id: body.autonomousReleaseId,
      commitSha: f.R,
      testRunId: null,
      testRunNumber: GITHUB_RUN_ID,
    })]);

    f.repo.heads.main = f.R;
    f.repo.tags['v0.43.0'] = f.R;
    await minuteRound(f.ctx, new Date(), () => () => undefined);

    const open = await f.openTurn();
    expect(open.number).toBeGreaterThan(f.turn.number);
    expect(open).toMatchObject({ baseVersion: 'v0.43.0', baseCommit: f.R });
  });

  it('defers turn closing without a false stale alarm when GitHub is rate-limited at tag check, then closes after reset', async () => {
    const f = await releasingOnGitHub();
    let now = RESET_UNIX * 1000 - 60_000;
    f.ctx.clock = () => now;
    f.repo.tags['v0.42.0'] = BASE;
    await minuteRound(f.ctx, new Date(now), () => () => undefined);
    await f.approve();

    let limited = false;
    stubGitHubApi(url => {
      if (limited) return rateLimitedResponse(403);
      if (url.pathname.endsWith(`/runs/${GITHUB_RUN_ID}`)) return jsonResponse(runPayload(f.R));
      if (url.pathname.endsWith('/attempts/2/jobs')) return jsonResponse(jobsPayload(f.R));
      return new Response('Not Found', { status: 404 });
    });

    expect((await f.recordRelease({ githubRunId: GITHUB_RUN_ID })).isError).toBe(false);
    f.repo.heads.main = f.R;
    f.repo.tags['v0.43.0'] = f.R;

    limited = true;
    await minuteRound(f.ctx, new Date(now), () => () => undefined);
    expect(await f.openTurn()).toMatchObject({ id: f.turn.id, status: 'open' });
    expect((await f.db.select().from(waitNotices)).filter(n => n.dedupKey.startsWith('release_tag:'))).toEqual([]);

    limited = false;
    now = RESET_UNIX * 1000 + 1_000;
    await minuteRound(f.ctx, new Date(now), () => () => undefined);
    expect((await f.openTurn()).id).not.toBe(f.turn.id);
  });

  it('keeps the turn open and warns of a stale release when the recorded GitHub run fails on a newer attempt before tagging', async () => {
    const f = await releasingOnGitHub();
    f.repo.tags['v0.42.0'] = BASE;
    await minuteRound(f.ctx, new Date(), () => () => undefined);
    await f.approve();

    let currentAttempt: RunStub = { run_attempt: 2, conclusion: 'success' };
    stubGitHubApi(url => {
      if (url.pathname.endsWith(`/runs/${GITHUB_RUN_ID}`)) return jsonResponse(runPayload(f.R, currentAttempt));
      if (url.pathname.endsWith('/attempts/2/jobs')) return jsonResponse(jobsPayload(f.R, { run_attempt: 2 }));
      return new Response('Not Found', { status: 404 });
    });

    expect((await f.recordRelease({ githubRunId: GITHUB_RUN_ID })).isError).toBe(false);
    currentAttempt = { run_attempt: 3, conclusion: 'failure' };
    f.repo.heads.main = f.R;
    f.repo.tags['v0.43.0'] = f.R;

    await minuteRound(f.ctx, new Date(), () => () => undefined);
    expect(await f.openTurn()).toMatchObject({ id: f.turn.id, status: 'open' });
    const notices = (await f.db.select().from(waitNotices)).filter(n => n.dedupKey.startsWith('release_tag:'));
    expect(notices).toHaveLength(2);
    expect(notices.find(n => n.personId)!.guard.tag).toEqual({ version: 'v0.43.0', commit: f.R, why: 'stale' });
  });

  it('keeps run_tests runId release proof working as before', async () => {
    const f = await releasingOnGitHub();
    f.repo.tags['v0.42.0'] = BASE;
    await minuteRound(f.ctx, new Date(), () => () => undefined);
    const run = await f.fullRun();
    await f.approve();

    const result = await f.recordRelease({ runId: run.id });
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ commit: f.R, runId: run.id, githubRunId: null, githubRunAttempt: null });

    f.repo.heads.main = f.R;
    f.repo.tags['v0.43.0'] = f.R;
    await minuteRound(f.ctx, new Date(), () => () => undefined);
    expect((await f.openTurn()).id).not.toBe(f.turn.id);
  });
});
