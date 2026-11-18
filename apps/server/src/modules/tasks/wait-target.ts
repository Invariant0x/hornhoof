import type { RecordedWaitOn } from '@hornhoof/protocol/waits';
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents } from '../../db/schema.js';
import { liveSubscription } from '../conversation/placement.js';
import { refuse } from './state.js';

export async function checkedWaitTarget(ctx: Ctx, companyId: string, waiter: string, on: RecordedWaitOn | undefined): Promise<RecordedWaitOn | undefined> {
  if (on?.kind !== 'employee') return on;
  const [target] = await ctx.db.select().from(agents).where(and(
    eq(agents.id, on.employee), eq(agents.companyId, companyId), ne(agents.kind, 'assistant'), isNull(agents.removedAt), isNull(agents.switchedOffAt),
  ));
  // An id in capitals finds the same employee, so the one found is compared too.
  if (on.employee === waiter || target?.id === waiter) throw refuse(400, 'task_invalid', 'Name another employee to wait for.');
  if (!target || !(await liveSubscription(ctx, target.id))) throw refuse(400, 'task_invalid', 'That employee cannot take work. Name an available employee or an external event.');
  return { kind: 'employee', employee: target.id, name: target.name };
}
