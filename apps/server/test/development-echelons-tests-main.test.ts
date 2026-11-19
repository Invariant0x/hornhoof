import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks, turns } from '../src/db/schema.js';
import { report, submit } from '../src/modules/tasks/engine.js';
import type { TreeReader } from '../src/modules/testruns/compare.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { testsFixture, verified } from './development-echelons-verification.js';

const MAIN = 'd'.repeat(40), MERGED = 'e'.repeat(40), EDITED = '9'.repeat(40);
const OWN = ['logic/totals.ts'], FROM_MAIN = ['logic/rates.ts'];
/* The paths of a comparison, or CAPPED where GitHub listed 300 of its files and so proved only that the head holds the base. */
const CAPPED = 'capped';
type Change = string[] | typeof CAPPED;

/* A candidate at Tests whose own change passed and whose checks failed only for what the main line fixed since its base. The
   main line is at MAIN, and so is the open turn of the department, which started from it and took nothing in yet; the
   candidate branch holds MERGED, the candidate with that main line merged in. */
async function behindMain(merge: Change = FROM_MAIN, branchHead = MERGED, more: Record<string, Change> = {}) {
  const f = await testsFixture();
  const [turn] = await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
  const turnBranch = `turn-${turn!.number}`;
  f.ctx.readCommit = async (_repo, want) => {
    const branch = 'branch' in want ? want.branch : 'task-1';
    return { branch, commitSha: branch === 'main' || branch === turnBranch ? MAIN : branchHead };
  };
  const changes: Record<string, Change> = { [`${BASE}..${MAIN}`]: FROM_MAIN, [`${MAIN}..${MAIN}`]: [], [`${MAIN}..${MERGED}`]: OWN, [`${HEAD}..${MERGED}`]: merge, ...more };
  f.ctx.readCompare = async (_repo, refs) => {
    const paths = changes[`${refs.base}..${refs.head}`];
    if (paths === CAPPED) return { complete: false, reason: 'too-many-files', lineage: { baseSha: refs.base, headSha: refs.head, commits: [] } };
    return paths ? { complete: true, baseSha: refs.base, headSha: refs.head, paths, diff: '@@ -1 +1 @@\n-old\n+new' } : { complete: false, reason: 'not-an-ancestor' };
  };
  const took = (baseCommit = MAIN) => submit(f.ctx, f.tester.id, f.task.id, { summary: 'Took the main line in.', evidence: 'Merged origin/main into task-1.', review: { baseCommit } });
  return { ...f, took, turnBranch, changes };
}

describe('Tests takes the main line into a candidate whose own change passed', () => {
  it('keeps the candidate at Tests with its owner, who checks the merged candidate there and hands it on', async () => {
    const f = await behindMain();
    const moved = await f.took();
    expect(moved.task).toMatchObject({ assigneeAgentId: f.tester.id });
    expect(moved.wakes).toEqual([]);
    const route = (await f.detail()).echelons;
    expect(route).toMatchObject({ stage: 'tests', phase: 'active' });
    expect(route.candidateId).not.toBe(f.snapshot.candidateId);
    expect(route.stages.map(step => [step.stage, step.status, step.ownerAgentId])).toEqual(f.snapshot.stages.map(step => [step.stage, step.status, step.ownerAgentId]));
    expect((await f.detail()).log.findLast(event => event.kind === 'submitted')?.data).toMatchObject({
      candidate: { id: route.candidateId, parentId: f.snapshot.candidateId, baseCommit: MAIN, commit: MERGED, branch: 'task-1', paths: OWN, producedBy: { stage: 'tests', agentId: f.tester.id } },
      tookMain: { from: BASE, to: MAIN },
    });

    const checked = await report(f.ctx, f.tester.id, f.task.id, verified(route));
    expect(checked.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'ready', stage: 'tests', candidateId: route.candidateId });
  });

  it('refuses a merge that changes what the main line did not bring, and keeps the candidate as it was', async () => {
    const f = await behindMain([...FROM_MAIN, ...OWN]);
    await expect(f.took()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('logic/totals.ts') as unknown });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: f.snapshot.candidateId });
  });

  it('refuses a base that is not on the main line, as it would hide the change from the checks', async () => {
    /* An edit of the candidate's own file, named as if the candidate itself were the main line taken in. */
    const f = await behindMain(OWN, EDITED, { [`${BASE}..${HEAD}`]: OWN, [`${HEAD}..${EDITED}`]: OWN });
    await expect(f.took(HEAD)).rejects.toMatchObject({ status: 409,
      message: `${MAIN} does not hold ${HEAD}, or the change between them could not be read; nor does ${f.turnBranch} at ${MAIN}. Take in the main line or ${f.turnBranch}, and name the commit you took in as review.baseCommit.` });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', candidateId: f.snapshot.candidateId });
  });

  it('refuses the same base, as nothing of the main line was taken in', async () => {
    const f = await behindMain();
    await expect(f.took(BASE)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', candidateId: f.snapshot.candidateId });
  });

  it('takes the main line only from the Tests owner, never from the author', async () => {
    const f = await behindMain();
    await expect(submit(f.ctx, f.author.id, f.task.id, { summary: 'Mine.', evidence: 'Merged.', review: { baseCommit: MAIN } })).rejects.toMatchObject({ status: 403 });
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ assigneeAgentId: f.tester.id });
  });
});

