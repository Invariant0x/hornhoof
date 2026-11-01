import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { agents, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

export type ToolJob = { id: string; companyId: string; agentId: string; agentKind: (typeof agents.$inferSelect)['kind']; departmentId: string | null; skills: string[] };

/* The token works only while its job runs, and only for a job that belongs to an agent. */
export async function jobOf(ctx: Ctx, req: FastifyRequest): Promise<ToolJob> {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const [job] = token
    ? await ctx.db
        .select({ id: jobs.id, companyId: jobs.companyId, agentId: agents.id, agentKind: agents.kind, departmentId: agents.departmentId, skills: agents.skills })
        .from(jobs)
        .innerJoin(agents, eq(agents.id, jobs.agentId))
        .where(and(eq(jobs.toolTokenHash, hashToken(token)), eq(jobs.status, 'running')))
    : [];
  if (!job) throw new ApiError(401, 'unauthorized', 'This tool token is not valid.', 'tool_token_invalid');
  return job;
}
