import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskStates } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { workingCopies } from '../src/disk/copies.js';
import { agentGit } from '../src/task-copies.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fill = (path: string, bytes: number) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
};

/* A node's folder, its agents' folders under work/agents, and a bare origin for their clones. */
function node() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-disk-copies-')));
  roots.push(dir);
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(dir, 'seed');
  git(dir, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'start');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  /* An agent's clone, in its folder. */
  const clone = (agent: string, folder: string) => {
    const agentDir = join(dir, 'work', 'agents', agent);
    mkdirSync(agentDir, { recursive: true });
    const path = join(agentDir, folder);
    git(agentDir, 'clone', '-q', origin, path);
    return path;
  };
  /* A task's worktree of a clone on task-<n>, with a commit of its own and installed dependencies, pushed unless told. */
  const copy = (clonePath: string, folder: string, branch: string, { push = true } = {}) => {
    const path = join(clonePath, '..', folder);
    git(clonePath, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main');
    writeFileSync(join(path, `${branch}.txt`), 'work\n');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', branch);
    if (push) git(path, 'push', '-q', 'origin', branch);
    fill(join(path, 'node_modules', 'left-pad', 'index.js'), 256 * 1024);
    return path;
  };
  return { dir, clone, copy };
}

const OWNER = { user: null, home: null };
const closedUpTo = (upTo: number, open: number[] = []): TaskStates => ({ open, upTo });

describe("the working copies of an agent's finished tasks, in a node's disk care", () => {
  it('go once they are clean and pushed, in every clone of every agent, and the bytes they took count', async () => {
    const { dir, clone, copy } = node();
    const a = clone('agent-a', 'shop'), b = clone('agent-a', 'shop-again'), c = clone('agent-b', 'shop');
    const done = [copy(a, 'shop-7', 'task-7'), copy(b, 'shop-8', 'task-8'), copy(c, 'shop-9', 'task-9')];
    const copies = workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => closedUpTo(9) });
    const freed = await copies.clean();
    for (const path of done) expect(existsSync(path)).toBe(false);
    for (const path of [a, b, c]) expect(existsSync(join(path, '.git'))).toBe(true);
    expect(freed).toBeGreaterThanOrEqual(3 * 256 * 1024);
    expect(copies.kept()).toEqual([]);
  });

  it('keeps one with a change not committed, without its dependencies, and names it for the card', async () => {
    const { dir, clone, copy } = node();
    const shop = clone('agent-a', 'shop');
    const busy = copy(shop, 'shop-7', 'task-7');
    writeFileSync(join(busy, 'task-7.txt'), 'work\nmore, not committed\n');
    const copies = workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => closedUpTo(7) });
    expect(await copies.clean()).toBeGreaterThanOrEqual(256 * 1024);
    expect(readFileSync(join(busy, 'task-7.txt'), 'utf8')).toBe('work\nmore, not committed\n');
    expect(existsSync(join(busy, 'node_modules'))).toBe(false);
    expect(copies.kept()).toEqual([{ agent: 'agent-a', path: 'shop-7', task: 7, bytes: expect.any(Number), why: 'uncommitted' }]);
  });

  it('keeps one with a commit on no remote, the commit with it', async () => {
    const { dir, clone, copy } = node();
    const shop = clone('agent-a', 'shop');
    const ahead = copy(shop, 'shop-7', 'task-7', { push: false });
    const copies = workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => closedUpTo(7) });
    await copies.clean();
    expect(git(ahead, 'log', '-1', '--format=%s').trim()).toBe('task-7');
    expect(copies.kept()).toEqual([{ agent: 'agent-a', path: 'shop-7', task: 7, bytes: expect.any(Number), why: 'unpushed' }]);
  });

  it('keeps a pushed one that holds an ignored file no remote has, without its dependencies, and names that file for the card', async () => {
    const { dir, clone, copy } = node();
    const shop = clone('agent-a', 'shop');
    const done = copy(shop, 'shop-7', 'task-7');
    writeFileSync(join(shop, '.git', 'info', 'exclude'), '.env\n');
    writeFileSync(join(done, '.env'), 'KEY=made-up\n');
    const copies = workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => closedUpTo(7) });
    expect(await copies.clean()).toBeGreaterThanOrEqual(256 * 1024);
    expect(readFileSync(join(done, '.env'), 'utf8')).toBe('KEY=made-up\n');
    expect(existsSync(join(done, 'node_modules'))).toBe(false);
    expect(copies.kept()).toEqual([{ agent: 'agent-a', path: 'shop-7', task: 7, bytes: expect.any(Number), why: 'ignored', ignored: ['.env'] }]);
  });

  it('leaves an open task and its dependencies alone', async () => {
    const { dir, clone, copy } = node();
    const open = copy(clone('agent-a', 'shop'), 'shop-7', 'task-7');
    const copies = workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => closedUpTo(9, [7]) });
    expect(await copies.clean()).toBe(0);
    expect(existsSync(join(open, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('removes nothing before it knows which tasks are open, or where git would run as root', async () => {
    const { dir, clone, copy } = node();
    const done = copy(clone('agent-a', 'shop'), 'shop-7', 'task-7');
    expect(await workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => null }).clean()).toBe(0);
    expect(await workingCopies({ dir, git: null, tasks: () => closedUpTo(7) }).clean()).toBe(0);
    expect(existsSync(done)).toBe(true);
  });

  it('never follows an agent folder that is a link', async () => {
    const { dir, clone, copy } = node();
    const outside = clone('agent-a', 'shop');
    const done = copy(outside, 'shop-7', 'task-7');
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'hh-disk-elsewhere-')));
    roots.push(elsewhere);
    const moved = join(elsewhere, 'agent-a');
    execFileSync('mv', [join(dir, 'work', 'agents', 'agent-a'), moved]);
    git(join(moved, 'shop'), 'worktree', 'repair', join(moved, 'shop-7'));
    symlinkSync(moved, join(dir, 'work', 'agents', 'agent-a'));
    const copies = workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => closedUpTo(7) });
    expect(await copies.clean()).toBe(0);
    expect(existsSync(join(moved, 'shop-7', 'task-7.txt'))).toBe(true);
    expect(done).toContain('agent-a');
  });
});
