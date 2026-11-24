import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubCiReader } from '../src/modules/testruns/github-ci.js';
import { GitHubLimits } from '../src/modules/testruns/github-limit.js';

const COMMIT = 'c'.repeat(40);
const DEFAULT = 'a'.repeat(40);
const REPO = { url: 'https://github.com/acme/shop.git', token: 'ghp_synthetic_token_for_tests_only' };
const RESET_UNIX = 1_795_529_400; // 2026-11-24T14:10:00.000Z
const RUNS_AT_COMMIT = `actions/runs?head_sha=${COMMIT}&per_page=100&page=1`;

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
type Called = { path: string; init: RequestInit };

/* GitHub as these tests say it is: each request's path after /repos/acme/shop goes to one function. */
function github(answer: (path: string) => Answer | undefined) {
  const called: Called[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/repos\/acme\/shop\/?/, '') + new URL(url).search;
    called.push({ path, init });
    const said = answer(path) ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(said.body ?? {}), { status: said.status ?? 200, headers: said.headers });
  });
  return called;
}

const run = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, workflow_id: 1, head_sha: COMMIT, status: 'completed', conclusion: 'success', run_attempt: 1,
  html_url: `https://github.com/acme/shop/actions/runs/${id}`, repository: { full_name: 'acme/shop' }, head_repository: { full_name: 'acme/shop' }, ...extra,
});
const job = (id: number, runId: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, run_id: runId, run_attempt: 1, name, head_sha: COMMIT, status: 'completed', conclusion: 'success',
  html_url: `https://github.com/acme/shop/actions/runs/${runId}/job/${id}`, ...extra,
});
const runsPage = (workflow_runs: unknown[], total = workflow_runs.length) => ({ total_count: total, workflow_runs });
const jobsPage = (jobs: unknown[], total = jobs.length) => ({ total_count: total, jobs });
type Listed = { run: ReturnType<typeof run>; jobs?: unknown[] };

const BY_HAND = 'name: Release\non:\n  push:\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n';
const ON_PUSH = 'name: CI\non:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n';
const TAG_COMMIT = 'e'.repeat(40);
const TAG_OBJECT = 'f'.repeat(40);
const RELEASED_AT = '2026-11-20T10:00:00Z';
type Wf = { id: number; name: string; text: string; last: string | null; state: string; path: string };
const wf = (id: number, name: string, extra: Partial<Wf> = {}): Wf => ({ id, name, text: BY_HAND, last: 'success', state: 'active', path: `.github/workflows/${name.toLowerCase().replace(/ /g, '-')}.yml`, ...extra });
/* A version release the repository published: its tag, what the tag names, and the runs of the commit that succeeded. */
type Released = { tag: string; commit?: string; at?: string; draft?: boolean; prerelease?: boolean; annotated?: boolean; gone?: boolean; runs?: unknown[] };
/* A run of workflow that was going on while the release was published, by default. */
const during = (workflow_id: number, extra: Record<string, unknown> = {}) =>
  run(900 + workflow_id, 'release run', { workflow_id, head_sha: TAG_COMMIT, run_started_at: '2026-11-20T09:50:00Z', updated_at: '2026-11-20T10:01:00Z', ...extra });
type Setup = { workflows?: Wf[]; releases?: Released[] };

/* What GitHub says of which workflow releases: the workflows, the version releases and what made the latest, and the default
   branch with the runs of each workflow on it. By default one workflow, CI, that was never released. */
