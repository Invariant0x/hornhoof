import type { Ctx } from '../../app.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { appendEvent } from '../events/store.js';

/* A machine access change goes to the orchestrator's window, attributed to the person when there was one. */
export async function computerLine(ctx: Ctx, companyId: string, data: Record<string, unknown>, personId: string | null): Promise<void> {
  const orchestrator = await orchestratorOf(ctx, companyId);
  if (orchestrator) await appendEvent(ctx, { companyId, agentId: orchestrator.id, kind: 'computer', data, personId });
}
