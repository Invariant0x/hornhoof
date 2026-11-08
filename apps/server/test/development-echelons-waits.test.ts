import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskWaits } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, FIRST, fixture } from './development-echelons-fixture.js';

describe('waits follow the required checking owner', () => {
  it('binds Review to its current candidate and ends that wait on forward handoff', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed tests.', review: { baseCommit: BASE } });
    const candidateId = (await f.detail()).echelons.candidateId;
    const open = () => f.db.select().from(taskWaits).where(and(eq(taskWaits.taskId, f.task.id), eq(taskWaits.kind, 'review'), isNull(taskWaits.endedAt)));
    expect(await open()).toEqual([expect.objectContaining({ ownerAgentId: f.reviewer.id, sourceKey: `review:${f.task.id}:${candidateId}:${f.reviewer.id}` })]);
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Correct.', reviewedCommit: FIRST });
    expect(await open()).toEqual([]);
  });
});
