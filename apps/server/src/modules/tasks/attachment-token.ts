import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentOnNode } from '../conversation/queue.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { jobsOf } from '../nodes/messages.js';
import { turnSign } from './turn-signs.js';
import { jobOf, toolJobFields, type ToolJob } from '../tools/job.js';

const PREFIX = 'hh-attachment.';
const LIFE_MS = 5 * 60_000;
const Claims = z.object({
  job: z.uuid(), agent: z.uuid(), task: z.uuid(), expires: z.number().int(),
  node: z.union([z.object({ kind: z.literal('node'), nodeId: z.uuid() }), z.object({ kind: z.literal('builtin'), machine: z.string() })]),
});
const running = and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), sql`${jobs.error} is distinct from 'cancelled'`);
const invalid = () => new ApiError(401, 'unauthorized', 'This attachment permission is not valid.', 'attachment_invalid');
const mac = (ctx: Ctx, payload: string) => createHmac('sha256', ctx.config.secret).update(`${PREFIX}${payload}`).digest();

/* Issued only over the authenticated node link. This permission names one existing task turn, is never a tool token,
   and is kept only for the bridge's current HTTP upload. The file itself uses the normal 50 MB attachment route. */
export async function attachmentToken(ctx: Ctx, node: NodeIdentity, agentId: string): Promise<string | null> {
  const [job] = await ctx.db.select({ id: jobs.id, taskId: jobs.taskId }).from(jobs)
    .where(and(jobsOf(node, ctx), eq(jobs.agentId, agentId), running, isNotNull(jobs.taskId)))
    .orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(1);
  if (!job?.taskId) return null;
  const identity = node.kind === 'node' ? { kind: node.kind, nodeId: node.nodeId } : node;
  const payload = Buffer.from(JSON.stringify({ job: job.id, agent: agentId, task: job.taskId, node: identity, expires: Date.now() + LIFE_MS })).toString('base64url');
  return `${PREFIX}${payload}.${mac(ctx, payload).toString('base64url')}`;
}

function verifiedPayload(ctx: Ctx, token: string): string {
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token.slice(PREFIX.length));
  if (!parts) throw invalid();
  const payload = parts[1]!;
  const expected = mac(ctx, payload), given = Buffer.from(parts[2]!, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();
  return payload;
}

function claimsOf(ctx: Ctx, token: string): z.infer<typeof Claims> {
  const payload = verifiedPayload(ctx, token);
  let value: unknown;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
  const parsed = Claims.safeParse(value);
  if (!parsed.success || parsed.data.expires <= Date.now()) throw invalid();
  return parsed.data;
}

export type AttachmentJob = ToolJob & { attachmentTaskId?: string };

/* Verify the live turn again when the bytes arrive: stopping it or moving the program invalidates an earlier grant. */
export async function attachmentJobOf(ctx: Ctx, req: FastifyRequest): Promise<AttachmentJob> {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token?.startsWith(PREFIX)) return jobOf(ctx, req);
  const claims = claimsOf(ctx, token);
  const target = await agentOnNode(ctx, claims.node, claims.agent);
  if (!target || target.agent.switchedOffAt) throw invalid();
  const [job] = await ctx.db.select(toolJobFields).from(jobs).innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(and(eq(jobs.id, claims.job), eq(jobs.agentId, claims.agent), eq(jobs.taskId, claims.task), jobsOf(claims.node, ctx), running));
  if (!job) throw invalid();
  turnSign(ctx, job.id);
  return { ...job, attachmentTaskId: claims.task };
}
