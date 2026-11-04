import type { RecordedWaitOn } from '@hornhoof/protocol/waits';
import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents } from '../../db/schema.js';
import { liveSubscription } from '../conversation/queue.js';
import { refuse } from './engine.js';

export async function checkedWaitTarget(ctx: Ctx, companyId: string, waiter: string, on: RecordedWaitOn | undefined): Promise<RecordedWaitOn | undefined> {
  if (on?.kind !== 'employee') return on;
  if (on.employee === waiter) throw refuse(400, 'task_invalid', 'Name another employee to wait for.');
  const [target] = await ctx.db.select().from(agents).where(and(
    eq(agents.id, on.employee), eq(agents.companyId, companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt),
  ));
  if (!target || !(await liveSubscription(ctx, target.id))) throw refuse(400, 'task_invalid', 'That employee cannot take work. Name an available employee or an external event.');
  return { kind: 'employee', employee: target.id, name: target.name };
}
