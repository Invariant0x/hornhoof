import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs, taskEvents, taskRoutes, testParts, testRuns } from '../src/db/schema.js';
import { finishAuthorCheck } from '../src/modules/tasks/author-check-completion.js';
import { submitWithAuthorCheck } from '../src/modules/tasks/author-check-submit.js';
import { submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const input = { summary: 'Keep totals.', evidence: 'Affected checks.', review: { baseCommit: BASE, authorCheckPlan: 'plan-text' } };
async function authorFixture(repair = false) {
  const f = await fixture();
  if (repair) {
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Initial code.', evidence: 'Checked.', review: { baseCommit: BASE } });
    f.atCommit('c'.repeat(40));
  }
  f.ctx.config.authorCheck = true;
  const jobFor = async (actor = f.author) => {
    const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: actor.id, subscriptionId: actor.subscriptionId!, taskId: f.task.id, kind: 'conversation', prompt: 'Submit checked code', timeoutMs: 1000 }).returning();
    return { id: job!.id, companyId: f.task.companyId, agentId: actor.id, agentKind: actor.kind, departmentId: actor.departmentId };
  };
  const pending = async () => {
    const events = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'updated'))).orderBy(desc(taskEvents.id));
    return events.find(event => event.data.authorCheckPending)!.data.authorCheckPending as { runId: string; review: { authorId: string } };
  };
  return { ...f, jobFor, pending };
}

async function finishPassed(f: Awaited<ReturnType<typeof authorFixture>>) {
  const pending = await f.pending();
  const [run] = await f.db.select().from(testRuns).where(eq(testRuns.id, pending.runId));
  const printed = { version: 1, submissionCommit: run!.commitSha, checkCommit: run!.commitSha,
    scope: { kind: 'changed', paths: ['logic/totals.ts'] },
    stages: ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'].map(name => ({ name, status: 'passed', exitCode: 0, partId: null })),
    numbers: { tests: { passed: 2, failed: 0, skipped: 0, total: 2 }, changedLines: { covered: 4, total: 4 }, worstCrap: 2, dryerFlags: 0 },
  };
  await f.db.update(testRuns).set({ status: 'passed', finishedAt: new Date() }).where(eq(testRuns.id, run!.id));
  await f.db.update(testParts).set({ status: 'passed', commit: run!.commitSha, exitCode: 0, error: null, finishedAt: new Date(), tail: `AUTHOR_CHECK ${JSON.stringify(printed)}` }).where(eq(testParts.runId, run!.id));
  return finishAuthorCheck(f.ctx, run!.id);
}

