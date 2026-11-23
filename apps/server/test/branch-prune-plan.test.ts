import { describe, expect, it } from 'vitest';
import { GitHubRateLimited } from '../src/modules/testruns/github-limit.js';
import { CLOSED_GRACE_MS, TURNS_KEPT, planPrune, type Facts, type Holds, type Verdict } from '../src/modules/repos/prune-plan.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 12);
const sha = (c: string) => c.repeat(40);
const M1 = sha('1'), M2 = sha('2'), M3 = sha('3'), T1 = sha('4'), T2 = sha('5'), U1 = sha('6'), U2 = sha('7'), U3 = sha('8'), U4 = sha('9');

/* The history of the repository in these tests: main goes M1, M2, M3; the open turn goes on from M3 with T1, T2; the unmerged
   work of closed tasks starts at M1 and stands apart. A commit holds itself and whatever is under it. */
const PARENTS: Record<string, string[]> = { [M2]: [M1], [M3]: [M2], [T1]: [M3], [T2]: [T1], [U1]: [M1], [U2]: [M1], [U3]: [M1], [U4]: [M1] };
const under = (commit: string): Set<string> => {
  const seen = new Set<string>();
  const walk = (c: string) => { if (!seen.has(c)) { seen.add(c); for (const p of PARENTS[c] ?? []) walk(p); } };
  walk(commit);
  return seen;
};
const holds = async (holder: string, head: string) => under(holder).has(head);
const plan = async (f: Facts, h: Holds = holds): Promise<Verdict[]> => (await planPrune(f, h)).verdicts;

const task = (status: string, extra: { paused?: boolean; closedDaysAgo?: number } = {}) =>
  ({ status, paused: extra.paused ?? false, closedAt: extra.closedDaysAgo === undefined ? null : NOW - extra.closedDaysAgo * DAY });

function facts(more: Partial<Facts> = {}): Facts {
  return {
    main: 'main',
    heads: {},
    tags: {},
    tasks: new Map(),
    recorded: new Set(),
    now: NOW,
    ...more,
  };
}

const verdictOf = (all: Verdict[], branch: string) => all.find(v => v.branch === branch);
const actions = (all: Verdict[]) => Object.fromEntries(all.map(v => [v.branch, v.action]));

