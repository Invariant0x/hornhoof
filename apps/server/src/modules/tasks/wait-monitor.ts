import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, turns } from '../../db/schema.js';
import { liveSubscription } from '../conversation/queue.js';
import { notificationMessage } from '../events/notifications.js';
import { operationsWatchers } from './silent.js';
import { deliverWaitNotices, recordWaitNotice } from './wait-notices.js';
import { quietDepartment, taskVersions, waitCycles, waitKey } from './wait-observations.js';

async function orchestrator(ctx: Ctx, companyId: string): Promise<string | null> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return agent && await liveSubscription(ctx, agent.id) ? agent.id : null;
}

async function recordCycles(ctx: Ctx, now: Date): Promise<void> {
  for (const group of await waitCycles(ctx, now)) {
    const work = group.map(edge => edge.task);
    const companyId = work[0]!.companyId;
    const recipient = await orchestrator(ctx, companyId);
    if (!recipient) continue;
    const versions = taskVersions(work);
    const text = `As of ${now.toISOString()}, these employees wait on one another:\n${group.map(edge => `${edge.name} on #${edge.task.number} waits for ${edge.task.externalWait!.on!.name ?? edge.to}: ${edge.task.externalWait!.reason}, until ${edge.task.externalWait!.until}.`).join('\n')}\nCheck the current tasks and decide who takes the first step.`;
    await recordWaitNotice(ctx.db, {
      companyId, agentId: recipient, dedupKey: `cycle:${waitKey(versions)}`, guard: { tasks: versions },
      message: await notificationMessage(ctx, companyId, 'wait_cycle', text, { tasks: work.map(t => ({ id: t.id, number: t.number })) }),
    });
  }
}

async function recordQuietDepartments(ctx: Ctx, now: Date): Promise<void> {
  for (const turn of await ctx.db.select().from(turns).where(eq(turns.status, 'open'))) {
    for (const department of await ctx.db.select().from(departments).where(eq(departments.companyId, turn.companyId))) {
      const observation = await quietDepartment(ctx, turn.id, department.id, now);
      if (!observation) continue;
      const watcher = (await operationsWatchers(ctx, turn.companyId)).find(agent => agent.roleKey === 'OPS-WATCH');
      const recipient = watcher?.id ?? await orchestrator(ctx, turn.companyId);
      if (!recipient) continue;
      const name = department.name || department.templateKey || department.roleCode;
      const text = `As of ${now.toISOString()}, department ${name} has had no employee working since ${observation.since.toISOString()} in open turn ${turn.number}. All its open work waits:\n${observation.reasons.join('\n')}\nCheck the current waits and tell the orchestrator what can move first.`;
      await recordWaitNotice(ctx.db, {
        companyId: turn.companyId, agentId: recipient, dedupKey: `quiet:${observation.key}`,
        guard: { tasks: taskVersions(observation.work), quiet: { turnId: turn.id, departmentId: department.id, key: observation.key } },
        message: await notificationMessage(ctx, turn.companyId, 'department_quiet', text, { tasks: observation.work.map(t => ({ id: t.id, number: t.number })) }),
      });
    }
  }
}

/* Called after waits expire, at startup and at least once each minute. */
export async function checkWaitHealth(ctx: Ctx, now = new Date()): Promise<void> {
  await recordCycles(ctx, now);
  await recordQuietDepartments(ctx, now);
  await deliverWaitNotices(ctx, now);
}
