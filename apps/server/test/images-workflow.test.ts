import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';
import { listenIn } from '../../../test-support/ports.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(ROOT, 'scripts/tests-mark.mjs');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/images.yml'), 'utf8');
/* Runner variables apply to trusted events in private repositories. */
const TRUSTED = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
const PRIVATE = 'github.event.repository.private';
const runsOn = (variable: string) => `\${{ ${PRIVATE} && ${TRUSTED} && vars.${variable} && fromJSON(vars.${variable}) || 'ubuntu-latest' }}`;
const TESTS_RUNS_ON = runsOn('TESTS_RUNS_ON');
const BUILD_RUNS_ON = runsOn('BUILD_RUNS_ON');
const BUILDER = { driver: "${{ github.event.repository.private && vars.BUILDKIT_ENDPOINT && 'remote' || 'docker-container' }}", endpoint: "${{ github.event.repository.private && vars.BUILDKIT_ENDPOINT || '' }}" };
const run = promisify(execFile);
const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();

type Marks = Record<string, { context: string; state: string }[]>;

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-images-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* One commit on the branch, changing one file. */
function commit(dir: string, branch: string, file: string): string {
  git(dir, 'checkout', '--quiet', branch);
  writeFileSync(join(dir, file), `${branch} ${Math.random()}\n`);
  git(dir, 'add', file);
  git(dir, 'commit', '--quiet', '-m', `${branch} ${file}`);
  return git(dir, 'rev-parse', 'HEAD');
}

function repository(): string {
  const dir = folder();
  git(dir, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(dir, 'first.txt'), 'first\n');
  git(dir, 'add', 'first.txt');
  git(dir, 'commit', '--quiet', '-m', 'first');
  git(dir, 'branch', 'turn-8');
  return dir;
}

/* GitHub's API as the script reads it: each commit's latest status per context. */
async function github(marks: Marks, answer?: (res: ServerResponse) => void) {
  const asked: { url: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    asked.push({ url: req.url ?? '', authorization: req.headers.authorization });
    if (answer) return answer(res);
    const sha = /\/commits\/([0-9a-f]{40})\/status/.exec(req.url ?? '')?.[1] ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'whatever', statuses: marks[sha] ?? [] }));
  });
  await listenIn(server);
  onTestFinished(() => new Promise<void>(done => {
    server.closeAllConnections();
    server.close(() => done());
  }));
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

const PUSH = { repository: { full_name: 'acme/shop', private: true } };
const FROM_FORK = { ...PUSH, pull_request: { head: { repo: { full_name: 'stranger/shop' } } } };
const FROM_BRANCH = { ...PUSH, pull_request: { head: { repo: { full_name: 'acme/shop' } } } };
const FROM_GONE_FORK = { ...PUSH, pull_request: { head: { repo: null } } };

/* The script as the workflow's first job runs it, in a checkout of the commit. A null event: GitHub gave it none to read. */
async function decide(dir: string, sha: string, api: string, event: unknown = PUSH) {
  const place = folder();
  const eventPath = join(place, 'event.json');
  const output = join(place, 'output');
  writeFileSync(output, '');
  if (event !== null) writeFileSync(eventPath, JSON.stringify(event));
  const { stdout } = await run('node', [SCRIPT], { cwd: dir, env: { ...process.env, GITHUB_SHA: sha, GITHUB_REPOSITORY: 'acme/shop', GITHUB_API_URL: api, GITHUB_TOKEN: 'ghs_workflow', GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output } });
  return { out: readFileSync(output, 'utf8'), said: stdout };
}

const MARKED = [{ context: 'hornhoof/tests', state: 'success' }];
const PROVED = 'proved=true\n';
const NOT_PROVED = 'proved=false\n';

