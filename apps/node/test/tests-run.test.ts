import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { MAX_RUN_FILES, TEST_LOG_BYTES, type ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { clearShared, partFiles, partFolders, putOutputs, removeOldParts, runTests, type PartFiles } from '../src/tests.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { listenIn } from '../../../test-support/ports.mjs';

type TestRun = Extract<ServerMessage, { type: 'tests.run' }>;
/* A part's time that never runs out: the longest a timer waits, less the minute what a part made may still take to go on
   the task. */
const NEVER_MS = 2_147_483_647 - 60_000;

/* A clock that moves only when the test moves it, for the part's timers, its time and the waits that end at a moment,
   which Node's own AbortSignal.timeout would keep on the real clock. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const timer = new AbortController();
    setTimeout(() => { timer.abort(new DOMException('The operation timed out.', 'TimeoutError')); }, ms);
    return timer.signal;
  });
  onTestFinished(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/* A repository with a main branch and a branch per given name, each with marker.txt saying its name. */
function origin(branches: string[] = ['task-12-checkout']): { url: string; commits: Record<string, string> } {
  const work = mkdtempSync(join(tmpdir(), 'hh-origin-'));
  git(work, 'init', '--quiet', '--initial-branch=main');
  const commits: Record<string, string> = {};
  for (const branch of ['main', ...branches]) {
    if (branch !== 'main') git(work, 'checkout', '--quiet', '-b', branch, 'main');
    writeFileSync(join(work, 'marker.txt'), `${branch}\n`);
    git(work, 'add', 'marker.txt');
    git(work, 'commit', '--quiet', '-m', branch);
    commits[branch] = git(work, 'rev-parse', 'HEAD');
  }
  git(work, 'checkout', '--quiet', 'main');
  return { url: work, commits };
}

const nodeDir = () => mkdtempSync(join(tmpdir(), 'hh-node-'));
const run = (url: string, over: Partial<TestRun> = {}): TestRun => ({
  type: 'tests.run', partId: 'part-1', repo: { url, token: '' }, branch: 'task-12-checkout', task: 12, command: 'cat marker.txt', part: 1, parts: 1, timeoutMs: NEVER_MS, ...over,
});

describe('a part of a test run on a node', () => {
  it('clones the branch into a fresh folder, runs the command there and removes the folder', async () => {
    const { url, commits } = origin();
    const dir = nodeDir();
    const done = await runTests(run(url, { command: 'cat marker.txt; ls -a ..' }), { dir, user: null, hidden: [] });
    expect(done).toMatchObject({ type: 'tests.done', partId: 'part-1', ok: true, exitCode: 0, error: null, commit: commits['task-12-checkout'] });
    expect(done.log).toContain('task-12-checkout\n');
    expect(readdirSync(join(dir, 'runs'))).toEqual([]);
  });

  it('runs in runs/<part> of the data folder, with its home and temporary folder there', async () => {
    const { url } = origin();
    const dir = realpathSync(nodeDir());
    const done = await runTests(run(url, { command: 'pwd; echo "$HOME"; echo "$TMPDIR"' }), { dir, user: null, hidden: [] });
    const root = join(dir, 'runs', 'part-1');
    expect(done.log).toContain(`${join(root, 'repo')}\n${join(root, 'home')}\n${join(root, 'tmp')}\n`);
  });

  it('runs where the image checks that the quality tools read its sources as sources', async () => {
    const { url } = origin();
    const dir = realpathSync(nodeDir());
    const done = await runTests(run(url, { command: 'pwd' }), { dir, user: null, hidden: [] });
    const repo = relative(dir, done.log.split('\n').find(line => line.startsWith(dir))!);
    expect(readFileSync(new URL('../quality/test_part_paths.py', import.meta.url), 'utf8')).toContain(`PART_REPO = Path("/data/${repo}")`);
  });

  /* The image keeps the grammars of the quality tools in place and names them; without the name crapper fetches them from the
     network and fails where it cannot. */
  it('gives the quality tools the grammars the machine keeps, and nothing else of its own environment', async () => {
    vi.stubEnv('TREE_SITTER_LANGUAGE_PACK_CACHE_DIR', '/opt/hornhoof/grammars');
    vi.stubEnv('HH_SOMETHING_OF_THE_NODE', 'secret');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const { url } = origin();
    const done = await runTests(run(url, { command: 'printf "%s|%s\n" "$TREE_SITTER_LANGUAGE_PACK_CACHE_DIR" "$HH_SOMETHING_OF_THE_NODE"' }), { dir: nodeDir(), user: null, hidden: [] });
    expect(done).toMatchObject({ ok: true, exitCode: 0 });
    expect(done.log).toContain('/opt/hornhoof/grammars|\n');
  });

  it('exposes PLAYWRIGHT_BROWSERS_PATH on /data/browsers and prepares the repository browser before running the check', async () => {
    const { url } = origin();
    const dir = nodeDir();
    const seen: string[] = [];
    const done = await runTests(
      run(url, { command: 'printf "%s|%s\n" "$PLAYWRIGHT_BROWSERS_PATH" "$PLAYWRIGHT_SKIP_BROWSER_GC"' }),
      {
        dir,
        user: null,
        hidden: [],
        prepareRepoBrowser: async repoDir => {
          seen.push(repoDir);
        },
      },
    );
    expect(done).toMatchObject({ ok: true, exitCode: 0 });
    expect(seen).toHaveLength(1);
    expect(done.log).toContain(`${join(dir, 'browsers')}|1`);

    const failed = await runTests(run(url, { partId: 'part-2', command: 'echo should-not-run' }), {
      dir,
      user: null,
      hidden: [],
      prepareRepoBrowser: async () => {
        throw new Error('Playwright browsers could not start: libgbm.so.1 missing');
      },
    });
    expect(failed).toMatchObject({ ok: false, error: 'failed', exitCode: null });
    expect(failed.log).toContain('Playwright browsers could not start: libgbm.so.1 missing');
    expect(failed.log).not.toContain('should-not-run');
  });

  it("finds the task's own branch by its number when none is named, and says which when it cannot", async () => {
    const { url, commits } = origin(['task-12-checkout', 'task-120-other', 'task-7-a', 'task-7-b']);
    const dir = nodeDir();
    expect(await runTests(run(url, { branch: null }), { dir, user: null, hidden: [] })).toMatchObject({ ok: true, commit: commits['task-12-checkout'] });
    const several = await runTests(run(url, { branch: null, task: 7 }), { dir, user: null, hidden: [] });
    expect(several).toMatchObject({ ok: false, error: 'clone_failed', exitCode: null });
    expect(several.log).toContain('task-7-a, task-7-b');
    const none = await runTests(run(url, { branch: null, task: 99 }), { dir, user: null, hidden: [] });
    expect(none).toMatchObject({ ok: false, error: 'clone_failed' });
    expect(none.log).toContain('task-99');
    const missing = await runTests(run(url, { branch: 'task-5-gone' }), { dir, user: null, hidden: [] });
    expect(missing).toMatchObject({ ok: false, error: 'clone_failed' });
  });

  it("says why it found no branch when the repository's branches cannot be listed", async () => {
    const dir = nodeDir();
    const gone = join(dir, 'no-such-repository');
    const done = await runTests(run(gone, { branch: null, command: 'echo ran-the-command' }), { dir, user: null, hidden: [] });
    expect(done).toMatchObject({ ok: false, exitCode: null, error: 'clone_failed', commit: null });
    expect(done.log).toContain('no-such-repository');
    expect(done.log).not.toContain('ran-the-command');
  });

  it('says it was stopped when stopped while looking for its branch', async () => {
    const { url } = origin();
    const stop = new AbortController();
    stop.abort();
    const done = await runTests(run(url, { branch: null, command: 'echo ran-the-command' }), { dir: nodeDir(), user: null, hidden: [], signal: stop.signal });
    expect(done).toMatchObject({ ok: false, exitCode: null, error: 'cancelled', commit: null });
    expect(done.log).not.toContain('ran-the-command');
  });

  it("fails with the command's exit code, keeping the start and the end of a long log", async () => {
    const { url } = origin();
    const command = `echo FIRST; head -c ${2 * TEST_LOG_BYTES} /dev/zero | tr '\\0' x; echo; echo LAST; exit 3`;
    const done = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [] });
    expect(done).toMatchObject({ ok: false, error: 'failed', exitCode: 3 });
    expect(Buffer.byteLength(done.log)).toBeLessThanOrEqual(TEST_LOG_BYTES + 1024);
    expect(done.log).toContain('FIRST');
    expect(done.log).toContain('LAST');
    expect(done.log).toMatch(/left out/);
  });

  it('stops at its time limit together with every program the command started', async () => {
    const { url } = origin();
    const dir = nodeDir();
    fakeClock();
    let ended = false;
    const running = runTests(run(url, { command: 'touch started; sleep 30 & sleep 30; wait', timeoutMs: 1500 }), { dir, user: null, hidden: [] }).finally(() => { ended = true; });
    await eventually(() => existsSync(join(dir, 'runs', 'part-1', 'repo', 'started')));
    await vi.advanceTimersByTimeAsync(1499);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const done = await running;
    expect(done).toMatchObject({ ok: false, error: 'timeout', exitCode: null });
    expect(done.log).toMatch(/did not finish within 2 s/);
    expect(readdirSync(join(dir, 'runs'))).toEqual([]);
  });

  it('stops when Hornhoof calls it off', async () => {
    const { url } = origin();
    const stop = new AbortController(), dir = nodeDir();
    const done = runTests(run(url, { command: 'touch going; sleep 30' }), { dir, user: null, hidden: [], signal: stop.signal });
    await eventually(() => existsSync(join(dir, 'runs', 'part-1', 'repo', 'going')));
    stop.abort();
    expect(await done).toMatchObject({ ok: false, error: 'cancelled', exitCode: null });
  });

  it("keeps the repository's token and the node's key out of the command and its log, and tells the command its part", async () => {
    const { url } = origin();
    const command = 'echo "token=[$HH_GIT_PASSWORD]"; echo node-key-1234567890 ghp_repotoken0123456789; echo "part $HH_TEST_PART of $HH_TEST_PARTS"; printf "\\033[31mred\\033[0m\\n"';
    const repo = { url: `file://${url}`, token: 'ghp_repotoken0123456789' };
    const done = await runTests(run(url, { command, repo, part: 2, parts: 3 }), { dir: nodeDir(), user: null, hidden: ['node-key-1234567890'] });
    expect(done.ok).toBe(true);
    expect(done.log).toContain('token=[]');
    expect(done.log).not.toContain('node-key-1234567890');
    expect(done.log).not.toContain('ghp_repotoken0123456789');
    expect(done.log).toContain('[hidden]');
    expect(done.log).toContain('part 2 of 3');
    expect(done.log).toContain('red\n');
    expect(done.log).not.toContain('\u001b[');
  });

  it('leaves nothing behind when the clone fails', async () => {
    const dir = nodeDir();
    const done = await runTests(run(join(tmpdir(), 'no-such-repo-hh')), { dir, user: null, hidden: [] });
    expect(done).toMatchObject({ ok: false, error: 'clone_failed' });
    expect(existsSync(join(dir, 'runs', 'part-1'))).toBe(false);
  });

  /* As the product run's config does by itself: a machine of 16 cores and 7 GB free went to swap with half its cores in workers. */
  it("gives Vitest the cores the load leaves free and as many workers as the free memory holds, unless a count is named", async () => {
    const { url } = origin();
    const command = 'echo "workers=$VITEST_MAX_WORKERS"', gib = 2 ** 30;
    const idle = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, load: 0, memFree: 64 * gib, env: {} });
    expect(idle.log).toContain('workers=15\n');
    const some = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, load: 4.5, memFree: 64 * gib, env: {} });
    expect(some.log).toContain('workers=11\n');
    const busy = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, load: 12, memFree: 64 * gib, env: {} });
    expect(busy.log).toContain('workers=4\n');
    const memory = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, load: 0, memFree: 11.5 * gib, env: {} });
    expect(memory.log).toContain('workers=4\n');
    const short = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, load: 0, memFree: 2 * gib, env: {} });
    expect(short.log).toContain('workers=1\n');
    const one = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 1, load: 0, memFree: 64 * gib, env: {} });
    expect(one.log).toContain('workers=1\n');
    const presetEnv = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, env: { VITEST_MAX_WORKERS: '3' } });
    expect(presetEnv.log).toContain('workers=3\n');
    /* Vitest also takes a share of the cores, which the machine keeps as it named it. */
    const presetShare = await runTests(run(url, { command }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, env: { VITEST_MAX_WORKERS: '50%' } });
    expect(presetShare.log).toContain('workers=50%\n');
    const presetCmd = await runTests(run(url, { command: 'VITEST_MAX_WORKERS=2 sh -c \'echo "workers=$VITEST_MAX_WORKERS"\'' }), { dir: nodeDir(), user: null, hidden: [], cpus: 16, env: {} });
    expect(presetCmd.log).toContain('workers=2\n');
  });
});

