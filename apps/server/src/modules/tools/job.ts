import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { agents, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

/* answersCeo: the turn carries a message of the CEO, so the tools only the CEO may ask for work in it. */
export type ToolJob = {
  id: string;
  companyId: string;
  agentId: string;
  agentKind: (typeof agents.$inferSelect)['kind'];
  roleKey: string | null;
  departmentId: string | null;
  skills: string[];
  answersCeo: boolean;
};

/* The token works only while its job runs, and only for a job that belongs to an agent. */
export async function jobOf(ctx: Ctx, req: FastifyRequest): Promise<ToolJob> {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const [job] = token
    ? await ctx.db
        .select({
          id: jobs.id,
          companyId: jobs.companyId,
          agentId: agents.id,
          agentKind: agents.kind,
          roleKey: agents.roleKey,
          departmentId: agents.departmentId,
          skills: agents.skills,
          answersCeo: jobs.answersCeo,
        })
        .from(jobs)
        .innerJoin(agents, eq(agents.id, jobs.agentId))
        .where(and(eq(jobs.toolTokenHash, hashToken(token)), eq(jobs.status, 'running')))
    : [];
  if (!job) throw new ApiError(401, 'unauthorized', 'This tool token is not valid.', 'tool_token_invalid');
  return job;
}