describe('whether a mark spares this commit the tests', () => {
  it('takes a success on the commit itself, and asks GitHub with the workflow token', async () => {
    const dir = repository();
    const sha = commit(dir, 'main', 'a.txt');
    const hub = await github({ [sha]: MARKED });
    expect((await decide(dir, sha, hub.api)).out).toBe(PROVED);
    expect(hub.asked).toEqual([{ url: `/repos/acme/shop/commits/${sha}/status?per_page=100`, authorization: 'Bearer ghs_workflow' }]);
  });

  it('runs the tests when the commit has no mark', async () => {
    const dir = repository();
    const sha = commit(dir, 'main', 'a.txt');
    const hub = await github({});
    expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
  });

  it.each(['failure', 'pending', 'error'])('runs the tests when the mark says %s', async state => {
    const dir = repository();
    const sha = commit(dir, 'main', 'a.txt');
    const hub = await github({ [sha]: [{ context: 'hornhoof/tests', state }] });
    expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
  });

  it("takes no other context's success for the mark", async () => {
    const dir = repository();
    const sha = commit(dir, 'main', 'a.txt');
    const hub = await github({ [sha]: [{ context: 'ci/hornhoof/tests', state: 'success' }, { context: 'hornhoof/test', state: 'success' }] });
    expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
  });

  describe('a merge', () => {
    /* The turn's branch merged into main with main behind it: the merge holds exactly what the turn's branch holds. */
    function cleanMerge() {
      const dir = repository();
      const second = commit(dir, 'turn-8', 'turn.txt');
      git(dir, 'checkout', '--quiet', 'main');
      git(dir, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'turn-8');
      return { dir, sha: git(dir, 'rev-parse', 'HEAD'), second };
    }

    /* Main moved on before the merge, so it brings in what the turn's branch never checked. */
    function mergeWithMore() {
      const dir = repository();
      const second = commit(dir, 'turn-8', 'turn.txt');
      commit(dir, 'main', 'hotfix.txt');
      git(dir, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'turn-8');
      return { dir, sha: git(dir, 'rev-parse', 'HEAD'), second };
    }

    it('takes the mark of its second parent when its tree is that parent’s', async () => {
      const { dir, sha, second } = cleanMerge();
      const hub = await github({ [second]: MARKED });
      expect((await decide(dir, sha, hub.api)).out).toBe(PROVED);
    });

    it('finds that parent in a checkout two commits deep, as the workflow makes it', async () => {
      const { dir, sha, second } = cleanMerge();
      const clone = folder();
      git(clone, 'clone', '--quiet', '--depth=2', `file://${dir}`, '.');
      const hub = await github({ [second]: MARKED });
      expect((await decide(clone, sha, hub.api)).out).toBe(PROVED);
    });

    it('runs the tests when that parent has no mark', async () => {
      const { dir, sha } = cleanMerge();
      const hub = await github({});
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
    });

    it('runs the tests when that parent’s mark is a failure', async () => {
      const { dir, sha, second } = cleanMerge();
      const hub = await github({ [second]: [{ context: 'hornhoof/tests', state: 'failure' }] });
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
    });

    it('takes its own failure over its parent’s success', async () => {
      const { dir, sha, second } = cleanMerge();
      const hub = await github({ [sha]: [{ context: 'hornhoof/tests', state: 'failure' }], [second]: MARKED });
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
    });

    it('never takes its parent’s mark when its tree differs from that parent’s', async () => {
      const { dir, sha, second } = mergeWithMore();
      const hub = await github({ [second]: MARKED });
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
      expect(hub.asked.map(a => a.url)).toEqual([`/repos/acme/shop/commits/${sha}/status?per_page=100`]);
    });

    it('never takes a mark through a merge of a conflict resolved by hand', async () => {
      const dir = repository();
      const second = commit(dir, 'turn-8', 'same.txt');
      commit(dir, 'main', 'same.txt');
      expect(() => git(dir, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'turn-8')).toThrow();
      writeFileSync(join(dir, 'same.txt'), 'by hand\n');
      git(dir, 'add', 'same.txt');
      git(dir, 'commit', '--quiet', '-m', 'merge');
      const hub = await github({ [second]: MARKED });
      expect((await decide(dir, git(dir, 'rev-parse', 'HEAD'), hub.api)).out).toBe(NOT_PROVED);
    });

    it('takes its own mark whatever its tree', async () => {
      const { dir, sha } = mergeWithMore();
      const hub = await github({ [sha]: MARKED });
      expect((await decide(dir, sha, hub.api)).out).toBe(PROVED);
    });

    it('does not look past two parents', async () => {
      const dir = repository();
      const second = commit(dir, 'turn-8', 'turn.txt');
      const third = commit(dir, 'main', 'other.txt');
      const octopus = git(dir, 'commit-tree', `${second}^{tree}`, '-p', third, '-p', second, '-p', 'main~1', '-m', 'octopus');
      const hub = await github({ [second]: MARKED });
      expect((await decide(dir, octopus, hub.api)).out).toBe(NOT_PROVED);
    });
  });

  describe('a pull request', () => {
    it.each([['a fork', FROM_FORK], ['a fork that is gone', FROM_GONE_FORK]])('from %s runs the tests always, and GitHub is not even asked', async (_what, event) => {
      const dir = repository();
      const sha = commit(dir, 'main', 'a.txt');
      const hub = await github({ [sha]: MARKED });
      expect((await decide(dir, sha, hub.api, event)).out).toBe(NOT_PROVED);
      expect(hub.asked).toEqual([]);
    });

    it('from a branch of the repository takes the mark like any commit', async () => {
      const dir = repository();
      const sha = commit(dir, 'main', 'a.txt');
      const hub = await github({ [sha]: MARKED });
      expect((await decide(dir, sha, hub.api, FROM_BRANCH)).out).toBe(PROVED);
    });
  });

  describe('when it cannot tell', () => {
    it.each([403, 404, 500])('runs the tests when GitHub answers %i, and says why', async status => {
      const dir = repository();
      const sha = commit(dir, 'main', 'a.txt');
      const hub = await github({}, res => {
        res.writeHead(status);
        res.end('{}');
      });
      const { out, said } = await decide(dir, sha, hub.api);
      expect(out).toBe(NOT_PROVED);
      expect(said).toContain(String(status));
    });

    it('runs the tests when GitHub answers nonsense', async () => {
      const dir = repository();
      const sha = commit(dir, 'main', 'a.txt');
      const hub = await github({}, res => {
        res.writeHead(200);
        res.end('not json');
      });
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
    });

    it('runs the tests when GitHub cannot be reached', async () => {
      const dir = repository();
      const sha = commit(dir, 'main', 'a.txt');
      expect((await decide(dir, sha, 'http://127.0.0.1:1')).out).toBe(NOT_PROVED);
    });

    it('runs the tests when the event cannot be read', async () => {
      const dir = repository();
      const sha = commit(dir, 'main', 'a.txt');
      const hub = await github({ [sha]: MARKED });
      expect((await decide(dir, sha, hub.api, null)).out).toBe(NOT_PROVED);
    });

    it('runs the tests when git cannot read the commit', async () => {
      const dir = repository();
      const hub = await github({});
      expect((await decide(dir, 'd'.repeat(40), hub.api)).out).toBe(NOT_PROVED);
    });
  });
});

