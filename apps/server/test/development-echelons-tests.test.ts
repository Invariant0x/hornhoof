import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testParts } from '../src/db/schema.js';
import { report, submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';

describe('Tests verifies the final candidate without changing it', () => {
  it('keeps the candidate and makes it ready for the head after verified exact parts', async () => {
    const f = await testsFixture(true);
    const run = await f.run();
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]));
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'ready', candidateId: f.snapshot.candidateId });
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.head.id]);
  });
  it('does not accept a passed manual command as proof of the candidate applicable test scope', async () => {
    const f = await testsFixture();
    const run = await f.manualRun();
    expect(run.command).toBe('Changed tests');
    expect(run.environmentSnapshot).toBeNull();
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified([run.id])).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it('rejects an author receipt made before the checker changed the commit', async () => {
    const f = await testsFixture(true);
    const run = await f.run(HEAD);
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified([run.id])).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['missing', 'unfinished', 'wrong-part-commit', 'zero-parts', 'duplicate'])('rejects %s evidence', async problem => {
    const f = await testsFixture();
    const run = await f.run(f.finalCommit, problem === 'zero-parts' ? 0 : 1);
    if (problem === 'unfinished') await f.db.update(testParts).set({ status: 'running', exitCode: null }).where(eq(testParts.runId, run.id));
    if (problem === 'wrong-part-commit') await f.db.update(testParts).set({ commit: BASE }).where(eq(testParts.runId, run.id));
    const ids = problem === 'missing' ? [randomUUID()] : problem === 'duplicate' ? [run.id, run.id] : [run.id];
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified(ids)).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it('refuses code submission from Tests', async () => {
    const f = await testsFixture();
    await expect(submit(f.ctx, f.tester.id, f.task.id, { summary: 'Tests must not edit code.', evidence: 'None.', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 403 });
  });
});
