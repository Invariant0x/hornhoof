import { and, eq, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents } from '../../db/schema.js';
import { departmentOwner } from '../departments/approval-policy.js';
import { notificationMessage } from '../events/notifications.js';
import { recordWaitNotice } from '../tasks/wait-notices.js';
import type { Signal } from './lifecycle.js';
import { reportText, type Report } from './run.js';

export type SignalPlace = { companyId: string; departmentId: string; checkId: string; kind: string };

const recipients = (ctx: Pick<Ctx, 'db'>, place: SignalPlace) => ctx.db.select({ id: agents.id }).from(agents).where(and(
  eq(agents.companyId, place.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt),
  or(eq(agents.kind, 'orchestrator'), and(eq(agents.kind, 'head'), eq(agents.departmentId, place.departmentId))),
));

/* One signal to the head of the department and to the orchestrator, through the notices that survive a restart. There is no
   way yet to call a person directly from outside a task, so the text names the owner for the orchestrator to tell. */
export async function recordCheckSignal(ctx: Pick<Ctx, 'db' | 'templates'>, place: SignalPlace, signal: Signal, report: Report): Promise<void> {
  const owner = await departmentOwner(ctx, place.companyId, place.departmentId);
  const text = `Model check ${place.kind} is off and stays off until a run passes. Tell the owner of its department, ${owner?.name ?? 'the CEO'}.\n${reportText(report)}`;
  const message = await notificationMessage(ctx, place.companyId, 'service', text);
  for (const agent of await recipients(ctx, place)) {
    await recordWaitNotice(ctx.db, { companyId: place.companyId, agentId: agent.id, dedupKey: `model-check:${place.checkId}:${signal.dedupKey}:${agent.id}`, guard: { tasks: [] }, message });
  }
}
