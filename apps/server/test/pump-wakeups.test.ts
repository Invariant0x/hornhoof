import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, jobs, subscriptions } from '../src/db/schema.js';
import { onSubscription } from '../src/modules/conversation/line.js';
import { agentState, pump } from '../src/modules/conversation/queue.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { failureCompany } from './failure-company.js';
import { statements } from './helpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const LIMIT_GRACE_MS = 5_000;
/* Long enough on the test's clock for a line that spins to run its queries many times over. */
const SETTLE_MS = 150;
const settle = () => vi.advanceTimersByTimeAsync(SETTLE_MS);

/* Bruno's plan, at its limit or past the share set for tasks until in an hour, and a turn waiting for him. */
async function line(plan: 'limit' | 'spent' | 'free' = 'limit') {
  const c = await failureCompany();
  /* The clock and the pump's timers go only as far as a test moves them. */
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const resetsAt = new Date(Date.now() + HOUR).toISOString();
  if (plan === 'limit') await c.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.sub.id));
  if (plan === 'spent') await c.db.update(subscriptions).set({ budget: 50, limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.8, resetsAt }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.sub.id));
  const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Checkout', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true });
  const waiting = async (at: Date, options: { task?: boolean; prompt?: string; report?: boolean } = {}) => {
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.agent.id, kind: 'conversation', prompt: options.prompt ?? 'Go on.', taskId: options.task ? task.id : null, timeoutMs: 1000, status: 'queued', notBefore: at }).returning();
    if (options.task) {
      const route = routeSnapshot(await routeOf(c.db, task), task.assigneeAgentId);
      await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.agent.id, jobId: job!.id, kind: 'message',
        data: { text: job!.prompt, taskWake: taskWakeOf(task, { why: 'go_on' }, route) } });
    }
    /* A report waits out its short window without holding the agent's line, unlike a delayed retry. */
    if (options.report) await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.agent.id, jobId: job!.id, kind: 'message', data: { text: 'Done.', report: 'Done.' } });
    return job!;
  };
  /* Each timer the pump sets from now on, with how long it waits. */
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const delays = () => timer.mock.calls.map(([, ms]) => ms ?? 0);
  const planned = () => delays().filter(ms => ms > MIN);
  return { ...c, waiting, delays, planned, resetsAt };
}

const inAnHour = (ms: number | undefined) => {
  expect(ms).toBeGreaterThan(HOUR - MIN);
  expect(ms).toBeLessThanOrEqual(HOUR + LIMIT_GRACE_MS);
};

