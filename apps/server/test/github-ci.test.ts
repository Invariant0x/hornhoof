import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubCiReader } from '../src/modules/testruns/github-ci.js';
import { GitHubLimits } from '../src/modules/testruns/github-limit.js';

const COMMIT = 'c'.repeat(40);
const REPO = { url: 'https://github.com/acme/shop.git', token: 'ghp_synthetic_token_for_tests_only' };
const RESET_UNIX = 1_795_529_400; // 2026-11-24T14:10:00.000Z

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
type Called = { path: string; init: RequestInit };

/* GitHub as these tests say it is: each request's path after /repos/acme/shop/ goes to one function. */
function github(answer: (path: string) => Answer | undefined) {
  const called: Called[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/repos/acme/shop/', '') + new URL(url).search;
    called.push({ path, init });
    const said = answer(path) ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(said.body ?? {}), { status: said.status ?? 200, headers: said.headers });
  });
  return called;
}

const run = (name: string, extra: Record<string, unknown> = {}) => ({ name, head_sha: COMMIT, status: 'completed', conclusion: 'success', html_url: `https://github.com/acme/shop/actions/runs/1/job/${name.length}`, ...extra });
const runs = (check_runs: unknown[], total = check_runs.length) => ({ total_count: total, check_runs });
const status = (statuses: unknown[], state = 'success', total = statuses.length) => ({ sha: COMMIT, state, total_count: total, statuses });
/* A repository where checks and statuses are what is given, and which keeps no workflow file. */
const checks = (check_runs: unknown[], statuses: unknown[] = []) => (path: string): Answer | undefined => {
  if (path.startsWith(`commits/${COMMIT}/check-runs`)) return { body: runs(check_runs) };
  if (path.startsWith(`commits/${COMMIT}/status`)) return { body: status(statuses) };
  return undefined;
};

afterEach(() => vi.unstubAllGlobals());

