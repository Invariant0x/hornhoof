import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubCiDispatcher } from '../src/modules/testruns/github-dispatch.js';
import { GitHubLimits } from '../src/modules/testruns/github-limit.js';

const COMMIT = 'c'.repeat(40);
const RELEASE = '.github/workflows/release.yml';
const REPO = { url: 'https://github.com/acme/shop.git', token: 'ghp_synthetic_token_for_tests_only', releaseWorkflow: RELEASE };
const RESET_UNIX = 1_795_529_400;

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };
type Called = { path: string; init: RequestInit };

function github(answer: (path: string, init: RequestInit) => Answer | undefined) {
  const called: Called[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const at = new URL(url);
    expect(at.origin).toBe('https://api.github.com');
    const path = at.pathname.replace(/^\/repos\/acme\/shop\/?/, '') + at.search;
    called.push({ path, init });
    const said = answer(path, init) ?? { status: 404, body: { message: 'Not Found' } };
    const status = said.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(said.body ?? {}), { status, headers: said.headers });
  });
  return called;
}

type W = { id: number; name: string; path: string; state: string };
const wf = (id: number, name: string, state = 'active'): W => ({ id, name, path: `.github/workflows/${name.toLowerCase().replace(/ /g, '-')}.yml`, state });

/* A repository whose workflows are the given ones, each asked for by its file name; the commit's run started by hand lists as
   `listed`. Nothing else of the repository is answered: the release workflow is the one its settings name, so no file, release
   or tag is read to tell it. */
const repository = (workflows: W[], extra: { post?: Answer; listed?: unknown[] } = {}) => (path: string, init: RequestInit): Answer | undefined => {
  const file = /^actions\/workflows\/([^/?]+)$/.exec(path)?.[1];
  if (file) {
    const found = workflows.find(w => w.path.endsWith(`/${decodeURIComponent(file)}`));
    return found ? { body: found } : undefined;
  }
  for (const w of workflows) {
    if (path === `actions/workflows/${w.id}/dispatches` && init.method === 'POST') return extra.post ?? { status: 204 };
    if (path === `actions/workflows/${w.id}/runs?event=workflow_dispatch&head_sha=${COMMIT}&per_page=5`) {
      const runs = extra.listed ?? [];
      return { body: { total_count: runs.length, workflow_runs: runs } };
    }
  }
  return undefined;
};
const run = (extra: Record<string, unknown> = {}) => ({ id: 777, workflow_id: 2, head_sha: COMMIT, html_url: 'https://github.com/acme/shop/actions/runs/777', repository: { full_name: 'acme/shop' }, ...extra });
const dispatcher = (pause = vi.fn(async () => {}), repo: { url: string; token: string; releaseWorkflow?: string | null } = REPO) => ({ pause, start: () => githubCiDispatcher(undefined, pause)(repo, 'turn-44', COMMIT) });

afterEach(() => vi.unstubAllGlobals());

