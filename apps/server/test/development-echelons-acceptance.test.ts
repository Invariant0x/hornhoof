import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { approvalPolicies, departments, tasks, turns } from '../src/db/schema.js';
import { answer, ask, loadTask, report, submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE } from './development-echelons-fixture.js';
import { changeReport, testsFixture, verified } from './development-echelons-verification.js';

/* A checked candidate of the department's work, which goes into its open turn, or of a product with a repository of its
   own, which goes to main with a person's approval. */
async function readyFixture(inTurn = true) {
  const f = await testsFixture();
  let integrationBranch = 'main';
  if (inTurn) {
    const [turn] = await f.db.select().from(turns).where(and(eq(turns.companyId, f.task.companyId), eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
    integrationBranch = `turn-${turn!.number}`;
  } else {
    const [product] = await f.db.insert(departments).values({ companyId: f.task.companyId, parentId: f.task.departmentId!, roleCode: 'DEV', repoUrl: 'https://github.com/acme/app.git' }).returning();
    await f.db.update(tasks).set({ productId: product!.id }).where(eq(tasks.id, f.task.id));
  }
  f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: f.finalCommit });
  await report(f.ctx, f.tester.id, f.task.id, f.verified());
  const route = (await f.detail()).echelons;
  const acceptance = { candidateId: route.candidateId!, revision: route.revision, integrationCommit: f.finalCommit };
  return { ...f, acceptance, integrationBranch };
}