type Job = { needs?: string | string[]; if?: string; 'runs-on': string; permissions?: Record<string, string>; outputs?: Record<string, string>; strategy?: { matrix: { part?: number[] | string } }; env?: Record<string, string>; steps: { uses?: string; if?: string; with?: Record<string, unknown>; id?: string; run?: string; env?: Record<string, string> }[] };
const JOBS = (parse(WORKFLOW) as { jobs: Record<string, Job> }).jobs;
const needsOf = (job: Job) => [job.needs ?? []].flat();

type Results = Record<string, 'success' | 'failure' | 'skipped'>;
type Scenario = { event?: string; payload?: unknown; ref?: string; proved?: boolean; markJob?: 'success' | 'failure'; tests?: 'success' | 'failure'; images?: 'success' | 'failure'; cancelled?: boolean };

/* Which jobs run, from the workflow's own conditions, as GitHub reads them: a condition with no status function of its own
   runs only when every job before it, however far back, succeeded. Every job that runs ends as the scenario says. */
function runWorkflow({ event = 'push', payload = FROM_BRANCH, ref = 'refs/heads/main', proved = false, markJob = 'success', tests = 'success', images = 'success', cancelled = false }: Scenario): Results {
  const results: Results = {};
  const ancestors = (name: string): string[] => needsOf(JOBS[name]!).flatMap(n => [n, ...ancestors(n)]);
  const context = () => ({
    github: { event_name: event, event: payload, repository: 'acme/shop', ref },
    cancelled: () => cancelled,
    needs: Object.fromEntries(Object.keys(results).map(n => [n, { result: results[n], outputs: { proved: n === 'mark' && results[n] === 'success' ? String(proved) : '' } }])),
  });
  for (const name of ['mark', 'test', 'passed', 'images', 'publish', 'release']) {
    const expression = (JOBS[name]!.if ?? 'true').replace(/^\$\{\{|\}\}$/g, '').trim().replace(/\.(?=[A-Za-z_])/g, '?.');
    const ownStatus = /\b(always|cancelled|failure|success)\(\)/.test(expression);
    const allowed = ownStatus || (ancestors(name).every(n => results[n] === 'success') && !cancelled);
    const runs = allowed && Boolean(runInNewContext(expression, context()));
    results[name] = !runs ? 'skipped' : name === 'mark' ? markJob : name === 'test' ? tests : name === 'images' ? images : 'success';
  }
  return results;
}

