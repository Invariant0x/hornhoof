import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
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
const RELEASE_VERSION = join(ROOT, 'scripts/release-version.mjs');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/images.yml'), 'utf8');
/* The runners the repository variable names, GitHub's machines without it, and always for a pull request from a fork. */
const TRUSTED = "(github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)";
const runsOn = (variable: string) => `\${{ ${TRUSTED} && vars.${variable} && fromJSON(vars.${variable}) || 'ubuntu-latest' }}`;
const TESTS_RUNS_ON = runsOn('TESTS_RUNS_ON');
const BUILD_RUNS_ON = runsOn('BUILD_RUNS_ON');
const BUILDER = { driver: "${{ vars.BUILDKIT_ENDPOINT && 'remote' || 'docker-container' }}", endpoint: '${{ vars.BUILDKIT_ENDPOINT }}' };
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

const PUSH = { repository: { full_name: 'acme/shop' } };
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

  describe('a release commit', () => {
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const NOTES = '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A cart keeps its items.\n\n## [0.5.0] - 2026-11-04\n\n### Fixed\n\n- A checkout issue.\n';
    const CART = { name: '@shop/cart', version: '0.5.0', dependencies: { 'left-pad': '^1.3.0' } };
    const statusOf = (sha: string) => `/repos/acme/shop/commits/${sha}/status?per_page=100`;

    function write(dir: string, path: string, text: string) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }

    /* A repository with workspaces, as release:version reads it; its one commit is the parent of the release. */
    function shop() {
      const dir = folder();
      git(dir, 'init', '--quiet', '--initial-branch=main');
      write(dir, 'package.json', json({ name: 'shop', version: '0.5.0', workspaces: ['packages/*'] }));
      write(dir, 'packages/cart/package.json', json(CART));
      write(dir, 'packages/cart/index.js', 'export const cart = [];\n');
      write(dir, 'package-lock.json', json({
        name: 'shop',
        version: '0.5.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { name: 'shop', version: '0.5.0', workspaces: ['packages/*'] },
          'node_modules/@shop/cart': { resolved: 'packages/cart', link: true },
          'node_modules/left-pad': { version: '1.3.0' },
          'packages/cart': CART,
        },
      }));
      write(dir, 'CHANGELOG.md', NOTES);
      git(dir, 'add', '--all');
      git(dir, 'commit', '--quiet', '-m', 'cart');
      return { dir, parent: git(dir, 'rev-parse', 'HEAD') };
    }

    /* The release commit as a release is made: `npm run release:version -- turn 6`, then the notes of 0.6.0 under their heading. */
    function release(dir: string, more: () => void = () => {}, heading = '## [0.6.0] - 2026-11-18') {
      execFileSync(process.execPath, [RELEASE_VERSION, 'turn', '6'], { cwd: dir, stdio: 'ignore' });
      write(dir, 'CHANGELOG.md', NOTES.replace('## [Unreleased]\n', `## [Unreleased]\n\n${heading}\n`));
      more();
      git(dir, 'commit', '--quiet', '--all', '-m', 'Release 0.6.0: version and its notes');
      return git(dir, 'rev-parse', 'HEAD');
    }

    it('takes the passed mark of its parent when it changes only the versions release:version writes and the notes', async () => {
      const { dir, parent } = shop();
      const sha = release(dir);
      const hub = await github({ [parent]: MARKED });
      const { out, said } = await decide(dir, sha, hub.api);
      expect(out).toBe(PROVED);
      expect(hub.asked.map(a => a.url)).toEqual([statusOf(sha), statusOf(parent)]);
      expect(said).toContain(parent);
    });

    it('takes it for the real release 0.34.1 over 209274b1, its patch applied as git made it', async () => {
      const fixture = JSON.parse(readFileSync(join(ROOT, 'apps/server/test/fixtures/release-0.34.1.json'), 'utf8')) as { files: Record<string, string>; patch: string };
      const dir = folder();
      git(dir, 'init', '--quiet', '--initial-branch=main');
      for (const [path, text] of Object.entries(fixture.files)) write(dir, path, text);
      git(dir, 'add', '--all');
      git(dir, 'commit', '--quiet', '-m', 'Keep no scrollbar room beside the tracker lists drawer on a phone');
      const parent = git(dir, 'rev-parse', 'HEAD');
      const patch = join(folder(), 'release.patch');
      writeFileSync(patch, fixture.patch);
      git(dir, 'apply', patch);
      git(dir, 'commit', '--quiet', '--all', '-m', 'Release 0.34.1: version and its notes');
      const hub = await github({ [parent]: MARKED });
      expect((await decide(dir, git(dir, 'rev-parse', 'HEAD'), hub.api)).out).toBe(PROVED);
    });

    it('runs the tests when one more line changed beside them, and GitHub is not asked of its parent', async () => {
      const { dir, parent } = shop();
      const sha = release(dir, () => write(dir, 'packages/cart/index.js', 'export const cart = [1];\n'));
      const hub = await github({ [parent]: MARKED });
      const { out, said } = await decide(dir, sha, hub.api);
      expect(out).toBe(NOT_PROVED);
      expect(said).toContain('packages/cart/index.js');
      expect(hub.asked.map(a => a.url)).toEqual([statusOf(sha)]);
    });

    it('runs the tests when a package.json also bumps a dependency', async () => {
      const { dir, parent } = shop();
      const sha = release(dir, () => {
        const manifest = JSON.parse(readFileSync(join(dir, 'packages/cart/package.json'), 'utf8')) as typeof CART;
        write(dir, 'packages/cart/package.json', json({ ...manifest, dependencies: { 'left-pad': '^1.3.1' } }));
      });
      const hub = await github({ [parent]: MARKED });
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
    });

    it.each([['no mark', []], ['a failure', [{ context: 'hornhoof/tests', state: 'failure' }]]])('runs the tests when its parent has %s', async (_what, marks) => {
      const { dir, parent } = shop();
      const sha = release(dir);
      const hub = await github({ [parent]: marks });
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
    });

    it('runs the tests for a merge, even one that brings in only versions and notes over a parent with a passed mark', async () => {
      const { dir, parent } = shop();
      git(dir, 'checkout', '--quiet', '-b', 'release');
      release(dir);
      git(dir, 'checkout', '--quiet', 'main');
      git(dir, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'release');
      const hub = await github({ [parent]: MARKED });
      expect((await decide(dir, git(dir, 'rev-parse', 'HEAD'), hub.api)).out).toBe(NOT_PROVED);
    });

    it('runs the tests when its release check fails, as the tests would', async () => {
      const { dir, parent } = shop();
      const sha = release(dir, () => {}, '## [0.6.0] on 18 November');
      const hub = await github({ [parent]: MARKED });
      const { out, said } = await decide(dir, sha, hub.api);
      expect(out).toBe(NOT_PROVED);
      expect(said).toContain('release check');
      expect(hub.asked.map(a => a.url)).toEqual([statusOf(sha)]);
    });

    it('takes it as well when another commit is checked out, as the choice of tests asks of the commits before it', async () => {
      const { dir, parent } = shop();
      const sha = release(dir);
      git(dir, 'checkout', '--quiet', parent);
      const hub = await github({ [parent]: MARKED });
      expect((await decide(dir, sha, hub.api)).out).toBe(PROVED);
    });

    it('runs the tests for the first commit, which has no parent to take a mark from', async () => {
      const dir = repository();
      const hub = await github({});
      const { out, said } = await decide(dir, git(dir, 'rev-parse', 'main'), hub.api);
      expect(out).toBe(NOT_PROVED);
      expect(said).toContain('first commit');
    });

    it('runs the release check on the files of that commit, not on those checked out', async () => {
      const { dir, parent } = shop();
      const sha = release(dir, () => {}, '## [0.6.0] on 18 November');
      git(dir, 'checkout', '--quiet', parent);
      const hub = await github({ [parent]: MARKED });
      expect((await decide(dir, sha, hub.api)).out).toBe(NOT_PROVED);
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
type Scenario = { event?: string; ref?: string; proved?: boolean; markJob?: 'success' | 'failure'; tests?: 'success' | 'failure'; images?: 'success' | 'failure'; cancelled?: boolean };

/* Which jobs run, from the workflow's own conditions, as GitHub reads them: a condition with no status function of its own
   runs only when every job before it, however far back, succeeded. Every job that runs ends as the scenario says. */
function runWorkflow({ event = 'push', ref = 'refs/heads/main', proved = false, markJob = 'success', tests = 'success', images = 'success', cancelled = false }: Scenario): Results {
  const results: Results = {};
  const ancestors = (name: string): string[] => needsOf(JOBS[name]!).flatMap(n => [n, ...ancestors(n)]);
  const context = () => ({
    github: { event_name: event, ref },
    cancelled: () => cancelled,
    needs: Object.fromEntries(Object.keys(results).map(n => [n, { result: results[n], outputs: { proved: n === 'mark' && results[n] === 'success' ? String(proved) : '' } }])),
  });
  for (const name of ['mark', 'test', 'passed', 'images', 'publish', 'release']) {
    const expression = (JOBS[name]!.if ?? 'true').replace(/^\$\{\{|\}\}$/g, '').trim();
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

  it('runs the tests in the parts the first job chose, four without its answer, on GitHub’s machines unless the repository variable names other runners', () => {
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
    expect(qemu.map(step => step.if)).toEqual(["${{ steps.fresh.outputs.version == 'new' && !vars.BUILDKIT_ENDPOINT }}"]);
  });

  it('gives the first job the whole history, the token, and only the rights to read', () => {
    const { permissions, outputs, steps } = JOBS.mark!;
    expect(permissions).toEqual({ contents: 'read', statuses: 'read' });
    expect(outputs).toEqual({ proved: '${{ steps.mark.outputs.proved }}', parts: '${{ steps.select.outputs.parts }}', selection: '${{ steps.select.outputs.selection }}', base: '${{ steps.select.outputs.base }}' });
    expect(steps[0]!.uses).toMatch(/^actions\/checkout@/);
    expect(steps[0]!.with).toEqual({ 'fetch-depth': 0 });
    expect(steps[1]).toEqual({ id: 'mark', env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }, run: 'node scripts/tests-mark.mjs' });
    expect(steps.filter(step => step.env?.GITHUB_TOKEN).map(step => step.id)).toEqual(['mark', 'select']);
  });
});

/* The step of a job that looks whether its version is out, and the release job's own steps, run as GitHub runs them: their
   text through bash, in a checkout of the release commit, against a fake GitHub, a fake registry and a gh that asks the
   fake GitHub and writes down everything else it is told to do. Nothing reaches the network. */
describe('whether a version is out, as the images, publish and release jobs look', () => {
  const VERSION = '0.34.1';
  const TOKEN = 'ghs_workflow_token';
  const ACTOR = 'octocat';
  const TAG_OBJECT = 'f'.repeat(40);
  const INDEX = `sha256:${'1'.repeat(64)}`;
  const AMD64 = `sha256:${'2'.repeat(64)}`;
  const ATTESTATION = `sha256:${'3'.repeat(64)}`;
  const CONFIG = `sha256:${'4'.repeat(64)}`;
  const IMAGE = `ghcr.io/invariant0x/hornhoof:${VERSION}`;

  type Where = 'none' | 'here' | 'other';
  type World = { tag?: Where; release?: boolean; image?: Where | 'unlabeled'; github?: number; registry?: number };
  type Ran = { code: number; said: string; outputs: Record<string, Record<string, string>>; gh: string[][]; asked: { url: string; authorization: string | undefined }[]; notes: string | null; sha: string; other: string };

  const project = (dir: string, version: string) => {
    mkdirSync(join(dir, 'packages/protocol'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'hornhoof', version, workspaces: ['packages/*'] }, null, 2)}\n`);
    writeFileSync(join(dir, 'packages/protocol/package.json'), `${JSON.stringify({ name: '@hornhoof/protocol', version }, null, 2)}\n`);
    writeFileSync(join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [${version}] - 2026-11-18\n\n### Fixed\n\n- Servers update to ${version}.\n`);
    git(dir, 'add', 'package.json', 'packages', 'CHANGELOG.md');
    git(dir, 'commit', '--quiet', '-m', `Release ${version}: version and its notes`);
    return git(dir, 'rev-parse', 'HEAD');
  };

  /* The checkout a job makes: the commit before the release, the release commit on it, the annotated tag where the push put
     one, and the repository's scripts beside them. */
  function checkout(world: World) {
    const dir = folder();
    git(dir, 'init', '--quiet', '--initial-branch=main');
    const other = project(dir, '0.34.0');
    const sha = project(dir, VERSION);
    if (world.tag && world.tag !== 'none') git(dir, 'tag', '-a', `v${VERSION}`, '-m', `v${VERSION}`, world.tag === 'here' ? sha : other);
    symlinkSync(join(ROOT, 'scripts'), join(dir, 'scripts'));
    return { dir, sha, other };
  }

  /* GitHub's API under /api, and a registry that asks for a token first, as ghcr.io does, and serves blobs from elsewhere. */
  async function outside(world: World, sha: string, other: string) {
    const asked: Ran['asked'] = [];
    let base = '';
    const revision = { here: sha, other, unlabeled: null }[world.image as 'here' | 'other' | 'unlabeled'];
    const reply = (res: ServerResponse, code: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const api = (req: IncomingMessage, res: ServerResponse, path: string) => {
      if (world.github) return reply(res, world.github, { message: 'GitHub is down' });
      if (path === `/repos/acme/shop/git/ref/tags/v${VERSION}`) {
        return world.tag && world.tag !== 'none' ? reply(res, 200, { ref: `refs/tags/v${VERSION}`, object: { type: 'tag', sha: TAG_OBJECT } }) : reply(res, 404, { message: 'Not Found' });
      }
      if (path === `/repos/acme/shop/git/tags/${TAG_OBJECT}`) return reply(res, 200, { tag: `v${VERSION}`, object: { type: 'commit', sha: world.tag === 'here' ? sha : other } });
      if (path === `/repos/acme/shop/releases/tags/v${VERSION}`) return world.release ? reply(res, 200, { tag_name: `v${VERSION}` }) : reply(res, 404, { message: 'Not Found' });
      return reply(res, 404, { message: 'Not Found' });
    };
    const registry = (req: IncomingMessage, res: ServerResponse, url: string) => {
      if (world.registry) return reply(res, world.registry, { errors: [{ code: 'UNAVAILABLE' }] });
      if (url.startsWith('/token?')) {
        const basic = `Basic ${Buffer.from(`${ACTOR}:${TOKEN}`).toString('base64')}`;
        return req.headers.authorization === basic ? reply(res, 200, { token: 'pull-token' }) : reply(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] });
      }
      if (url === '/cdn/config') return reply(res, 200, { architecture: 'amd64', os: 'linux', config: { Labels: revision ? { 'org.opencontainers.image.revision': revision } : {} } });
      if (req.headers.authorization !== 'Bearer pull-token') {
        return reply(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] }, { 'www-authenticate': `Bearer realm="${base}/token",service="ghcr.io",scope="repository:invariant0x/hornhoof:pull"` });
      }
      if (url === `/v2/invariant0x/hornhoof/manifests/${VERSION}`) {
        if (!world.image || world.image === 'none') return reply(res, 404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
        return reply(res, 200, {
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.index.v1+json',
          manifests: [
            { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: ATTESTATION, size: 1, platform: { os: 'unknown', architecture: 'unknown' } },
            { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: AMD64, size: 1, platform: { os: 'linux', architecture: 'amd64' } },
          ],
        }, { 'content-type': 'application/vnd.oci.image.index.v1+json', 'docker-content-digest': INDEX });
      }
      if (url === `/v2/invariant0x/hornhoof/manifests/${AMD64}`) {
        return reply(res, 200, { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: CONFIG, size: 1 }, layers: [] }, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' });
      }
      if (url === `/v2/invariant0x/hornhoof/blobs/${CONFIG}`) return reply(res, 307, undefined, { location: `${base}/cdn/config` });
      return reply(res, 404, { errors: [{ code: 'NAME_UNKNOWN' }] });
    };
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      asked.push({ url, authorization: req.headers.authorization });
      if (url.startsWith('/api/')) return api(req, res, url.slice('/api'.length));
      return registry(req, res, url);
    });
    await listenIn(server);
    onTestFinished(() => new Promise<void>(done => {
      server.closeAllConnections();
      server.close(() => done());
    }));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { asked, api: `${base}/api`, registry: base };
  }

  /* A gh that asks the fake GitHub for `gh api` and only writes down what else it was told. */
  function gh() {
    const bin = folder();
    const calls = join(bin, 'calls.jsonl');
    writeFileSync(calls, '');
    writeFileSync(join(bin, 'gh'), [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "require('node:fs').appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n');",
      "if (args[0] === 'api') fetch(`${process.env.GITHUB_API_URL}/${args[1]}`, { headers: { authorization: `Bearer ${process.env.GH_TOKEN}` } }).then(res => process.exit(res.ok ? 0 : 1), () => process.exit(1));",
      '',
    ].join('\n'), { mode: 0o755 });
    return { bin, calls };
  }

  /* An expression as GitHub fills it in, from what the step can see. */
  const evaluate = (expression: string, context: object) => runInNewContext(expression.replace(/^\$\{\{|\}\}$/g, '').trim(), context) as unknown;
  const fill = (value: string, context: object) => value.replace(/\$\{\{(.*?)\}\}/g, (_all, expression: string) => String(evaluate(expression, context) ?? ''));

  const bash = (script: string, cwd: string, env: NodeJS.ProcessEnv) => new Promise<{ code: number; out: string }>(done => {
    execFile('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, env }, (error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, out: `${stdout}${stderr}` }));
  });

  /* The steps of the job that run a script, in order, each when its condition holds, until one fails: only the step that
     looks, for the images and publish jobs, whose later steps build and move images. */
  async function run(name: 'images' | 'publish' | 'release', world: World, event = 'push'): Promise<Ran> {
    const { dir, sha, other } = checkout(world);
    const { asked, api, registry } = await outside(world, sha, other);
    const stub = gh();
    const temp = folder();
    const own = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GITHUB_|GH_|RUNNER_|HORNHOOF_)/.test(key)));
    const outputs: Ran['outputs'] = {};
    let said = '';
    let code = 0;
    const steps = JOBS[name]!.steps.filter(step => step.run && (name === 'release' || step.id === 'fresh'));
    for (const [at, step] of steps.entries()) {
      const context = { github: { event_name: event, sha, repository: 'acme/shop', ref: 'refs/heads/main' }, secrets: { GITHUB_TOKEN: TOKEN }, vars: {}, steps: Object.fromEntries(Object.entries(outputs).map(([id, values]) => [id, { outputs: values }])) };
      if (step.if && !evaluate(step.if, context)) continue;
      const output = join(temp, `output-${at}`);
      writeFileSync(output, '');
      const env = {
        ...own,
        PATH: `${stub.bin}:${process.env.PATH}`,
        GH_CALLS: stub.calls,
        GITHUB_SHA: sha,
        GITHUB_REPOSITORY: 'acme/shop',
        GITHUB_EVENT_NAME: event,
        GITHUB_ACTOR: ACTOR,
        GITHUB_API_URL: api,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: temp,
        HORNHOOF_REGISTRY_URL: registry,
        ...Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, fill(value, context)])),
      };
      const ran = await bash(step.run!, dir, env);
      said += ran.out;
      if (step.id) outputs[step.id] = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      if (ran.code !== 0) {
        code = ran.code;
        break;
      }
    }
    const calls = readFileSync(stub.calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    let notes: string | null = null;
    try { notes = readFileSync(join(temp, 'release-notes.md'), 'utf8'); } catch { notes = null; }
    return { code, said, outputs, gh: calls.filter(args => args[0] !== 'api'), asked, notes, sha, other };
  }

  const released = (ran: Ran) => ran.gh.filter(args => args[0] === 'release' && args[1] === 'create');
  const siteStarted = (ran: Ran) => ran.gh.some(args => args.join(' ') === 'workflow run installer-site.yml --repo acme/shop --ref main');

  it('builds, publishes and releases a version whose tag came with main on this very commit, with no images yet, as 0.34.1 did', async () => {
    const world: World = { tag: 'here', release: false, image: 'none' };
    const images = await run('images', world);
    expect(images.code, images.said).toBe(0);
    expect(images.outputs.fresh).toEqual({ version: 'new' });
    const publish = await run('publish', world);
    expect(publish.code, publish.said).toBe(0);
    expect(publish.outputs.fresh).toEqual({ version: 'new' });
    const release = await run('release', world);
    expect(release.code, release.said).toBe(0);
    expect(released(release)).toHaveLength(1);
    expect(released(release)[0]!.slice(0, 3)).toEqual(['release', 'create', `v${VERSION}`]);
    expect(siteStarted(release)).toBe(true);
    expect(release.notes).toContain(`Servers update to ${VERSION}.`);
  });

  it('builds, publishes, tags and releases a new version that has neither a tag nor images', async () => {
    const world: World = { tag: 'none', release: false, image: 'none' };
    expect((await run('images', world)).outputs.fresh).toEqual({ version: 'new' });
    expect((await run('publish', world)).outputs.fresh).toEqual({ version: 'new' });
    const release = await run('release', world);
    expect(release.code, release.said).toBe(0);
    expect(released(release)[0]).toEqual(expect.arrayContaining(['release', 'create', `v${VERSION}`, '--target', release.sha]));
    expect(siteStarted(release)).toBe(true);
  });

  it('builds, moves and releases nothing when the tag, the images of this commit and the release are all out', async () => {
    const world: World = { tag: 'here', release: true, image: 'here' };
    const images = await run('images', world);
    expect(images.code, images.said).toBe(0);
    expect(images.outputs.fresh).toEqual({ version: 'out' });
    expect(images.said).toContain(`Version ${VERSION} is out already`);
    const publish = await run('publish', world);
    expect(publish.code, publish.said).toBe(0);
    expect(publish.outputs.fresh).toEqual({ version: 'out' });
    const release = await run('release', world);
    expect(release.code, release.said).toBe(0);
    expect(release.gh).toEqual([]);
  });

  it('creates only the release when the tag and the images are out but the release is missing', async () => {
    const world: World = { tag: 'here', release: false, image: 'here' };
    expect((await run('images', world)).outputs.fresh).toEqual({ version: 'out' });
    expect((await run('publish', world)).outputs.fresh).toEqual({ version: 'out' });
    const release = await run('release', world);
    expect(release.code, release.said).toBe(0);
    expect(released(release)).toHaveLength(1);
    expect(siteStarted(release)).toBe(true);
  });

  it.each(['images', 'publish', 'release'] as const)('the %s job stops, and says why, when the tag is on another commit', async name => {
    const ran = await run(name, { tag: 'other', release: false, image: 'none' });
    expect(ran.code).not.toBe(0);
    expect(ran.said).toContain(`The tag v${VERSION} is on commit ${ran.other}, not on this commit ${ran.sha}.`);
    expect(ran.gh).toEqual([]);
  });

  it.each(['images', 'publish'] as const)('the %s job stops, and says why, when the published images are those of another commit', async name => {
    const ran = await run(name, { tag: 'none', release: false, image: 'other' });
    expect(ran.code).not.toBe(0);
    expect(ran.said).toContain(`${IMAGE} holds the images of commit ${ran.other}, not of this commit ${ran.sha}.`);
  });

  it.each(['images', 'publish'] as const)('the %s job stops when the published images carry no revision label to tell whose they are', async name => {
    const ran = await run(name, { tag: 'here', release: false, image: 'unlabeled' });
    expect(ran.code).not.toBe(0);
    expect(ran.said).toContain(`${IMAGE} has no revision label`);
  });

  it('builds the images of a run by hand whatever is out, and asks neither GitHub nor the registry', async () => {
    const ran = await run('images', { tag: 'other', release: true, image: 'other' }, 'workflow_dispatch');
    expect(ran.code, ran.said).toBe(0);
    expect(ran.outputs.fresh).toEqual({ version: 'new' });
    expect(ran.asked).toEqual([]);
  });

  it.each([
    ['images', { github: 500 }],
    ['images', { registry: 500 }],
    ['publish', { registry: 503 }],
    ['release', { github: 502 }],
  ] as const)('the %s job stops when it cannot tell, and says what answered', async (name, trouble) => {
    const ran = await run(name, { tag: 'here', release: false, image: 'here', ...trouble });
    expect(ran.code).not.toBe(0);
    expect(ran.said).toContain(String(Object.values(trouble)[0]));
    expect(released(ran)).toEqual([]);
  });

  it('gives the token only to GitHub and the registry, never where a blob is served from, and prints it nowhere', async () => {
    for (const name of ['images', 'publish', 'release'] as const) {
      const ran = await run(name, { tag: 'here', release: true, image: 'here' });
      expect(ran.said).not.toContain(TOKEN);
      expect(ran.said).not.toContain(Buffer.from(`${ACTOR}:${TOKEN}`).toString('base64'));
      expect(ran.asked.filter(a => a.url.startsWith('/cdn/')).map(a => a.authorization)).toEqual(name === 'release' ? [] : [undefined]);
    }
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
  it('sends a push, a run by hand and a pull request from a branch of this repository where the variables say, to GitHub’s machines without them, and names no runner of its own', () => {
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
