import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubCiDispatcher } from '../src/modules/testruns/github-dispatch.js';
import { GitHubLimits } from '../src/modules/testruns/github-limit.js';

const COMMIT = 'c'.repeat(40);
const DEFAULT = 'a'.repeat(40);
const REPO = { url: 'https://github.com/acme/shop.git', token: 'ghp_synthetic_token_for_tests_only' };
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

const file = (text: string) => ({ body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n') } });
const BY_HAND = 'name: Release\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n';
const ON_PUSH = 'name: CI\non:\n  push:\njobs:\n  test:\n    runs-on: ubuntu-latest\n';
type W = { id: number; name: string; path: string; state: string; text: string; last?: string | null };
const wf = (id: number, name: string, text: string, last: string | null = 'success', state = 'active'): W => ({ id, name, path: `.github/workflows/${name.toLowerCase().replace(/ /g, '-')}.yml`, state, text, last });

/* A repository whose workflows are the given ones; the commit's run of the one started by hand lists as `listed`. */
const MADE = 'e'.repeat(40);
const RELEASED_AT = '2026-11-20T10:00:00Z';
const alive = (workflow_id: number) => ({ id: 900 + workflow_id, workflow_id, head_sha: MADE, run_started_at: '2026-11-20T09:50:00Z', updated_at: '2026-11-20T10:01:00Z', repository: { full_name: 'acme/shop' }, head_repository: { full_name: 'acme/shop' }, name: 'run', status: 'completed', conclusion: 'success', run_attempt: 1 });
type Made = { by: number[] };
const repository = (workflows: W[], extra: { post?: Answer; listed?: unknown[]; made?: Made } = {}) => (path: string, init: RequestInit): Answer | undefined => {
  if (path === '') return { body: { default_branch: 'main' } };
  if (path === 'releases?per_page=30') return { body: extra.made ? [{ tag_name: 'v0.43.0', draft: false, prerelease: false, published_at: RELEASED_AT }] : [] };
  if (path === 'git/ref/tags/v0.43.0') return { body: { object: { type: 'commit', sha: MADE } } };
  if (path === `actions/runs?head_sha=${MADE}&status=success&per_page=100&page=1`) {
    const runs = (extra.made?.by ?? []).map(alive);
    return { body: { total_count: runs.length, workflow_runs: runs } };
  }
  if (path === 'commits?per_page=1') return { body: [{ sha: DEFAULT }] };
  if (path === 'actions/workflows?per_page=100') return { body: { total_count: workflows.length, workflows: workflows.map(({ id, name, path: p, state }) => ({ id, name, path: p, state })) } };
  for (const w of workflows) {
    if (path === `contents/${w.path}?ref=${DEFAULT}`) return file(w.text);
    if (path === `actions/workflows/${w.id}/runs?branch=main&status=completed&exclude_pull_requests=true&per_page=1`) {
      return { body: { total_count: w.last ? 1 : 0, workflow_runs: w.last ? [{ conclusion: w.last, status: 'completed' }] : [] } };
    }
    if (path === `actions/workflows/${w.id}/dispatches` && init.method === 'POST') return extra.post ?? { status: 204 };
    if (path === `actions/workflows/${w.id}/runs?event=workflow_dispatch&head_sha=${COMMIT}&per_page=5`) {
      const runs = extra.listed ?? [];
      return { body: { total_count: runs.length, workflow_runs: runs } };
    }
  }
  return undefined;
};
const run = (extra: Record<string, unknown> = {}) => ({ id: 777, workflow_id: 2, head_sha: COMMIT, html_url: 'https://github.com/acme/shop/actions/runs/777', repository: { full_name: 'acme/shop' }, ...extra });
const dispatcher = (pause = vi.fn(async () => {})) => ({ pause, start: () => githubCiDispatcher(undefined, pause)(REPO, 'turn-44', COMMIT) });

afterEach(() => vi.unstubAllGlobals());

describe("starting the repository's release workflow on a commit of a turn branch", () => {
  it('starts the one workflow that can be started by hand and was green on the default branch, on the turn branch, and names the run of the exact commit', async () => {
    const called = github(repository([wf(1, 'CI', ON_PUSH), wf(2, 'Release', BY_HAND)], { listed: [run()] }));
    expect(await dispatcher().start()).toEqual({ state: 'started', workflow: 'Release (.github/workflows/release.yml)', run: 777, url: 'https://github.com/acme/shop/actions/runs/777' });
    const post = called.filter(c => c.init.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]!.path).toBe('actions/workflows/2/dispatches');
    expect(JSON.parse(post[0]!.init.body as string)).toEqual({ ref: 'turn-44' });
    expect(post[0]!.init).toMatchObject({ redirect: 'manual', headers: expect.objectContaining({ authorization: `Bearer ${REPO.token}` }) as unknown });
    expect(called.indexOf(post[0]!)).toBe(called.length - 2);
  });

  it('ignores a run of another commit, and says no run yet where GitHub lists none, looking a few times', async () => {
    github(repository([wf(2, 'Release', BY_HAND)], { listed: [run({ head_sha: 'd'.repeat(40) }), run({ workflow_id: 9 }), run({ repository: { full_name: 'mallory/shop' } })] }));
    const d = dispatcher();
    expect(await d.start()).toEqual({ state: 'started', workflow: 'Release (.github/workflows/release.yml)', run: null, url: null });
    expect(d.pause).toHaveBeenCalledTimes(3);
  });

  describe('a repository with no workflow to start', () => {
    it.each([
      ['one that starts by push only', [wf(1, 'CI', ON_PUSH)]],
      ['one that was never run on the default branch', [wf(2, 'Release', BY_HAND, null)]],
      ['one whose latest run on the default branch failed', [wf(2, 'Release', BY_HAND, 'failure')]],
      ['one whose latest run was cancelled', [wf(2, 'Release', BY_HAND, 'cancelled')]],
      ['one that is disabled', [wf(2, 'Release', BY_HAND, 'success', 'disabled_manually')]],
      ['one that names workflow_dispatch only in a comment', [wf(2, 'Release', '# run it with workflow_dispatch\n' + ON_PUSH)]],
      ['none at all', []],
    ])('refuses, and starts nothing, with %s', async (_what, workflows) => {
      const called = github(repository(workflows));
      expect(await dispatcher().start()).toMatchObject({ state: 'refused', why: expect.stringContaining('No workflow of the repository can be started by hand') as unknown });
      expect(called.filter(c => c.init.method === 'POST')).toEqual([]);
    });

    it('refuses, naming them, where more than one workflow qualifies, and does not guess', async () => {
      const called = github(repository([wf(2, 'Release', BY_HAND), wf(3, 'Images', BY_HAND)]));
      const said = await dispatcher().start();
      expect(said).toMatchObject({ state: 'refused' });
      expect(said.state === 'refused' && said.why).toContain('Release (.github/workflows/release.yml); Images (.github/workflows/images.yml)');
      expect(called.filter(c => c.init.method === 'POST')).toEqual([]);
    });

    it('starts the workflow that made the latest version release, though a second one can be started by hand and was green too (Images and Installer site)', async () => {
      const called = github(repository([wf(3, 'Images', BY_HAND), wf(2, 'Installer site', BY_HAND)], { made: { by: [3] }, listed: [run({ workflow_id: 3 })] }));
      expect(await dispatcher().start()).toMatchObject({ state: 'started', workflow: 'Images (.github/workflows/images.yml)', run: 777 });
      expect(called.filter(c => c.init.method === 'POST').map(c => c.path)).toEqual(['actions/workflows/3/dispatches']);
    });

    it('refuses where the workflow that made the latest release cannot be started by hand, and names it', async () => {
      const called = github(repository([wf(3, 'Images', ON_PUSH), wf(2, 'Installer site', BY_HAND)], { made: { by: [3] } }));
      const said = await dispatcher().start();
      expect(said).toMatchObject({ state: 'refused' });
      expect(said.state === 'refused' && said.why).toContain('Images (.github/workflows/images.yml) made the latest version release, but it cannot be started by hand');
      expect(called.filter(c => c.init.method === 'POST')).toEqual([]);
    });

    it('refuses, naming them, where more than one workflow was going on when the latest release was made', async () => {
      const called = github(repository([wf(3, 'Images', BY_HAND), wf(2, 'Installer site', BY_HAND)], { made: { by: [3, 2] } }));
      const said = await dispatcher().start();
      expect(said.state === 'refused' && said.why).toContain('was going on when the latest version release was made: Images (.github/workflows/images.yml); Installer site (.github/workflows/installer-site.yml)');
      expect(called.filter(c => c.init.method === 'POST')).toEqual([]);
    });

    it('does not count a second workflow that can be started by hand but was red last', async () => {
      github(repository([wf(2, 'Release', BY_HAND), wf(3, 'Images', BY_HAND, 'failure')], { listed: [run()] }));
      expect(await dispatcher().start()).toMatchObject({ state: 'started', workflow: 'Release (.github/workflows/release.yml)' });
    });
  });

  describe('where GitHub will not start it', () => {
    it.each([
      [403, 'Resource not accessible by integration'],
      [404, 'Not Found'],
      [401, 'Bad credentials'],
    ])('refuses on %s, and says the token needs actions: write', async (status, message) => {
      github(repository([wf(2, 'Release', BY_HAND)], { post: { status, body: { message } } }));
      const said = await dispatcher().start();
      expect(said).toMatchObject({ state: 'refused' });
      expect(said.state === 'refused' && said.why).toContain(`(${status}: ${message})`);
      expect(said.state === 'refused' && said.why).toContain('actions: write');
    });

    it('refuses with its own words where the workflow has no workflow_dispatch trigger on the branch', async () => {
      github(repository([wf(2, 'Release', BY_HAND)], { post: { status: 422, body: { message: "Workflow does not have 'workflow_dispatch' trigger" } } }));
      expect(await dispatcher().start()).toEqual({ state: 'refused', why: "GitHub refused to start the workflow (422: Workflow does not have 'workflow_dispatch' trigger)." });
    });

    it('is unsure where the request went out and GitHub failed or did not answer: it is not known whether CI started', async () => {
      github(repository([wf(2, 'Release', BY_HAND)], { post: { status: 502 } }));
      expect(await dispatcher().start()).toMatchObject({ state: 'unsure', workflow: 'Release (.github/workflows/release.yml)' });
      const ok = repository([wf(2, 'Release', BY_HAND)]);
      github((path, init) => { if (init.method === 'POST') throw new DOMException('timed out', 'TimeoutError'); return ok(path, init); });
      expect(await dispatcher().start()).toMatchObject({ state: 'unsure' });
    });

    it('is limited where the request limit is used up, never unsure, and keeps it for the account', async () => {
      const limited = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_UNIX) } };
      github(repository([wf(2, 'Release', BY_HAND)], { post: limited }));
      const limits = new GitHubLimits(() => Date.UTC(2026, 10, 24, 14, 0), () => {});
      expect(await githubCiDispatcher(limits, async () => {})(REPO, 'turn-44', COMMIT)).toEqual({ state: 'limited', limit: { remaining: 0, resetAt: RESET_UNIX * 1000 } });
    });
  });

  describe('what it will not read or start', () => {
    it.each([
      'https://git.example.test/acme/shop.git', 'https://github.com.evil.test/acme/shop', 'http://github.com/acme/shop', 'https://user:pw@github.com/acme/shop',
    ])('is unsupported, and asks nobody: %s', async url => {
      const called = github(() => ({ status: 500 }));
      expect(await githubCiDispatcher(undefined, async () => {})({ url, token: 'x' }, 'turn-44', COMMIT)).toMatchObject({ state: 'unsupported' });
      expect(called).toEqual([]);
    });

    it('is unread for a commit that is not a full commit id, or a list of workflows it cannot read whole', async () => {
      const called = github(() => ({ status: 500 }));
      expect(await githubCiDispatcher(undefined, async () => {})(REPO, 'turn-44', 'main')).toMatchObject({ state: 'unread' });
      expect(called).toEqual([]);
      const many = Array.from({ length: 31 }, (_v, i) => wf(i + 1, `W${i}`, ON_PUSH));
      github(repository(many));
      expect(await dispatcher().start()).toMatchObject({ state: 'unread' });
      github(path => path === 'actions/workflows?per_page=100' ? { body: { total_count: 5, workflows: [] } } : repository([])(path, {}));
      expect(await dispatcher().start()).toMatchObject({ state: 'unread' });
    });

    it('is unread, and starts nothing, where the default branch or a workflow file cannot be read', async () => {
      const called = github(path => (path === 'commits?per_page=1' ? { status: 500 } : repository([wf(2, 'Release', BY_HAND)])(path, {})));
      expect(await dispatcher().start()).toMatchObject({ state: 'unread' });
      github(path => (path.startsWith('contents/') ? { status: 500 } : repository([wf(2, 'Release', BY_HAND)])(path, {})));
      expect(await dispatcher().start()).toMatchObject({ state: 'unread' });
      expect(called.filter(c => c.init.method === 'POST')).toEqual([]);
    });
  });
});