describe('an author-check follows its current producer and route', () => {
  it('refuses another employee replaying a matching pending submission', async () => {
    const f = await authorFixture();
    await submitWithAuthorCheck(f.ctx, await f.jobFor(), f.task.id, input);
    await expect(submitWithAuthorCheck(f.ctx, await f.jobFor(f.reviewer), f.task.id, input).then(() => null)).rejects.toMatchObject({ status: 403 });
  });
  it('pins the checker as the producer of its own repair check', async () => {
    const f = await authorFixture(true);
    await submitWithAuthorCheck(f.ctx, await f.jobFor(f.reviewer), f.task.id, input);
    expect((await f.pending()).review.authorId).toBe(f.reviewer.id);
  });
  it('does not borrow another producer run merely because its command and SHA match', async () => {
    const f = await authorFixture(true);
    const oldJob = await f.jobFor();
    const commit = 'c'.repeat(40);
    await f.db.insert(testRuns).values({ companyId: f.task.companyId, number: 1, taskId: f.task.id, departmentId: f.task.departmentId, agentId: f.author.id, jobId: oldJob.id, branch: 'task-1', commitSha: commit, command: `npm run -s check:author -- --sha ${commit} --base ${BASE} --plan 'plan-text'`, timeoutMs: 1000 });
    await submitWithAuthorCheck(f.ctx, await f.jobFor(f.reviewer), f.task.id, input);
    const pending = await f.pending();
    const [run] = await f.db.select().from(testRuns).where(eq(testRuns.id, pending.runId));
    expect(run!.agentId).toBe(f.reviewer.id);
    expect(run!.commitSha).toBe(commit);
  });
  it('refuses a pending replay after the route revision changes', async () => {
    const f = await authorFixture();
    const job = await f.jobFor();
    await submitWithAuthorCheck(f.ctx, job, f.task.id, input);
    const [route] = await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, f.task.id));
    await f.db.update(taskRoutes).set({ revision: route!.revision + 1 }).where(eq(taskRoutes.taskId, f.task.id));
    await expect(submitWithAuthorCheck(f.ctx, job, f.task.id, input).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it('does not apply a completed old check or record its quality after the route changes', async () => {
    const f = await authorFixture();
    await submitWithAuthorCheck(f.ctx, await f.jobFor(), f.task.id, input);
    const pending = await f.pending();
    const [route] = await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, f.task.id));
    await f.db.update(taskRoutes).set({ revision: route!.revision + 1 }).where(eq(taskRoutes.taskId, f.task.id));
    await f.db.update(testRuns).set({ status: 'failed', finishedAt: new Date() }).where(eq(testRuns.id, pending.runId));
    await f.db.update(testParts).set({ status: 'failed', commit: HEAD, error: 'failed', exitCode: 1, finishedAt: new Date() }).where(eq(testParts.runId, pending.runId));
    await expect(finishAuthorCheck(f.ctx, pending.runId).then(() => null)).rejects.toMatchObject({ status: 409 });
    const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id));
    expect(events.filter(event => event.data.authorCheck || event.data.authorCheckOutcome)).toEqual([]);
  });
  it('completes a repair check under the fixing checker with its own quality receipt', async () => {
    const f = await authorFixture(true);
    await submitWithAuthorCheck(f.ctx, await f.jobFor(f.reviewer), f.task.id, input);
    await finishPassed(f);
    const event = (await f.detail()).log.findLast(row => row.kind === 'submitted');
    expect(event?.data).toMatchObject({ candidate: { parentId: expect.any(String), producedBy: { agentId: f.reviewer.id, stage: 'review' } }, review: { authorId: f.reviewer.id, quality: { status: 'passed', record: { authorId: f.reviewer.id } } } });
  });
  it('preserves the submission operation across completion and an acknowledged replay', async () => {
    const f = await authorFixture();
    const job = await f.jobFor();
    const request = { ...input, operationId: randomUUID() };
    await submitWithAuthorCheck(f.ctx, job, f.task.id, request);
    await finishPassed(f);
    const again = await submitWithAuthorCheck(f.ctx, job, f.task.id, request);
    expect(again.wakes).toEqual([]);
    expect((await f.detail()).log.filter(row => row.kind === 'submitted')).toHaveLength(1);
    expect((await f.detail()).log.findLast(row => row.kind === 'submitted')?.data).toMatchObject({ operation: { id: request.operationId } });
  });
  it('does not complete a check after its producer model changes', async () => {
    const f = await authorFixture();
    await submitWithAuthorCheck(f.ctx, await f.jobFor(), f.task.id, input);
    const pending = await f.pending();
    await f.db.update(agents).set({ model: 'gpt-6-luna' }).where(eq(agents.id, f.author.id));
    await f.db.update(testRuns).set({ status: 'failed', finishedAt: new Date() }).where(eq(testRuns.id, pending.runId));
    await f.db.update(testParts).set({ status: 'failed', commit: HEAD, error: 'failed', exitCode: 1, finishedAt: new Date() }).where(eq(testParts.runId, pending.runId));
    await expect(finishAuthorCheck(f.ctx, pending.runId).then(() => null)).rejects.toMatchObject({ status: 409 });
    const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id));
    expect(events.filter(event => event.data.authorCheck || event.data.authorCheckOutcome)).toEqual([]);
  });

});