const discovery = (setup: Setup = {}) => (path: string): Answer | undefined => {
  const workflows = setup.workflows ?? [wf(1, 'CI')];
  const releases = setup.releases ?? [];
  if (path === 'actions/workflows?per_page=100') return { body: { total_count: workflows.length, workflows: workflows.map(({ id, name, state, path: p }) => ({ id, name, state, path: p })) } };
  if (path === 'releases?per_page=30') return { body: releases.map(r => ({ tag_name: r.tag, draft: r.draft ?? false, prerelease: r.prerelease ?? false, published_at: r.at ?? RELEASED_AT })) };
  for (const r of releases) {
    const commit = r.commit ?? TAG_COMMIT;
    if (path === `git/ref/tags/${r.tag}`) return r.gone ? undefined : { body: { object: r.annotated ? { type: 'tag', sha: TAG_OBJECT } : { type: 'commit', sha: commit } } };
    if (r.annotated && path === `git/tags/${TAG_OBJECT}`) return { body: { object: { type: 'commit', sha: commit } } };
    if (path === `actions/runs?head_sha=${commit}&status=success&per_page=100&page=1`) return { body: runsPage(r.runs ?? []) };
  }
  if (path === '') return { body: { default_branch: 'main' } };
  if (path === 'commits?per_page=1') return { body: [{ sha: DEFAULT }] };
  for (const w of workflows) {
    if (path === `contents/${w.path}?ref=${DEFAULT}`) return { body: { type: 'file', encoding: 'base64', content: Buffer.from(w.text).toString('base64') } };
    if (path === `actions/workflows/${w.id}/runs?branch=main&status=completed&exclude_pull_requests=true&per_page=1`) {
      return { body: { total_count: w.last ? 1 : 0, workflow_runs: w.last ? [{ conclusion: w.last, status: 'completed' }] : [] } };
    }
  }
  return undefined;
};

/* A repository whose commit has the workflow runs given, each with the jobs listed for it, and the release workflow its setup says. */
const actions = (listed: Listed[], setup: Setup = {}) => (path: string): Answer | undefined => {
  if (path === RUNS_AT_COMMIT) return { body: runsPage(listed.map(l => l.run)) };
  const jobs = /^actions\/runs\/(\d+)\/jobs\?filter=latest&per_page=100&page=1$/.exec(path);
  return jobs ? { body: jobsPage(listed.find(l => l.run.id === Number(jobs[1]))?.jobs ?? []) } : discovery(setup)(path);
};
const ci = (name: string, jobs: unknown[], extra: Record<string, unknown> = {}, id = 1) => ({ run: run(id, name, extra), jobs });

afterEach(() => vi.unstubAllGlobals());