describe('.github/workflows/images.yml', () => {
  it('runs the jobs in that order: the mark first, the tests on it, the passed mark, the images and the publish job on both, the release after the publish job', () => {
    expect(needsOf(JOBS.mark!)).toEqual([]);
    expect(needsOf(JOBS.test!)).toEqual(['mark']);
    expect(needsOf(JOBS.passed!)).toEqual(['mark', 'test']);
    expect(needsOf(JOBS.images!)).toEqual(['mark', 'test']);
    expect(needsOf(JOBS.publish!)).toEqual(['mark', 'test', 'images']);
    expect(needsOf(JOBS.release!)).toEqual(['publish']);
  });

  const BY_HAND = { event: 'workflow_dispatch', ref: 'refs/heads/turn-8' };

  it('skips the tests and goes straight to the images, the publish job and the release when the mark proved the commit', () => {
    expect(runWorkflow({ proved: true })).toEqual({ mark: 'success', test: 'skipped', passed: 'skipped', images: 'success', publish: 'success', release: 'success' });
  });

  it('runs the tests before the images and the publish job when the mark did not prove it', () => {
    expect(runWorkflow({ proved: false })).toEqual({ mark: 'success', test: 'success', passed: 'success', images: 'success', publish: 'success', release: 'success' });
  });

  it('moves nothing and releases nothing when the images of the push failed', () => {
    expect(runWorkflow({ proved: false, images: 'failure' })).toEqual({ mark: 'success', test: 'success', passed: 'success', images: 'failure', publish: 'skipped', release: 'skipped' });
  });

  it('skips the tests and builds the images of a run by hand when the mark proved the commit', () => {
    expect(runWorkflow({ ...BY_HAND, proved: true })).toEqual({ mark: 'success', test: 'skipped', passed: 'skipped', images: 'success', publish: 'skipped', release: 'skipped' });
  });

  it('runs the tests before the images of a run by hand when the mark did not prove it', () => {
    expect(runWorkflow({ ...BY_HAND, proved: false })).toEqual({ mark: 'success', test: 'success', passed: 'success', images: 'success', publish: 'skipped', release: 'skipped' });
  });

  it('builds and moves nothing when the tests failed', () => {
    expect(runWorkflow({ proved: false, tests: 'failure' })).toEqual({ mark: 'success', test: 'failure', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped' });
    expect(runWorkflow({ ...BY_HAND, proved: false, tests: 'failure' })).toEqual({ mark: 'success', test: 'failure', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped' });
  });

  it('runs the tests when the first job itself failed, and goes on from them only', () => {
    expect(runWorkflow({ markJob: 'failure' })).toEqual({ mark: 'failure', test: 'success', passed: 'skipped', images: 'success', publish: 'success', release: 'success' });
    expect(runWorkflow({ ...BY_HAND, markJob: 'failure' })).toEqual({ mark: 'failure', test: 'success', passed: 'skipped', images: 'success', publish: 'skipped', release: 'skipped' });
    expect(runWorkflow({ markJob: 'failure', tests: 'failure' })).toEqual({ mark: 'failure', test: 'failure', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped' });
  });

  it('builds and moves nothing for a pull request, marked or not', () => {
    expect(runWorkflow({ event: 'pull_request', ref: 'refs/pull/1/merge', proved: true })).toEqual({ mark: 'success', test: 'skipped', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped' });
    expect(runWorkflow({ event: 'pull_request', ref: 'refs/pull/1/merge', proved: false })).toEqual({ mark: 'success', test: 'success', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped' });
  });

  it('publishes and releases only for a push to main, not for a run by hand from main either', () => {
    expect(runWorkflow({ event: 'workflow_dispatch', ref: 'refs/heads/main', proved: true })).toEqual({ mark: 'success', test: 'skipped', passed: 'skipped', images: 'success', publish: 'skipped', release: 'skipped' });
    expect(runWorkflow({ event: 'push', ref: 'refs/heads/turn-8', proved: true })).toMatchObject({ images: 'skipped', publish: 'skipped', release: 'skipped' });
  });

  it('builds and moves nothing once the run is cancelled', () => {
    expect(runWorkflow({ proved: true, cancelled: true })).toMatchObject({ test: 'skipped', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped' });
    expect(runWorkflow({ ...BY_HAND, proved: true, cancelled: true })).toMatchObject({ test: 'skipped', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped' });
  });

  it('runs the tests in the parts the first job chose, four without its answer, with runner variables for private repositories', () => {
    expect(JOBS.test!['runs-on']).toBe(TESTS_RUNS_ON);
    expect(JOBS.test!.strategy!.matrix.part).toBe("${{ fromJSON(needs.mark.outputs.parts || '[1, 2, 3, 4]') }}");
    expect(JOBS.test!.env).toEqual({ PART: '${{ matrix.part }}/4', SELECTION: '${{ needs.mark.outputs.selection }}' });
  });

  it('sends the first job and the tests by one variable, and images, publishing and the release by another', () => {
    for (const name of ['mark', 'passed']) expect(JOBS[name]!['runs-on']).toBe(TESTS_RUNS_ON);
    /* The tests against real Postgres and Pebble start their servers in Docker, which the runners TESTS_RUNS_ON names need
       not have: they run only where a variable of their own names a runner that has a daemon, and are left out while it
       names none. */
    expect(JOBS['test-real']!['runs-on']).toBe(runsOn('REAL_RUNS_ON'));
    expect(JOBS['test-real']!.if).toBe("${{ vars.REAL_RUNS_ON != '' }}");
    for (const name of ['images', 'publish', 'release']) expect(JOBS[name]!['runs-on']).toBe(BUILD_RUNS_ON);
    expect(Object.keys(JOBS).sort()).toEqual(['images', 'mark', 'passed', 'publish', 'release', 'test', 'test-real']);
  });

  it('builds with the BuildKit the repository variable names, and with GitHub’s own and its emulator without one', () => {
    const buildx = (job: Job) => job.steps.filter(step => step.uses?.startsWith('docker/setup-buildx-action@'));
    for (const name of ['images', 'publish']) expect(buildx(JOBS[name]!).map(step => step.with)).toEqual([BUILDER]);
    const qemu = JOBS.images!.steps.filter(step => step.uses?.startsWith('docker/setup-qemu-action@'));
    expect(qemu.map(step => step.if)).toEqual(["${{ steps.fresh.outputs.version == 'new' && !(github.event.repository.private && vars.BUILDKIT_ENDPOINT) }}"]);
  });

  it('gives the first job the whole history, the token, and only the rights to read', () => {
    const { permissions, outputs, steps } = JOBS.mark!;
    expect(permissions).toEqual({ contents: 'read', statuses: 'read' });
    expect(outputs).toEqual({ proved: '${{ steps.mark.outputs.proved }}', parts: '${{ steps.select.outputs.parts }}', selection: '${{ steps.select.outputs.selection }}', base: '${{ steps.select.outputs.base }}' });
    expect(steps[0]!.uses).toMatch(/^actions\/checkout@/);
    expect(steps[0]!.with).toEqual({ 'fetch-depth': 0, 'persist-credentials': false });
    expect(steps[1]).toEqual({ id: 'mark', env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }, run: 'node scripts/tests-mark.mjs' });
    expect(steps.filter(step => step.env?.GITHUB_TOKEN).map(step => step.id)).toEqual(['mark', 'select']);
  });
});

/* Where a job runs, as GitHub reads its runs-on: a property that is not there is null, a variable that is not set is empty.
   Labels written out, as a list or as a plain value, come back as they are. */
const RUNNER_VARS = ['TESTS_RUNS_ON', 'BUILD_RUNS_ON', 'REAL_RUNS_ON'];
function runnerOf(expression: unknown, event_name: string, event: unknown, set: string): unknown {
  if (typeof expression !== 'string' || !expression.startsWith('${{')) return expression;
  const body = expression.replace(/^\$\{\{|\}\}$/g, '').trim().replace(/\.(?=[A-Za-z_])/g, '?.');
  const vars = Object.fromEntries([...RUNNER_VARS, 'BUILDKIT_ENDPOINT'].map(name => [name, RUNNER_VARS.includes(name) ? set : '']));
  return runInNewContext(body, { github: { event_name, repository: 'acme/shop', event }, vars, fromJSON: (text: string) => JSON.parse(text) as unknown });
}

const WORKFLOWS = readdirSync(join(ROOT, '.github/workflows')).filter(name => /\.ya?ml$/.test(name)).sort();
const jobsOf = (name: string) => Object.entries((parse(readFileSync(join(ROOT, '.github/workflows', name), 'utf8')) as { jobs: Record<string, Job> }).jobs);
const OWN = '["own", "x64"]';

describe('the runners of every workflow', () => {
  it.each(WORKFLOWS)('%s runs a pull request from a fork on GitHub’s machines, whatever the variables name', name => {
    for (const [job, { 'runs-on': runs }] of jobsOf(name)) {
      for (const [what, event] of [['a fork', FROM_FORK], ['a fork that is gone', FROM_GONE_FORK]] as const) {
        expect(runnerOf(runs, 'pull_request', event, OWN), `${job}, ${what}`).toBe('ubuntu-latest');
      }
    }
  });

  /* A label written into a workflow, self-hosted or a machine's own, would send a job to that machine whatever the
     repository's settings say: a job runs on GitHub's machines or on the runners a repository variable names, and nowhere
     else. */
  it('uses configured runners for trusted events in private repositories and otherwise uses GitHub runners', () => {
    for (const name of WORKFLOWS) {
      for (const [job, { 'runs-on': runs }] of jobsOf(name)) {
        const fromVariable = typeof runs === 'string' && /\bvars\./.test(runs);
        for (const [event_name, event] of [['push', PUSH], ['workflow_dispatch', PUSH], ['pull_request', FROM_BRANCH]] as const) {
          expect(runnerOf(runs, event_name, event, OWN), `${name} ${job} ${event_name}`).toEqual(fromVariable ? ['own', 'x64'] : 'ubuntu-latest');
          expect(runnerOf(runs, event_name, event, ''), `${name} ${job} ${event_name} without variables`).toBe('ubuntu-latest');
        }
      }
    }
  });

  it('starts no workflow on pull_request_target or workflow_run, which would run code of a pull request with the rights of this repository', () => {
    for (const name of WORKFLOWS) {
      const on = (parse(readFileSync(join(ROOT, '.github/workflows', name), 'utf8')) as { on: unknown }).on;
      const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on as object);
      expect(events, name).not.toContain('pull_request_target');
      expect(events, name).not.toContain('workflow_run');
    }
  });
});

describe('public repository workflow boundaries', () => {
  it('uses GitHub runners for every job of a public repository even when runner variables are set', () => {
    const publicEvent = { ...FROM_BRANCH, repository: { ...PUSH.repository, private: false } };
    for (const name of WORKFLOWS) {
      for (const [job, { 'runs-on': runs }] of jobsOf(name)) {
        for (const event of ['push', 'workflow_dispatch', 'pull_request']) {
          expect(runnerOf(runs, event, publicEvent, OWN), `${name} ${job} ${event}`).toBe('ubuntu-latest');
        }
      }
    }
  });

  it('runs fork tests without the job that passes the status token to repository scripts', () => {
    for (const payload of [FROM_FORK, FROM_GONE_FORK]) {
      expect(runWorkflow({ event: 'pull_request', payload, ref: 'refs/pull/1/merge', proved: true })).toEqual({
        mark: 'skipped', test: 'success', passed: 'skipped', images: 'skipped', publish: 'skipped', release: 'skipped',
      });
    }
  });

  it('keeps checkout credentials out of jobs that run on forks', () => {
    for (const [workflow, names] of [['images.yml', ['test', 'test-real']], ['sign-off.yml', ['sign-off']]] as const) {
      for (const [name, job] of jobsOf(workflow)) {
        if (!(names as readonly string[]).includes(name)) continue;
        const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
        expect(checkout?.with?.['persist-credentials'], `${workflow} ${name}`).toBe(false);
        expect(JSON.stringify(job)).not.toMatch(/secrets\.|github\.token/);
      }
    }
  });

  it('dispatches the installer only from main and scopes its credential to the deployment environment', () => {
    const send = Object.fromEntries(jobsOf('installer-site.yml')).send;
    expect(send).toMatchObject({
      if: "${{ github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' }}",
      environment: 'installer-site',
    });
    const upload = send!.steps.find(step => step.env?.EDGE_INSTALL_KEY);
    expect(upload?.env).toMatchObject({
      EDGE_INSTALL_KEY: '${{ secrets.EDGE_INSTALL_KEY }}',
      EDGE_INSTALL_HOST: '${{ secrets.EDGE_INSTALL_HOST }}',
      EDGE_KNOWN_HOSTS: '${{ secrets.EDGE_KNOWN_HOSTS }}',
    });
  });
});
