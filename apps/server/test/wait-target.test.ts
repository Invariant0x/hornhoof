import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks, waitNotices } from '../src/db/schema.js';
import { checkedWaitTarget } from '../src/modules/tasks/wait-target.js';
import { waitCompany } from './wait-company.js';

describe('named task waits', () => {
  it('keeps the old reason and deadline call valid without a recipient notice', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    const until = new Date(Date.now() + 60_000).toISOString();
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Registry', until } });
    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ reason: 'Registry', until });
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it.each(['time', 'ceo', 'machine', 'other'])('records an explicit external event: %s', async event => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Registry', until: new Date(Date.now() + 60_000).toISOString(), on: { kind: 'external', event } } });
    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ on: { kind: 'external', event } });
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it.each(['self', 'self in capitals', 'unknown', 'removed', 'off', 'no subscription'])('rejects an unavailable employee target without changing the wait: %s', async target => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    if (target === 'removed') await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.head.id));
    if (target === 'off') await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.head.id));
    if (target === 'no subscription') await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.head.id));
    const employee = target === 'self' ? c.agent.id : target === 'self in capitals' ? c.agent.id.toUpperCase() : target === 'unknown' ? randomUUID() : c.head.id;
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Acceptance', until: new Date(Date.now() + 60_000).toISOString(), on: { kind: 'employee', employee } } });
    expect(result.isError).toBe(true);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
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
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Acceptance', until: new Date(Date.now() + 60_000).toISOString(), on: { kind: 'employee', employee: c.head.id, name: 'Wrong name' } } });
    expect(result.isError).toBeFalsy();
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ on: { name: c.head.name } });
  });
});
