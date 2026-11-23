import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Holds } from '../src/modules/repos/prune-plan.js';
import { pushRefs } from '../src/modules/repos/ref-push.js';
import { takeIn, takeInMessage, type TakeInDeps } from '../src/modules/repos/take-in.js';
import { git, headOf, host, origin } from './git-origin.js';

const WHO = { name: 'Ivan Korol', email: 'ivan@example.com' };
const NOW = Date.UTC(2026, 10, 23, 12);

const holdsIn = (dir: string): Holds => async (holder, head) => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', head, holder], { cwd: dir }); return true; } catch { return false; }
};
const treeIn = (dir: string) => async (commit: string) => git(dir, 'rev-parse', `${commit}^{tree}`);

/* A turn branch at main, and a task branch of two commits on it. */
function turn() {
  const { dir, main, other } = origin();
  git(dir, 'branch', 'turn-7', main);
  return { dir, main, candidate: other };
}

function depsOf(dir: string, url: string, more: Partial<TakeInDeps> = {}): TakeInDeps {
  return { holds: holdsIn(dir), treeOf: treeIn(dir), push: (updates, options) => pushRefs({ url, token: '' }, updates, options), now: () => NOW, ...more };
}

const input = (main: string, candidate: string, more: Record<string, unknown> = {}) => ({ task: 1234, turn: 'turn-7', turnHead: main, candidate, who: WHO, ...more });

describe('taking a checked candidate into the turn branch as a merge commit of its own', () => {
  it('makes exactly one merge commit naming the task, over the turn head and the candidate, with the candidate\'s own tree', async () => {
    const { dir, main, candidate } = turn();
    const { url } = await host(dir);
    const taken = await takeIn(input(main, candidate), depsOf(dir, url));
    expect(taken).toEqual({ merge: headOf(dir, 'turn-7') });
    const merge = headOf(dir, 'turn-7')!;
    expect(git(dir, 'rev-list', '--parents', '-n', '1', merge)).toBe(`${merge} ${main} ${candidate}`);
    expect(git(dir, 'rev-parse', `${merge}^{tree}`)).toBe(git(dir, 'rev-parse', `${candidate}^{tree}`));
    expect(git(dir, 'diff', '--stat', candidate, merge)).toBe('');
    expect(git(dir, 'log', '-1', '--format=%s', merge)).toBe('Take in task-1234 (#1234)');
    expect(git(dir, 'rev-list', '--merges', '--count', `${main}..turn-7`)).toBe('1');
    expect(headOf(dir, 'main')).toBe(main);
    expect(headOf(dir, 'other')).toBe(candidate);
  });

  it('writes a commit git itself takes as one: its object is the one git makes of the same text, and the repository checks clean', async () => {
    const { dir, main, candidate } = turn();
    const { url } = await host(dir);
    await takeIn(input(main, candidate), depsOf(dir, url));
    const merge = headOf(dir, 'turn-7')!;
    const text = execFileSync('git', ['cat-file', 'commit', merge], { cwd: dir });
    const root = mkdtempSync(join(tmpdir(), 'hh-hash-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'commit.txt'), text);
    expect(git(dir, 'hash-object', '-t', 'commit', join(root, 'commit.txt'))).toBe(merge);
    expect(() => git(dir, 'fsck', '--strict', '--no-dangling')).not.toThrow();
    expect(git(dir, 'log', '-1', '--format=%an <%ae> %ct', merge)).toBe(`Ivan Korol <ivan@example.com> ${NOW / 1000}`);
    expect(git(dir, 'log', '-1', '--format=%B', merge)).toContain('Signed-off-by: Ivan Korol <ivan@example.com>');
    expect(takeInMessage(1234, WHO)).toBe('Take in task-1234 (#1234)\n\nSigned-off-by: Ivan Korol <ivan@example.com>\n');
  });

  it('refuses a candidate that does not hold the turn branch, so its tree would not be what was checked, and pushes nothing', async () => {
    const { dir, main, candidate } = turn();
    const newer = git(dir, 'commit-tree', '-p', main, '-m', 'someone else took in', `${main}^{tree}`);
    git(dir, 'update-ref', 'refs/heads/turn-7', newer);
    const { url, pushes } = await host(dir);
    const answer = await takeIn(input(newer, candidate), depsOf(dir, url));
    expect(answer).toEqual({ problem: expect.stringContaining('take') as unknown, stale: true });
    expect(pushes).toHaveLength(0);
    expect(headOf(dir, 'turn-7')).toBe(newer);
  });

  it('makes no merge for work the turn branch holds already, which is the fast-forward as it was', async () => {
    const { dir, candidate } = turn();
    git(dir, 'update-ref', 'refs/heads/turn-7', candidate);
    const { url, pushes } = await host(dir);
    expect(await takeIn(input(candidate, candidate), depsOf(dir, url))).toEqual({ already: true });
    expect(pushes).toHaveLength(0);
    expect(headOf(dir, 'turn-7')).toBe(candidate);
  });

  it('keeps a turn branch that went on after it was read, and says so', async () => {
    const { dir, main, candidate } = turn();
    const { url } = await host(dir);
    const moved = git(dir, 'commit-tree', '-p', main, '-m', 'another task landed', `${main}^{tree}`);
    const answer = await takeIn(input(main, candidate), depsOf(dir, url, {
      treeOf: async commit => {
        git(dir, 'update-ref', 'refs/heads/turn-7', moved);
        return git(dir, 'rev-parse', `${commit}^{tree}`);
      },
    }));
    expect(answer).toEqual({ problem: expect.stringContaining('went on') as unknown, stale: true });
    expect(headOf(dir, 'turn-7')).toBe(moved);
  });

  it('takes work only into a turn branch', async () => {
    const { dir, main, candidate } = turn();
    const { url, pushes } = await host(dir);
    for (const name of ['main', 'task-1', 'turn-7/x', 'refs/heads/turn-7']) {
      expect(await takeIn(input(main, candidate, { turn: name }), depsOf(dir, url))).toEqual({ problem: expect.stringContaining('turn branch') as unknown });
    }
    expect(pushes).toHaveLength(0);
    expect(headOf(dir, 'main')).toBe(main);
  });

  it('says what it could not read, and takes nothing in', async () => {
    const { dir, main, candidate } = turn();
    const { url, pushes } = await host(dir);
    expect(await takeIn(input(main, candidate), depsOf(dir, url, { holds: async () => null }))).toEqual({ problem: expect.stringContaining('could not be read') as unknown });
    expect(await takeIn(input(main, candidate), depsOf(dir, url, { treeOf: async () => null }))).toEqual({ problem: expect.stringContaining('could not be read') as unknown });
    expect(pushes).toHaveLength(0);
    expect(headOf(dir, 'turn-7')).toBe(main);
  });
});