describe('accepting only a checked and integrated candidate', () => {
  it('accepts a checked main integration when the department has no commit rule', async () => {
    const f = await readyFixture(false);
    const moved = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated the checked candidate.', acceptance: f.acceptance });
    expect(moved.task.status).toBe('done');
  });

  it('checks a freshly set commit rule before accepting the main integration', async () => {
    const f = await readyFixture(false);
    const read = f.ctx.readCommit;
    f.ctx.readCommit = async (repo, ref, timeout) => {
      if ('branch' in ref && ref.branch === 'main') {
        await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
      }
      return read(repo, ref, timeout);
    };
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Hold the integration.', acceptance: f.acceptance })).rejects.toMatchObject({ status: 403 });
    expect((await loadTask(f.db, f.task.id)).status).not.toBe('done');
  });

  it('closes the ready result for its head after reading the exact turn integration', async () => {
    const f = await readyFixture();
    const moved = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated the checked candidate.', ...{ acceptance: f.acceptance } });
    expect(moved.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({ phase: 'done', candidateId: f.acceptance.candidateId });
    const accepted = detail.log.findLast(event => event.kind === 'report')?.data;
    expect(accepted).toMatchObject({ acceptedCandidate: { candidateId: f.acceptance.candidateId, commit: f.finalCommit, routeRevision: detail.echelons.revision, integration: { branch: f.integrationBranch, commit: f.finalCommit } } });
    expect(accepted).not.toHaveProperty('acceptedCandidate.evidence');
  });
  it.each(['candidate', 'revision', 'integration'])('refuses stale %s identity without closing the result', async changed => {
    const f = await readyFixture();
    const acceptance = { ...f.acceptance };
    if (changed === 'candidate') acceptance.candidateId = randomUUID();
    if (changed === 'revision') acceptance.revision--;
    if (changed === 'integration') acceptance.integrationCommit = 'd'.repeat(40);
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Stale integration.', ...{ acceptance } }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await loadTask(f.db, f.task.id)).status).not.toBe('done');
  });
  it('refuses acceptance when the Tests report names another commit', async () => {
    const f = await readyFixture();
    await changeReport(f.db, f.task.id, 'verifiedCandidate', proof => ({ ...proof, commit: 'd'.repeat(40) }));
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'The report changed.', ...{ acceptance: f.acceptance } }).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it('accepts a candidate whose Tests report still names test runs, as reports did before', async () => {
    const f = await readyFixture();
    await changeReport(f.db, f.task.id, 'verifiedCandidate', proof => ({ ...proof, evidence: [{ runId: randomUUID(), commit: f.finalCommit }] }));
    expect((await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Accepted.', ...{ acceptance: f.acceptance } })).task.status).toBe('done');
  });
  it('refuses a source branch that advanced after Tests', async () => {
    const f = await readyFixture();
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: 'branch' in ref && ref.branch === f.integrationBranch ? f.finalCommit : 'd'.repeat(40) });
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'The source advanced.', ...{ acceptance: f.acceptance } }).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it('takes a merge commit into the turn as no checked result, even where it holds the candidate', async () => {
    const f = await readyFixture();
    const merged = 'd'.repeat(40);
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: 'branch' in ref && ref.branch === f.integrationBranch ? merged : f.finalCommit });
    const refused = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated alongside independent work.', ...{ acceptance: { ...f.acceptance, integrationCommit: merged } } }).then(() => null, (err: { status: number; message: string }) => err);
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('only by fast-forward') as unknown });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ turnId: null });
    expect((await loadTask(f.db, f.task.id)).status).not.toBe('done');
  });
  it('takes a merge commit to main only when the comparison proves candidate inclusion and a person approved that commit', async () => {
    const f = await readyFixture(false);
    const merged = 'd'.repeat(40);
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: 'branch' in ref && ref.branch === 'main' ? merged : f.finalCommit });
    const asked = await ask(f.ctx, f.head.id, f.task.id, { kind: 'approval', text: 'Approve this exact main integration.', commit: merged });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    const moved = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated alongside independent work.', ...{ acceptance: { ...f.acceptance, integrationCommit: merged } } });
    expect(moved.task).toMatchObject({ status: 'done', turnId: null });
  });
  it('proves a main merge holds the candidate by the line of a comparison whose files GitHub capped at 300, and nothing else', async () => {
    const f = await readyFixture(false);
    const merged = 'd'.repeat(40);
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: 'branch' in ref && ref.branch === 'main' ? merged : f.finalCommit });
    let head = merged;
    f.ctx.readCompare = async (_repo, refs) => ({ complete: false, reason: 'too-many-files', lineage: { baseSha: refs.base, headSha: head, commits: [] } });
    const asked = await ask(f.ctx, f.head.id, f.task.id, { kind: 'approval', text: 'Approve this exact main integration.', commit: merged });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    const accept = () => report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated alongside independent work.', ...{ acceptance: { ...f.acceptance, integrationCommit: merged } } });
    head = 'e'.repeat(40);
    await expect(accept()).rejects.toMatchObject({ status: 409 });
    expect((await loadTask(f.db, f.task.id)).status).not.toBe('done');
    head = merged;
    expect((await accept()).task).toMatchObject({ status: 'done', turnId: null });
  });
  it('requires approval of the exact main integration commit under the every rule', async () => {
    const f = await readyFixture(false);
    await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
    const asked = await ask(f.ctx, f.head.id, f.task.id, { kind: 'approval', text: 'Approve a different commit.', commit: 'd'.repeat(40) });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'No main approval.', ...{ acceptance: f.acceptance } }).then(() => null)).rejects.toMatchObject({ status: 403 });
  });
  it("accepts the observed main commit with the responsible person's approval", async () => {
    const f = await readyFixture(false);
    await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
    const asked = await ask(f.ctx, f.head.id, f.task.id, { kind: 'approval', text: 'Approve this exact main integration.', commit: f.finalCommit });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    const moved = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Observed the approved main commit.', ...{ acceptance: f.acceptance } });
    expect(moved.task.status).toBe('done');
  });
  it('verifies, accepts and coordinates a non-main turn task branch without requiring run_tests on its commit', async () => {
    const f = await testsFixture();
    const group = (await f.create({ title: 'Coordinate release batch', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    const [existing] = await f.db.select().from(turns).where(and(eq(turns.companyId, f.task.companyId), eq(turns.status, 'open')));
    const turn = existing ?? (await f.db.insert(turns).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, number: 17, goal: 'Keep totals correct.', status: 'open', openedAt: new Date() }).returning())[0]!;
    await f.db.update(tasks).set({ parentId: group.id, turnId: turn.id }).where(eq(tasks.id, f.task.id));
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: f.finalCommit });
    const before = (await f.detail()).echelons;
    await report(f.ctx, f.tester.id, f.task.id, {
      done: true,
      summary: 'Verified named local tests, types and lint on the task branch.',
      verification: { candidateId: before.candidateId!, revision: before.revision },
    });
    const afterTests = (await f.detail()).echelons;
    const accepted = await report(f.ctx, f.head.id, f.task.id, {
      done: true,
      summary: 'Integrated the checked task branch into the turn branch.',
      acceptance: { candidateId: afterTests.candidateId!, revision: afterTests.revision, integrationCommit: f.finalCommit },
    });
    expect(accepted.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    const detail = await f.detail();
    expect(detail.log.findLast(event => event.kind === 'report')?.data).toMatchObject({
      acceptedCandidate: {
        candidateId: afterTests.candidateId,
        commit: f.finalCommit,
        integration: { branch: `turn-${turn.number}`, commit: f.finalCommit },
      },
    });
    const closedParent = await report(f.ctx, f.head.id, group.id, { done: true, summary: 'All turn branches accepted; ready for one release full run.' });
    expect(closedParent.task).toMatchObject({ status: 'done' });
  });
  it('verifies without run_tests a task of the department, which goes into its open turn though it joins none until accepted', async () => {
    const f = await testsFixture();
    await f.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, f.task.id));
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: f.finalCommit });
    const before = (await f.detail()).echelons;
    await report(f.ctx, f.tester.id, f.task.id, {
      done: true,
      summary: 'Verified named local tests, types and lint on the task branch.',
      verification: { candidateId: before.candidateId!, revision: before.revision },
    });
    const ready = (await f.detail()).echelons;
    const accepted = await report(f.ctx, f.head.id, f.task.id, {
      done: true,
      summary: 'Into the turn branch; the release runs the full suite once.',
      acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: f.finalCommit },
    });
    expect(accepted.task).toMatchObject({ status: 'done', turnId: expect.any(String) });
  });
  it('verifies by local checks a product whose results go to its own main line straight too', async () => {
    const f = await testsFixture();
    const [product] = await f.db.insert(departments).values({ companyId: f.task.companyId, parentId: f.task.departmentId!, roleCode: 'DEV', repoUrl: 'https://github.com/acme/app.git' }).returning();
    await f.db.update(tasks).set({ turnId: null, productId: product!.id }).where(eq(tasks.id, f.task.id));
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.verified());
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons.phase).toBe('ready');
  });
});

