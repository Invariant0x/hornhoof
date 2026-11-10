import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, tasks, turns, waitNotices } from '../src/db/schema.js';
import * as inputLocks from '../src/modules/conversation/decision-context.js';
import { notificationMessage } from '../src/modules/events/notifications.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import { deliverWaitNotices, recordWaitNotice, requestedWaitNotice } from '../src/modules/tasks/wait-notices.js';
import { quietDepartment, taskVersions } from '../src/modules/tasks/wait-observations.js';
import { until } from './helpers.js';
import { waitCompany } from './wait-company.js';

async function pendingRequest() {
  const c = await waitCompany();
  const task = await c.task();
  await c.run(c.head.id);
  const now = new Date();
  const wait = { reason: 'Acceptance', since: now.toISOString(), until: new Date(now.getTime() + 3_600_000).toISOString(), on: { kind: 'employee' as const, employee: c.head.id, name: c.head.name } };
  await c.db.update(tasks).set({ externalWait: wait }).where(eq(tasks.id, task.id));
  await recordWaitNotice(c.db, (await requestedWaitNotice(c.ctx, { ...task, externalWait: wait }, c.agent.id))!);
  return { ...c, taskRow: task, now, wait };
}

async function pendingQuiet() {
  const c = await waitCompany({ turn: false });
  const now = new Date();
  const since = new Date(now.getTime() - 900_000);
  const [turn] = await c.db.insert(turns).values({ companyId: c.companyId, number: 1, goal: 'Deliver', openedAt: since }).returning();
  const task = await c.task();
  await c.db.update(tasks).set({ turnId: turn!.id, updatedAt: since, externalWait: null }).where(eq(tasks.id, task.id));
  const observation = (await quietDepartment(c.ctx, turn!.id, c.dev.id, now))!;
  await recordWaitNotice(c.db, { companyId: c.companyId, agentId: c.head.id, dedupKey: `quiet:${observation.key}`, guard: { tasks: taskVersions(observation.work), quiet: { turnId: turn!.id, departmentId: c.dev.id, key: observation.key } }, message: await notificationMessage(c.ctx, c.companyId, 'department_quiet', 'The department waits.') });
  return { ...c, now };
}

async function heldInput(c: Awaited<ReturnType<typeof waitCompany>>, agentId = c.head.id) {
  let release!: () => void;
  const held = inputLocks.withInputLock(c.ctx, agentId, () => new Promise<void>(resolve => { release = resolve; }));
  await until(() => !!release);
  let attempts = 0;
  const original = inputLocks.withInputLock;
  const spy = vi.spyOn(inputLocks, 'withInputLock').mockImplementation((ctx, id, fn) => {
    if (id === agentId) attempts++;
    return original(ctx, id, fn);
  });
  onTestFinished(() => spy.mockRestore());
  onTestFinished(() => { release(); });
  return { held, release, entered: (count = 1) => until(() => attempts >= count) };
}

describe('wait notice acceptance boundaries', () => {
  it('checks a changed wait after waiting for the recipient input lock', async () => {
    const c = await pendingRequest();
    const lock = await heldInput(c);
    const sending = deliverWaitNotices(c.ctx, c.now);
    await lock.entered();
    await c.db.update(tasks).set({ version: c.taskRow.version + 1, externalWait: null }).where(eq(tasks.id, c.taskRow.id));
    lock.release();
    await Promise.all([lock.held, sending]);
    expect(await c.messages(c.head.id)).toEqual([]);
    expect((await c.db.select().from(waitNotices))[0]!.cancelledAt).not.toBeNull();
  });

  it('checks the current deadline after waiting for the recipient input lock', async () => {
    const c = await pendingRequest();
    const lock = await heldInput(c);
    const sending = deliverWaitNotices(c.ctx, c.now);
    await lock.entered();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(c.wait.until).getTime());
    onTestFinished(() => clock.mockRestore());
    lock.release();
    await Promise.all([lock.held, sending]);
    expect(await c.messages(c.head.id)).toEqual([]);
  });

  it('does not let an expired claimant emit duplicate live words after a long input lock', async () => {
    const c = await pendingRequest();
    const lock = await heldInput(c);
    const first = deliverWaitNotices(c.ctx, c.now);
    await lock.entered();
    const second = deliverWaitNotices({ ...c.ctx }, new Date(c.now.getTime() + 120_000));
    await lock.entered(2);
    lock.release();
    await Promise.all([lock.held, first, second]);
    expect(c.sent.mock.calls.filter(([, message]) => message.type === 'agent.say')).toHaveLength(1);
    expect(await c.messages(c.head.id)).toHaveLength(1);
  });

  it('delivers a cycle to the orchestrator while another recipient input remains locked', async () => {
    const c = await pendingRequest();
    const second = await c.task(c.head.id);
    await c.db.update(tasks).set({ externalWait: { ...c.wait, on: { kind: 'employee', employee: c.agent.id, name: c.agent.name } } }).where(eq(tasks.id, second.id));
    const lock = await heldInput(c);
    const sending = checkWaitHealth(c.ctx, c.now);
    await lock.entered();
    let observed = false;
    await until(async () => { observed = (await c.messages(c.orchestrator.id)).length === 1; return observed; }).catch(() => {});
    lock.release();
    await Promise.all([lock.held, sending]);
    expect(observed).toBe(true);
  });

  it('drops a pending quiet observation if work starts behind the input lock', async () => {
    const c = await pendingQuiet();
    const lock = await heldInput(c, c.head.id);
    const sending = deliverWaitNotices(c.ctx, c.now);
    await lock.entered();
    await c.run();
    lock.release();
    await Promise.all([lock.held, sending]);
    expect(await c.messages(c.head.id)).toEqual([]);
    expect((await c.db.select().from(waitNotices))[0]!.cancelledAt).not.toBeNull();
  });

  it.each(['removed', 'off', 'subscription'] as const)('retargets a pending quiet notice if its head becomes %s', async kind => {
    const c = await pendingQuiet();
    const now = c.now;
    await c.db.update(agents).set(kind === 'removed' ? { removedAt: now } : kind === 'off' ? { switchedOffAt: now } : { subscriptionId: null }).where(eq(agents.id, c.head.id));
    await checkWaitHealth(c.ctx, now);
    await checkWaitHealth({ ...c.ctx }, new Date(now.getTime() + 120_000));
    expect(await c.messages(c.head.id)).toEqual([]);
    expect(await c.messages(c.watcher.id)).toEqual([]);
    expect(await c.messages(c.orchestrator.id)).toHaveLength(1);
    expect(await c.db.select().from(waitNotices)).toHaveLength(1);
  });
});