/* Hornhoof's side of a part's files: the task's files it hands out, and the files put on the task. */
function taskFiles(have: Record<string, string> = {}) {
  const put: { partId: string; name: string; text: string }[] = [];
  const files: PartFiles = {
    async get(partId, name) {
      if (!(name in have)) throw new Error(`Hornhoof answered 404: task 12 has no file ${name}.`);
      return Buffer.from(have[name]!);
    },
    async put(partId, name, bytes) {
      put.push({ partId, name, text: bytes.toString('utf8') });
    },
  };
  return { files, put };
}

/* Task files that never come and never go, until the part's signal ends the wait. stalledWaits counts the waits begun. */
let stalledWaits = 0;
const stalled: PartFiles = {
  get: (_partId, _name, signal) => new Promise((_, reject) => { stalledWaits++; signal?.addEventListener('abort', () => reject(new Error('aborted'))); }),
  put: (_partId, _name, _bytes, signal) => new Promise((_, reject) => { stalledWaits++; signal?.addEventListener('abort', () => reject(new Error('aborted'))); }),
};

/* A new commit on the branch, as when someone pushes after Hornhoof pinned the one before it. */
function moveBranch(url: string, branch: string): string {
  git(url, 'checkout', '--quiet', branch);
  writeFileSync(join(url, 'marker.txt'), 'moved\n');
  git(url, 'add', 'marker.txt');
  git(url, 'commit', '--quiet', '-m', 'moved');
  const head = git(url, 'rev-parse', 'HEAD');
  git(url, 'checkout', '--quiet', 'main');
  return head;
}

