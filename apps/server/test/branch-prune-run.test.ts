import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { pushRefs, type Push } from '../src/modules/repos/ref-push.js';
import type { Facts, Holds } from '../src/modules/repos/prune-plan.js';
import { archiveRef, pruneRepository, restoreBranch, restoreCommand, type Deps, type Entry } from '../src/modules/repos/prune-run.js';
import { GitHubRateLimited } from '../src/modules/testruns/github-limit.js';
import { git, headOf, host, origin } from './git-origin.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 12);
const refOf = (dir: string, ref: string): string | null => {
  try { return git(dir, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; }
};

/* Git's own answer to whether a commit is under another, as the repository would say it. */
const holdsIn = (dir: string): Holds => async (holder, head) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', head, holder], { cwd: dir }); return true; } catch { return false; }
};

/* The facts of a bare repository, with what Hornhoof's records say of its tasks. */
function factsOf(dir: string, tasks: Facts['tasks']): Facts {
  const heads: Record<string, string> = {};
  for (const line of git(dir, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads').split('\n')) {
    const [name, sha] = line.split(' ');
    heads[name!] = sha!;
  }
  return { main: 'main', heads, tags: {}, tasks, recorded: new Set(), now: NOW };
}

const tasks = (): Facts['tasks'] => new Map([
  [1, { status: 'done', paused: false, closedAt: NOW - 2 * DAY }],
  [2, { status: 'cancelled', paused: false, closedAt: NOW - DAY }],
  [3, { status: 'working', paused: false, closedAt: null }],
  [4, { status: 'cancelled', paused: false, closedAt: NOW - DAY }],
]);

/* main (one commit); task-1 at main's head, whose work main holds; task-2 and task-4 hold work of cancelled tasks that nothing
   holds; task-3 the same for an open task; and a branch of a person's. */
function repository() {
  const { dir, main, other } = origin();
  git(dir, 'branch', 'task-1', main);
  git(dir, 'branch', 'task-2', other);
  git(dir, 'branch', 'task-3', other);
  git(dir, 'branch', 'task-4', other);
  git(dir, 'branch', 'feature/mine', other);
  return { dir, main, other };
}

const recording = () => {
  const entries: Entry[] = [];
  return { entries, record: async (entry: Entry) => void entries.push(entry) };
};

describe('pruning the branches of a repository', () => {
  it('deletes what a turn, main or tag holds, archives what only a closed task holds, and touches nothing else', async () => {
    const { dir, main, other } = repository();
    const { url } = await host(dir);
    const { entries, record } = recording();
    const result = await pruneRepository({ facts: async () => factsOf(dir, tasks()), holds: holdsIn(dir), push: updates => pushRefs({ url, token: '' }, updates), record }, { apply: true });
    expect(result.stopped).toBeNull();
    expect(headOf(dir, 'task-1')).toBeNull();
    for (const archived of ['task-2', 'task-4']) {
      expect(headOf(dir, archived)).toBeNull();
      expect(refOf(dir, archiveRef(archived))).toBe(other);
    }
    expect(headOf(dir, 'task-3')).toBe(other);
    expect(headOf(dir, 'feature/mine')).toBe(other);
    expect(headOf(dir, 'other')).toBe(other);
    expect(headOf(dir, 'main')).toBe(main);
    expect(entries.map(e => [e.branch, e.done])).toEqual([['task-1', 'deleted'], ['task-2', 'archived'], ['task-4', 'archived']]);
    expect(entries[0]).toMatchObject({ head: main, heldBy: 'main', reason: expect.stringContaining('main') as unknown });
    expect(entries[1]).toMatchObject({ head: other, reason: expect.stringContaining('cancelled') as unknown });
  });

  it('changes nothing on a dry run, and says what it would do', async () => {
    const { dir, main } = repository();
    const { url, pushes } = await host(dir);
    const { entries, record } = recording();
    const result = await pruneRepository({ facts: async () => factsOf(dir, tasks()), holds: holdsIn(dir), push: updates => pushRefs({ url, token: '' }, updates), record }, { apply: false });
    expect(pushes).toHaveLength(0);
    expect(entries).toEqual([]);
    expect(result.verdicts.filter(v => v.action !== 'keep').map(v => [v.branch, v.action])).toEqual([['task-1', 'delete'], ['task-2', 'archive'], ['task-4', 'archive']]);
    expect(headOf(dir, 'task-1')).toBe(main);
  });

  it('restores an archived branch at its head with one command, and never over a branch that is there', async () => {
    const { dir, other } = repository();
    const { url } = await host(dir);
    const repo = { url, token: '' };
    await pruneRepository({ facts: async () => factsOf(dir, tasks()), holds: holdsIn(dir), push: updates => pushRefs(repo, updates), record: recording().record }, { apply: true });
    expect(headOf(dir, 'task-2')).toBeNull();
    expect(await restoreBranch(repo, 'task-2', async () => ({ [archiveRef('task-2')]: other }))).toEqual({ restored: other });
    expect(headOf(dir, 'task-2')).toBe(other);
    expect(await restoreBranch(repo, 'task-2', async () => ({ [archiveRef('task-2')]: other }))).toEqual({ problem: expect.stringContaining('task-2') as unknown });
    expect(await restoreBranch(repo, 'task-9', async () => ({}))).toEqual({ problem: expect.stringContaining('no archive') as unknown });
    expect(restoreCommand('task-2')).toBe(`git fetch origin ${archiveRef('task-2')} && git push origin FETCH_HEAD:refs/heads/task-2`);
  });

  it('keeps a branch that moved after it was read, and says so', async () => {
    const { dir, other } = repository();
    const { url } = await host(dir);
    const { entries, record } = recording();
    const result = await pruneRepository({
      facts: async () => {
        const read = factsOf(dir, tasks());
        git(dir, 'update-ref', 'refs/heads/task-1', other);
        return read;
      },
      holds: holdsIn(dir),
      push: updates => pushRefs({ url, token: '' }, updates),
      record,
    }, { apply: true });
    expect(result.entries.find(e => e.branch === 'task-1')).toMatchObject({ done: 'refused' });
    expect(entries.find(e => e.branch === 'task-1')?.problem).toEqual(expect.any(String));
    expect(headOf(dir, 'task-1')).toBe(other);
  });

  it('deletes no branch whose archive it could not make', async () => {
    const { dir, other } = repository();
    const { url } = await host(dir);
    const archiveRefused: Push = async updates => (updates.some(u => u.ref.startsWith('refs/hornhoof/'))
      ? { refs: Object.fromEntries(updates.map(u => [u.ref, 'denied'])) }
      : pushRefs({ url, token: '' }, updates));
    const { entries, record } = recording();
    await pruneRepository({ facts: async () => factsOf(dir, tasks()), holds: holdsIn(dir), push: archiveRefused, record }, { apply: true });
    expect(headOf(dir, 'task-2')).toBe(other);
    expect(headOf(dir, 'task-4')).toBe(other);
    expect(headOf(dir, 'task-1')).toBeNull();
    expect(entries.filter(e => e.done === 'refused').map(e => e.branch)).toEqual(['task-2', 'task-4']);
  });

  it('does a batch of the size asked and says there is more, then the next run does the rest', async () => {
    const { dir } = repository();
    const { url } = await host(dir);
    const deps: Deps = { facts: async () => factsOf(dir, tasks()), holds: holdsIn(dir), push: updates => pushRefs({ url, token: '' }, updates), record: recording().record };
    const first = await pruneRepository(deps, { apply: true, limit: 1 });
    expect(first.entries).toHaveLength(1);
    expect(first.stopped).toEqual({ why: 'batch' });
    const second = await pruneRepository(deps, { apply: true, limit: 5 });
    expect(second.entries.map(e => e.branch)).toEqual(['task-2', 'task-4']);
    expect(second.stopped).toBeNull();
  });

  it('stops where the request limit is used up, having done what it planned before, and says when it ends', async () => {
    const { dir, main } = repository();
    const { url } = await host(dir);
    let asked = 0;
    const holds = holdsIn(dir);
    const limited: Holds = async (holder, head) => {
      if (++asked > 1) throw new GitHubRateLimited({ remaining: 0, resetAt: NOW + 60_000 });
      return holds(holder, head);
    };
    const { entries, record } = recording();
    const result = await pruneRepository({ facts: async () => factsOf(dir, tasks()), holds: limited, push: updates => pushRefs({ url, token: '' }, updates), record }, { apply: true });
    expect(result.stopped).toEqual({ why: 'limit', resetAt: new Date(NOW + 60_000).toISOString() });
    expect(entries.length).toBeLessThan(3);
    expect(headOf(dir, 'main')).toBe(main);
    expect(headOf(dir, 'task-3')).not.toBeNull();
  });

  it('spends no more requests than its budget, keeps the branches it could not tell of, and says the budget was spent', async () => {
    const { dir, main } = repository();
    const { url, pushes } = await host(dir);
    let asked = 0;
    const real = holdsIn(dir);
    const counting: Holds = async (holder, head) => { asked++; return real(holder, head); };
    const deps: Deps = { facts: async () => factsOf(dir, tasks()), holds: counting, push: updates => pushRefs({ url, token: '' }, updates), record: recording().record };
    const none = await pruneRepository(deps, { apply: true, budget: 0 });
    expect(none).toMatchObject({ entries: [], stopped: { why: 'budget' } });
    expect(asked).toBe(0);
    expect(pushes).toHaveLength(0);
    expect(headOf(dir, 'task-1')).toBe(main);
    asked = 0;
    const some = await pruneRepository(deps, { apply: true, budget: 1 });
    expect(asked).toBe(1);
    expect(some.stopped).toEqual({ why: 'budget' });
    asked = 0;
    const enough = await pruneRepository(deps, { apply: true, budget: 100 });
    expect(enough.stopped).toBeNull();
    expect(asked).toBeLessThanOrEqual(100);
    expect(headOf(dir, 'task-2')).toBeNull();
  });

  it('plans only the batch it will change, so a big repository costs few requests a run', async () => {
    const { dir, main } = repository();
    /* Six more branches, each on a commit of its own that main holds already, so each costs a request to plan. */
    const extra = new Map<number, { status: string; paused: boolean; closedAt: number | null }>();
    let tip = main;
    for (let n = 10; n < 16; n++) {
      const commit = git(dir, 'commit-tree', '-p', tip, '-m', `work ${n}`, `${main}^{tree}`);
      git(dir, 'update-ref', `refs/heads/task-${n}`, commit);
      git(dir, 'update-ref', 'refs/heads/main', commit);
      tip = commit;
      extra.set(n, { status: 'done', paused: false, closedAt: NOW - 2 * DAY });
    }
    const { url } = await host(dir);
    let asked = 0;
    const real = holdsIn(dir);
    const counting: Holds = async (holder, head) => { asked++; return real(holder, head); };
    const deps: Deps = { facts: async () => factsOf(dir, new Map([...tasks(), ...extra])), holds: counting, push: updates => pushRefs({ url, token: '' }, updates), record: recording().record };
    await pruneRepository(deps, { apply: false });
    const whole = asked;
    asked = 0;
    const first = await pruneRepository(deps, { apply: true, limit: 1 });
    expect(first.entries).toHaveLength(1);
    /* One more than it changes, to know there is more. */
    expect(first.verdicts.filter(v => v.action !== 'keep')).toHaveLength(2);
    expect(first.stopped).toEqual({ why: 'batch' });
    expect(asked).toBeLessThan(whole);
    expect(asked).toBeLessThanOrEqual(2);
  });

  it('says why a repository it cannot read is left as it is', async () => {
    const { entries, record } = recording();
    const pushed: string[] = [];
    const result = await pruneRepository({ facts: async () => ({ problem: 'Hornhoof could not read the branches of the repository: it answered 404.' }), holds: async () => true, push: async updates => { pushed.push(...updates.map(u => u.ref)); return { refs: {} }; }, record }, { apply: true });
    expect(result).toMatchObject({ verdicts: [], entries: [], stopped: { why: 'unreadable', problem: expect.stringContaining('404') as unknown } });
    expect(entries).toEqual([]);
    expect(pushed).toEqual([]);
  });
});
