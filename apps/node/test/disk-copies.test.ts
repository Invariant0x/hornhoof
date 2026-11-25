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

  it('removes release-check worktrees, detached task worktrees, and standalone task clones of finished and cancelled tasks, while keeping open, paused, blocked, and unpushed ones and listing the largest remaining copies', async () => {
    const { dir, clone, copy } = node();
    const a = clone('agent-a', 'shop');
    const b = clone('agent-b', 'shop');
    /* Closed tasks: finished #7 on release-check-7, cancelled #8 on detached HEAD at shop-8, and standalone clone shop-9 on task-9. */
    const releaseDone = copy(a, 'release-7', 'release-check-7');
    const detachedCancelled = join(a, '..', 'shop-8');
    git(a, 'worktree', 'add', '-q', '--detach', detachedCancelled, 'origin/main');
    fill(join(detachedCancelled, 'node_modules', 'pkg', 'index.js'), 256 * 1024);
    const standaloneDone = clone('agent-b', 'shop-9');
    git(standaloneDone, 'checkout', '-q', '-b', 'task-9');
    writeFileSync(join(standaloneDone, 'nine.txt'), 'done\n');
    git(standaloneDone, 'add', '.');
    git(standaloneDone, 'commit', '-q', '-m', 'task-9');
    git(standaloneDone, 'push', '-q', 'origin', 'task-9');
    fill(join(standaloneDone, 'node_modules', 'pkg', 'index.js'), 256 * 1024);

    /* Protected copies: #10 open (biggest), #11 paused, #12 blocked, closed #13 with an unpushed commit, and a primary clone of a repo literally named app-6 checked out on task-6. */
    const openBig = copy(a, 'shop-10', 'task-10');
    fill(join(openBig, 'node_modules', 'big', 'bundle.js'), 768 * 1024);
    const pausedCopy = copy(b, 'shop-11', 'task-11');
    fill(join(pausedCopy, 'node_modules', 'med', 'bundle.js'), 384 * 1024);
    const blockedCopy = copy(b, 'shop-12', 'release-check-12');
    const unpushedClosed = copy(a, 'shop-13', 'task-13', { push: false });
    const app6Origin = join(dir, 'app-6.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', app6Origin);
    const app6Primary = join(dir, 'work', 'agents', 'agent-c', 'app-6');
    mkdirSync(join(dir, 'work', 'agents', 'agent-c'), { recursive: true });
    git(dir, 'clone', '-q', app6Origin, app6Primary);
    writeFileSync(join(app6Primary, 'README.md'), 'app-6\n');
    git(app6Primary, 'add', '.');
    git(app6Primary, 'commit', '-q', '-m', 'init');
    git(app6Primary, 'push', '-q', 'origin', 'HEAD:main');
    git(app6Primary, 'checkout', '-q', '-b', 'task-6');
    git(app6Primary, 'push', '-q', 'origin', 'task-6');

    const copies = workingCopies({ dir, git: agentGit(dir, OWNER), tasks: () => closedUpTo(15, [10, 11, 12]) }) as ReturnType<typeof workingCopies> & {
      copies?: () => { agent: string; path: string; task: number | null; bytes: number }[];
    };
    const freed = await copies.clean();
    expect(freed).toBeGreaterThanOrEqual(3 * 256 * 1024);
    expect(existsSync(releaseDone)).toBe(false);
    expect(existsSync(detachedCancelled)).toBe(false);
    expect(existsSync(standaloneDone)).toBe(false);
    expect(existsSync(join(openBig, 'node_modules', 'big', 'bundle.js'))).toBe(true);
    expect(existsSync(join(pausedCopy, 'node_modules', 'med', 'bundle.js'))).toBe(true);
    expect(existsSync(join(blockedCopy, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(existsSync(unpushedClosed)).toBe(true);
    expect(existsSync(join(app6Primary, '.git'))).toBe(true);

    const listed = copies.copies?.() ?? [];
    expect(listed.length).toBeGreaterThanOrEqual(4);
    expect(listed[0]).toMatchObject({ agent: 'agent-a', path: 'shop-10', task: 10 });
    expect(listed[1]).toMatchObject({ agent: 'agent-b', path: 'shop-11', task: 11 });
    expect(listed.map(c => c.bytes)).toEqual([...listed.map(c => c.bytes)].sort((x, y) => y - x));
  });
});