describe('a part pinned to one commit', () => {
  it('checks the pinned commit after its branch moved on, and says that is what it checked', async () => {
    const { url, commits } = origin();
    const pinned = commits['task-12-checkout']!;
    expect(moveBranch(url, 'task-12-checkout')).not.toBe(pinned);
    const done = await runTests(run(url, { commitSha: pinned }), { dir: nodeDir(), user: null, hidden: [] });
    expect(done).toMatchObject({ ok: true, exitCode: 0, error: null, commit: pinned });
    expect(done.log).toContain('task-12-checkout\n');
    expect(done.log).not.toContain('moved\n');
  });

  it('finds the pinned commit without a branch name', async () => {
    const { url, commits } = origin(['elsewhere']);
    const done = await runTests(run(url, { branch: null, commitSha: commits.elsewhere! }), { dir: nodeDir(), user: null, hidden: [] });
    expect(done).toMatchObject({ ok: true, commit: commits.elsewhere });
    expect(done.log).toContain('elsewhere\n');
  });

  it('never runs the command when the repository does not have the pinned commit', async () => {
    const { url } = origin();
    const done = await runTests(run(url, { commitSha: 'f'.repeat(40), command: 'echo ran-the-command' }), { dir: nodeDir(), user: null, hidden: [] });
    expect(done).toMatchObject({ ok: false, exitCode: null, error: 'clone_failed', commit: null });
    expect(done.log).not.toContain('ran-the-command');
  });

  it('never runs the command when the checkout lands on another commit, and reports the one it landed on', async () => {
    const { url, commits } = origin();
    /* An annotated tag's own object can be fetched, and checking it out lands on the commit it points at. */
    git(url, 'tag', '-a', 'v1', '-m', 'v1', commits['task-12-checkout']!);
    const tag = git(url, 'rev-parse', 'v1');
    expect(tag).not.toBe(commits['task-12-checkout']);
    const seen: string[] = [];
    const done = await runTests(run(url, { commitSha: tag, command: 'echo ran-the-command' }), { dir: nodeDir(), user: null, hidden: [], prepareRepoBrowser: async repoDir => void seen.push(repoDir) });
    expect(done).toMatchObject({ ok: false, exitCode: null, error: 'clone_failed', commit: commits['task-12-checkout'] });
    expect(done.log).not.toContain('ran-the-command');
    expect(seen).toEqual([]);
  });

  it('says it was stopped, not that the commit is missing, when stopped before it got there', async () => {
    const { url, commits } = origin();
    const stop = new AbortController();
    stop.abort();
    const done = await runTests(run(url, { commitSha: commits['task-12-checkout']!, command: 'echo ran-the-command' }), { dir: nodeDir(), user: null, hidden: [], signal: stop.signal });
    expect(done).toMatchObject({ ok: false, exitCode: null, error: 'cancelled', commit: null });
    expect(done.log).not.toContain('ran-the-command');
  });

  it('leaves the origin remote in place for commands that read it', async () => {
    const { url, commits } = origin();
    const done = await runTests(run(url, { commitSha: commits['task-12-checkout']!, command: 'git remote get-url origin' }), { dir: nodeDir(), user: null, hidden: [] });
    expect(done).toMatchObject({ ok: true });
    expect(done.log).toContain(`\n${url}\n`);
  });
});