describe("the repository's CI on one exact commit", () => {
  it('is green when every run finished with every job done, skipped and neutral jobs as no fault, and asks only for the Actions runs of the exact commit with the repository token', async () => {
    const called = github(actions([ci('CI', [job(11, 1, 'test (1)'), job(12, 1, 'test (2)'), job(13, 1, 'publish', { conclusion: 'skipped' }), job(14, 1, 'lint', { conclusion: 'neutral' })])]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 2 });
    expect(called.map(c => c.path)).toEqual([
      RUNS_AT_COMMIT, 'actions/workflows?per_page=100', 'releases?per_page=30', '', 'commits?per_page=1', `contents/.github/workflows/ci.yml?ref=${DEFAULT}`,
      'actions/workflows/1/runs?branch=main&status=completed&exclude_pull_requests=true&per_page=1', 'actions/runs/1/jobs?filter=latest&per_page=100&page=1',
    ]);
    expect(called[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: expect.objectContaining({ authorization: `Bearer ${REPO.token}` }) as unknown });
  });

  it('counts the jobs of every run: two workflows that both finished are green together', async () => {
    github(actions([ci('CI', [job(11, 1, 'test')], {}, 1), ci('Images', [job(21, 2, 'build'), job(22, 2, 'scan')], {}, 2)]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 3 });
  });

  describe('what only a workflow run proves (B1)', () => {
    it('is not green on a success status or a success check run of another app, which anyone with write access can post: no Actions run is on the commit', async () => {
      const called = github(path => path === RUNS_AT_COMMIT ? { body: runsPage([]) } : path === `contents/.github/workflows?ref=${COMMIT}` ? { body: [{ type: 'file', name: 'ci.yml' }] } : path.startsWith(`commits/${COMMIT}/status`)
        ? { body: { sha: COMMIT, state: 'success', total_count: 1, statuses: [{ context: 'ci/forged', state: 'success' }] } }
        : path.startsWith(`commits/${COMMIT}/check-runs`) ? { body: { total_count: 1, check_runs: [{ name: 'forged', head_sha: COMMIT, status: 'completed', conclusion: 'success', app: { slug: 'evil' } }] } } : undefined);
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'absent' });
      expect(called.map(c => c.path).filter(p => p.startsWith(`commits/${COMMIT}`))).toEqual([]);
    });

    it('does not read a run of a fork, or one whose own repository is another, as the commit\'s', async () => {
      github(path => path === RUNS_AT_COMMIT
        ? { body: runsPage([run(7, 'CI', { head_repository: { full_name: 'mallory/shop' } }), run(8, 'CI', { repository: { full_name: 'mallory/shop' } })]) }
        : path === `contents/.github/workflows?ref=${COMMIT}` ? { body: [{ type: 'file', name: 'ci.yml' }] } : undefined);
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'absent' });
    });

    it('compares the repository without case, as GitHub names it', async () => {
      github(actions([ci('CI', [job(11, 1, 'test')], { repository: { full_name: 'ACME/Shop' }, head_repository: { full_name: 'Acme/shop' } })]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 1 });
    });
  });

  describe('CI that is reported in part (B2)', () => {
    it('is pending while one of two workflows is still under way, though the other finished green', async () => {
      github(actions([ci('CI', [job(11, 1, 'test')], {}, 1), ci('Images', [], { status: 'in_progress', conclusion: null }, 2)]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'pending', check: 'Images', url: 'https://github.com/acme/shop/actions/runs/2', outcome: 'in_progress' });
    });

    it('is pending while a job of a finished run has not finished', async () => {
      github(actions([ci('CI', [job(11, 1, 'test (1)'), job(12, 1, 'test (2)', { status: 'in_progress', conclusion: null })])]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'pending', check: 'CI / test (2)', url: 'https://github.com/acme/shop/actions/runs/1/job/12', outcome: 'in_progress' });
    });

    it('is pending, never green, for a run that finished with no job listed: a job is missing', async () => {
      github(actions([ci('CI', [])]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'pending', check: 'CI', url: 'https://github.com/acme/shop/actions/runs/1', outcome: 'no job of it has reported' });
    });

    it('is unread when the jobs listed are fewer than its total says: a job is missing from the list', async () => {
      github(path => path === RUNS_AT_COMMIT ? { body: runsPage([run(1, 'CI')]) } : path.includes('/jobs') ? { body: jobsPage(path.endsWith('page=1') ? [job(11, 1, 'test')] : [], 3) } : discovery()(path));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('has run nothing that succeeded where every job was skipped or neutral, or every run was skipped', async () => {
      github(actions([ci('CI', [job(11, 1, 'publish', { conclusion: 'skipped' }), job(12, 1, 'lint', { conclusion: 'neutral' })])]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'idle', checks: 2 });
      github(actions([ci('CI', [], { conclusion: 'skipped' })]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'idle', checks: 1 });
    });

    it('does not let a skipped workflow count for a success next to nothing that succeeded', async () => {
      github(actions([ci('CI', [], { conclusion: 'skipped' }, 1), ci('Images', [], { conclusion: 'neutral' }, 2)]));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'idle' });
    });
  });

  it('is red on the first run that failed, with its name and link, though another is still under way', async () => {
    github(actions([ci('CI', [], { status: 'in_progress', conclusion: null }, 1), ci('Images', [], { conclusion: 'failure', html_url: 'https://github.com/acme/shop/actions/runs/9' }, 2)]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'red', check: 'Images', url: 'https://github.com/acme/shop/actions/runs/9', outcome: 'failure' });
  });

  it.each(['cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])('is red on a run that ended %s', async conclusion => {
    github(actions([ci('CI', [job(11, 1, 'test')], {}, 1), ci('images', [], { conclusion }, 2)]));
    expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'red', check: 'images', outcome: conclusion });
  });

  it('is red on a job that failed in a run that says success, named with its workflow', async () => {
    github(actions([ci('CI', [job(11, 1, 'test (1)'), job(12, 1, 'test (2)', { conclusion: 'failure' })])]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'red', check: 'CI / test (2)', url: 'https://github.com/acme/shop/actions/runs/1/job/12', outcome: 'failure' });
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('is pending on a run that is %s, and reads no job of it', async state => {
    const called = github(actions([ci('CI', [job(11, 1, 'test')], { status: state, conclusion: null })]));
    expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'pending', check: 'CI', outcome: state });
    expect(called.map(c => c.path)).not.toContain('actions/runs/1/jobs?filter=latest&per_page=100&page=1');
  });

  it('puts first a failure over a pending run', async () => {
    github(actions([ci('a', [], { status: 'queued', conclusion: null }, 1), ci('b', [], { conclusion: 'failure' }, 2)]));
    expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'red', check: 'b' });
  });

  describe('tests that were skipped prove nothing (B1)', () => {
    it("is red, never green, for Images' run where the first job saw a status that says the tests passed and so skipped them: mark and images succeeded, test did not run", async () => {
      github(actions([ci('Images', [job(11, 1, 'mark'), job(12, 1, 'test', { conclusion: 'skipped' }), job(13, 1, 'images (hornhoof)')])]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'red', check: 'Images / test', url: 'https://github.com/acme/shop/actions/runs/1/job/12', outcome: 'skipped' });
    });

    it.each(['test', 'Test', 'tests', 'test (1)', 'test (3/4)', 'tests (linux, 22)'])('is red for a skipped test job named %s', async name => {
      github(actions([ci('CI', [job(11, 1, 'mark'), job(12, 1, name, { conclusion: 'skipped' })])]));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'red', outcome: 'skipped' });
    });

    it('is red for a skipped test job whatever else passed, and names it first before one that is still pending', async () => {
      github(actions([ci('CI', [job(11, 1, 'lint', { status: 'in_progress', conclusion: null }), job(12, 1, 'test (2)', { conclusion: 'skipped' }), job(13, 1, 'build')])]));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'red', check: 'CI / test (2)', outcome: 'skipped' });
    });

    it.each(['test-real', 'passed', 'contest', 'latest', 'publish', 'e2e tests', 'test_real'])('does not take a skipped job named %s for a skipped test job', async name => {
      github(actions([ci('CI', [job(11, 1, 'test'), job(12, 1, name, { conclusion: 'skipped' })])]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 1 });
    });
  });

  describe('only the release workflow counts (B5)', () => {
    it('is absent, not green, where the one run on the commit is another workflow\'s: anyone with write access can start Media on a branch', async () => {
      github(actions([ci('Media', [job(51, 5, 'build')], { workflow_id: 9 }, 5)]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'absent' });
    });

    it('goes on the release workflow alone: another workflow\'s failed or unfinished run on the commit is no proof and no blocker', async () => {
      github(actions([
        ci('CI', [job(11, 1, 'test')], {}, 1),
        ci('Media', [], { workflow_id: 9, conclusion: 'failure' }, 5),
        ci('Docs', [], { workflow_id: 8, status: 'in_progress', conclusion: null }, 6),
      ]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 1 });
    });

    it('reads no job of another workflow\'s run', async () => {
      const called = github(actions([ci('CI', [job(11, 1, 'test')], {}, 1), ci('Media', [job(51, 5, 'build')], { workflow_id: 9 }, 5)]));
      await githubCiReader()(REPO, COMMIT);
      expect(called.map(c => c.path).filter(p => p.includes('/jobs'))).toEqual(['actions/runs/1/jobs?filter=latest&per_page=100&page=1']);
    });
  });

  describe("which workflow is the repository's release workflow (B6)", () => {
    const images = wf(1, 'Images');
    const site = wf(2, 'Installer site');
    const made = (workflowId: number, extra: Partial<Released> = {}): Released => ({ tag: 'v0.43.0', runs: [during(workflowId)], ...extra });
    const imagesRun = ci('Images', [job(11, 1, 'mark'), job(12, 1, 'test (1)'), job(13, 1, 'images')], {}, 1);

    it('is the workflow that made the latest version release, though another can be started by hand and was green on the default branch too', async () => {
      github(actions([imagesRun], { workflows: [images, site], releases: [made(1)] }));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 3 });
    });

    it('does not take the other workflow of that repository for the release: its run alone is absent, and its failure blocks nothing', async () => {
      github(actions([ci('Installer site', [job(21, 2, 'deploy')], { workflow_id: 2 }, 2)], { workflows: [images, site], releases: [made(1)] }));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'absent' });
      github(actions([imagesRun, ci('Installer site', [], { workflow_id: 2, conclusion: 'failure' }, 2)], { workflows: [images, site], releases: [made(1)] }));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 3 });
    });

    it('reads the tag of an annotated release to its commit', async () => {
      github(actions([imagesRun], { workflows: [images, site], releases: [made(1, { annotated: true })] }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'green' });
    });

    it('takes the newest published version release, setting aside drafts, pre-releases and tags that are no version', async () => {
      const newer = [
        { tag: 'v0.44.0', commit: 'd'.repeat(40), at: '2026-11-23T10:00:00Z', draft: true, runs: [during(2, { head_sha: 'd'.repeat(40) })] },
        { tag: 'v0.44.0-rc.1', commit: 'b'.repeat(40), at: '2026-11-22T10:00:00Z', prerelease: true, runs: [during(2, { head_sha: 'b'.repeat(40) })] },
        { tag: 'nightly', commit: '9'.repeat(40), at: '2026-11-21T10:00:00Z', runs: [during(2, { head_sha: '9'.repeat(40) })] },
      ];
      github(actions([imagesRun], { workflows: [images, site], releases: [...newer, made(1)] }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'green' });
    });

    it('names no workflow, and so is unnamed, where more than one was going on when the release was made', async () => {
      github(actions([imagesRun], { workflows: [images, site], releases: [made(1, { runs: [during(1), during(2)] })] }));
      const said = await githubCiReader()(REPO, COMMIT);
      expect(said).toMatchObject({ state: 'unnamed' });
      expect(said.state === 'unnamed' && said.why).toContain('Images (.github/workflows/images.yml); Installer site (.github/workflows/installer-site.yml)');
    });

    it.each([
      ['no version release at all', {}],
      ['a release made by hand: no run was going on when it was published', { releases: [made(1, { runs: [during(1, { run_started_at: '2026-11-19T09:00:00Z', updated_at: '2026-11-19T09:30:00Z' })] })] }],
      ['a release whose tag is gone', { releases: [made(1, { gone: true })] }],
      ['a release made by a workflow that is not active any more', { workflows: [wf(1, 'CI'), wf(3, 'Old', { state: 'disabled_manually' })], releases: [made(3)] }],
    ])('falls back to the one workflow that can be started by hand and was green on the default branch, with %s', async (_what, setup) => {
      github(actions([ci('CI', [job(11, 1, 'test')])], setup));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 1 });
    });

    it.each([
      ['two that can be started by hand and were green', [wf(1, 'Images'), wf(2, 'Installer site')]],
      ['none that can be started by hand', [wf(1, 'CI', { text: ON_PUSH })]],
      ['none that was green on the default branch', [wf(1, 'CI', { last: 'failure' })]],
    ])('is unnamed where no release made it and there are %s, and says why', async (_what, workflows) => {
      github(actions([ci('CI', [job(11, 1, 'test')])], { workflows }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unnamed', why: expect.stringContaining('release workflow') as unknown });
    });

    it('is unread, never green, where the list of workflows or of releases cannot be read whole', async () => {
      github(path => path === 'releases?per_page=30' ? { status: 502 } : actions([imagesRun], { workflows: [images], releases: [] })(path));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
      github(path => path === 'actions/workflows?per_page=100' ? { body: { total_count: 3, workflows: [] } } : actions([imagesRun])(path));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
      github(path => path === 'releases?per_page=30' ? { body: { not: 'a list' } } : actions([imagesRun])(path));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });
  });

  describe('a commit no workflow run is on', () => {
    const WORKFLOWS = [{ type: 'file', name: 'images.yml' }];
    /* A repository whose default branch head is DEFAULT, with what is given at that head; the commit has no run, and keeps the
       workflow files given for it (none where undefined). */
    const repository = (own: Answer | undefined, head: { workflows?: Answer; checks?: number; statuses?: number; list?: Answer; info?: Answer } = {}) => (path: string): Answer | undefined => {
      if (path === RUNS_AT_COMMIT) return { body: runsPage([]) };
      if (path === '') return head.info ?? { body: { default_branch: 'main' } };
      if (path === 'commits?per_page=1') return head.list ?? { body: [{ sha: DEFAULT }] };
      if (path === `contents/.github/workflows?ref=${COMMIT}`) return own;
      if (path === `contents/.github/workflows?ref=${DEFAULT}`) return head.workflows;
      if (path === `commits/${DEFAULT}/check-runs?filter=latest&per_page=1`) return { body: { total_count: head.checks ?? 0, check_runs: [] } };
      if (path === `commits/${DEFAULT}/status?per_page=1`) return { body: { sha: DEFAULT, total_count: head.statuses ?? 0, statuses: [] } };
      return undefined;
    };

    it('is absent where the commit keeps workflow files that have not run on it yet, and asks nothing of the default branch', async () => {
      const called = github(repository({ body: WORKFLOWS }));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'absent' });
      expect(called.map(c => c.path)).toEqual([RUNS_AT_COMMIT, `contents/.github/workflows?ref=${COMMIT}`]);
    });

    it('has no CI when neither the commit nor the default branch keeps a workflow file, and no check or status ever reported on the default branch', async () => {
      const called = github(repository(undefined));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'none' });
      expect(called.map(c => c.path)).toEqual([
        RUNS_AT_COMMIT, `contents/.github/workflows?ref=${COMMIT}`, '', 'commits?per_page=1',
        `contents/.github/workflows?ref=${DEFAULT}`, `commits/${DEFAULT}/check-runs?filter=latest&per_page=1`, `commits/${DEFAULT}/status?per_page=1`,
      ]);
    });

    it('has no CI where the workflow folders hold no workflow', async () => {
      const files = { body: [{ type: 'file', name: 'README.md' }, { type: 'dir', name: 'actions.yml' }] };
      github(repository(files, { workflows: files }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'none' });
    });

    it('is stripped, never none, for a commit that deleted every workflow file where the default branch keeps them', async () => {
      github(repository(undefined, { workflows: { body: WORKFLOWS } }));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'stripped', branch: 'main' });
    });

    it.each([
      ['a check run', { checks: 1 }],
      ['a status', { statuses: 1 }],
    ])('is stripped, never none, where the default branch keeps no workflow file but %s was reported on its head', async (_what, head) => {
      github(repository(undefined, head));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'stripped' });
    });

    it.each([
      ['a server error on the default branch', { list: { status: 500 } }],
      ['a repository with no commits', { list: { status: 409, body: { message: 'Git Repository is empty.' } } }],
      ['an empty list of commits', { list: { body: [] } }],
      ['a default branch head that is no commit id', { list: { body: [{ sha: 'main' }] } }],
      ['a repository that names no default branch', { info: { body: {} } }],
      ['workflow files of the default branch that cannot be read', { workflows: { status: 500 } }],
    ])('is unread, never none, for %s', async (_what, head) => {
      github(repository(undefined, head));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('is unread when the workflow folder of the commit cannot be read', async () => {
      github(repository({ status: 500 }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('is unread when the checks reported on the default branch head cannot be read', async () => {
      github(path => (path.startsWith(`commits/${DEFAULT}/status`) ? { status: 502 } : repository(undefined)(path)));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
      github(path => (path.startsWith(`commits/${DEFAULT}/check-runs`) ? { body: { total_count: 'many' } } : repository(undefined)(path)));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
      github(path => (path.startsWith(`commits/${DEFAULT}/status`) ? { body: { sha: COMMIT, total_count: 0, statuses: [] } } : repository(undefined)(path)));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });
  });

  describe('an address the reader cannot place as github.com (B3)', () => {
    it.each([
      'https://git.example.test/acme/shop.git',
      'https://github.com.evil.test/acme/shop',
      'https://gitlab.com/acme/shop',
      'http://github.com/acme/shop',
      'https://user:pw@github.com/acme/shop',
      'https://github.com/acme',
      'git@github.com:acme/shop.git',
      'not an address',
      '',
    ])('is unsupported, never no CI, and asks nobody: %s', async url => {
      const called = github(() => ({ status: 500 }));
      expect(await githubCiReader()({ url, token: 'x' }, COMMIT)).toMatchObject({ state: 'unsupported' });
      expect(called).toEqual([]);
    });
  });

  it('reads no commit that is not a full commit id', async () => {
    const called = github(() => ({ status: 500 }));
    expect(await githubCiReader()(REPO, 'main')).toMatchObject({ state: 'unread' });
    expect(called).toEqual([]);
  });

  describe('what GitHub answers that cannot be trusted', () => {
    it.each([
      ['a server error', () => ({ status: 502 })],
      ['a repository it cannot see', () => ({ status: 404 })],
      ['an answer that is no list of runs', () => ({ body: { total_count: 'many' } })],
      ['a run of another commit', () => ({ body: runsPage([run(1, 'CI', { head_sha: 'd'.repeat(40) })]) })],
      ['a list shorter than its total', () => ({ body: runsPage([run(1, 'CI')], 2) })],
      ['more runs than one page', () => ({ body: runsPage([run(1, 'CI')], 101) })],
    ])('is unread for %s', async (_what, answer) => {
      github(path => (path === RUNS_AT_COMMIT ? answer() : undefined));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it.each([
      ['a job of another run', { run_id: 99 }],
      ['a job of another commit', { head_sha: 'd'.repeat(40) }],
      ['a job of another attempt', { run_attempt: 2 }],
    ])('is unread for %s', async (_what, extra) => {
      github(actions([ci('CI', [job(11, 1, 'test', extra)])]));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('is unread when GitHub does not answer in time', async () => {
      vi.stubGlobal('fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'unread', why: "GitHub didn't answer while its checks were read" });
    });
  });

  describe('a long list of jobs', () => {
    const page = (from: number, count: number, total: number) => jobsPage(Array.from({ length: count }, (_v, i) => job(from + i, 1, `test (${from + i})`)), total);
    const runs = (path: string): Answer | undefined => (path === RUNS_AT_COMMIT ? { body: runsPage([run(1, 'CI')]) } : discovery()(path));

    it('is read page by page until every job is in', async () => {
      const called = github(path => {
        if (path.includes('/jobs') && path.endsWith('page=1')) return { body: page(1, 100, 150) };
        if (path.includes('/jobs') && path.endsWith('page=2')) return { body: page(101, 50, 150) };
        return runs(path);
      });
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 150 });
      expect(called.filter(c => c.path.includes('/jobs')).map(c => c.path.slice(-6))).toEqual(['page=1', 'page=2']);
    });

    it('is unread when a page comes back empty or the total changes under it', async () => {
      github(path => (path.includes('/jobs') ? { body: path.endsWith('page=1') ? page(1, 100, 150) : page(101, 0, 150) } : runs(path)));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
      github(path => (path.includes('/jobs') ? { body: path.endsWith('page=1') ? page(1, 100, 150) : page(101, 50, 151) } : runs(path)));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('is unread for a run with more jobs than the pages it reads', async () => {
      github(path => (path.includes('/jobs') ? { body: page(1, 100, 5000) } : runs(path)));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'unread', why: 'it has more jobs than are read' });
    });
  });

  describe("GitHub's request limit", () => {
    const limited = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_UNIX) } };

    it('says so, and when it ends, rather than guessing what CI says', async () => {
      github(() => limited);
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'limited', limit: { remaining: 0, resetAt: RESET_UNIX * 1000 } });
    });

    it('is not mistaken for a refusal of 403 with requests left', async () => {
      github(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '12' } }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it("is kept for the account, so the server's other readers stop asking once one met it, and no request goes out", async () => {
      const warned: unknown[] = [];
      const limits = new GitHubLimits(() => Date.UTC(2026, 10, 24, 14, 0), limit => warned.push(limit));
      const called = github(() => limited);
      const read = githubCiReader(limits);
      expect(await read(REPO, COMMIT)).toMatchObject({ state: 'limited' });
      const before = called.length;
      expect(await read(REPO, COMMIT)).toMatchObject({ state: 'limited', limit: { resetAt: RESET_UNIX * 1000 } });
      expect(called).toHaveLength(before);
      expect(warned).toHaveLength(1);
    });
  });

  describe('what GitHub names that an agent will read', () => {
    it('keeps a name to one short line and a link to a plain https address', async () => {
      github(actions([ci('x'.repeat(400), [], { conclusion: 'failure', html_url: 'javascript:alert(1)' }, 1), ci('y', [], { conclusion: 'failure', html_url: 'http://github.com/a' }, 2)]));
      const red = await githubCiReader()(REPO, COMMIT);
      expect(red).toMatchObject({ state: 'red', url: null });
      expect(red.state === 'red' && red.check).toHaveLength(160);
      github(actions([ci('line one\nline two', [], { conclusion: 'failure', html_url: `https://user:pw@github.com/a` })]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'red', check: 'line one line two', url: null, outcome: 'failure' });
    });

    it('names a run with no name by its path', async () => {
      github(actions([ci('', [], { name: null, path: '.github/workflows/ci.yml', conclusion: 'failure' })]));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'red', check: '.github/workflows/ci.yml' });
    });
  });
});
