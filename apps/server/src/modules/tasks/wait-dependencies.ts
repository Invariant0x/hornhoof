import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, tasks } from '../../db/schema.js';
import { liveSubscription } from '../conversation/placement.js';
import { pausedCompanyIds } from '../org/pause-state.js';
import { CLOSED } from './state.js';
import { expireWait } from './wait-expiry.js';

async function unavailableEmployee(ctx: Ctx, companyId: string, id: string): Promise<string | null> {
  const [employee] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, id)));
  if (!employee || employee.removedAt) return 'removed';
  if (employee.switchedOffAt) return 'switched off';
  return await liveSubscription(ctx, id) ? null : 'no plan';
}

/* An unavailable dependency gives the holder a turn to choose another way forward. */
export async function checkWaitDependencies(ctx: Ctx): Promise<void> {
  const paused = await pausedCompanyIds(ctx.db);
  const waiting = await ctx.db.select().from(tasks).where(and(isNotNull(tasks.externalWait), notInArray(tasks.status, [...CLOSED])));
  for (const task of waiting) {
    if (paused.has(task.companyId)) continue;
    const wait = task.externalWait;
    if (wait?.on?.kind !== 'employee') continue;
    const on = wait.on;
    const reason = await unavailableEmployee(ctx, task.companyId, on.employee);
    if (!reason) continue;
    const consequence = wait.work ? `Find a way to continue "${wait.reason}".` : `The wait for "${wait.reason}" ended.`;
    await expireWait(ctx, task, `${on.name || on.employee} cannot take work now: ${reason}. ${consequence}`);
  }
}