describe("starting the repository's release workflow on a commit of a turn branch", () => {
  it('starts the workflow the repository settings name, on the turn branch, with the input full so that it runs every test, and names the run of the exact commit', async () => {
    const called = github(repository([wf(1, 'CI'), wf(2, 'Release')], { listed: [run()] }));
    expect(await dispatcher().start()).toEqual({ state: 'started', workflow: 'Release (.github/workflows/release.yml)', run: 777, url: 'https://github.com/acme/shop/actions/runs/777' });
    const post = called.filter(c => c.init.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]!.path).toBe('actions/workflows/2/dispatches');
    expect(JSON.parse(post[0]!.init.body as string)).toEqual({ ref: 'turn-44', inputs: { full: 'true' } });
    expect(post[0]!.init).toMatchObject({ redirect: 'manual', headers: expect.objectContaining({ authorization: `Bearer ${REPO.token}` }) as unknown });
    expect(called.indexOf(post[0]!)).toBe(called.length - 2);
  });

  it('ignores a run of another commit, and says no run yet where GitHub lists none, looking a few times', async () => {
    github(repository([wf(2, 'Release')], { listed: [run({ head_sha: 'd'.repeat(40) }), run({ workflow_id: 9 }), run({ repository: { full_name: 'mallory/shop' } })] }));
    const d = dispatcher();
    expect(await d.start()).toEqual({ state: 'started', workflow: 'Release (.github/workflows/release.yml)', run: null, url: null });
    expect(d.pause).toHaveBeenCalledTimes(3);
  });

  describe('the workflow is the one the settings name, never one the server picks (B6, B7)', () => {
    it('starts only the named one where several others could be started by hand and were green (Images and Installer site)', async () => {
      const called = github(repository([wf(3, 'Images'), wf(2, 'Installer site')], { listed: [run({ workflow_id: 3 })] }));
      expect(await dispatcher(undefined, { ...REPO, releaseWorkflow: '.github/workflows/images.yml' }).start()).toMatchObject({ state: 'started', workflow: 'Images (.github/workflows/images.yml)', run: 777 });
      expect(called.filter(c => c.init.method === 'POST').map(c => c.path)).toEqual(['actions/workflows/3/dispatches']);
    });

    it.each([undefined, null, ''])('refuses, and starts and reads nothing, where the settings name none (%j): it says to name it there', async releaseWorkflow => {
      const called = github(repository([wf(2, 'Release')]));
      expect(await dispatcher(undefined, { ...REPO, releaseWorkflow }).start()).toEqual({ state: 'refused', why: 'name the release workflow in the repository settings.' });
      expect(called).toEqual([]);
    });

    it.each([
      ['one that is disabled', '.github/workflows/old.yml', [wf(2, 'Release'), wf(4, 'Old', 'disabled_manually')]],
      ['one the repository does not have', '.github/workflows/gone.yml', [wf(2, 'Release')]],
      ['a file name without its folder', 'release.yml', [wf(2, 'Release')]],
      ['no workflow at all', RELEASE, []],
    ])('refuses, and starts nothing, where the settings name %s', async (_what, path, workflows) => {
      const called = github(repository(workflows));
      const said = await dispatcher(undefined, { ...REPO, releaseWorkflow: path }).start();
      expect(said).toMatchObject({ state: 'refused', why: expect.stringContaining('is not an active workflow of the repository') as unknown });
      expect(called.filter(c => c.init.method === 'POST')).toEqual([]);
    });

    it("reads no release, tag, file or run of another workflow to tell it: nothing a token with write access publishes or starts chooses it", async () => {
      const called = github((path, init) => /^(releases|git\/|contents\/)/.test(path)
        ? { body: [{ tag_name: 'v0.43.1', draft: false, prerelease: false, published_at: '2026-11-24T13:00:00Z' }] }
        : repository([wf(2, 'Release'), wf(9, 'Media')], { listed: [run()] })(path, init));
      await dispatcher().start();
      expect(called.map(c => c.path)).toEqual(['actions/workflows/release.yml', 'actions/workflows/2/dispatches', `actions/workflows/2/runs?event=workflow_dispatch&head_sha=${COMMIT}&per_page=5`]);
    });
  });

  describe('where GitHub will not start it', () => {
    it.each([
      [403, 'Resource not accessible by integration'],
      [404, 'Not Found'],
      [401, 'Bad credentials'],
    ])('refuses on %s, and says the token needs actions: write', async (status, message) => {
      github(repository([wf(2, 'Release')], { post: { status, body: { message } } }));
      const said = await dispatcher().start();
      expect(said).toMatchObject({ state: 'refused' });
      expect(said.state === 'refused' && said.why).toContain(`(${status}: ${message})`);
      expect(said.state === 'refused' && said.why).toContain('actions: write');
    });

    it.each([
      "Workflow does not have 'workflow_dispatch' trigger",
      "Unexpected inputs provided: [\"full\"]",
    ])('refuses with its own words where the workflow does not take the dispatch it is asked: %s', async message => {
      github(repository([wf(2, 'Release')], { post: { status: 422, body: { message } } }));
      expect(await dispatcher().start()).toEqual({ state: 'refused', why: `GitHub refused to start the workflow (422: ${message}).` });
    });

    it('is unsure where the request went out and GitHub failed or did not answer: it is not known whether CI started', async () => {
      github(repository([wf(2, 'Release')], { post: { status: 502 } }));
      expect(await dispatcher().start()).toMatchObject({ state: 'unsure', workflow: 'Release (.github/workflows/release.yml)' });
      const ok = repository([wf(2, 'Release')]);
      github((path, init) => { if (init.method === 'POST') throw new DOMException('timed out', 'TimeoutError'); return ok(path, init); });
      expect(await dispatcher().start()).toMatchObject({ state: 'unsure' });
    });

    it('is limited where the request limit is used up, never unsure, and keeps it for the account', async () => {
      const limited = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_UNIX) } };
      github(repository([wf(2, 'Release')], { post: limited }));
      const limits = new GitHubLimits(() => Date.UTC(2026, 10, 24, 14, 0), () => {});
      expect(await githubCiDispatcher(limits, async () => {})(REPO, 'turn-44', COMMIT)).toEqual({ state: 'limited', limit: { remaining: 0, resetAt: RESET_UNIX * 1000 } });
    });
  });

  describe('what it will not read or start', () => {
    it.each([
      'https://git.example.test/acme/shop.git', 'https://github.com.evil.test/acme/shop', 'http://github.com/acme/shop', 'https://user:pw@github.com/acme/shop',
    ])('is unsupported, and asks nobody: %s', async url => {
      const called = github(() => ({ status: 500 }));
      expect(await githubCiDispatcher(undefined, async () => {})({ url, token: 'x', releaseWorkflow: RELEASE }, 'turn-44', COMMIT)).toMatchObject({ state: 'unsupported' });
      expect(called).toEqual([]);
    });

    it('is unread for a commit that is not a full commit id', async () => {
      const called = github(() => ({ status: 500 }));
      expect(await githubCiDispatcher(undefined, async () => {})(REPO, 'turn-44', 'main')).toMatchObject({ state: 'unread' });
      expect(called).toEqual([]);
    });

    it('is unread, and starts nothing, where the workflow named cannot be read', async () => {
      const called = github(path => (path === 'actions/workflows/release.yml' ? { status: 500 } : repository([wf(2, 'Release')])(path, {})));
      expect(await dispatcher().start()).toMatchObject({ state: 'unread' });
      github(path => (path === 'actions/workflows/release.yml' ? { body: { nothing: 'of a workflow' } } : repository([wf(2, 'Release')])(path, {})));
      expect(await dispatcher().start()).toMatchObject({ state: 'unread' });
      expect(called.filter(c => c.init.method === 'POST')).toEqual([]);
    });
  });
});
