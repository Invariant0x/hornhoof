import { taskForWake } from '../src/modules/tasks/wake-state.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tasks } from '../src/db/schema.js';
import { report } from '../src/modules/tasks/engine.js';
import { testsFixture } from './development-echelons-verification.js';

async function failedFixture() {
  const f = await testsFixture();
  const input = { ...f.verified(), done: false, summary: 'web/test/a.test.ts fails on the candidate.' };
  return { ...f, input };
}

describe('Tests failure belongs to the current candidate', () => {
  it('escalates a failing check to the head without returning it to the author', async () => {
    const f = await failedFixture();
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.input);
    expect(moved.task).toMatchObject({ status: 'blocked', assigneeAgentId: null });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'escalated', stage: 'tests', candidateId: f.snapshot.candidateId });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
    expect(await taskForWake(f.db, moved.wakes[0]!)).toMatchObject({ id: f.task.id });
    /* The tracker's move notes where the status went, beside what the failed check names. */
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toEqual({
      failedVerification: { candidateId: f.snapshot.candidateId, routeRevision: f.snapshot.revision },
      fromStatus: 'open',
      toStatus: 'blocked',
    });
  });
  it('escalates to the department head when a worker originally created the task', async () => {
    const f = await failedFixture();
    await f.db.update(tasks).set({ createdByAgentId: f.author.id }).where(eq(tasks.id, f.task.id));
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.input);
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
    expect(await taskForWake(f.db, moved.wakes[0]!)).toMatchObject({ id: f.task.id });
  });
  it('never sends a failed candidate back to its author on Development, whatever the report asks', async () => {
    const f = await failedFixture();
    const backwards = { ...f.input.verification, defect: true };
    await expect(report(f.ctx, f.tester.id, f.task.id, { ...f.input, verification: backwards })).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'active', stage: 'tests', candidateId: f.snapshot.candidateId });
    expect((await f.detail()).echelons.stages.find(step => step.stage === 'development')?.status).toBe('complete');
    expect((await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)))[0]).toMatchObject({ assigneeAgentId: f.tester.id });
  });
  it('refuses a former owner reporting a Tests failure', async () => {
    const f = await failedFixture();
    await expect(report(f.ctx, f.author.id, f.task.id, f.input).then(() => null)).rejects.toMatchObject({ status: 403 });
  });
});