describe("the repository's CI on one exact commit", () => {
  it('is green when every check passed, skipped and neutral ones as no fault, and reads the exact commit with the repository token', async () => {
    const called = github(checks([run('test (1)'), run('test (2)'), run('publish', { conclusion: 'skipped' }), run('lint', { conclusion: 'neutral' })], [{ context: 'hornhoof/tests', state: 'success' }]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 5 });
    expect(called.map(c => c.path)).toEqual([`commits/${COMMIT}/check-runs?filter=latest&per_page=100&page=1`, `commits/${COMMIT}/status?per_page=100&page=1`]);
    expect(called[0]!.init).toMatchObject({ redirect: 'manual', headers: expect.objectContaining({ authorization: `Bearer ${REPO.token}` }) as unknown });
  });

  it('is red on the first check that failed, with its name and link, though others are still under way', async () => {
    github(checks([run('test (1)', { status: 'in_progress', conclusion: null }), run('test (2)', { conclusion: 'failure', html_url: 'https://github.com/acme/shop/actions/runs/9/job/2' })]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'red', check: 'test (2)', url: 'https://github.com/acme/shop/actions/runs/9/job/2', outcome: 'failure' });
  });

  it.each(['cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])('is red on a check that ended %s', async conclusion => {
    github(checks([run('test (1)'), run('images', { conclusion })]));
    expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'red', check: 'images', outcome: conclusion });
  });

  it('is red on a status that failed or errored, named by its context and target', async () => {
    github(checks([run('test (1)')], [{ context: 'ci/legacy', state: 'error', target_url: 'https://ci.example.test/builds/4' }]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'red', check: 'ci/legacy', url: 'https://ci.example.test/builds/4', outcome: 'error' });
  });

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])('is pending on a check that is %s', async state => {
    github(checks([run('test (1)'), run('test (2)', { status: state, conclusion: null })]));
    expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'pending', check: 'test (2)', outcome: state });
  });

  it('is pending on a status that is pending', async () => {
    github(checks([run('test (1)')], [{ context: 'ci/legacy', state: 'pending' }]));
    expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'pending', check: 'ci/legacy' });
  });

  it('has run nothing that succeeded where every check was skipped or neutral', async () => {
    github(checks([run('publish', { conclusion: 'skipped' }), run('lint', { conclusion: 'neutral' })]));
    expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'idle', checks: 2 });
  });

  it('puts first a failure over a pending check in a status too, and does not count a pending status as a pass', async () => {
    github(checks([], [{ context: 'a', state: 'pending' }, { context: 'b', state: 'failure' }]));
    expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'red', check: 'b' });
  });

  describe('a commit nothing has reported on', () => {
    const nothing = (workflows: Answer | undefined) => (path: string) => path.startsWith('contents/.github/workflows') ? workflows : checks([])(path);

    it('has no CI when the repository keeps no workflow file at that commit', async () => {
      const called = github(nothing(undefined));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'none' });
      expect(called.at(-1)!.path).toBe(`contents/.github/workflows?ref=${COMMIT}`);
    });

    it('has no CI where its workflow folder holds no workflow', async () => {
      github(nothing({ body: [{ type: 'file', name: 'README.md' }, { type: 'dir', name: 'actions.yml' }] }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'none' });
    });

    it('is pending where it keeps workflows that have not reported on that commit yet: a release does not outrun its CI', async () => {
      github(nothing({ body: [{ type: 'file', name: 'images.yml' }] }));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'pending', check: 'the workflows of the repository', url: null, outcome: 'no check of them has reported on this commit' });
    });

    it('is unread when the workflow folder cannot be read', async () => {
      github(nothing({ status: 500 }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });
  });

  it('has no CI, and asks nobody, for a repository that is not on github.com', async () => {
    const called = github(() => ({ status: 500 }));
    expect(await githubCiReader()({ url: 'https://git.example.test/acme/shop.git', token: 'x' }, COMMIT)).toMatchObject({ state: 'none' });
    expect(called).toEqual([]);
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
      ['an answer that is no list of checks', () => ({ body: { total_count: 'many' } })],
      ['a check run of another commit', () => ({ body: runs([run('test (1)', { head_sha: 'd'.repeat(40) })]) })],
    ])('is unread for %s', async (_what, answer) => {
      github(path => (path.startsWith(`commits/${COMMIT}/check-runs`) ? answer() : { body: status([]) }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('is unread for a combined status of another commit', async () => {
      github(path => (path.startsWith(`commits/${COMMIT}/check-runs`) ? { body: runs([run('test (1)')]) } : { body: { ...status([]), sha: 'd'.repeat(40) } }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('is unread when GitHub does not answer in time', async () => {
      vi.stubGlobal('fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'unread', why: "GitHub didn't answer while its checks were read" });
    });
  });

  describe('a long list of checks', () => {
    const page = (from: number, count: number, total: number) => runs(Array.from({ length: count }, (_v, i) => run(`test (${from + i})`)), total);

    it('is read page by page until every check is in', async () => {
      const called = github(path => {
        if (path.includes('check-runs') && path.endsWith('page=1')) return { body: page(1, 100, 150) };
        if (path.includes('check-runs') && path.endsWith('page=2')) return { body: page(101, 50, 150) };
        return { body: status([]) };
      });
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'green', checks: 150 });
      expect(called.filter(c => c.path.includes('check-runs')).map(c => c.path.slice(-6))).toEqual(['page=1', 'page=2']);
    });

    it('is unread when a page comes back empty or the total changes under it', async () => {
      github(path => (path.endsWith('page=1') && path.includes('check-runs') ? { body: page(1, 100, 150) } : path.includes('check-runs') ? { body: page(101, 0, 150) } : { body: status([]) }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
      github(path => (path.endsWith('page=1') && path.includes('check-runs') ? { body: page(1, 100, 150) } : path.includes('check-runs') ? { body: page(101, 50, 151) } : { body: status([]) }));
      expect(await githubCiReader()(REPO, COMMIT)).toMatchObject({ state: 'unread' });
    });

    it('is unread for a commit with more checks than the pages it reads', async () => {
      github(path => (path.includes('check-runs') ? { body: page(1, 100, 5000) } : { body: status([]) }));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'unread', why: 'it has more check runs than are read' });
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
    it('keeps a check name to one short line and a link to a plain https address', async () => {
      github(checks([run('x'.repeat(400), { conclusion: 'failure', html_url: 'javascript:alert(1)' }), run('y', { conclusion: 'failure', html_url: 'http://github.com/a' })]));
      const red = await githubCiReader()(REPO, COMMIT);
      expect(red).toMatchObject({ state: 'red', url: null });
      expect(red.state === 'red' && red.check).toHaveLength(160);
      github(checks([run('line one\nline two', { conclusion: 'failure', html_url: `https://user:pw@github.com/a` })]));
      expect(await githubCiReader()(REPO, COMMIT)).toEqual({ state: 'red', check: 'line one line two', url: null, outcome: 'failure' });
    });
  });
});
