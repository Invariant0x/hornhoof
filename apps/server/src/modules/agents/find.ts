import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach } from '../../auth/access.js';
import { requireCompanyScope, requirePerson, type Person } from '../../auth/session.js';
import { agents } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { orchestratorOf } from '../conversation/queue.js';

const AgentParams = z.object({ id: z.union([z.literal('orchestrator'), z.uuid()]) });

export type AgentRow = typeof agents.$inferSelect;

/* The agent a request names by id, or "orchestrator", for a person who may reach it: the orchestrator for people who
   see the whole company, an employee for people who reach its department. Removed employees are gone. */
export async function agentFor(ctx: Ctx, req: FastifyRequest): Promise<{ me: Person; agent: AgentRow }> {
  const me = await requirePerson(req, ctx.db);
  const { id } = AgentParams.parse(req.params);
  const agent =
    id === 'orchestrator'
      ? await orchestratorOf(ctx, me.companyId)
      : (await ctx.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, me.companyId), isNull(agents.removedAt))))[0];
  if (!agent) throw new ApiError(404, 'not_found', id === 'orchestrator' ? 'This company has no orchestrator.' : 'This employee does not exist.', 'agent_unknown');
  if (agent.kind === 'orchestrator') requireCompanyScope(me);
  else if (!canReach(await accessOf(ctx.db, me), await agentSpot(ctx.db, agent))) {
    throw new ApiError(403, 'forbidden', 'This employee works in a department you do not have.', 'not_your_department');
  }
  return { me, agent };
}
