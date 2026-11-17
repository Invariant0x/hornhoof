import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks } from '../src/db/schema.js';
import { report, submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { testsFixture, verified } from './development-echelons-verification.js';

const MAIN = 'd'.repeat(40), MERGED = 'e'.repeat(40), EDITED = '9'.repeat(40);
const OWN = ['logic/totals.ts'], FROM_MAIN = ['logic/rates.ts'];

/* A candidate at Tests whose own change passed and whose checks failed only for what the main line fixed since its base. The
   main line is at MAIN; the candidate branch holds MERGED, the candidate with that main line merged in. */
async function behindMain(merge: string[] = FROM_MAIN, branchHead = MERGED, more: Record<string, string[]> = {}) {
  const f = await testsFixture();
  f.ctx.readCommit = async (_repo, want) => 'branch' in want && want.branch === 'main' ? { branch: 'main', commitSha: MAIN } : { branch: 'task-1', commitSha: branchHead };
  const changes: Record<string, string[]> = { [`${BASE}..${MAIN}`]: FROM_MAIN, [`${MAIN}..${MAIN}`]: [], [`${MAIN}..${MERGED}`]: OWN, [`${HEAD}..${MERGED}`]: merge, ...more };
  f.ctx.readCompare = async (_repo, refs) => {
    const paths = changes[`${refs.base}..${refs.head}`];
    return paths ? { complete: true, baseSha: refs.base, headSha: refs.head, paths, diff: '@@ -1 +1 @@\n-old\n+new' } : { complete: false, reason: 'not-an-ancestor' };
  };
  const took = (baseCommit = MAIN) => submit(f.ctx, f.tester.id, f.task.id, { summary: 'Took the main line in.', evidence: 'Merged origin/main into task-1.', review: { baseCommit } });
  return { ...f, took };
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
    await expect(f.took(HEAD)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${MAIN} does not hold ${HEAD}, or the change between them could not be read`) as unknown });
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
