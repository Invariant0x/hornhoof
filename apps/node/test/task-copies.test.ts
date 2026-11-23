import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it, vi } from 'vitest';
import { runJob, type ProviderAdapter } from '../src/runner.js';
import { agentGit, closedCopies, removeClosedCopies } from '../src/task-copies.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

const OWNER = { user: null, home: null };

/* An agent's folder with its clone of a repository whose origin is a bare repository next to it, as the node leaves it. */
function agentFolder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hh-copies-')));
  const origin = join(root, 'origin.git'), agent = join(root, 'agent'), clone = join(agent, 'shop');
  mkdirSync(agent);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, clone);
  git(clone, 'commit', '-q', '--allow-empty', '-m', 'start');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  /* A task's copy on its branch task-<n>, with one commit of its own, pushed unless told otherwise. */
  const copy = (folder: string, branch: string, { push = true } = {}) => {
    const path = join(agent, folder);
    git(clone, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main');
    writeFileSync(join(path, `${branch}.txt`), 'work\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', branch);
    if (push) git(path, 'push', '-q', 'origin', branch);
    return path;
  };
  const trees = () => git(clone, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length));
  return { root, agent, clone, copy, trees };
}

describe("the worktrees of an agent's closed tasks", () => {
  it('removes the copy of a closed task that is clean and pushed, and the repository forgets it', async () => {
    const { agent, clone, copy, trees } = agentFolder();
    const done = copy('shop-7', 'task-7');
    /* Its dependencies, which git ignores, go with it. */
    writeFileSync(join(clone, '.git', 'info', 'exclude'), 'node_modules/\n');
    mkdirSync(join(done, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(done, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    const lines = await removeClosedCopies(clone, agent, { open: [], upTo: 7 }, OWNER);
    expect(existsSync(done)).toBe(false);
    expect(trees()).toEqual([clone]);
    expect(lines).toEqual([`Removed the worktree of closed task #7 at ${done}.`]);
  });

  it('keeps the copy of a closed task with a file that is not committed, and says why', async () => {
    const { agent, clone, copy, trees } = agentFolder();
    const dirty = copy('shop-8', 'task-8');
    writeFileSync(join(dirty, 'notes.md'), 'half done\n');
    const lines = await removeClosedCopies(clone, agent, { open: [], upTo: 8 }, OWNER);
    expect(existsSync(join(dirty, 'notes.md'))).toBe(true);
    expect(trees()).toEqual([clone, dirty]);
    expect(lines).toEqual([`Kept the worktree of closed task #8 at ${dirty}: it has changes that are not committed.`]);
  });

  it('removes the copy of a closed task whose ignored files all come back by themselves: dependencies, builds, caches, test output', async () => {
    const { agent, clone, copy } = agentFolder();
    const done = copy('shop-14', 'task-14');
    writeFileSync(join(clone, '.git', 'info', 'exclude'), 'node_modules/\ndist/\n.cache/\n*.tsbuildinfo\napps/web/e2e/results/\n');
    for (const folder of ['node_modules/left-pad', 'packages/web/dist', '.cache/vite', 'apps/web/e2e/results/run-1']) {
      mkdirSync(join(done, folder), { recursive: true });
      writeFileSync(join(done, folder, 'x'), 'x\n');
    }
    writeFileSync(join(done, 'tsconfig.tsbuildinfo'), '{}\n');
    const lines = await removeClosedCopies(clone, agent, { open: [], upTo: 14 }, OWNER);
    expect(existsSync(done)).toBe(false);
    expect(lines).toEqual([`Removed the worktree of closed task #14 at ${done}.`]);
  });

  it('keeps the copy of a closed task that holds an ignored file that comes back from nowhere, and names it', async () => {
    const { agent, clone, copy, trees } = agentFolder();
    const done = copy('shop-15', 'task-15');
    writeFileSync(join(clone, '.git', 'info', 'exclude'), 'node_modules/\n.env\nlocal/\n');
    writeFileSync(join(done, '.env'), 'KEY=made-up\n');
    mkdirSync(join(done, 'local'));
    writeFileSync(join(done, 'local', 'data.db'), 'rows\n');
    mkdirSync(join(done, 'node_modules'));
    const lines = await removeClosedCopies(clone, agent, { open: [], upTo: 15 }, OWNER);
    expect(existsSync(join(done, '.env'))).toBe(true);
    expect(trees()).toEqual([clone, done]);
    expect(lines).toEqual([`Kept the worktree of closed task #15 at ${done}: it holds what git ignores and no remote has: .env, local/.`]);
  });

  it('keeps the copy if an ignored file that comes back from nowhere appears while its size is being measured', async () => {
    const { agent, clone, copy, trees } = agentFolder();
    const done = copy('shop-16', 'task-16');
    writeFileSync(join(clone, '.git', 'info', 'exclude'), '.env\n');
    const run = agentGit(agent, OWNER)!;
    const { copies } = await closedCopies(clone, agent, { open: [], upTo: 16 }, run, async path => {
      writeFileSync(join(path, '.env'), 'KEY=late\n');
    });
    expect(existsSync(join(done, '.env'))).toBe(true);
    expect(trees()).toEqual([clone, done]);
    expect(copies).toEqual([
      { path: done, task: 16, removed: false, why: 'ignored', reason: 'it holds what git ignores and no remote has: .env', ignored: ['.env'] },
    ]);
  });

  it('keeps the copy of a closed task with a commit that is not on the remote, and says why', async () => {
    const { agent, clone, copy, trees } = agentFolder();
    const unpushed = copy('t9', 'task-9-docs', { push: false });
    const lines = await removeClosedCopies(clone, agent, { open: [], upTo: 9 }, OWNER);
    expect(existsSync(unpushed)).toBe(true);
    expect(trees()).toEqual([clone, unpushed]);
    expect(lines).toEqual([`Kept the worktree of closed task #9 at ${unpushed}: 1 commit of it is not on the remote.`]);
  });

  it('keeps the copy of an open task, of a task it does not know yet, and every other worktree, whatever their age', async () => {
    const { root, agent, clone, copy, trees } = agentFolder();
    const open = copy('shop-10', 'task-10');
    const later = copy('shop-12', 'task-12');
    const own = copy('scratch', 'spike');
    const outside = join(root, 'elsewhere');
    git(clone, 'worktree', 'add', '-q', '-b', 'task-11', outside, 'origin/main');
    git(clone, 'push', '-q', 'origin', 'task-11');
    const lines = await removeClosedCopies(clone, agent, { open: [10], upTo: 11 }, OWNER);
    expect(trees().sort()).toEqual([clone, open, later, own, outside].sort());
    expect(lines).toEqual([]);
  });

  it("runs no git in the agent's folder as root, whose settings could run programs of the agent's", async () => {
    const { agent, clone, copy, trees } = agentFolder();
    const done = copy('shop-6', 'task-6');
    const asked: string[][] = [];
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      const lines = await removeClosedCopies(clone, agent, { open: [], upTo: 6 }, OWNER, async args => { asked.push(args); return ''; });
      expect(lines).toEqual(["The worktrees of closed tasks stay: git would run in the agent's folder as root."]);
    } finally {
      vi.restoreAllMocks();
    }
    expect(asked).toEqual([]);
    expect(trees()).toEqual([clone, done]);
  });

  it('removes a merged copy whose branch was never pushed by itself', async () => {
    const { agent, clone, copy, trees } = agentFolder();
    const merged = copy('shop-3', 'task-3', { push: false });
    git(merged, 'push', '-q', 'origin', 'HEAD:main');
    await removeClosedCopies(clone, agent, { open: [], upTo: 3 }, OWNER);
    expect(trees()).toEqual([clone]);
  });
});

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
const AGENT = '7d3c2a10-0000-4000-8000-000000000001';

describe("an agent's turn", () => {
  it('starts after the copies of closed tasks have gone, and the node log says what went', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hh-copies-turn-')));
    const agent = join(root, 'work', 'agents', AGENT), clone = join(agent, 'shop'), origin = join(root, 'origin.git');
    mkdirSync(agent, { recursive: true });
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, clone);
    git(clone, 'commit', '-q', '--allow-empty', '-m', 'start');
    git(clone, 'push', '-q', 'origin', 'HEAD:main');
    const closed = join(agent, 'shop-4'), open = join(agent, 'shop-5');
    git(clone, 'worktree', 'add', '-q', '-b', 'task-4', closed, 'origin/main');
    git(clone, 'push', '-q', 'origin', 'task-4');
    git(clone, 'worktree', 'add', '-q', '-b', 'task-5', open, 'origin/main');
    const seen: boolean[] = [];
    const adapter: ProviderAdapter = {
      install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [],
      run: async () => { seen.push(existsSync(closed), existsSync(open)); return { ok: true, sessionId: 's', result: '', output: '', error: null, limits: null }; },
    };
    const lines: string[] = [];
    const msg: JobRun = {
      type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 60_000, secret: null, instructions: null, toolToken: null,
      workspace: { key: AGENT, repo: { url: 'https://github.com/acme/shop.git', branch: 'main', token: '' }, tasks: { open: [5], upTo: 5 } },
    };
    const done = await runJob(adapter, msg, root, { prepareRepoBrowser: async () => {}, log: line => lines.push(line) });
    expect(done.ok).toBe(true);
    expect(seen).toEqual([false, true]);
    expect(lines).toEqual([`Removed the worktree of closed task #4 at ${closed}.`]);
  });
});
