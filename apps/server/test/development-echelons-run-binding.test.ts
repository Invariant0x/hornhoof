import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, taskEvents, taskRoutes, tasks, testRuns } from '../src/db/schema.js';
import { report } from '../src/modules/tasks/engine.js';
import { startRun } from '../src/modules/testruns/runs.js';
import { testsFixture } from './development-echelons-verification.js';

async function fixture() {
  const f = await testsFixture();
  const jobFor = async (actor = f.tester) => {
    const [job] = await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: actor.id, subscriptionId: actor.subscriptionId!, taskId: f.task.id, kind: 'conversation', prompt: 'Check the current candidate', timeoutMs: 1000 }).returning();
    return { id: job!.id, companyId: f.task.companyId, agentId: actor.id, agentKind: actor.kind, departmentId: actor.departmentId };
  };
  const job = await jobFor();
  const candidate = { candidateId: f.snapshot.candidateId!, revision: f.snapshot.revision };
  const input = { task: f.task.number, candidate };
  const runs = () => f.db.select().from(testRuns).where(eq(testRuns.taskId, f.task.id));
  return { ...f, job, jobFor, candidate, input, runs };
}

describe('Tests run ownership and immutable source binding', () => {
  it('records the exact source and route when the current Tests owner starts a run', async () => {
    const f = await fixture();
    await startRun(f.ctx, f.job, f.input);
    const [run] = await f.runs();
    const events = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'comment')));
    expect(events.map(event => event.data)).toContainEqual(expect.objectContaining({ candidateRun: {
      runId: run!.id, candidateId: f.candidate.candidateId, routeRevision: f.candidate.revision,
      baseCommit: 'a'.repeat(40), commit: f.finalCommit, branch: 'task-1', testerId: f.tester.id,
    } }));
  });
  it('passes the immutable candidate base into product environment discovery', async () => {
    const f = await fixture();
    await startRun(f.ctx, f.job, { task: f.task.number, candidate: f.candidate });
    const [run] = await f.runs();
    expect(run!.environmentRequest).toMatchObject({ baseCommit: 'a'.repeat(40) });
    expect(run!.commitSha).toBe(f.finalCommit);
  });

  it.each(['missing', 'candidate', 'revision', 'branch', 'head'])('refuses a %s mismatch before queuing a run', async problem => {
    const f = await fixture();
    const candidate = { ...f.candidate };
    if (problem === 'candidate') candidate.candidateId = randomUUID();
    if (problem === 'revision') candidate.revision--;
    if (problem === 'head') f.atCommit('d'.repeat(40));
    const input = { ...f.input, candidate: problem === 'missing' ? undefined : candidate, ...(problem === 'branch' ? { branch: 'other' } : {}) };
    await expect(startRun(f.ctx, f.job, input).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect(await f.runs()).toEqual([]);
  });
  it('refuses a former author starting checks for the current Tests stage', async () => {
    const f = await fixture();
    await expect(startRun(f.ctx, await f.jobFor(f.author), f.input).then(() => null)).rejects.toMatchObject({ status: 403 });
    expect(await f.runs()).toEqual([]);
  });
  it('revalidates ownership after reading the remote source', async () => {
    const f = await fixture();
    f.ctx.readCommit = async () => {
      await f.db.update(tasks).set({ assigneeAgentId: f.head.id }).where(eq(tasks.id, f.task.id));
      return { branch: 'task-1', commitSha: f.finalCommit };
    };
    await expect(startRun(f.ctx, f.job, f.input).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect(await f.runs()).toEqual([]);
  });
  it('does not certify a passed run that has no server-owned candidate binding', async () => {
    const f = await fixture();
    const run = await f.run();
    await f.db.delete(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'comment')));
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified([run.id])).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it('does not certify an earlier assignment revision even when the SHA is unchanged', async () => {
    const f = await fixture();
    const run = await f.run();
    await f.db.update(taskRoutes).set({ revision: f.snapshot.revision + 1 }).where(eq(taskRoutes.taskId, f.task.id));
    const verification = { candidateId: f.snapshot.candidateId!, revision: f.snapshot.revision + 1, runIds: [run.id] };
    await expect(report(f.ctx, f.tester.id, f.task.id, { done: true, summary: 'An older assignment checked this SHA.', verification }).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
});
