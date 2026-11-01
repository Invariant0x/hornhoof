import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_LOG_BYTES, type ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { runTests } from '../src/tests.js';

type TestRun = Extract<ServerMessage, { type: 'tests.run' }>;

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
  type: 'tests.run', partId: 'part-1', repo: { url, token: '' }, branch: 'task-12-checkout', task: 12, command: 'cat marker.txt', part: 1, parts: 1, timeoutMs: 60_000, ...over,
});

describe('a part of a test run on a node', () => {
  it('clones the branch into a fresh folder, runs the command there and removes the folder', async () => {
    const { url, commits } = origin();
    const dir = nodeDir();
    const done = await runTests(run(url, { command: 'cat marker.txt; ls -a ..' }), { dir, user: null, hidden: [] });
    expect(done).toMatchObject({ type: 'tests.done', partId: 'part-1', ok: true, exitCode: 0, error: null, commit: commits['task-12-checkout'] });
    expect(done.log).toContain('task-12-checkout\n');
    expect(readdirSync(join(dir, 'tests'))).toEqual([]);
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
    const started = Date.now();
    const done = await runTests(run(url, { command: 'sleep 30 & sleep 30; wait', timeoutMs: 1500 }), { dir, user: null, hidden: [] });
    expect(done).toMatchObject({ ok: false, error: 'timeout', exitCode: null });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(done.log).toMatch(/did not finish within 1 s|did not finish within 2 s/);
    expect(readdirSync(join(dir, 'tests'))).toEqual([]);
  });

  it('stops when Hornhoof calls it off', async () => {
    const { url } = origin();
    const stop = new AbortController();
    const done = runTests(run(url, { command: 'echo going; sleep 30' }), { dir: nodeDir(), user: null, hidden: [], signal: stop.signal });
    await new Promise(r => setTimeout(r, 1500));
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
    expect(existsSync(join(dir, 'tests', 'part-1'))).toBe(false);
  });
});
