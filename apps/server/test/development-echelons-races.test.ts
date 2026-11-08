import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, subscriptions, taskEvents } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Keep totals.', evidence: 'Changed tests passed.', review: { baseCommit: BASE } };

describe('one current assignment under retries and identity changes', () => {
  it('acknowledges both concurrent copies of one submission but commits one candidate', async () => {
    const f = await fixture();
    const input = { ...code, operationId: randomUUID() };
    const results = await Promise.allSettled([submit(f.ctx, f.author.id, f.task.id, input), submit(f.ctx, f.author.id, f.task.id, input)]);
    expect(results.map(value => value.status)).toEqual(['fulfilled', 'fulfilled']);
    const events = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(events).toHaveLength(1);
    expect((await f.detail()).echelons.ownerAgentId).toBe(f.reviewer.id);
  });
  it('does not accept the checking assignment after its subscription changes', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    const [plan] = await f.db.insert(subscriptions).values({ companyId: f.task.companyId, provider: 'claude', kind: 'personal', label: 'Another plan', status: 'ready' }).returning();
    await f.db.update(agents).set({ subscriptionId: plan!.id }).where(eq(agents.id, f.reviewer.id));
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Old assignment.', reviewedCommit: HEAD }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.stage).toBe('review');
  });
  it('does not accept a checker whose required skill was removed after handoff', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    await f.db.update(agents).set({ skills: [] }).where(eq(agents.id, f.reviewer.id));
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'I no longer have this ability.', reviewedCommit: HEAD }).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
});
