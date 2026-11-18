import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, tasks } from '../../db/schema.js';
import { liveSubscription } from '../conversation/queue.js';
import { CLOSED } from './state.js';
import { expireWait } from './external-wait.js';

async function unavailableEmployee(ctx: Ctx, companyId: string, id: string): Promise<string | null> {
  const [employee] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, id)));
  if (!employee || employee.removedAt) return 'removed';
  if (employee.switchedOffAt) return 'switched off';
  return await liveSubscription(ctx, id) ? null : 'no plan';
}

/* A dependency that cannot take work gives the waiting holder a turn to choose another way forward. */
export async function checkWaitDependencies(ctx: Ctx): Promise<void> {
  const waiting = await ctx.db.select().from(tasks).where(and(isNotNull(tasks.externalWait), notInArray(tasks.status, [...CLOSED])));
  for (const task of waiting) {
    const on = task.externalWait?.on;
    if (on?.kind !== 'employee') continue;
    const reason = await unavailableEmployee(ctx, task.companyId, on.employee);
    if (reason) await expireWait(ctx, task, `${on.name || on.employee} cannot take work now: ${reason}. The wait for "${task.externalWait!.reason}" ended.`);
  }
}
