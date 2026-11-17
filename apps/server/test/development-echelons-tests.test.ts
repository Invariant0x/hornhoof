import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { report, submit } from '../src/modules/tasks/engine.js';
import { BASE } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';

describe('Tests verifies the final candidate without changing it', () => {
  it.each([false, true])('keeps the candidate and makes it ready for the head on its report (fixed in Review=%s)', async fix => {
    const f = await testsFixture(fix);
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.verified());
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'ready', candidateId: f.snapshot.candidateId });
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.head.id]);
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toEqual({ verifiedCandidate: {
      candidateId: f.snapshot.candidateId, commit: f.finalCommit, routeRevision: f.snapshot.revision + 1, testedRevision: f.snapshot.revision,
    } });
  });
  it('takes the report of an agent that still names its test runs, as an earlier build asked, and leaves them out', async () => {
    const f = await testsFixture();
    const { verification } = f.verified();
    const moved = await report(f.ctx, f.tester.id, f.task.id, { ...f.verified(), verification: { ...verification, runIds: [randomUUID()] } });
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).log.findLast(event => event.kind === 'report')?.data).toEqual({ verifiedCandidate: {
      candidateId: f.snapshot.candidateId, commit: f.finalCommit, routeRevision: f.snapshot.revision + 1, testedRevision: f.snapshot.revision,
    } });
  });
  it('refuses a report that names a field no build knew', async () => {
    const f = await testsFixture();
    const { verification } = f.verified();
    await expect(report(f.ctx, f.tester.id, f.task.id, { ...f.verified(), verification: { ...verification, runs: [] } as typeof verification }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it.each(['candidate', 'revision'] as const)('refuses a report naming another %s', async problem => {
    const f = await testsFixture();
    const { verification } = f.verified();
    const named = problem === 'candidate' ? { ...verification, candidateId: randomUUID() } : { ...verification, revision: verification.revision + 1 };
    await expect(report(f.ctx, f.tester.id, f.task.id, { ...f.verified(), verification: named }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it('refuses a hand-in from Tests that holds nothing beyond the candidate it received', async () => {
    const f = await testsFixture();
    await expect(submit(f.ctx, f.tester.id, f.task.id, { summary: 'Nothing new.', evidence: 'None.', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('still at the candidate you received') as unknown });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: f.snapshot.candidateId });
  });
});
