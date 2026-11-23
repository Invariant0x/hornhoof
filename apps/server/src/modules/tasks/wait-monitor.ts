import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { departments, turns } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { notificationMessage } from '../events/notifications.js';
import { quietRecipient, waitOrchestrator } from './wait-recipients.js';
import { checkWaitDependencies } from './wait-dependencies.js';
import { sweepWaits } from './wait-escalation.js';
import { deliverWaitNotices, recordWaitNotice } from './wait-notices.js';
import { departmentScope, quietDepartment, taskVersions, waitCycles, waitKey } from './wait-observations.js';

async function recordCycles(ctx: Ctx, now: Date): Promise<void> {
  for (const group of await waitCycles(ctx, now)) {
    const work = group.map(edge => edge.task);
    const companyId = work[0]!.companyId;
    const recipient = await waitOrchestrator(ctx, companyId);
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
    if (!turn.departmentId) continue;
    /* A turn is its department's: only its department, products and sub-departments are asked about. A department's silence
       is its products' too: whoever hears of it once does not hear it again for each. */
    const scope = await departmentScope(ctx, turn.companyId, turn.departmentId);
    const told = new Set<string>();
    for (const department of await ctx.db.select().from(departments).where(and(eq(departments.companyId, turn.companyId), inArray(departments.id, scope))).orderBy(asc(departments.createdAt), asc(departments.id))) {
      const observation = await quietDepartment(ctx, turn.id, department.id, now);
      if (!observation) continue;
      const recipient = await quietRecipient(ctx, turn.companyId, department.id);
      const heard = `${recipient}:${observation.silent.map(t => t.id).sort().join()}`;
      if (!recipient || told.has(heard)) continue;
      told.add(heard);
      const name = department.name || department.templateKey || department.roleCode;
      const text = `As of ${now.toISOString()}, department ${name} has had no employee working since ${observation.since.toISOString()} in open turn ${turn.number}, and nothing says why for ${observation.silent.map(t => `#${t.number}`).join(', ')}. See what they need.`;
      await recordWaitNotice(ctx.db, {
        companyId: turn.companyId, agentId: recipient, dedupKey: `quiet:${observation.key}`,
        guard: { tasks: taskVersions(observation.work), quiet: { turnId: turn.id, departmentId: department.id, key: observation.key } },
        message: await notificationMessage(ctx, turn.companyId, 'department_quiet', text, { tasks: observation.silent.map(t => ({ id: t.id, number: t.number })) }),
      });
    }
  }
}

/* Called after waits expire, at startup and at least once each minute. */
export async function checkWaitHealth(ctx: Ctx, now = new Date()): Promise<void> {
  await checkWaitDependencies(ctx);
  await recordCycles(ctx, now);
  await recordQuietDepartments(ctx, now);
  await sweepWaits(ctx, now);
  await deliverWaitNotices(ctx, now);
}

/* The check as a tool call asks for it, after its own move: the check reads a lot and may fail (the 5 s transaction timeout of a
   busy minute), but the move is done by then, so the call does not fail for it. The failure is logged, and the next minute's
   round does the check again. */
export async function tryWaitHealth(ctx: Ctx, now = new Date()): Promise<void> {
  await checkWaitHealth(ctx, now).catch((error: unknown) => ctx.log.error({ error: loggable(error) }, 'Checking task waits after a tool call failed; the next minute round does it again.'));
}
