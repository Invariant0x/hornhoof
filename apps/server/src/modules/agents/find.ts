import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireAgentView } from '../../auth/agent-view.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { agents } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { orchestratorOf } from '../conversation/turn-records.js';

const AgentParams = z.object({ id: z.union([z.literal('orchestrator'), z.uuid()]) });

export type AgentRow = typeof agents.$inferSelect;

/* The agent a request names by id, or "orchestrator", whoever asks. Removed employees are gone. */
export async function namedAgent(ctx: Ctx, req: FastifyRequest): Promise<{ me: Person; agent: AgentRow }> {
  const me = await requirePerson(req, ctx.db);
  const { id } = AgentParams.parse(req.params);
  const agent =
    id === 'orchestrator'
      ? await orchestratorOf(ctx, me.companyId)
      : (await ctx.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, me.companyId), isNull(agents.removedAt))))[0];
  if (!agent) throw new ApiError(404, 'not_found', id === 'orchestrator' ? 'This company has no orchestrator.' : 'This employee does not exist.', 'agent_unknown');
  return { me, agent };
}

/* The same, for a person who sees it. */
export async function agentFor(ctx: Ctx, req: FastifyRequest): Promise<{ me: Person; agent: AgentRow }> {
  const found = await namedAgent(ctx, req);
  await requireAgentView(ctx.db, found.me, found.agent);
  return found;
}
