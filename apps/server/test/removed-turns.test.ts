import { eq } from 'drizzle-orm';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { agentInbox, agents, companies, jobs, programDeliveries } from '../src/db/schema.js';
import { enqueueTurn, insertTurn, NoSubscription, pump, pumpWaiting } from '../src/modules/conversation/queue.js';
import { failureCompany } from './failure-company.js';
import { operatorCompany } from './program-operator-company.js';

const NOW = new Date('2026-11-18T00:00:00Z');
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  onTestFinished(() => { vi.useRealTimers(); });
});

it('never dispatches a recorded queued turn of a removed employee', async () => {
  const c = await failureCompany();
  const id = await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Waiting words.', createdBy: null });
  await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
  await pumpWaiting(c.ctx);
  await pump(c.ctx, c.agent.id);
  expect(await c.jobOf(id)).toMatchObject({ status: 'queued', startedAt: null });
  expect(c.sent.mock.calls.flatMap(([, frame]) => frame.type === 'job.run' ? [frame] : [])).toEqual([]);
});

it('creates no inbox turn for unread recorded letters of a removed employee', async () => {
  const c = await failureCompany();
  await c.db.update(companies).set({ inboxMode: 'inbox' }).where(eq(companies.id, c.companyId));
  await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
  await c.db.insert(agentInbox).values({ companyId: c.companyId, agentId: c.agent.id, senderKind: 'hornhoof', senderName: 'Hornhoof', kind: 'notification', text: 'A recorded late notice.', status: 'unread' });
  await pump(c.ctx, c.agent.id);
  await pump(c.ctx, c.agent.id);
  expect(await c.turnsOf()).toEqual([]);
});

it('rejects a late inbox enqueue for a removed employee without creating a turn', async () => {
  const c = await failureCompany();
  await c.db.update(companies).set({ inboxMode: 'inbox' }).where(eq(companies.id, c.companyId));
  await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
  await expect(enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Another late notice.', createdBy: null, message: { personId: null, text: 'Another late notice.' } })).rejects.toBeInstanceOf(NoSubscription);
  expect(await c.turnsOf()).toEqual([]);
});

it('creates no inbox turn when removal wins the race to reserve it', async () => {
  const c = await failureCompany();
  await c.db.update(companies).set({ inboxMode: 'inbox' }).where(eq(companies.id, c.companyId));
  vi.mocked(c.ctx.hub.isReady).mockReturnValue(false);
  const transact = c.db.transaction.bind(c.db);
  vi.spyOn(c.db, 'transaction').mockImplementationOnce(async (fn, config) => {
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
    return transact(fn, config);
  });
  await expect(enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'A concurrent notice.', createdBy: null, message: { personId: null, text: 'A concurrent notice.' } })).rejects.toBeInstanceOf(NoSubscription);
  expect(await c.turnsOf()).toEqual([]);
});

it('keeps a switched-off employee inbox queued and sends it after switching on', async () => {
  const c = await failureCompany();
  await c.db.update(companies).set({ inboxMode: 'inbox' }).where(eq(companies.id, c.companyId));
  await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.agent.id));
  const id = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'A recorded notice.', createdBy: null, message: { personId: null, text: 'A recorded notice.' } });
  await pump(c.ctx, c.agent.id);
  expect(await c.jobOf(id)).toMatchObject({ status: 'queued', inboxWake: true, startedAt: null });
  expect(c.sent.mock.calls.flatMap(([, frame]) => frame.type === 'job.run' ? [frame] : [])).toEqual([]);
  await c.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, c.agent.id));
  await pump(c.ctx, c.agent.id);
  expect(await c.jobOf(id)).toMatchObject({ status: 'running', inboxWake: true });
  expect(c.sent.mock.calls.flatMap(([, frame]) => frame.type === 'job.run' ? [frame.jobId] : [])).toEqual([id]);
});

it('ends a turn once if its delivery target is removed after the turn was taken', async () => {
  const c = await operatorCompany();
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const id = await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Waiting words.', createdBy: null });
  const transact = c.db.transaction.bind(c.db);
  let removed = false;
  /* Record the concurrent removal after the queue takes the row, before the real delivery reservation reads it. */
  vi.spyOn(c.db, 'transaction').mockImplementation(async (fn, config) => {
    const result = await transact(fn, config);
    if (!removed && (await c.jobOf(id)).status === 'running') {
      removed = true;
      await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
    }
    return result;
  });
  const info = vi.spyOn(c.ctx.log, 'info');
  const error = vi.spyOn(c.ctx.log, 'error');
  await pump(c.ctx, c.agent.id);
  expect(await c.jobOf(id)).toMatchObject({ status: 'obsolete', error: 'delivery_target_missing', toolTokenHash: null, finishedAt: NOW });
  const first = await c.jobOf(id);
  await pump(c.ctx, c.agent.id);
  await pumpWaiting(c.ctx);
  expect(await c.jobOf(id)).toEqual(first);
  expect(info.mock.calls.map(call => call[1])).toEqual(['A turn ended because its program delivery target no longer exists.']);
  expect(error.mock.calls).toEqual([]);
  expect(c.sent.mock.calls.flatMap(([, frame]) => frame.type === 'job.run' ? [frame] : [])).toEqual([]);
  expect(await c.db.select().from(programDeliveries).where(eq(programDeliveries.jobId, id))).toEqual([]);
});

it.each(['offline', 'socket error'] as const)('retries a temporary %s delivery failure on the next pump', async refusal => {
  const c = await operatorCompany();
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, c.job.id));
  const id = await insertTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'Waiting words.', createdBy: null });
  c.sent.mockImplementation((_node, frame) => {
    if (frame.type !== 'job.run') return true;
    if (refusal === 'socket error') throw new Error('The socket is not open.');
    return false;
  });
  await pump(c.ctx, c.agent.id);
  expect(await c.jobOf(id)).toMatchObject({ status: 'queued', startedAt: null, toolTokenHash: null, finishedAt: null });
  const [cancelled] = await c.db.select().from(programDeliveries).where(eq(programDeliveries.jobId, id));
  expect(cancelled).toMatchObject({ outcome: 'cancelled', attemptedAt: null });
  c.sent.mockReturnValue(true);
  await pump(c.ctx, c.agent.id);
  expect(await c.jobOf(id)).toMatchObject({ status: 'running' });
  const deliveries = await c.db.select().from(programDeliveries).where(eq(programDeliveries.jobId, id));
  expect(deliveries.filter(d => d.outcome === 'pending')).toHaveLength(1);
});
