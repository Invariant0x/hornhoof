import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { turns } from '../src/db/schema.js';
import { submit } from '../src/modules/tasks/engine.js';
import type { CompareResult } from '../src/modules/testruns/compare.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';

/* The shape of #1540's N2: a developer pushes commits of their own on the task branch, names their tip as review.baseCommit and
   hands in only what comes after it. Review, Security and Tests then see only that later change, and the turn takes the
   commits under it by fast-forward. A base is the main line or the open turn of the department, or a commit one of them holds. */
const MAIN = BASE, TURN = '7'.repeat(40), TURN_OLD = '8'.repeat(40), MAIN_ON = '9'.repeat(40), UNCHECKED = '1'.repeat(40), MERGED = 'e'.repeat(40);

/* What the repository says: where each branch is, which commit holds which, and the comparisons GitHub capped at 300 files
   (they prove the line by their commits), cut short (they prove nothing) or could not give at all. A name in tagged is a tag
   of the repository where it has no such branch, which git takes as well and says so. */
type Repository = { heads: Record<string, string>; holds: Record<string, string[]>; capped: Set<string>; cut: Set<string>; failing: Set<string>; unreadable: Set<string>; tagged?: Set<string> };

function serve(f: Awaited<ReturnType<typeof fixture>>, repo: Repository): void {
  f.ctx.readCommit = async (_repo, want) => {
    const branch = 'branch' in want ? want.branch : 'task-1';
    if (repo.unreadable.has(branch)) throw new Error('unreadable');
    const commitSha = repo.heads[branch];
    if (commitSha && repo.tagged?.has(branch)) return { branch, commitSha, tag: true };
    return commitSha ? { branch, commitSha } : { problem: `The repository has no branch ${branch}.`, missing: true };
  };
  f.ctx.readCompare = async (_repo, refs): Promise<CompareResult> => {
    const key = `${refs.base}..${refs.head}`;
    if (repo.failing.has(key)) throw new Error('unavailable');
    if (refs.base !== refs.head && !(repo.holds[refs.head] ?? []).includes(refs.base)) return { complete: false, reason: 'not-an-ancestor' };
    if (repo.cut.has(key)) return { complete: false, reason: 'incomplete-comparison' };
    if (repo.capped.has(key)) return { complete: false, reason: 'too-many-files', lineage: { baseSha: refs.base, headSha: refs.head, commits: [] } };
    return { complete: true, baseSha: refs.base, headSha: refs.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' };
  };
}

/* A task in Development whose branch is at HEAD: on UNCHECKED, a commit of the developer's own, on the open turn at TURN, which
   went on from TURN_OLD and holds main at MAIN. */
async function onTheBranch() {
  const f = await fixture();
  const [turn] = await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
  const turnBranch = `turn-${turn!.number}`;
  const repo: Repository = {
    heads: { main: MAIN, [turnBranch]: TURN, 'task-1': HEAD },
    holds: { [HEAD]: [UNCHECKED, TURN, TURN_OLD, MAIN, MAIN_ON], [UNCHECKED]: [TURN, TURN_OLD, MAIN], [TURN]: [TURN_OLD, MAIN], [TURN_OLD]: [MAIN], [MAIN_ON]: [MAIN] },
    capped: new Set(), cut: new Set(), failing: new Set(), unreadable: new Set(),
  };
  serve(f, repo);
  const handIn = (baseCommit: string) => submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Focused checks.', review: { baseCommit } });
  const untouched = async () => expect((await f.detail()).echelons).toMatchObject({ stage: 'development', phase: 'active', candidateId: null });
  const handedIn = async () => expect((await f.detail()).echelons).toMatchObject({ stage: 'review', candidateId: expect.any(String) as unknown });
  return { ...f, turnBranch, repo, handIn, untouched, handedIn };
}

describe('a candidate starts from a line its department releases', () => {
  it('refuses a base neither main nor the open turn holds, as the commits under it reached no check', async () => {
    const f = await onTheBranch();
    await expect(f.handIn(UNCHECKED)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(UNCHECKED) as unknown });
    await expect(f.handIn(UNCHECKED)).rejects.toMatchObject({ message: expect.stringContaining(`${f.turnBranch} at ${TURN}`) as unknown });
    await expect(f.handIn(UNCHECKED)).rejects.toMatchObject({ message: expect.stringContaining(`main at ${MAIN}`) as unknown });
    await f.untouched();
  });

  it.each([['the head of the open turn', TURN], ['a commit the open turn went on from', TURN_OLD], ['the head of main', MAIN]])('takes %s as the base', async (_what, base) => {
    const f = await onTheBranch();
    await f.handIn(base);
    await f.handedIn();
  });

  it('takes a base main holds that the open turn does not hold yet, as main brings only released work', async () => {
    const f = await onTheBranch();
    f.repo.heads.main = MAIN_ON;
    await f.handIn(MAIN_ON);
    await f.handedIn();
  });

  it('proves the line by the commits of a comparison GitHub capped at 300 files', async () => {
    const f = await onTheBranch();
    f.repo.capped.add(`${TURN_OLD}..${TURN}`);
    await f.handIn(TURN_OLD);
    await f.handedIn();
  });

  it.each([
    ['came back cut short', (repo: Repository) => repo.cut.add(`${TURN_OLD}..${TURN}`)],
    ['could not be read', (repo: Repository) => repo.failing.add(`${TURN_OLD}..${TURN}`)],
    ['is of a turn branch that could not be read', (repo: Repository) => repo.unreadable.add(Object.keys(repo.heads).find(b => b.startsWith('turn-'))!)],
  ])('refuses a base held only by the open turn where the comparison %s', async (_how, change) => {
    const f = await onTheBranch();
    change(f.repo);
    await expect(f.handIn(TURN_OLD)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(TURN_OLD) as unknown });
    await f.untouched();
  });

  /* H1 of #1569: a tag of the turn branch's name, as a ref written where the branch was deleted, is no line. */
  it('reads the lines by branch alone: a tag named as the open turn holds no base, and one named main holds none either', async () => {
    const f = await onTheBranch();
    f.repo.tagged = new Set([f.turnBranch]);
    await expect(f.handIn(TURN_OLD)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(TURN_OLD) as unknown });
    f.repo.tagged = new Set(['main']);
    await expect(f.handIn(MAIN)).rejects.toMatchObject({ status: 409 });
    await f.untouched();
  });

  it('refuses every base while main cannot be read', async () => {
    const f = await onTheBranch();
    f.repo.unreadable.add('main');
    await expect(f.handIn(TURN)).rejects.toMatchObject({ status: 409 });
    await f.untouched();
  });
});

/* A candidate handed in before this check, or on a line that was rewritten since, whose base neither line holds now. */
describe('a take-in at Tests keeps the base on the line', () => {
  it('refuses to take the turn into a candidate whose own base the line does not hold', async () => {
    const f = await testsFixture();
    const [turn] = await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
    const turnBranch = `turn-${turn!.number}`;
    const repo: Repository = {
      heads: { main: MAIN_ON, [turnBranch]: TURN, 'task-1': MERGED },
      holds: { [MERGED]: [HEAD, BASE, TURN, MAIN_ON], [HEAD]: [BASE], [TURN]: [MAIN_ON] },
      capped: new Set(), cut: new Set(), failing: new Set(), unreadable: new Set(),
    };
    serve(f, repo);
    const before = (await f.detail()).echelons;
    await expect(submit(f.ctx, f.tester.id, f.task.id, { summary: `Took ${turnBranch} in.`, evidence: 'Merged.', review: { baseCommit: TURN } }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining(BASE) as unknown });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: before.candidateId });
  });
});
