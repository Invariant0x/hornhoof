import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, tasks, waitNotices, type TASK_STATUSES } from '../src/db/schema.js';
import { recordCheckSignal } from '../src/modules/model-checks/signal.js';
import { departmentHasWork } from '../src/modules/model-checks/work.js';
import { deliverWaitNotices } from '../src/modules/tasks/wait-notices.js';
import { company } from './department-owner-fixture.js';
import type { Report } from '../src/modules/model-checks/run.js';

const COUNTS = { falseAllows: 1, falseDenies: 0, classErrors: 0, total: 3, unavailable: 0 };
const REPORT: Report = { status: 'failed', problems: ['must_block_missed'], infraErrors: 0, mustBlockMisses: 1, all: COUNTS, holdout: COUNTS, missedDevCases: [] };
const SIGNAL = { dedupKey: 'digest:must_block_missed', problems: ['must_block_missed' as const] };

describe('whether a department has work', () => {
  const setStatus = async (c: Awaited<ReturnType<typeof company>>, status: (typeof TASK_STATUSES)[number]) => c.db.update(tasks).set({ status }).where(eq(tasks.id, c.task.id));

  it.each(['open', 'working', 'review', 'waiting', 'blocked'] as const)('counts a task that is %s', async status => {
    const c = await company();
    await setStatus(c, status);
    expect(await departmentHasWork(c.app.ctx, c.companyId, c.dev.id)).toBe(true);
  });

  it.each(['planned', 'done', 'cancelled'] as const)('does not count a task that is %s', async status => {
    const c = await company();
    await setStatus(c, status);
    expect(await departmentHasWork(c.app.ctx, c.companyId, c.dev.id)).toBe(false);
  });

  it('counts the work of a product of the department', async () => {
    const c = await company();
    await c.db.update(tasks).set({ departmentId: c.product.id }).where(eq(tasks.id, c.task.id));
    expect(await departmentHasWork(c.app.ctx, c.companyId, c.dev.id)).toBe(true);
  });

  it('does not count the work of another department', async () => {
    const c = await company();
    await setStatus(c, 'done');
    expect(await departmentHasWork(c.app.ctx, c.companyId, c.dev.id)).toBe(false);
    expect(await departmentHasWork(c.app.ctx, c.companyId, c.sales.id)).toBe(true);
  });

  it('knows no department of another company', async () => {
    const c = await company();
    expect(await departmentHasWork(c.app.ctx, randomUUID(), c.dev.id)).toBe(false);
  });
});

describe('the signal of a failed run', () => {
  const place = (c: Awaited<ReturnType<typeof company>>) => ({ companyId: c.companyId, departmentId: c.dev.id, checkId: randomUUID(), kind: 'outbound_review' });
  const noticesFor = (c: Awaited<ReturnType<typeof company>>, agentId: string) => c.db.select().from(waitNotices).where(and(eq(waitNotices.companyId, c.companyId), eq(waitNotices.agentId, agentId)));

  it('goes to the head of the department and the orchestrator, once each, with the name of the owner', async () => {
    const c = await company();
    await c.db.update(departments).set({ ownerPersonId: c.ids.dana }).where(eq(departments.id, c.dev.id));
    const where = place(c);
    await recordCheckSignal(c.app.ctx, where, SIGNAL, REPORT);
    await recordCheckSignal(c.app.ctx, where, SIGNAL, REPORT);
    for (const agentId of [c.head.id, c.orchestrator.id]) {
      const notices = await noticesFor(c, agentId);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.message.text).toContain('Dana');
      expect(notices[0]!.message.text).toContain('Must-block examples let through: 1');
      expect(notices[0]!.message.notification.source).toBe('service');
    }
  });

  it('names the CEO when the department has no owner', async () => {
    const c = await company();
    await recordCheckSignal(c.app.ctx, place(c), SIGNAL, REPORT);
    expect((await noticesFor(c, c.head.id))[0]!.message.text).toContain('the CEO');
  });

  it('goes again for a failure of another kind', async () => {
    const c = await company();
    const where = place(c);
    await recordCheckSignal(c.app.ctx, where, SIGNAL, REPORT);
    await recordCheckSignal(c.app.ctx, where, { dedupKey: 'digest:no_result', problems: ['no_result'] }, REPORT);
    expect(await noticesFor(c, c.head.id)).toHaveLength(2);
  });

  it('keeps apart the same failure of two checks', async () => {
    const c = await company();
    await recordCheckSignal(c.app.ctx, place(c), SIGNAL, REPORT);
    await recordCheckSignal(c.app.ctx, place(c), SIGNAL, REPORT);
    expect(await noticesFor(c, c.head.id)).toHaveLength(2);
  });

  it('reaches a head of another department only for that department', async () => {
    const c = await company();
    await recordCheckSignal(c.app.ctx, place(c), SIGNAL, REPORT);
    expect(await noticesFor(c, c.salesHead.id)).toEqual([]);
  });

  it('goes out through the same delivery as every wait notice, and is not sent twice', async () => {
    const c = await company();
    await recordCheckSignal(c.app.ctx, place(c), SIGNAL, REPORT);
    await deliverWaitNotices(c.app.ctx);
    await deliverWaitNotices(c.app.ctx);
    const [notice] = await noticesFor(c, c.head.id);
    expect(notice!.deliveredAt).not.toBeNull();
    expect(notice!.cancelledAt).toBeNull();
  });
});
