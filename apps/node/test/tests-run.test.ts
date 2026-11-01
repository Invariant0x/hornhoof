import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { MAX_RUN_FILES, TEST_LOG_BYTES, type ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { partFiles, partFolders, putOutputs, runTests, type PartFiles } from '../src/tests.js';

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

/* Task files that never come and never go, until the part's signal ends the wait. */
const stalled: PartFiles = {
  get: (_partId, _name, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
  put: (_partId, _name, _bytes, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
};

describe('a part of other work on a node', () => {
  const work = (over: Partial<TestRun> = {}): TestRun => ({
    type: 'tests.run', kind: 'work', partId: 'part-1', repo: null, branch: null, task: 12, command: 'true', part: 1, parts: 1, timeoutMs: 60_000, ...over,
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
    expect(readdirSync(join(dir, 'tests'))).toEqual([]);
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
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const stopped = await runTests(work({ files: ['data.csv'], command: 'echo RAN' }), { dir, user: null, hidden: [], files: stalled, signal: stop.signal });
    expect(stopped).toMatchObject({ ok: false, error: 'cancelled' });
    expect(stopped.log).not.toContain('RAN');
    const late = await runTests(work({ files: ['data.csv'], command: 'echo RAN', timeoutMs: 300 }), { dir, user: null, hidden: [], files: stalled });
    expect(late).toMatchObject({ ok: false, error: 'timeout' });
    expect(readdirSync(join(dir, 'tests'))).toEqual([]);
  });

  it('stops putting what it made on the task when the part is stopped meanwhile', async () => {
    const dir = nodeDir();
    const stop = new AbortController();
    const done = runTests(work({ command: 'echo made > "$HH_OUT/a.txt"; echo made > "$HH_OUT/b.txt"' }), { dir, user: null, hidden: [], files: stalled, signal: stop.signal });
    setTimeout(() => stop.abort(), 500);
    const result = await done;
    expect(result.log).toMatch(/Stopped before a\.txt went on the task\./);
    expect(result.log).not.toMatch(/Put on the task|b\.txt (went|could)/);
    expect(readdirSync(join(dir, 'tests'))).toEqual([]);
  });

  it("keeps the part's folder the node's, and gives its user only the folders inside it", () => {
    const root = '/n/tests/part-1';
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
    await putOutputs(work(), folder, { ...me, uid: me.uid + 1 }, files, { line: (l: string) => void lines.push(l) } as never, AbortSignal.timeout(5000));
    expect(put).toEqual([]);
    expect(lines.join('\n')).toMatch(/output folder is no longer the part's own/);
    await putOutputs(work(), folder, me, files, { line: (l: string) => void lines.push(l) } as never, AbortSignal.timeout(5000));
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
    expect(readdirSync(join(dir, 'tests'))).toEqual([]);
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
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    onTestFinished(() => void server.close());
    const files = partFiles(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'node-key-1234567890');
    expect((await files.get('part-1', 'data 1.csv')).toString('utf8')).toBe('a,b\n');
    await files.put('part-1', 'out.txt', Buffer.from('made'));
    await expect(files.get('part-1', 'gone.csv')).rejects.toThrow('Hornhoof answered 404: Task 12 has no file gone.csv.');
    expect(seen.slice(0, 2)).toEqual(['GET /api/parts/part-1/files/data%201.csv Bearer node-key-1234567890 ', 'PUT /api/parts/part-1/files/out.txt Bearer node-key-1234567890 made']);
  });

  it("gives up on a file Hornhoof is slow to answer or to send once the part's signal ends", async () => {
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/half.csv')) {
        res.writeHead(200);
        res.write('a,');
      }
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    onTestFinished(() => {
      server.closeAllConnections();
      server.close();
    });
    const files = partFiles(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'node-key-1234567890');
    await expect(files.get('part-1', 'silent.csv', AbortSignal.timeout(100))).rejects.toThrow();
    await expect(files.get('part-1', 'half.csv', AbortSignal.timeout(100))).rejects.toThrow();
    await expect(files.put('part-1', 'out.txt', Buffer.from('made'), AbortSignal.timeout(100))).rejects.toThrow();
  });
});