describe('the line of an agent whose waiting turn may not go out now', () => {
  it.each([
    { name: 'at the limit of its plan', plan: 'limit' as const, off: false, wakes: true },
    { name: 'past the share set for tasks', plan: 'spent' as const, off: false, wakes: true },
    { name: 'switched off', plan: 'free' as const, off: true, wakes: false },
  ])('does not spin on a retry that is due but may not go, $name', async ({ plan, off, wakes }) => {
    const c = await line(plan);
    if (off) await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.agent.id));
    const retry = await c.waiting(new Date(Date.now() - 1000), { task: true });
    await pump(c.ctx, c.agent.id);
    const seen = statements();
    await settle();
    expect(seen).toEqual([]);
    expect(c.delays().filter(ms => ms <= 0)).toEqual([]);
    expect(await c.jobOf(retry.id)).toMatchObject({ status: 'queued' });
    if (wakes) inAnHour(c.planned().at(-1));
    else expect(c.planned()).toEqual([]);
  });

  it('keeps the wake at the reset when a turn that may go waits longer than the limit', async () => {
    const c = await line('spent');
    await c.waiting(new Date(Date.now() + 2 * HOUR), { report: true });
    await pump(c.ctx, c.agent.id);
    expect(c.planned()).toHaveLength(1);
    inAnHour(c.planned()[0]);
  });

  it('wakes for a turn that may go before the reset, and sets the wake at the reset again after it', async () => {
    const c = await line('spent');
    const soon = await c.waiting(new Date(Date.now() + 10 * MIN), { report: true });
    await pump(c.ctx, c.agent.id);
    inAnHour(c.planned().at(0));
    const wake = c.planned().at(-1)!;
    expect(wake).toBeGreaterThan(9 * MIN);
    expect(wake).toBeLessThanOrEqual(10 * MIN);
    await c.db.update(jobs).set({ status: 'failed', error: 'cancelled' }).where(eq(jobs.id, soon.id));
    await pump(c.ctx, c.agent.id);
    inAnHour(c.planned().at(-1));
  });

  it('does not wake for a later task turn that may not go before the reset', async () => {
    const c = await line('spent');
    await c.waiting(new Date(Date.now() + 10 * MIN), { task: true, report: true });
    await pump(c.ctx, c.agent.id);
    expect(c.planned()).toHaveLength(1);
    inAnHour(c.planned()[0]);
  });

  it('wakes for a report that waits while nothing else holds the plan', async () => {
    const c = await line('free');
    await c.waiting(new Date(Date.now() + 10 * MIN), { report: true });
    await pump(c.ctx, c.agent.id);
    expect(c.planned()).toHaveLength(1);
    expect(c.planned()[0]).toBeLessThanOrEqual(10 * MIN);
  });

  it('sends a due turn once what held it is over', async () => {
    const c = await line('free');
    const retry = await c.waiting(new Date(Date.now() - 1000), { task: true });
    await pump(c.ctx, c.agent.id);
    expect(await c.jobOf(retry.id)).toMatchObject({ status: 'running' });
  });

  it.each([
    { plan: 'spent' as const, reason: 'budget', text: 'share set for tasks' },
    { plan: 'limit' as const, reason: 'limit', text: 'usage limit' },
  ])('shows a $plan hold over ten minutes and tells Operations only once', async ({ plan, reason, text }) => {
    const c = await line(plan);
    const old = new Date(Date.now() - 11 * MIN);
    const first = await c.waiting(new Date(Date.now() - 1000), { task: true });
    await c.db.update(jobs).set({ createdAt: old }).where(eq(jobs.id, first.id));
    await pump(c.ctx, c.agent.id);
    expect(await agentState(c.ctx, c.agent.id)).toMatchObject({ held: { reason, since: old.toISOString(), until: c.resetsAt } });
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    expect((await c.turnsOf(c.watcher.id))[0]!.prompt).toContain(text);
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, c.watcher.id));

    const second = await c.waiting(new Date(Date.now() - 1000), { task: true });
    await c.db.update(jobs).set({ createdAt: old }).where(eq(jobs.id, second.id));
    await c.db.update(jobs).set({ status: 'failed', error: 'cancelled', finishedAt: new Date() }).where(eq(jobs.id, first.id));
    await pump(c.ctx, c.agent.id);
    await pump(c.ctx, c.agent.id);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    expect(await c.jobOf(first.id)).toMatchObject({ status: 'failed', error: 'cancelled' });
    expect(await c.jobOf(second.id)).toMatchObject({ status: 'queued' });
  });

  it('sends an already queued Operations notice after the outer dispatch rejects', async () => {
    const c = await line('spent');
    const held = await c.waiting(new Date(Date.now() - 1000), { task: true });
    await c.db.update(jobs).set({ createdAt: new Date(Date.now() - 11 * MIN) }).where(eq(jobs.id, held.id));
    const failure = new Error('The dispatch failed after storing the notice.');
    const notifyHold = c.ctx.conversationEffects.notifyHold;
    vi.spyOn(c.ctx.conversationEffects, 'notifyHold').mockImplementationOnce(async (...args) => {
      await notifyHold(...args);
      throw failure;
    });

    await expect(pump(c.ctx, c.agent.id)).rejects.toBe(failure);
    await onSubscription(c.ctx, c.sub.id, () => Promise.resolve());

    expect(await c.turnsOf(c.watcher.id)).toEqual([
      expect.objectContaining({ status: 'running', prompt: expect.stringContaining('share set for tasks') }),
    ]);
    expect(await c.jobOf(held.id)).toMatchObject({ status: 'queued' });
  });

  it('tells Operations of a hold once while its reset moves by milliseconds only, and again once it moves by minutes', async () => {
    const c = await line('limit');
    /* A provider gives the same reset with other milliseconds each time it is asked: a whole minute and a little. */
    const minute = Math.ceil((Date.now() + HOUR) / MIN) * MIN;
    const resetAt = (ms: number) => c.db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(minute + ms).toISOString() }] }, limitsUpdatedAt: new Date() }).where(eq(subscriptions.id, c.sub.id));
    await resetAt(738);
    const held = await c.waiting(new Date(Date.now() - 1000), { task: true });
    await c.db.update(jobs).set({ createdAt: new Date(Date.now() - 11 * MIN) }).where(eq(jobs.id, held.id));
    await pump(c.ctx, c.agent.id);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    const free = () => c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, c.watcher.id));
    for (const ms of [867, 929, 956, 12]) {
      await free();
      await resetAt(ms);
      await pump(c.ctx, c.agent.id);
    }
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(1);
    await free();
    await resetAt(5 * MIN + 400);
    await pump(c.ctx, c.agent.id);
    expect(await c.turnsOf(c.watcher.id)).toHaveLength(2);
  });
});
