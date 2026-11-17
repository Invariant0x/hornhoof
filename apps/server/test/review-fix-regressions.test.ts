import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, taskEvents } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, FIRST, fixture, rejectedFinding } from './review-fixture.js';

const problem = { category: 'data' as const, blocking: true, path: 'logic/totals.ts', line: 3, harm: 'A buyer loses the cart total.' };

describe('candidate source regressions', () => {
  it('retains historical vendor credit when the original reviewer is unavailable', async () => {
    const f = await rejectedFinding();
    await f.db.update(agents).set({ switchedOffAt: new Date(), removedAt: new Date(), subscriptionId: f.author.subscriptionId }).where(eq(agents.id, f.reviewer.id));
    expect((await f.confirm()).isError).toBeFalsy();
    /* The reviewer left the company, so its tools stop: the head reads the task. */
    expect((await f.read(f.head)).reviewFindings.byVendor).toEqual([{ vendor: 'codex', count: 1, findingIds: [f.finding.findingId] }]);
  });

  it('rejects blocking findings attached to PASS', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Good', reviewedCommit: FIRST, issues: [problem] })).rejects.toMatchObject({ reason: 'task_invalid' });
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'verdict')))).toEqual([]);
  });
});