describe('which branches of a repository Hornhoof deletes, archives and keeps', () => {
  const base = () => facts({
    heads: { main: M3, 'turn-43': T2, 'task-1': M2, 'task-2': T1, 'task-3': U1, 'task-4': U2, 'task-5': U3, 'task-6': M2, 'task-7': U4, 'task-999': U1, 'feature/x': U1, 'release-check-3': U1 },
    recorded: new Set(['turn-43']),
    tasks: new Map([
      [1, task('done', { closedDaysAgo: 2 })], [2, task('done', { closedDaysAgo: 1 })], [3, task('cancelled', { closedDaysAgo: 1 })],
      [4, task('done', { closedDaysAgo: 10 })], [5, task('done', { closedDaysAgo: 1 })], [6, task('working')], [7, task('waiting', { paused: true })],
    ]),
  });

  it('deletes a task branch whose head main holds, and one only the turn branch holds, saying which', async () => {
    const all = await plan(base(), holds);
    expect(verdictOf(all, 'task-1')).toMatchObject({ action: 'delete', head: M2, heldBy: 'main' });
    expect(verdictOf(all, 'task-2')).toMatchObject({ action: 'delete', head: T1, heldBy: 'turn-43' });
  });

  it('deletes a branch a release tag holds that no branch does', async () => {
    const heads = { ...base().heads, 'turn-43': M3, 'task-2': U1 };
    const all = await plan(facts({ ...base(), heads, tags: { 'v0.9.0': T2 } }), holds);
    expect(verdictOf(all, 'task-2')).toMatchObject({ action: 'keep' });
    const held = await plan(facts({ ...base(), heads: { ...heads, 'task-2': T1 }, tags: { 'v0.9.0': T2 } }), holds);
    expect(verdictOf(held, 'task-2')).toMatchObject({ action: 'delete', heldBy: 'v0.9.0' });
  });

  it('archives an unmerged branch of a cancelled task, and of one closed long ago, and keeps one closed lately', async () => {
    const all = await plan(base(), holds);
    expect(verdictOf(all, 'task-3')).toMatchObject({ action: 'archive', head: U1 });
    expect(verdictOf(all, 'release-check-3')).toMatchObject({ action: 'archive', head: U1 });
    expect(verdictOf(all, 'task-4')).toMatchObject({ action: 'archive', head: U2 });
    expect(verdictOf(all, 'task-5')).toMatchObject({ action: 'keep', reason: expect.stringContaining('closed') as unknown });
    expect(CLOSED_GRACE_MS).toBeGreaterThan(DAY);
  });

  it('never touches the branch of an open or a paused task, held or not', async () => {
    const all = await plan(base(), holds);
    expect(verdictOf(all, 'task-6')).toMatchObject({ action: 'keep', reason: expect.stringContaining('open') as unknown });
    expect(verdictOf(all, 'task-7')).toMatchObject({ action: 'keep', reason: expect.stringContaining('paused') as unknown });
  });

  it('never touches main, a branch of no task of this company, or a branch it has no record of', async () => {
    const all = await plan(base(), holds);
    expect(verdictOf(all, 'main')).toMatchObject({ action: 'keep' });
    expect(verdictOf(all, 'task-999')).toMatchObject({ action: 'keep', reason: expect.stringContaining('not a task') as unknown });
    expect(verdictOf(all, 'feature/x')).toMatchObject({ action: 'keep', reason: expect.stringContaining('not made by Hornhoof') as unknown });
    expect(actions(all).main).toBe('keep');
  });

  it('keeps a branch it could not tell about, and goes on with the others', async () => {
    const unsure: Holds = async (holder, head) => (head === M2 ? null : holds(holder, head));
    const all = await plan(base(), unsure);
    expect(verdictOf(all, 'task-1')).toMatchObject({ action: 'keep', reason: expect.stringContaining('could not be read') as unknown });
    expect(verdictOf(all, 'task-2')).toMatchObject({ action: 'delete' });
  });

  it('keeps the newest turn branches, and deletes an older one only where a release tag stands on its head', async () => {
    const heads: Record<string, string> = { main: M3 };
    for (let n = 1; n <= TURNS_KEPT + 2; n++) heads[`turn-${n}`] = n === 1 ? M1 : n === 2 ? M2 : n === 3 ? M3 : M3;
    const turns = new Set(Object.keys(heads).filter(name => name !== 'main'));
    const all = await plan(facts({ heads, recorded: turns, tags: { 'v0.1.0': M1, nightly: M2 } }), holds);
    expect(verdictOf(all, 'turn-1')).toMatchObject({ action: 'delete', reason: expect.stringContaining('v0.1.0') as unknown });
    /* A tag that is no release (v*) stands on turn-2's head, which keeps it. */
    expect(verdictOf(all, 'turn-2')).toMatchObject({ action: 'keep', reason: expect.stringContaining('release tag') as unknown });
    for (let n = 3; n <= TURNS_KEPT + 2; n++) expect(verdictOf(all, `turn-${n}`)).toMatchObject({ action: 'keep' });
  });

  it('keeps every turn branch while there are no more than it keeps, tagged or not', async () => {
    const heads: Record<string, string> = { main: M3 };
    for (let n = 1; n <= TURNS_KEPT; n++) heads[`turn-${n}`] = M3;
    const all = await plan(facts({ heads, recorded: new Set(Object.keys(heads)), tags: { 'v0.1.0': M3 } }), holds);
    expect(all.filter(v => v.action !== 'keep')).toEqual([]);
  });

  it('never plans a tag, whatever its name or what it holds', async () => {
    const all = await plan(facts({ ...base(), tags: { 'v1.0.0': M3, 'task-3': U1, 'turn-1': M1 } }), holds);
    expect(all.every(v => !v.branch.startsWith('v1.') && v.branch !== 'turn-1')).toBe(true);
    expect(verdictOf(all, 'task-3')).toMatchObject({ action: 'archive' });
  });

  it('stops where the repository\'s request limit is used up, and says what it planned before and when it ends', async () => {
    let asked = 0;
    const limited: Holds = async (holder, head) => {
      if (++asked > 4) throw new GitHubRateLimited({ remaining: 0, resetAt: NOW + 1_000 });
      return holds(holder, head);
    };
    const { verdicts, stopped } = await planPrune(base(), limited);
    expect(stopped).toEqual({ remaining: 0, resetAt: NOW + 1_000 });
    expect(verdicts.length).toBeGreaterThan(0);
    expect(verdicts.length).toBeLessThan(Object.keys(base().heads).length);
    const names = verdicts.map(v => v.branch);
    expect(names).toEqual([...names].sort());
  });
});
