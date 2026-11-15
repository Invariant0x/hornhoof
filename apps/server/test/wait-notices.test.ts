import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, taskEvents, tasks, waitNotices } from '../src/db/schema.js';
import { comment } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { deliverWaitNotices, recordWaitNotice, requestedWaitNotice } from '../src/modules/tasks/wait-notices.js';
import type { mcp } from './helpers.js';
import { waitCompany } from './wait-company.js';

const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const told = async (c: Awaited<ReturnType<typeof waitCompany>>, agentId: string) =>
  (await c.messages(agentId)).filter(m => (m.data as { notification?: { source?: string } }).notification?.source === 'wait_requested');
const waitOn = (client: Awaited<ReturnType<typeof mcp>>, task: number, employee: string, reason: string, until = later(60_000)) =>
  client.callTool({ name: 'wait_for', arguments: { task, reason, until, on: { kind: 'employee', employee } } });

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
    const result = await worker.client.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Acceptance on host-a', until, on: { kind: 'employee', employee: c.head.id } } });
    expect(result.isError).toBeFalsy();
    const [message] = await c.messages(c.head.id);
    expect(message).toMatchObject({ data: { notification: { source: 'wait_requested', tasks: [{ id: task.id, number: task.number }] }, actor: { kind: 'agent', id: c.agent.id } } });
    expect(message!.data).toMatchObject({ text: expect.stringContaining('Acceptance on host-a') });
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
    /* A claim takes the later of the given time and the clock: one that stands still leaves the given times to decide. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
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
    if (state === 'replaced') await c.db.update(tasks).set({ externalWait: { ...wait, on: { kind: 'employee', employee: c.watcher.id } }, version: task.version + 1 }).where(eq(tasks.id, task.id));
    if (state === 'changed') await c.db.update(tasks).set({ externalWait: null, version: task.version + 1 }).where(eq(tasks.id, task.id));
    await deliverWaitNotices(c.ctx, new Date(now.getTime() + (state === 'expired' ? 60_000 : 1)));
    expect(await c.messages(c.head.id)).toEqual([]);
    expect((await c.db.select().from(waitNotices))[0]!.cancelledAt).not.toBeNull();
  });

  describe('a wait said again', () => {
    it('tells the employee once while the same wait on it stands, and keeps the new reason and date', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance on host-a')).isError).toBeFalsy();
      const until = later(90_000);
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance on host-a, now with the report read', until)).isError).toBeFalsy();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance on host-a, the report read twice', until)).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(1);
      expect(await c.db.select().from(waitNotices)).toHaveLength(1);
      expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toMatchObject({ reason: 'Acceptance on host-a, the report read twice', until, on: { kind: 'employee', employee: c.head.id } });
    });

    it('tells another employee the wait moved to', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      await waitOn(worker.client, task.number, c.head.id, 'Acceptance');
      expect((await waitOn(worker.client, task.number, c.watcher.id, 'The alert on host-a')).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(1);
      expect(await c.messages(c.watcher.id)).toHaveLength(1);
    });

    it('tells the employee nothing new when the holder ended the wait and waits on them again', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      await waitOn(worker.client, task.number, c.head.id, 'Acceptance');
      for (const reason of ['Acceptance of the second part', 'Acceptance of the third part']) {
        expect((await worker.client.callTool({ name: 'end_wait', arguments: { task: task.number } })).isError).toBeFalsy();
        expect((await waitOn(worker.client, task.number, c.head.id, reason)).isError).toBeFalsy();
      }
      expect(await told(c, c.head.id)).toHaveLength(1);
    });

    it('tells the employee nothing new when the wait ran out and the holder waits on them again', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run();
      await waitOn(worker.client, task.number, c.head.id, 'Acceptance');
      const [row] = await c.db.select().from(tasks).where(eq(tasks.id, task.id));
      await c.db.update(tasks).set({ externalWait: { ...row!.externalWait!, until: new Date(Date.now() - 1).toISOString() } }).where(eq(tasks.id, task.id));
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance, asked again')).isError).toBeFalsy();
      expect(await told(c, c.head.id)).toHaveLength(1);
    });

    it('tells the employee again once the work on the task moved', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run(c.agent.id, task.id);
      await waitOn(worker.client, task.number, c.head.id, 'Acceptance');
      expect((await worker.client.callTool({ name: 'blocked', arguments: { task: task.number, why: 'The host-a key is gone.' } })).isError).toBeFalsy();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance with the new key')).isError).toBeFalsy();
      const notes = await told(c, c.head.id);
      expect(notes).toHaveLength(2);
      expect(notes[1]!.data).toMatchObject({ text: expect.stringContaining('Acceptance with the new key') });
    });

    it('tells the employee once when a notice that never went out was dropped and the holder waits on them again', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const wait = { reason: 'Acceptance', since: new Date().toISOString(), until: later(60_000), on: { kind: 'employee' as const, employee: c.head.id, name: c.head.name } };
      const [standing] = await c.db.update(tasks).set({ externalWait: wait, version: task.version + 1 }).where(eq(tasks.id, task.id)).returning();
      await recordWaitNotice(c.db, (await requestedWaitNotice(c.ctx, standing!, c.agent.id))!);
      await c.db.update(tasks).set({ externalWait: null, version: task.version + 2 }).where(eq(tasks.id, task.id));
      await deliverWaitNotices(c.ctx);
      expect(await told(c, c.head.id)).toHaveLength(0);
      const worker = await c.run();
      expect((await waitOn(worker.client, task.number, c.head.id, 'Acceptance, asked again')).isError).toBeFalsy();
      const notes = await told(c, c.head.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.data).toMatchObject({ text: expect.stringContaining('Acceptance, asked again') });
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

  describe('a wait said again after an answer', () => {
    /* The holder waits on the head, and the head answers on the task, which ends the wait. */
    async function answered(how: 'comment' | 'message') {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run(c.agent.id, task.id);
      const head = await c.run(c.head.id);
      expect((await waitOn(worker.client, task.number, c.head.id, 'The report on host-a')).isError).toBeFalsy();
      const answer = () => how === 'comment'
        ? head.client.callTool({ name: 'comment', arguments: { task: task.number, text: 'Here is the report.' } })
        : head.client.callTool({ name: 'message_employee', arguments: { employee: c.agent.id, task: task.number, text: 'Here is the report.' } });
      expect((await answer()).isError).toBeFalsy();
      expect((await c.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.externalWait).toBeNull();
      return { ...c, number: task.number, taskId: task.id, worker, answer };
    }

    it.each(['comment', 'message'] as const)('tells the employee nothing new when the holder waits on them again after their %s', async how => {
      const c = await answered(how);
      expect((await waitOn(c.worker.client, c.number, c.head.id, 'The report on host-a, now read')).isError).toBeFalsy();
      expect((await c.answer()).isError).toBeFalsy();
      expect((await waitOn(c.worker.client, c.number, c.head.id, 'The report on host-a, read twice')).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(1);
      expect(await c.db.select().from(waitNotices)).toHaveLength(1);
      expect((await c.db.select().from(tasks).where(eq(tasks.id, c.taskId)))[0]!.externalWait).toMatchObject({ reason: 'The report on host-a, read twice', on: { employee: c.head.id } });
    });

    it('tells the employee nothing new however long ago they answered', async () => {
      const c = await answered('comment');
      await c.db.update(taskEvents).set({ createdAt: new Date(Date.now() - 3 * 3_600_000) }).where(and(eq(taskEvents.taskId, c.taskId), eq(taskEvents.kind, 'comment')));
      expect((await waitOn(c.worker.client, c.number, c.head.id, 'The report on host-a, asked again')).isError).toBeFalsy();
      expect(await told(c, c.head.id)).toHaveLength(1);
    });

    it('tells the employee nothing new when someone else ended the wait', async () => {
      const c = await waitCompany();
      const task = await c.task();
      const worker = await c.run(c.agent.id, task.id);
      await waitOn(worker.client, task.number, c.head.id, 'The report on host-a');
      await wakeAll(c.ctx, (await comment(c.ctx, { agentId: c.watcher.id }, task.id, 'The alert on host-a is gone.')).wakes);
      expect((await waitOn(worker.client, task.number, c.head.id, 'The report on host-a, asked again')).isError).toBeFalsy();
      expect(await told(c, c.head.id)).toHaveLength(1);
    });

    it('tells another employee the wait moved to after the answer', async () => {
      const c = await answered('comment');
      expect((await waitOn(c.worker.client, c.number, c.watcher.id, 'The alert on host-a')).isError).toBeFalsy();
      expect(await c.messages(c.head.id)).toHaveLength(1);
      expect(await c.messages(c.watcher.id)).toHaveLength(1);
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
