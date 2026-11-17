import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { fixture } from './development-echelons-fixture.js';
import { verified } from './development-echelons-verification.js';

/* The case of #1136 as Operations recorded it on 17.11: the candidate reached Tests as the commit of Security, its branch
   already held the main line, and the Tests owner pushed a repair of one test file on top, production untouched. */
const MAIN = 'f4fb7eff1840c17bacd6826c109e341a35d076ba';
const AUTHOR = '542177951181ba9cd98acb77f8a2f1fc22e37a01';
const SECURITY = '54d9d703f6e2d4f2e82ce882f7f50f9d1708ea38';
const REPAIR = '81cea98cd32a05ea05871f1d047f201a77d3a33c';
const OFF_LINE = '7c86700600000000000000000000000000000000';
const BRANCH = 'task-1136';
const SCOPE = ['apps/node/src/program-check.ts', 'apps/node/src/redact.ts'];
/* Each commit of the branch after the main line, with the files it changed. */
const LINE: [string, string[]][] = [
  [MAIN, []],
  [AUTHOR, ['apps/node/src/program-check.ts', 'apps/node/test/program-check.test.ts']],
  [SECURITY, ['apps/node/src/program-check.ts', 'apps/node/src/redact.ts', 'apps/node/test/login-terminal.test.ts', 'apps/node/test/program-check.test.ts', 'apps/node/test/redact.test.ts']],
  [REPAIR, ['apps/node/test/program-check.test.ts']],
];
const EVIDENCE = 'npx vitest run apps/node/test/program-check.test.ts at 81cea98c: 1 file, 24 passed; production untouched.';

async function atTests() {
  const f = await fixture({ riskClass: 'security' });
  let head = AUTHOR;
  f.ctx.readCommit = async (_repo, want) => 'branch' in want && want.branch === 'main' ? { branch: 'main', commitSha: MAIN } : { branch: BRANCH, commitSha: head };
  f.ctx.readCompare = async (_repo, refs) => {
    const from = LINE.findIndex(([sha]) => sha === refs.base), to = LINE.findIndex(([sha]) => sha === refs.head);
    if (from < 0 || to < from) return { complete: false, reason: 'not-an-ancestor' };
    const paths = [...new Set(LINE.slice(from + 1, to + 1).flatMap(([, changed]) => changed))];
    return { complete: true, baseSha: refs.base, headSha: refs.head, paths, diff: '@@ -1 +1 @@\n-old\n+new' };
  };
  const { task } = await f.create({ title: 'Program checks', riskClass: 'security', paths: SCOPE });
  const on = (commit: string) => { head = commit; };
  const detail = () => f.detail(task.id);
  await submit(f.ctx, f.author.id, task.id, { summary: 'Install again when a program does not start.', evidence: 'Named node tests.', review: { baseCommit: MAIN } });
  await verdict(f.ctx, f.reviewer.id, task.id, { pass: true, comment: 'Checked.', reviewedCommit: AUTHOR });
  await verdict(f.ctx, f.security.id, task.id, { pass: false, comment: 'Diagnostics leak a token; fixing.', reviewedCommit: AUTHOR });
  on(SECURITY);
  await submit(f.ctx, f.security.id, task.id, { summary: 'Keep program checks isolated and OAuth diagnostics private.', evidence: 'Named node tests.', review: { baseCommit: MAIN } });
  const received = (await detail()).echelons;
  const repair = (changes: { baseCommit?: string; by?: string } = {}) =>
    submit(f.ctx, changes.by ?? f.tester.id, task.id, { summary: 'Use virtual time when checking agent installation.', evidence: EVIDENCE, review: { baseCommit: changes.baseCommit ?? MAIN } });
  return { ...f, task, on, detail, received, repair };
}

describe('Tests hands in its own repair of the candidate it checks, on the same branch and base', () => {
  it('starts from the case of #1136: the candidate of Security at Tests, with its owner', async () => {
    const f = await atTests();
    expect(f.received).toMatchObject({ stage: 'tests', phase: 'active', ownerAgentId: f.tester.id });
    expect(f.received.stages.find(step => step.stage === 'tests')).toMatchObject({ status: 'active', candidateId: null });
  });

  it('takes the repair without a newer main line and keeps it at Tests with its owner, linked to the candidate it received', async () => {
    const f = await atTests();
    f.on(REPAIR);
    const moved = await f.repair();
    expect(moved.task).toMatchObject({ assigneeAgentId: f.tester.id });
    expect(moved.wakes).toEqual([]);
    const route = (await f.detail()).echelons;
    expect(route).toMatchObject({ stage: 'tests', phase: 'active', ownerAgentId: f.tester.id, revision: f.received.revision + 1 });
    expect(route.candidateId).not.toBe(f.received.candidateId);
    expect((await f.detail()).log.findLast(event => event.kind === 'submitted')?.data).toMatchObject({
      evidence: EVIDENCE,
      candidate: { id: route.candidateId, parentId: f.received.candidateId, baseCommit: MAIN, commit: REPAIR, branch: BRANCH, producedBy: { stage: 'tests', agentId: f.tester.id } },
      repaired: { from: SECURITY, to: REPAIR },
    });
  });

  it('then verifies the repaired candidate with its local checks alone, naming no test runs', async () => {
    const f = await atTests();
    f.on(REPAIR);
    await f.repair();
    const route = (await f.detail()).echelons;
    await expect(report(f.ctx, f.tester.id, f.task.id, verified(f.received))).rejects.toMatchObject({ status: 409 });
    const checked = await report(f.ctx, f.tester.id, f.task.id, verified(route));
    expect(checked.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'ready', candidateId: route.candidateId });
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toEqual({ verifiedCandidate: {
      candidateId: route.candidateId, commit: REPAIR, routeRevision: route.revision + 1, testedRevision: route.revision,
    } });
  });

  it('gives no verdict at Tests and names the way a repair goes in', async () => {
    const f = await atTests();
    await expect(verdict(f.ctx, f.tester.id, f.task.id, { pass: false, comment: 'Repairing a test.', reviewedCommit: SECURITY }))
      .rejects.toMatchObject({ status: 409, message: expect.stringMatching(/submit.*report/s) as unknown });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', candidateId: f.received.candidateId });
  });

  it('refuses a hand-in that holds nothing beyond the candidate received, or that does not hold it', async () => {
    const f = await atTests();
    await expect(f.repair()).rejects.toMatchObject({ status: 409 });
    f.on(OFF_LINE);
    await expect(f.repair()).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', candidateId: f.received.candidateId });
  });
});

describe('only the current Tests owner hands a repair in', () => {
  it('refuses the author, another checker and an employee who holds nothing of the task', async () => {
    const f = await atTests();
    f.on(REPAIR);
    const stranger = await f.hire('Stranger', 'worker', 'DEV-TEST', f.claude.id, 'claude-opus-5-5');
    for (const by of [f.author.id, f.reviewer.id, f.security.id, stranger.id]) await expect(f.repair({ by })).rejects.toMatchObject({ status: 403 });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', candidateId: f.received.candidateId });
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ assigneeAgentId: f.tester.id });
  });

  it('refuses an owner whose assignment is stale, as its plan changed after the head assigned it', async () => {
    const f = await atTests();
    f.on(REPAIR);
    await f.db.update(agents).set({ subscriptionId: f.codex.id }).where(eq(agents.id, f.tester.id));
    await expect(f.repair()).rejects.toMatchObject({ status: 409, message: 'The checking assignment changed. Ask the head to assign it again.' });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', candidateId: f.received.candidateId });
  });
});
