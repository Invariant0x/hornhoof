import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, tasks, waitNotices } from '../src/db/schema.js';
import { deliverWaitNotices, recordWaitNotice, requestedWaitNotice } from '../src/modules/tasks/wait-notices.js';
import type { mcp } from './helpers.js';
import { waitCompany } from './wait-company.js';

describe('wait recipient notices', () => {
  it('does not create a recipient notice for a task with no wait', async () => {
    const c = await waitCompany();
    expect(await requestedWaitNotice(c.ctx, await c.task(), c.agent.id)).toBeNull();
  });

  it('wakes the employee with the recorded waiter, reason, task and deadline', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const worker = await c.run();
    const until = new Date(Date.now() + 60_000).toISOString();
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Acceptance on a-host', until, on: { kind: 'employee', employee: c.head.id } } });
    expect(result.isError).toBeFalsy();
    const [message] = await c.messages(c.head.id);
    expect(message).toMatchObject({ data: { notification: { source: 'wait_requested', tasks: [{ id: task.id, number: task.number }] }, actor: { kind: 'agent', id: c.agent.id } } });
    expect(message!.data).toMatchObject({ text: expect.stringContaining('Acceptance on a-host') });
    expect(message!.data).toMatchObject({ text: expect.stringContaining(c.agent.name) });
    expect(message!.data).toMatchObject({ text: expect.stringContaining(until) });
    expect((await c.turnsOf(c.head.id))[0]).toMatchObject({ status: 'running' });
    expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ on: { kind: 'employee', employee: c.head.id, name: c.head.name } });
  });

  it('puts a named wait into the employee running turn through the live input path', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const receiver = await c.run(c.head.id);
    const worker = await c.run();
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Acceptance', until: new Date(Date.now() + 60_000).toISOString(), on: { kind: 'employee', employee: c.head.id } } });
    expect(result.isError).toBeFalsy();
    expect((await c.messages(c.head.id))[0]).toMatchObject({ jobId: receiver.job.id });
  });

  it('retries a durable request after a restart and lease expiry without duplicating accepted input', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const now = new Date();
    const wait = { reason: 'Acceptance', since: now.toISOString(), until: new Date(now.getTime() + 3_600_000).toISOString(), on: { kind: 'employee' as const, employee: c.head.id, name: c.head.name } };
    await c.db.update(tasks).set({ externalWait: wait }).where(eq(tasks.id, task.id));
    const notice = (await requestedWaitNotice(c.ctx, { ...task, externalWait: wait }, c.agent.id))!;
    await recordWaitNotice(c.db, notice);
    await recordWaitNotice(c.db, notice);
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.head.id));
    await deliverWaitNotices(c.ctx, now);
    expect(await c.messages(c.head.id)).toEqual([]);
    expect((await c.db.select().from(waitNotices))[0]!.deliveredAt).toBeNull();
    await c.db.update(agents).set({ subscriptionId: c.sub.id }).where(eq(agents.id, c.head.id));
    await deliverWaitNotices({ ...c.ctx }, new Date(now.getTime() + 119_999));
    expect(await c.messages(c.head.id)).toEqual([]);
    const later = new Date(now.getTime() + 120_000);
    await Promise.all([deliverWaitNotices({ ...c.ctx }, later), deliverWaitNotices({ ...c.ctx }, later)]);
    await deliverWaitNotices(c.ctx, new Date(later.getTime() + 120_000));
    expect(await c.messages(c.head.id)).toHaveLength(1);
    const rows = await c.db.select().from(waitNotices);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveredAt).not.toBeNull();
  });

  it.each(['changed', 'replaced', 'expired'])('discards a pending %s request before queue acceptance', async state => {
    const c = await waitCompany();
    const task = await c.task();
    const now = new Date();
    const wait = { reason: 'Acceptance', since: now.toISOString(), until: new Date(now.getTime() + 60_000).toISOString(), on: { kind: 'employee' as const, employee: c.head.id } };
    await c.db.update(tasks).set({ externalWait: wait }).where(eq(tasks.id, task.id));
    const notice = (await requestedWaitNotice(c.ctx, { ...task, externalWait: wait }, c.agent.id))!;
    await recordWaitNotice(c.db, notice);
    if (state === 'replaced') await c.db.update(tasks).set({ externalWait: { ...wait, reason: 'A different acceptance' }, version: task.version + 1 }).where(eq(tasks.id, task.id));
    if (state === 'changed') await c.db.update(tasks).set({ externalWait: null, version: task.version + 1 }).where(eq(tasks.id, task.id));
    await deliverWaitNotices(c.ctx, new Date(now.getTime() + (state === 'expired' ? 60_000 : 1)));
    expect(await c.messages(c.head.id)).toEqual([]);
    expect((await c.db.select().from(waitNotices))[0]!.cancelledAt).not.toBeNull();
  });

  describe('a wait said again', () => {
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    const waitOn = (client: Awaited<ReturnType<typeof mcp>>, task: number, employee: string, reason: string, until = later(60_000)) =>
      client.callTool({ name: 'wait_for', arguments: { task, reason, until, on: { kind: 'employee', employee } } });

    it('tells the employee once while the same wait on it stands, and keeps the new reason and date', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance on a-host')).isError).toBeFalsy();
      const until = later(90_000);
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance on a-host, now with the report read', until)).isError).toBeFalsy();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance on a-host, the report read twice', until)).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(1);
      expect(await c.db.select().from(waitNotices)).toHaveLength(1);
      expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ reason: 'Acceptance on a-host, the report read twice', until, on: { kind: 'employee', employee: c.head.id } });
    });

    it('tells another employee the wait moved to', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      await waitOn(worker.client, task.number, c.head.id, 'Acceptance');
      expect((await waitOn(worker.client, task.number, c.watcher.id, 'The alert on a-host')).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(1);
      expect(await c.messages(c.watcher.id)).toHaveLength(1);
    });

    it('tells the employee again once the wait ended', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      await waitOn(worker.client, task.number, c.head.id, 'Acceptance');
      expect((await worker.client.callTool({ name: 'end_wait', arguments: { task: task.number } })).isError).toBeFalsy();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance of the second part')).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(2);
    });

    it('tells the employee again once the wait ran out', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      await waitOn(worker.client, task.number, c.head.id, 'Acceptance');
      const [row] = await c.db.select().from(tasks).where(eq(tasks.id, task.id));
      await c.db.update(tasks).set({ externalWait: { ...row!.externalWait!, until: new Date(Date.now() - 1).toISOString() } }).where(eq(tasks.id, task.id));
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance, asked again')).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(2);
    });

    it('still tells the employee when the notice of the standing wait has not gone out', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const now = new Date();
      const wait = { reason: 'Acceptance', since: now.toISOString(), until: later(60_000), on: { kind: 'employee' as const, employee: c.head.id, name: c.head.name } };
      const [standing] = await c.db.update(tasks).set({ externalWait: wait, version: task.version + 1 }).where(eq(tasks.id, task.id)).returning();
      await recordWaitNotice(c.db, (await requestedWaitNotice(c.ctx, standing!, c.agent.id))!);
      const worker = await c.run();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance, asked again')).isError).toBeFalsy();
      const told = await c.messages(c.head.id);
      expect(told).toHaveLength(1);
      expect(told[0]!.data).toMatchObject({ text: expect.stringContaining('Acceptance, asked again') });
    });
  });

  it('makes no notice for a wait whose employee is the one who waits', async () => {
    const c = await waitCompany();
    const task = await c.task();
    const now = new Date();
    const wait = { reason: 'My own review', since: now.toISOString(), until: new Date(now.getTime() + 60_000).toISOString(), on: { kind: 'employee' as const, employee: c.agent.id } };
    expect(await requestedWaitNotice(c.ctx, { ...task, externalWait: wait }, c.agent.id)).toBeNull();
  });
});
