import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents } from '../../db/schema.js';
import { liveSubscription } from '../conversation/queue.js';
import { operationsWatchers } from './silent.js';

export async function waitOrchestrator(ctx: Ctx, companyId: string): Promise<string | null> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!agent) return null;
  return await liveSubscription(ctx, agent.id) ? agent.id : null;
}

export async function quietRecipient(ctx: Ctx, companyId: string): Promise<string | null> {
  const watcher = (await operationsWatchers(ctx, companyId)).find(agent => agent.roleKey === 'OPS-WATCH');
  return watcher ? watcher.id : waitOrchestrator(ctx, companyId);
}
