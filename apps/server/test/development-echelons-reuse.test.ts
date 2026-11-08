import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testParts, testRuns } from '../src/db/schema.js';
import { loadTask, report } from '../src/modules/tasks/engine.js';
import { currentCandidate } from '../src/modules/tasks/echelons-candidates.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { verifiedCandidateEvidence } from '../src/modules/tasks/echelons-tests.js';
import { testsFixture } from './development-echelons-verification.js';

describe('fingerprint reuse in final candidate evidence', () => {
  it('keeps the source fingerprints after temporary cache data is cleared', async () => {
    const f = await testsFixture(), source = await f.run(f.finalCommit, 1, { cache: true });
    expect(source.fileCache?.fingerprints).toEqual([]);
    expect(source.fileCache).toMatchObject({ verifiedFingerprints: source.environmentSnapshot!.candidate!.fingerprints });
  });
  it.each([false, true])('reuses an attested candidate unit while retaining required final checks=%s', async finalChecks => {
    const f = await testsFixture();
    const source = await f.run(f.finalCommit, 1, { cache: true, finalChecks });
    expect(source.status).toBe('passed');
    const reused = await f.run(f.finalCommit, 1, { cache: true, finalChecks });
    expect(reused.status).toBe('passed');
    expect(reused.parts).toBe(finalChecks ? 1 : 0);
    expect(reused.fileCache).toMatchObject({ mode: 'cached', reused: 1, reusedUnits: [{ suiteId: 'vitest', file: 'web/test/a.test.ts', fingerprint: '1'.repeat(64), runId: source.id, commitSha: f.finalCommit }] });
    const parts = await f.db.select().from(testParts).where(eq(testParts.runId, reused.id));
    expect(parts.map(part => part.environmentSelection!.selection.kind)).toEqual(finalChecks ? ['final'] : []);
    const moved = await report(f.ctx, f.tester.id, f.task.id, f.verified([reused.id]));
    expect(moved.task.assigneeAgentId).toBe(f.head.id);
    expect((await f.detail()).echelons.phase).toBe('ready');
  });
  it.each(['missing', 'failed', 'receipt', 'commit', 'repository', 'fingerprint'] as const)('refuses a reused result with %s source evidence', async problem => {
    const f = await testsFixture(), source = await f.run(f.finalCommit, 1, { cache: true });
    const reused = await f.run(f.finalCommit, 1, { cache: true });
    expect(reused.parts).toBe(0);
    if (problem === 'missing') {
      const fileCache = structuredClone(reused.fileCache!);
      fileCache.reusedUnits![0]!.runId = randomUUID();
      await f.db.update(testRuns).set({ fileCache }).where(eq(testRuns.id, reused.id));
    }
    if (problem === 'failed') await f.db.update(testParts).set({ status: 'failed', exitCode: 1 }).where(eq(testParts.runId, source.id));
    if (problem === 'receipt') await f.db.update(testParts).set({ environmentReceipt: null }).where(eq(testParts.runId, source.id));
    if (problem === 'commit') await f.db.update(testRuns).set({ commitSha: 'd'.repeat(40) }).where(eq(testRuns.id, source.id));
    if (problem === 'repository' || problem === 'fingerprint') {
      const snapshot = structuredClone(source.environmentSnapshot!);
      if (problem === 'repository') snapshot.description.repositoryScope.repoUrlHash = 'd'.repeat(64);
      else snapshot.candidate!.fingerprints[0]!.fingerprint = 'd'.repeat(64);
      await f.db.update(testRuns).set({ environmentSnapshot: snapshot }).where(eq(testRuns.id, source.id));
    }
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified([reused.id])).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.phase).toBe('active');
  });
  it('revalidates the original reused source after the Tests report', async () => {
    const f = await testsFixture(), source = await f.run(f.finalCommit, 1, { cache: true });
    const reused = await f.run(f.finalCommit, 1, { cache: true });
    expect(reused.parts).toBe(0);
    await report(f.ctx, f.tester.id, f.task.id, f.verified([reused.id]));
    await f.db.update(testParts).set({ environmentReceipt: null }).where(eq(testParts.runId, source.id));
    const task = await loadTask(f.db, f.task.id), route = await routeOf(f.db, task), candidate = await currentCandidate(f.db, task, route);
    await expect(verifiedCandidateEvidence(f.db, task, route, candidate).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
});
