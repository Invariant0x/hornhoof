import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, tasks, testParts, turns } from '../src/db/schema.js';
import { answer, ask, loadTask, report } from '../src/modules/tasks/engine.js';
import { testsFixture } from './development-echelons-verification.js';

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
  const run = await f.run();
  await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]));
  const route = (await f.detail()).echelons;
  const acceptance = { candidateId: route.candidateId!, revision: route.revision, integrationCommit: f.finalCommit };
  return { ...f, acceptance, run, integrationBranch };
}

describe('accepting only a checked and integrated candidate', () => {
  it('closes the ready result for its head after reading the exact turn integration', async () => {
    const f = await readyFixture();
    const moved = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Integrated the checked candidate.', ...{ acceptance: f.acceptance } });
    expect(moved.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({ phase: 'done', candidateId: f.acceptance.candidateId });
    expect(detail.log.findLast(event => event.kind === 'report')?.data).toMatchObject({ acceptedCandidate: {
      candidateId: f.acceptance.candidateId, commit: f.finalCommit, routeRevision: detail.echelons.revision,
      evidence: [{ runId: f.run.id, commit: f.finalCommit }], integration: { branch: f.integrationBranch, commit: f.finalCommit },
    } });
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
  it('refuses acceptance when a Tests part became invalid after its report', async () => {
    const f = await readyFixture();
    await f.db.update(testParts).set({ status: 'failed', exitCode: 1 }).where(eq(testParts.runId, f.run.id));
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'The evidence changed.', ...{ acceptance: f.acceptance } }).then(() => null)).rejects.toMatchObject({ status: 409 });
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
  it('requires a real human approval of the exact main integration commit', async () => {
    const f = await readyFixture(false);
    await expect(report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'No main approval.', ...{ acceptance: f.acceptance } }).then(() => null)).rejects.toMatchObject({ status: 403 });
  });
  it('accepts the observed main commit only after the normal human approval route', async () => {
    const f = await readyFixture(false);
    const asked = await ask(f.ctx, f.head.id, f.task.id, { kind: 'approval', text: 'Approve this exact main integration.', commit: f.finalCommit });
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, asked.request.id, { approve: true });
    const moved = await report(f.ctx, f.head.id, f.task.id, { done: true, summary: 'Observed the approved main commit.', ...{ acceptance: f.acceptance } });
    expect(moved.task.status).toBe('done');
  });
});
