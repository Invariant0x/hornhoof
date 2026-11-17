import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, turns } from '../src/db/schema.js';
import { report, submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { testsFixture, verified } from './development-echelons-verification.js';
import { echelonsTurn } from './helpers.js';

/* The shape of #1214, #1216 and #1112: a candidate at Tests on a base of the main line, while the open turn of its
   department went on with other accepted results that the main line does not hold yet. The turn branch takes a result only
   by fast-forward, so the Tests owner merges the turn branch into the candidate branch and hands the merge in. */
const TURN_HEAD = '7'.repeat(40), MERGED = 'e'.repeat(40), TURN_LATER = '8'.repeat(40), ELSEWHERE = '9'.repeat(40), OTHER_HEAD = '6'.repeat(40);
const OWN = ['logic/totals.ts'], FROM_TURN = ['logic/rates.ts'];

async function turnWentOn(more: Record<string, string[]> = {}) {
  const f = await testsFixture();
  const [turn] = await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
  const turnBranch = `turn-${turn!.number}`;
  const heads: Record<string, string> = { main: BASE, [turnBranch]: TURN_HEAD };
  let candidateHead = MERGED;
  f.ctx.readCommit = async (_repo, want) => {
    const branch = 'branch' in want ? want.branch : 'task-1';
    return { branch, commitSha: heads[branch] ?? candidateHead };
  };
  const changes: Record<string, string[]> = {
    [`${BASE}..${TURN_HEAD}`]: FROM_TURN, [`${TURN_HEAD}..${TURN_HEAD}`]: [], [`${TURN_HEAD}..${MERGED}`]: OWN, [`${HEAD}..${MERGED}`]: FROM_TURN,
    [`${BASE}..${MERGED}`]: [...OWN, ...FROM_TURN], [`${MERGED}..${MERGED}`]: [], ...more,
  };
  f.ctx.readCompare = async (_repo, refs) => {
    const paths = changes[`${refs.base}..${refs.head}`];
    return paths ? { complete: true, baseSha: refs.base, headSha: refs.head, paths, diff: '@@ -1 +1 @@\n-old\n+new' } : { complete: false, reason: 'not-an-ancestor' };
  };
  const took = (baseCommit = TURN_HEAD) => submit(f.ctx, f.tester.id, f.task.id, { summary: `Took ${turnBranch} in.`, evidence: `Merged origin/${turnBranch} into task-1; named tests of the change pass.`, review: { baseCommit } });
  const unchanged = async () => expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: f.snapshot.candidateId });
  return { ...f, turnBranch, heads, changes, took, unchanged, at: (commit: string) => { candidateHead = commit; } };
}

describe('Tests takes the open turn of its department into a candidate, as it takes the main line', () => {
  it('keeps the merge at Tests with its owner, and the turn takes it by fast-forward once checked', async () => {
    const f = await turnWentOn();
    const moved = await f.took();
    expect(moved.task).toMatchObject({ assigneeAgentId: f.tester.id });
    expect(moved.wakes).toEqual([]);
    const route = (await f.detail()).echelons;
    expect(route).toMatchObject({ stage: 'tests', phase: 'active', revision: f.snapshot.revision + 1 });
    expect((await f.detail()).log.findLast(event => event.kind === 'submitted')?.data).toMatchObject({
      candidate: { id: route.candidateId, parentId: f.snapshot.candidateId, baseCommit: TURN_HEAD, commit: MERGED, branch: 'task-1', paths: OWN, producedBy: { stage: 'tests', agentId: f.tester.id } },
      tookTurn: { branch: f.turnBranch, from: BASE, to: TURN_HEAD },
    });

    await report(f.ctx, f.tester.id, f.task.id, verified(route));
    const ready = (await f.detail()).echelons;
    f.heads[f.turnBranch] = MERGED;
    const accepted = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: `Fast-forwarded ${f.turnBranch} to the checked merge.`, acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: MERGED } });
    expect(accepted.task).toMatchObject({ status: 'done' });
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toMatchObject({
      acceptedCandidate: { candidateId: route.candidateId, commit: MERGED, integration: { branch: f.turnBranch, commit: MERGED } },
    });
  });

  it('refuses a base that is on neither the main line nor the open turn of the department', async () => {
    const f = await turnWentOn({ [`${BASE}..${ELSEWHERE}`]: FROM_TURN, [`${ELSEWHERE}..${MERGED}`]: OWN });
    await expect(f.took(ELSEWHERE)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(ELSEWHERE) as unknown });
    await f.unchanged();
  });

  it('refuses a merge that does not hold the candidate it replaces', async () => {
    const f = await turnWentOn();
    delete f.changes[`${HEAD}..${MERGED}`];
    await expect(f.took()).rejects.toMatchObject({ status: 409, message: `${MERGED} does not hold ${HEAD}, or the change between them could not be read.` });
    await f.unchanged();
  });

  it('refuses the turn branch of another department', async () => {
    const f = await turnWentOn({ [`${BASE}..${OTHER_HEAD}`]: FROM_TURN, [`${OTHER_HEAD}..${MERGED}`]: OWN });
    const [other] = await f.db.insert(departments).values({ companyId: f.task.companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
    const opened = await echelonsTurn(f.db, f.task.companyId);
    expect(opened.departmentId).toBe(other!.id);
    f.heads[`turn-${opened.number}`] = OTHER_HEAD;
    await expect(f.took(OTHER_HEAD)).rejects.toMatchObject({ status: 409 });
    await f.unchanged();
  });

  it('refuses a merge that changes the candidate beyond what the turn brought, naming the change', async () => {
    const f = await turnWentOn({ [`${HEAD}..${MERGED}`]: [...FROM_TURN, ...OWN] });
    await expect(f.took()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('logic/totals.ts') as unknown });
    await f.unchanged();
  });

  it('refuses a merge of a turn head the turn has since gone on from, as the turn could not take it by fast-forward', async () => {
    const f = await turnWentOn({ [`${TURN_HEAD}..${TURN_LATER}`]: ['logic/fees.ts'], [`${BASE}..${TURN_LATER}`]: [...FROM_TURN, 'logic/fees.ts'] });
    f.heads[f.turnBranch] = TURN_LATER;
    await expect(f.took()).rejects.toMatchObject({ status: 409, message: expect.stringContaining(TURN_LATER) as unknown });
    await f.unchanged();
  });
});
