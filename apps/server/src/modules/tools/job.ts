import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { agents, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { mergePending } from '../nodes/parked.js';
import { turnSign } from '../tasks/turn-signs.js';

export type ToolJob = {
  id: string;
  companyId: string;
  agentId: string;
  agentKind: (typeof agents.$inferSelect)['kind'];
  roleKey: string | null;
  departmentId: string | null;
  skills: string[];
};
export type RunJob = Pick<ToolJob, 'id' | 'companyId' | 'agentId' | 'agentKind'> & Partial<Pick<ToolJob, 'departmentId'>>;

export const toolJobFields = {
  id: jobs.id,
  companyId: jobs.companyId,
  agentId: agents.id,
  agentKind: agents.kind,
  roleKey: agents.roleKey,
  departmentId: agents.departmentId,
  skills: agents.skills,
};

const notValid = () => new ApiError(401, 'unauthorized', 'This tool token is not valid.', 'tool_token_invalid');

/* A token no running job has. While the database of a machine the server was taken from waits to be merged, the job
   may be one that machine started, whose row comes with the merge, or one that waits here until then: the caller is
   asked to try again. The token of a job that ended is not valid, as ever. */
async function unknownToken(ctx: Ctx, token: string | undefined): Promise<ApiError> {
  if (!token || !(await mergePending(ctx.db))) return notValid();
  const [other] = await ctx.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.toolTokenHash, hashToken(token)));
  if (other && other.status !== 'queued') return notValid();
  return new ApiError(503, 'unavailable', 'Hornhoof is bringing back work from another machine. Try again in a few minutes.', 'merge_pending');
}

/* The token works only while its job runs, and only for a job that belongs to an agent still in the company: once a
   person stops the turn, its tools stop at once, while its program still winds down. */
export async function jobOf(ctx: Ctx, req: FastifyRequest): Promise<ToolJob> {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const [job] = token
    ? await ctx.db
        .select(toolJobFields)
        .from(jobs)
        .innerJoin(agents, eq(agents.id, jobs.agentId))
        .where(and(eq(jobs.toolTokenHash, hashToken(token)), eq(jobs.status, 'running'), sql`${jobs.error} is distinct from 'cancelled'`, isNull(agents.removedAt)))
    : [];
  if (!job) throw await unknownToken(ctx, token);
  /* A call of a Hornhoof tool is a sign that the turn goes on, whether or not its program has a screen to report. */
  turnSign(ctx, job.id);
  return job;
}