describe('the folders a restart left parts in', () => {
  it('go with what parts left there, read-only folders too, and nothing else goes', () => {
    const dir = nodeDir();
    const left = join(dir, 'tests', 'part-0', 'repo');
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'marker.txt'), 'left\n');
    chmodSync(left, 0o555);
    mkdirSync(join(dir, 'cache', 'dependencies'), { recursive: true });
    const lines: string[] = [];
    removeOldParts(dir, line => lines.push(line));
    expect(readdirSync(dir)).toEqual(['cache']);
    expect(readdirSync(join(dir, 'cache'))).toEqual(['dependencies']);
    expect(lines).toEqual([]);
  });

  it('take a part and a harness sync a restart stopped, as neither comes back to its folder', () => {
    const dir = nodeDir();
    const part = join(dir, 'runs', 'part-1', 'builders', 'unit-1');
    mkdirSync(part, { recursive: true });
    chmodSync(part, 0o555);
    mkdirSync(join(dir, 'runs', 'harness-request-1', 'repo'), { recursive: true });
    const lines: string[] = [];
    removeOldParts(dir, line => lines.push(line));
    expect(readdirSync(dir)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('is no trouble on a node that never had it', () => {
    const lines: string[] = [];
    removeOldParts(nodeDir(), line => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('is said, not thrown, when it cannot go', () => {
    const file = join(nodeDir(), 'file');
    writeFileSync(file, '');
    const lines: string[] = [];
    removeOldParts(file, line => lines.push(line));
    expect(lines).toEqual([expect.stringMatching(/^The old folder of test runs could not be removed: .+/)]);
  });
});

describe('a part of other work on a node', () => {
  const work = (over: Partial<TestRun> = {}): TestRun => ({
    type: 'tests.run', kind: 'work', partId: 'part-1', repo: null, branch: null, task: 12, command: 'true', part: 1, parts: 1, timeoutMs: NEVER_MS, ...over,
  });

  it('asks for a branch when it has a repository and none is named, and does not guess the task\'s', async () => {
    const { url } = origin(['task-12']);
    const done = await runTests(work({ repo: { url, token: '' }, command: 'echo ran-the-command' }), { dir: nodeDir(), user: null, hidden: [] });
    expect(done).toMatchObject({ ok: false, exitCode: null, error: 'clone_failed', commit: null });
    expect(done.log).toContain('Name the branch to clone.');
    expect(done.log).not.toContain('ran-the-command');
  });

  it('runs in runs/<part> of the data folder, beside a clone too, with its folders there', async () => {
    const dir = realpathSync(nodeDir());
    const root = join(dir, 'runs', 'part-1');
    const command = 'pwd; echo "$HH_IN"; echo "$HH_OUT"';
    const alone = await runTests(work({ command }), { dir, user: null, hidden: [], files: taskFiles().files });
    expect(alone.log).toContain(`${join(root, 'work')}\n${join(root, 'work')}\n${join(root, 'out')}\n`);
    const { url } = origin();
    const cloned = await runTests(work({ command, repo: { url, token: '' }, branch: 'task-12-checkout' }), { dir, user: null, hidden: [], files: taskFiles().files });
    expect(cloned.log).toContain(`${join(root, 'repo')}\n${join(root, 'in')}\n${join(root, 'out')}\n`);
  });

  it("runs in an empty folder with the task's files in it, and puts what it leaves in its output folder on the task", async () => {
    const dir = nodeDir();
    const { files, put } = taskFiles({ 'data.csv': 'a,b\n' });
    const command = 'ls -A; cat data.csv > "$HH_OUT/copy.csv"; echo "part $HH_PART of $HH_PARTS"; test "$(cd "$HH_IN" && pwd -P)" = "$(pwd -P)" && echo same';
    const done = await runTests(work({ command, files: ['data.csv'], part: 2, parts: 3 }), { dir, user: null, hidden: [], files });
    expect(done).toMatchObject({ type: 'tests.done', partId: 'part-1', ok: true, exitCode: 0, error: null, commit: null });
    expect(done.log).toContain('data.csv\n');
    expect(done.log).toContain('part 2 of 3');
    expect(done.log).toContain('same');
    expect(done.log).toMatch(/Put on the task: copy\.csv/);
    expect(put).toEqual([{ partId: 'part-1', name: 'copy.csv', text: 'a,b\n' }]);
    expect(readdirSync(join(dir, 'runs'))).toEqual([]);
  });

  it('leaves out of the task what is not a plain file, a named pipe too, without waiting on it', async () => {
    const { files, put } = taskFiles();
    const done = await runTests(work({ command: 'mkfifo "$HH_OUT/pipe"; mkdir "$HH_OUT/sub"; echo made > "$HH_OUT/made.txt"' }), { dir: nodeDir(), user: null, hidden: [], files });
    expect(done).toMatchObject({ ok: true });
    expect(put).toEqual([{ partId: 'part-1', name: 'made.txt', text: 'made\n' }]);
    expect(done.log).toMatch(/left out: pipe, sub/);
  });

  it('puts nothing on the task when the command put something else in place of its output folder', async () => {
    const elsewhere = nodeDir();
    writeFileSync(join(elsewhere, 'secret.txt'), 'not yours\n');
    const { files, put } = taskFiles();
    const done = await runTests(work({ command: `rmdir "$HH_OUT"; ln -s ${elsewhere} "$HH_OUT"` }), { dir: nodeDir(), user: null, hidden: [], files });
    expect(put).toEqual([]);
    expect(done.log).toMatch(/output folder is no longer the part's own/);
  });

  it("stops waiting for a task's file when the part is stopped or its time is up, and removes its folder", async () => {
    const dir = nodeDir();
    const stop = new AbortController(), asked = stalledWaits;
    const stopping = runTests(work({ files: ['data.csv'], command: 'echo RAN' }), { dir, user: null, hidden: [], files: stalled, signal: stop.signal });
    await eventually(() => stalledWaits > asked);
    stop.abort();
    const stopped = await stopping;
    expect(stopped).toMatchObject({ ok: false, error: 'cancelled' });
    expect(stopped.log).not.toContain('RAN');
    fakeClock();
    const waited = stalledWaits;
    let ended = false;
    const waiting = runTests(work({ files: ['data.csv'], command: 'echo RAN', timeoutMs: 300 }), { dir, user: null, hidden: [], files: stalled }).finally(() => { ended = true; });
    await eventually(() => stalledWaits > waited);
    await vi.advanceTimersByTimeAsync(299);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const late = await waiting;
    expect(late).toMatchObject({ ok: false, error: 'timeout' });
    expect(readdirSync(join(dir, 'runs'))).toEqual([]);
  });

  it('stops putting what it made on the task when the part is stopped meanwhile', async () => {
    const dir = nodeDir();
    const stop = new AbortController(), asked = stalledWaits;
    const done = runTests(work({ command: 'echo made > "$HH_OUT/a.txt"; echo made > "$HH_OUT/b.txt"' }), { dir, user: null, hidden: [], files: stalled, signal: stop.signal });
    await eventually(() => stalledWaits > asked);
    stop.abort();
    const result = await done;
    expect(result.log).toMatch(/Stopped before a\.txt went on the task\./);
    expect(result.log).not.toMatch(/Put on the task|b\.txt (went|could)/);
    expect(readdirSync(join(dir, 'runs'))).toEqual([]);
  });

  it("keeps the part's folder the node's, and gives its user only the folders inside it", () => {
    const root = '/n/runs/part-1';
    expect(partFolders(root, work())).toEqual({ own: root, user: ['home', 'tmp', 'out', 'work'].map(f => join(root, f)) });
    expect(partFolders(root, work({ repo: { url: 'https://x/y.git', token: '' } }))).toEqual({ own: root, user: ['home', 'tmp', 'out', 'in', 'repo'].map(f => join(root, f)) });
    expect(partFolders(root, work({ kind: undefined, repo: { url: 'https://x/y.git', token: '' } }))).toEqual({ own: root, user: ['home', 'tmp', 'repo'].map(f => join(root, f)) });
  });

  it("puts nothing on the task from an output folder its user does not own", async () => {
    const folder = nodeDir();
    writeFileSync(join(folder, 'made.txt'), 'made\n');
    const { files, put } = taskFiles();
    const lines: string[] = [];
    const me = { uid: process.getuid!(), gid: process.getgid!() };
    await putOutputs(work(), folder, { ...me, uid: me.uid + 1 }, files, { line: (l: string) => void lines.push(l) } as never, new AbortController().signal);
    expect(put).toEqual([]);
    expect(lines.join('\n')).toMatch(/output folder is no longer the part's own/);
    await putOutputs(work(), folder, me, files, { line: (l: string) => void lines.push(l) } as never, new AbortController().signal);
    expect(put).toEqual([{ partId: 'part-1', name: 'made.txt', text: 'made\n' }]);
  });

  it("clones a branch first when it has one, with the task's files beside it", async () => {
    const { url, commits } = origin();
    const { files, put } = taskFiles({ 'data.csv': 'x\n' });
    const done = await runTests(work({ repo: { url, token: '' }, branch: 'task-12-checkout', files: ['data.csv'], command: 'cat marker.txt; cat "$HH_IN/data.csv"; ls' }), { dir: nodeDir(), user: null, hidden: [], files });
    expect(done).toMatchObject({ ok: true, commit: commits['task-12-checkout'] });
    expect(done.log).toContain('task-12-checkout\nx\n');
    expect(done.log).not.toMatch(/^data\.csv$/m);
    expect(put).toEqual([]);
  });

  it("fails without running the command when a task file cannot be fetched", async () => {
    const dir = nodeDir();
    const { files } = taskFiles();
    const done = await runTests(work({ files: ['gone.csv'], command: 'echo RAN' }), { dir, user: null, hidden: [], files });
    expect(done).toMatchObject({ ok: false, error: 'files_failed', exitCode: null });
    expect(done.log).toContain('gone.csv');
    expect(done.log).not.toContain('RAN');
    expect(readdirSync(join(dir, 'runs'))).toEqual([]);
  });

  it('puts only plain files from the output folder, at most the most a part may, also when the command failed', async () => {
    const secret = join(mkdtempSync(join(tmpdir(), 'hh-secret-')), 'key');
    writeFileSync(secret, 'node-key-1234567890');
    const { files, put } = taskFiles();
    const many = Array.from({ length: MAX_RUN_FILES + 2 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    const command = `cd "$HH_OUT"; for f in ${many.join(' ')}; do echo $f > $f; done; ln -s ${secret} key; mkdir sub; echo x > sub/y; exit 4`;
    const done = await runTests(work({ command }), { dir: nodeDir(), user: null, hidden: [], files });
    expect(done).toMatchObject({ ok: false, error: 'failed', exitCode: 4 });
    expect(put.map(p => p.name)).toEqual(many.slice(0, MAX_RUN_FILES));
    expect(put.some(p => p.text.includes('node-key'))).toBe(false);
    expect(done.log).toMatch(new RegExp(`left out: ${many[MAX_RUN_FILES]}, ${many[MAX_RUN_FILES + 1]}, key, sub`));
  });

  it('says which file could not go on the task, and goes on with the others', async () => {
    const files: PartFiles = {
      get: async () => Buffer.alloc(0),
      put: async (_partId, name) => {
        if (name === 'a.txt') throw new Error('Hornhoof answered 413: Task 12 holds too many files.');
      },
    };
    const done = await runTests(work({ command: 'echo a > "$HH_OUT/a.txt"; echo b > "$HH_OUT/b.txt"' }), { dir: nodeDir(), user: null, hidden: [], files });
    expect(done.ok).toBe(true);
    expect(done.log).toMatch(/a\.txt could not go on the task: Hornhoof answered 413/);
    expect(done.log).toMatch(/Put on the task: b\.txt/);
  });
});

describe("a part's files through Hornhoof", () => {
  it("fetches and puts them at the part's address with the node's key, and gives Hornhoof's reason when it refuses", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization} ${Buffer.concat(chunks).toString('utf8')}`);
        if (req.url?.endsWith('/gone.csv')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { code: 'not_found', message: 'Task 12 has no file gone.csv.' } }));
        }
        res.writeHead(req.method === 'PUT' ? 201 : 200);
        res.end(req.method === 'GET' ? 'a,b\n' : '{}');
      });
    });
    await listenIn(server);
    onTestFinished(() => void server.close());
    const files = partFiles(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'node-key-1234567890');
    expect((await files.get('part-1', 'data 1.csv')).toString('utf8')).toBe('a,b\n');
    await files.put('part-1', 'out.txt', Buffer.from('made'));
    await expect(files.get('part-1', 'gone.csv')).rejects.toThrow('Hornhoof answered 404: Task 12 has no file gone.csv.');
    expect(seen.slice(0, 2)).toEqual(['GET /api/parts/part-1/files/data%201.csv Bearer node-key-1234567890 ', 'PUT /api/parts/part-1/files/out.txt Bearer node-key-1234567890 made']);
  });

  it("gives up on a file Hornhoof is slow to answer or to send once the part's signal ends", async () => {
    /* The part's signal ends once Hornhoof has the ask and leaves it unanswered, or has sent half the file. */
    const stops = new Map(['silent.csv', 'half.csv', 'out.txt'].map(name => [name, new AbortController()]));
    const stop = (url: string | undefined) => stops.get(decodeURIComponent(url?.split('/').at(-1) ?? ''))!.abort();
    const server = createServer((req, res) => {
      if (!req.url?.endsWith('/half.csv')) return stop(req.url);
      res.writeHead(200);
      res.write('a,', () => { stop(req.url); });
    });
    await listenIn(server);
    onTestFinished(() => {
      server.closeAllConnections();
      server.close();
    });
    const files = partFiles(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'node-key-1234567890');
    await expect(files.get('part-1', 'silent.csv', stops.get('silent.csv')!.signal)).rejects.toThrow();
    await expect(files.get('part-1', 'half.csv', stops.get('half.csv')!.signal)).rejects.toThrow();
    await expect(files.put('part-1', 'out.txt', Buffer.from('made'), stops.get('out.txt')!.signal)).rejects.toThrow();
  });
});

describe("the shared folders after a part", () => {
  it("removes what the part's user left where every user writes, without following links, and nothing of others", () => {
    const shared = nodeDir();
    const elsewhere = nodeDir();
    writeFileSync(join(elsewhere, 'keep.txt'), 'keep\n');
    writeFileSync(join(shared, 'left.txt'), 'secret\n');
    mkdirSync(join(shared, 'cache'));
    writeFileSync(join(shared, 'cache', 'blob'), 'x');
    symlinkSync(elsewhere, join(shared, 'link'));
    const me = process.getuid!();

    clearShared(me + 1, [shared]);
    expect(readdirSync(shared).sort()).toEqual(['cache', 'left.txt', 'link']);

    clearShared(me, [shared, join(shared, 'missing')]);
    expect(readdirSync(shared)).toEqual([]);
    expect(existsSync(shared)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual(['keep.txt']);
  });
});

it('uses the scoped mirror for repeated pinned manual runs and leaves no alternate object store', async () => {
  const source = origin(), commits = source.commits, dir = nodeDir();
  const { pathToFileURL } = await import('node:url');
  const url = pathToFileURL(source.url).href;
  const { createHash } = await import('node:crypto');
  const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(url).digest('hex') };
  const msg = run(url, { commitSha: commits['task-12-checkout'], repositoryScope, command: 'test ! -e .git/objects/info/alternates && cat marker.txt' });
  expect(await runTests(msg, { dir, user: null, hidden: [] })).toMatchObject({ ok: true, commit: commits['task-12-checkout'] });
  expect(existsSync(join(dir, 'cache', repositoryScope.companyId, repositoryScope.repositoryOwnerId, repositoryScope.repoUrlHash, 'mirror.git', 'objects'))).toBe(true);
  expect(await runTests({ ...msg, partId: 'part-2' }, { dir, user: null, hidden: [] })).toMatchObject({ ok: true });
});