/* The files of each commit as GitHub's trees name them: the main line changed 301 files since the candidate's base, more
   than GitHub lists of a comparison, and the candidate changed logic/totals.ts. */
const LINE = Array.from({ length: 301 }, (_, i) => `logic/line/${i}.ts`);
const blob = (path: string, content: string) => ({ path, type: 'blob', mode: '100644', sha: content.repeat(40) });
const files = (line: string, own: string, extra: { path: string; type: string; mode: string; sha: string }[] = []) => [...LINE.map(path => blob(path, line)), blob('logic/totals.ts', own), ...extra];

async function behindLargeMain(merged = files('2', '1'), tree: (commit: string) => Awaited<ReturnType<TreeReader>> | null = () => null) {
  const f = await behindMain(CAPPED, MERGED, { [`${BASE}..${MAIN}`]: CAPPED });
  const trees: Record<string, ReturnType<typeof files>> = { [BASE]: files('0', '0'), [HEAD]: files('0', '1'), [MAIN]: files('2', '0'), [MERGED]: merged };
  f.ctx.readTree = async (_repo, commit) => tree(commit) ?? (trees[commit] ? { complete: true, paths: trees[commit].map(e => e.path), entries: trees[commit] } : { complete: false, reason: 'tree-unavailable' });
  return f;
}

describe('Tests takes in a main line that changed more files than GitHub lists of a comparison', () => {
  it('keeps the merge as the candidate when it changes only what the main line brought', async () => {
    const f = await behindLargeMain();
    await f.took();
    const route = (await f.detail()).echelons;
    expect(route.candidateId).not.toBe(f.snapshot.candidateId);
    expect((await f.detail()).log.findLast(event => event.kind === 'submitted')?.data).toMatchObject({
      candidate: { baseCommit: MAIN, commit: MERGED, paths: OWN }, tookMain: { from: BASE, to: MAIN },
    });
  });

  it('refuses a merge that adds a path, changes the candidate or a mode beyond the line, naming each', async () => {
    const added = await behindLargeMain(files('2', '1', [blob('logic/extra.ts', '5')]));
    await expect(added.took()).rejects.toMatchObject({ status: 409,
      message: "The merge changes what main did not bring: logic/extra.ts. Take in only main; a failed check of the candidate's own change is reported with done false." });
    expect((await added.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: added.snapshot.candidateId });

    const edited = await behindLargeMain(files('2', '3'));
    await expect(edited.took()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('did not bring: logic/totals.ts.') as unknown });

    const moded = await behindLargeMain([...files('2', '1').filter(e => e.path !== 'logic/totals.ts'), { ...blob('logic/totals.ts', '1'), mode: '100755' }]);
    await expect(moded.took()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('did not bring: logic/totals.ts.') as unknown });
  });

  it('never takes a capped list for a clean one: where the files of a commit cannot be read whole, it refuses plainly', async () => {
    for (const unread of [{ complete: false as const, reason: 'incomplete-tree' }, { complete: true as const, paths: ['logic/totals.ts'] }]) {
      const f = await behindLargeMain(undefined, commit => commit === MERGED ? unread : null);
      await expect(f.took()).rejects.toMatchObject({ status: 409,
        message: `GitHub lists at most 300 files of a comparison, and the files of ${MERGED} could not be read whole, so it cannot be proved that the merge brings only main. Try again.` });
      expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: f.snapshot.candidateId });
    }
  });

  it('still refuses a base the main line does not hold, however large the change', async () => {
    const f = await behindLargeMain();
    delete f.changes[`${BASE}..${MAIN}`];
    await expect(f.took()).rejects.toMatchObject({ status: 409, message: `${MAIN} does not hold ${BASE}, or the change between them could not be read.` });
  });
});
