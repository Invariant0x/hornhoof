import type { Ctx } from '../../app.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { appendEvent } from '../events/store.js';
import { logName, onMachine } from './access.js';

/* A machine access change goes to the orchestrator's window, attributed to the person when there was one. */
export async function computerLine(ctx: Ctx, companyId: string, data: Record<string, unknown>, personId: string | null) {
  const orchestrator = await orchestratorOf(ctx, companyId);
  if (orchestrator) await appendEvent(ctx, { companyId, agentId: orchestrator.id, kind: 'computer', data, personId });
  return orchestrator;
}

/* Called directly on controlled clocks in tests, and by the leader's periodic step in the app. */
export async function expireAccess(ctx: Ctx): Promise<void> {
  for (const { companyId, machine } of await ctx.computer.expire()) {
    await computerLine(ctx, companyId, { state: 'expired', ...onMachine(logName(machine)) }, null);
    ctx.bus.publish(companyId, { type: 'computer' });
  }
}
