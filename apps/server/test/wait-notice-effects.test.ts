import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, tasks, waitNotices } from '../src/db/schema.js';
import * as inputLocks from '../src/modules/conversation/decision-context.js';
import { insertTurn } from '../src/modules/conversation/queue.js';
import { deliverWaitNotices, recordWaitNotice, requestedWaitNotice } from '../src/modules/tasks/wait-notices.js';
import { waitCompany } from './wait-company.js';

async function pendingRequest() {
  const c = await waitCompany();
  const lines: string[] = [];
  const logger = Fastify({ logger: { level: 'error', stream: { write: (line: string) => void lines.push(line) } } });
  onTestFinished(() => logger.close());
  const ctx = { ...c.ctx, log: logger.log };
  const task = await c.task();
  const now = new Date();
  const wait = { reason: 'Acceptance', since: now.toISOString(), until: new Date(now.getTime() + 3_600_000).toISOString(), on: { kind: 'employee' as const, employee: c.head.id } };
  await c.db.update(tasks).set({ externalWait: wait }).where(eq(tasks.id, task.id));
  await recordWaitNotice(c.db, (await requestedWaitNotice(ctx, { ...task, externalWait: wait }, c.agent.id))!);
  const [notice] = await c.db.select().from(waitNotices);
  const earlier = await insertTurn(ctx, { companyId: c.companyId, agentId: c.head.id, prompt: 'An earlier personal message.', createdBy: null });
  return { ...c, ctx, lines, taskRow: task, notice: notice!, earlier, now };
}

describe('wait notice queue and error effects', () => {
  it('pumps an earlier queued turn after accepting a notice', async () => {
    const c = await pendingRequest();
    await deliverWaitNotices(c.ctx, c.now);
    expect(await c.jobOf(c.earlier)).toMatchObject({ status: 'running' });
    expect((await c.db.select().from(waitNotices))[0]!.deliveredAt).not.toBeNull();
    expect(c.lines).toEqual([]);
  });

  it('does not pump unrelated queued work after cancelling a stale notice', async () => {
    const c = await pendingRequest();
    await c.db.update(tasks).set({ externalWait: null, version: c.taskRow.version + 1 }).where(eq(tasks.id, c.taskRow.id));
    await deliverWaitNotices(c.ctx, c.now);
    expect(await c.jobOf(c.earlier)).toMatchObject({ status: 'queued', startedAt: null });
    expect((await c.db.select().from(waitNotices))[0]!.cancelledAt).not.toBeNull();
    expect(c.lines).toEqual([]);
  });

  it('silently defers a switched off recipient without pumping its personal queue', async () => {
    const c = await pendingRequest();
    await c.db.update(agents).set({ switchedOffAt: c.now }).where(eq(agents.id, c.head.id));
    await deliverWaitNotices(c.ctx, c.now);
    expect(await c.jobOf(c.earlier)).toMatchObject({ status: 'queued', startedAt: null });
    expect((await c.db.select().from(waitNotices))[0]!.deliveredAt).toBeNull();
    expect(c.lines).toEqual([]);
  });

  it('does not pump unrelated work when another sender already claimed the notice', async () => {
    const c = await pendingRequest();
    let release!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const held = inputLocks.withInputLock(c.ctx, c.head.id, () => new Promise<void>(resolve => { release = resolve; locked(); }));
    await acquired;
    onTestFinished(() => release());
    let selected!: () => void;
    const selection = new Promise<void>(resolve => { selected = resolve; });
    const lock = inputLocks.withInputLock;
    const spy = vi.spyOn(inputLocks, 'withInputLock').mockImplementation((ctx, id, fn) => {
      if (id === c.head.id) selected();
      return lock(ctx, id, fn);
    });
    onTestFinished(() => spy.mockRestore());
    const sending = deliverWaitNotices(c.ctx, c.now);
    await selection;
    await c.db.update(waitNotices).set({ leaseId: randomUUID(), leaseUntil: new Date(c.now.getTime() + 120_000) }).where(eq(waitNotices.id, c.notice.id));
    release();
    await Promise.all([held, sending]);
    expect(await c.jobOf(c.earlier)).toMatchObject({ status: 'queued', startedAt: null });
    expect(c.lines).toEqual([]);
  });

  it('records a delivery failure with its notice id and leaves queued work alone', async () => {
    const c = await pendingRequest();
    const failure = vi.spyOn(c.db, 'transaction').mockRejectedValueOnce(new Error('The message could not be kept.'));
    onTestFinished(() => failure.mockRestore());
    await deliverWaitNotices(c.ctx, c.now);
    expect(c.lines.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ level: 50, waitNotice: c.notice.id, msg: 'Delivering a wait notice failed.', error: expect.objectContaining({ message: 'The message could not be kept.' }) }),
    ]);
    expect(await c.jobOf(c.earlier)).toMatchObject({ status: 'queued', startedAt: null });
    expect((await c.db.select().from(waitNotices))[0]!.deliveredAt).toBeNull();
  });
});
