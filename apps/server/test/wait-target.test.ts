import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks, waitNotices } from '../src/db/schema.js';
import { checkedWaitTarget } from '../src/modules/tasks/wait-target.js';
import { waitCompany } from './wait-company.js';

describe('task wait and work targets', () => {
  it('records work and a next check without an employee notice', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    const until = new Date(Date.now() + 60_000).toISOString();
    const old = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Registry', until } });
    expect(old.isError).toBe(true);
    const result = await worker.client.callTool({ name: 'track_work', arguments: { task: task.number, work: 'Registry', nextCheck: until } });
    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ reason: 'Registry', until, work: true });
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it.each(['time', 'ceo', 'machine', 'other'] as const)('preserves a stored external event and rejects a new wait for it: %s', async event => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    const wait = { reason: 'Registry', since: new Date().toISOString(), until: new Date(Date.now() + 60_000).toISOString(), on: { kind: 'external' as const, event } };
    await c.db.update(tasks).set({ externalWait: wait }).where(eq(tasks.id, task.id));
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'New request', until: wait.until, on: wait.on } });
    expect(result.isError).toBe(true);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toEqual(wait);
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it.each(['self', 'self in capitals', 'unknown', 'removed', 'off', 'no subscription'])('rejects an unavailable employee without changing the progress check: %s', async target => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    if (target === 'removed') await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
    if (target === 'off') await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.head.id));
    if (target === 'no subscription') await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.head.id));
    const employee = target === 'self' ? c.agent.id : target === 'self in capitals' ? c.agent.id.toUpperCase() : target === 'unknown' ? randomUUID() : c.head.id;
    const nextCheck = new Date(Date.now() + 60_000).toISOString();
    expect((await worker.client.callTool({ name: 'track_work', arguments: { task: task.number, work: 'Registry', nextCheck } })).isError).toBeFalsy();
    const [before] = await c.db.select().from(tasks).where(eq(tasks.id, task.id));
    const result = await worker.client.callTool({ name: 'track_work', arguments: { task: task.number, work: 'Acceptance', nextCheck, employee } });
    expect(result.isError).toBe(true);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ version: before!.version, externalWait: before!.externalWait });
    expect(await c.messages(c.head.id)).toEqual([]);
    expect(await c.db.select().from(waitNotices)).toEqual([]);
  });

  it('does not resolve an employee outside the task company', async () => {
    const c = await waitCompany();
    await expect(checkedWaitTarget(c.ctx, randomUUID(), c.agent.id, { kind: 'employee', employee: c.head.id })).rejects.toMatchObject({ reason: 'task_invalid' });
  });

  it('records the employee name from company data instead of a caller label', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    const result = await worker.client.callTool({ name: 'track_work', arguments: { task: task.number, work: 'Acceptance', nextCheck: new Date(Date.now() + 60_000).toISOString(), employee: c.head.id.toUpperCase(), name: 'Wrong name' } });
    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ work: true, on: { employee: c.head.id, name: c.head.name } });
  });
});
