import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testParts, testRuns } from '../src/db/schema.js';
import { report, submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';

describe('Tests verifies the final candidate without changing it', () => {
  it.each([false, true])('verifies an exact candidate with individual suite parts and final checks=%s', async finalChecks => {
    const f = await testsFixture();
    const run = await f.run(f.finalCommit, 1, { suitesOnly: true, finalChecks });
    expect(run.status).toBe('passed');
    expect(run.environmentSnapshot!.description.manifest.execution).toBeUndefined();
    const parts = await f.db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(testParts.part);
    expect(parts.map(part => part.environmentSelection!.selection)).toEqual([
      { kind: 'suite', suiteId: 'vitest', files: ['web/test/a.test.ts'] },
      ...(finalChecks ? [{ kind: 'final', suiteId: 'vitest', files: [] }] : []),
    ]);
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]));
    expect(moved.task.assigneeAgentId).toBe(f.head.id);
    expect((await f.detail()).echelons.phase).toBe('ready');
  });

  it('keeps the candidate and makes it ready for the head after verified exact parts', async () => {
    const f = await testsFixture(true);
    const run = await f.run();
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]));
    expect(moved.task).toMatchObject({ status: 'open', assigneeAgentId: f.head.id });
    expect((await f.detail()).echelons).toMatchObject({ phase: 'ready', candidateId: f.snapshot.candidateId });
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.head.id]);
  });
  /* Only a product run bound to the candidate narrows to the test files its change reaches; a command could run the whole suite. */
  it("refuses a manual command bound to the candidate on its task branch", async () => {
    const f = await testsFixture();
    await expect(f.manualRun()).rejects.toMatchObject({ reason: 'tests_not_release' });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it.each(['base', 'manifest', 'missing-fingerprint', 'duplicate-fingerprint', 'receipt', 'receipt-commit', 'selection'] as const)('rejects %s evidence after a product run has passed', async problem => {
    const f = await testsFixture(), run = await f.run();
    expect(run.status).toBe('passed');
    const snapshot = structuredClone(run.environmentSnapshot!);
    if (problem === 'base') snapshot.candidate!.baseCommit = 'f'.repeat(40);
    if (problem === 'manifest') snapshot.description.manifestHash = 'f'.repeat(64);
    if (problem === 'missing-fingerprint') snapshot.candidate!.fingerprints.pop();
    if (problem === 'duplicate-fingerprint') snapshot.candidate!.fingerprints.push(snapshot.candidate!.fingerprints[0]!);
    await f.db.update(testRuns).set({ environmentSnapshot: snapshot }).where(eq(testRuns.id, run.id));
    const [part] = await f.db.select().from(testParts).where(eq(testParts.runId, run.id));
    if (problem === 'receipt') await f.db.update(testParts).set({ environmentReceipt: null }).where(eq(testParts.id, part!.id));
    if (problem === 'receipt-commit') await f.db.update(testParts).set({ environmentReceipt: { ...part!.environmentReceipt!, commitSha: BASE } }).where(eq(testParts.id, part!.id));
    if (problem === 'selection') await f.db.update(testParts).set({ environmentSelection: { selection: { kind: 'suite', suiteId: 'vitest', files: ['web/test/other.test.ts'] }, after: [] } }).where(eq(testParts.id, part!.id));
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified([run.id])).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it.each([false, true])('refuses an omitted affected unit even when duplicate receipts pad the count=%s', async duplicate => {
    const f = await testsFixture(), run = await f.run(), snapshot = structuredClone(run.environmentSnapshot!);
    const unit = { ...snapshot.description.inventory[0]!, file: 'web/test/b.test.ts', selectionUnit: 'web/test/b.test.ts' };
    snapshot.description.inventory.push(unit);
    snapshot.candidate!.fingerprints.push({ suiteId: unit.suiteId, file: unit.file, fingerprint: '3'.repeat(64) });
    snapshot.candidate!.baseFingerprints.push({ suiteId: unit.suiteId, file: unit.file, fingerprint: '4'.repeat(64) });
    if (duplicate) {
      const [part] = await f.db.select().from(testParts).where(eq(testParts.runId, run.id));
      await f.db.insert(testParts).values({ ...part!, id: randomUUID(), part: 2 });
    }
    await f.db.update(testRuns).set({ environmentSnapshot: snapshot, parts: duplicate ? 2 : 1 }).where(eq(testRuns.id, run.id));
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified([run.id])).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it('keeps the applicable post-suite check in valid candidate evidence', async () => {
    const f = await testsFixture(), run = await f.run(f.finalCommit, 1, { finalChecks: true });
    expect(run.parts).toBe(2);
    expect((await report(f.ctx, f.tester.id, f.task.id, f.verified([run.id]))).task.status).toBe('open');
  });
  it('refuses a passed suite whose required post-suite check is missing', async () => {
    const f = await testsFixture(), run = await f.run(f.finalCommit, 1, { finalChecks: true });
    const parts = await f.db.select().from(testParts).where(eq(testParts.runId, run.id));
    const final = parts.find(part => part.environmentSelection?.selection.kind === 'final')!;
    await f.db.delete(testParts).where(eq(testParts.id, final.id));
    await f.db.update(testRuns).set({ parts: 1 }).where(eq(testRuns.id, run.id));
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
  it('refuses code of its own from Tests, which may take in only the main line', async () => {
    const f = await testsFixture();
    await expect(submit(f.ctx, f.tester.id, f.task.id, { summary: 'Tests must not edit code.', evidence: 'None.', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active', candidateId: f.snapshot.candidateId });
  });
});
