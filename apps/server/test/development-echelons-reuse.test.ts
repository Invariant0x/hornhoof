import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testParts } from '../src/db/schema.js';
import { report } from '../src/modules/tasks/engine.js';
import { testsFixture } from './development-echelons-verification.js';

describe('fingerprint reuse in final candidate evidence', () => {
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
});