/* The shape of #1507 and #1511: a checked candidate whose base the turn went on from cannot reach the turn by fast-forward.
   A take-in task merges the turn into the candidate's branch, has the merge checked and accepted into the turn, and the
   candidate reached the turn in that merge. The server refuses a subtask under a candidate being checked, so the take-in is a
   task of its own, bound to the result by the branch it worked on and the merge it brought. */
describe('accepting a result that an accepted take-in of its branch brought into the turn', () => {
  const MERGE = 'e'.repeat(40);
  async function takenIn(options: { accepted?: boolean; ownBranch?: boolean } = {}) {
    const f = await readyFixture();
    const heads: Record<string, string> = { [f.integrationBranch]: f.finalCommit };
    f.ctx.readCommit = async (_repo, ref) => {
      const branch = 'branch' in ref ? ref.branch : `task-${ref.task}`;
      return { branch, commitSha: heads[branch] ?? MERGE };
    };
    const { task: takeIn } = await f.create({ title: `Take ${f.integrationBranch} into #${f.task.number}`, brief: 'Merge the turn into the candidate branch.', body: 'Merge the turn.' });
    const branch = options.ownBranch ? `task-${takeIn.number}` : `task-${f.task.number}`;
    await submit(f.ctx, f.author.id, takeIn.id, { summary: 'Merged the turn in.', evidence: 'Named checks.', review: { baseCommit: BASE, branch } });
    await verdict(f.ctx, f.reviewer.id, takeIn.id, { pass: true, comment: 'Checked the merge.', reviewedCommit: MERGE });
    await report(f.ctx, f.tester.id, takeIn.id, verified((await f.detail(takeIn.id)).echelons));
    heads[f.integrationBranch] = MERGE;
    if (options.accepted !== false) {
      const ready = (await f.detail(takeIn.id)).echelons;
      await report(f.ctx, f.head.id, takeIn.id, { done: true, summary: 'Fast-forwarded the turn to the checked merge.', acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: MERGE } });
      expect(await loadTask(f.db, takeIn.id)).toMatchObject({ status: 'done' });
    }
    const accept = () => report(f.ctx, f.head.id, f.task.id, { done: true, summary: `Reached ${f.integrationBranch} through the take-in.`, acceptance: { ...f.acceptance, integrationCommit: MERGE } });
    return { ...f, takeIn, accept };
  }
  const refusedStill = async (f: Awaited<ReturnType<typeof takenIn>>, message: string) => {
    await expect(f.accept()).rejects.toMatchObject({ status: 409, message: expect.stringContaining(message) as unknown });
    expect((await loadTask(f.db, f.task.id)).status).not.toBe('done');
  };

  it('accepts the result with the merge its accepted take-in brought into the turn, which holds its candidate', async () => {
    const f = await takenIn();
    expect((await f.accept()).task).toMatchObject({ status: 'done', assigneeAgentId: null });
    expect((await loadTask(f.db, f.task.id)).turnId).toBe((await loadTask(f.db, f.takeIn.id)).turnId);
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toMatchObject({
      acceptedCandidate: { candidateId: f.acceptance.candidateId, commit: f.finalCommit, integration: { branch: f.integrationBranch, commit: MERGE, takeIn: { taskId: f.takeIn.id, number: f.takeIn.number } } },
    });
  });

  it('refuses the merge of a take-in that does not hold the candidate', async () => {
    const f = await takenIn();
    f.ctx.readCompare = async (_repo, refs) => refs.base === f.finalCommit && refs.head === MERGE ? { complete: false, reason: 'not-an-ancestor' } : { complete: true, baseSha: refs.base, headSha: refs.head, paths: [], diff: '' };
    await refusedStill(f, `does not hold the candidate ${f.finalCommit}`);
  });

  it('refuses the merge of a take-in that is not accepted', async () => {
    await refusedStill(await takenIn({ accepted: false }), 'only by fast-forward');
  });

  it('refuses the merge of an accepted task that worked on another branch', async () => {
    await refusedStill(await takenIn({ ownBranch: true }), 'only by fast-forward');
  });
});
