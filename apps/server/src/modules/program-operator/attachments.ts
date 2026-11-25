import { and, eq, isNull, lte } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { canViewAgent } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, departments, jobs, programOperatorCases, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { ToolJob } from '../tools/job.js';
import { fileBytes } from '../tasks/file-bytes.js';
import { ofOperations } from './staff.js';

const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const casePictureUnknown = (): ApiError => new ApiError(404, 'not_found', 'There is no such picture.', 'attachment_unknown');

type Reader = Pick<Ctx, 'db' | 'config' | 'files'>;

/* Bound the size in the query too: an invalid row never becomes an unbounded download. */
async function casePicture(ctx: Reader, companyId: string, id: string, caseId?: string) {
  const [found] = await ctx.db.select({ id: attachments.id, incident: programOperatorCases, target: agents }).from(attachments)
    .innerJoin(programOperatorCases, eq(programOperatorCases.id, attachments.operatorCaseId))
    .innerJoin(agents, eq(agents.id, programOperatorCases.agentId))
    .innerJoin(jobs, eq(jobs.id, programOperatorCases.jobId))
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(attachments.id, id), eq(attachments.companyId, companyId), eq(programOperatorCases.companyId, companyId),
      eq(agents.companyId, companyId), eq(jobs.companyId, companyId), eq(subscriptions.companyId, companyId),
      eq(attachments.agentId, agents.id), eq(attachments.jobId, jobs.id), eq(jobs.agentId, agents.id),
      eq(jobs.kind, 'conversation'), eq(attachments.mediaType, 'image/png'),
      lte(attachments.size, MAX_PICTURE_BYTES), caseId ? eq(programOperatorCases.id, caseId) : undefined));
  if (!found) return null;
  const bytes = await fileBytes(ctx, found.id);
  if (bytes.length > MAX_PICTURE_BYTES) return null;
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? { ...found, bytes } : null;
}

type CasePicture = NonNullable<Awaited<ReturnType<typeof casePicture>>>;
async function reportRecipient(db: Db, agent: typeof agents.$inferSelect, job: ToolJob, found: CasePicture): Promise<boolean> {
  if (agent.kind !== 'head' || !agent.departmentId || agent.departmentId !== found.target.departmentId || !found.incident.escalationJobId) return false;
  const [recipient] = await db.select({ id: jobs.agentId }).from(jobs).where(and(eq(jobs.id, found.incident.escalationJobId), eq(jobs.companyId, job.companyId), eq(jobs.agentId, agent.id)));
  return Boolean(recipient);
}

async function agentMayRead(db: Db, job: ToolJob, found: CasePicture): Promise<boolean> {
  const [current] = await db.select({ agent: agents, department: departments }).from(agents)
    .innerJoin(jobs, eq(jobs.agentId, agents.id))
    .leftJoin(departments, and(eq(departments.id, agents.departmentId), eq(departments.companyId, job.companyId)))
    .where(and(eq(agents.id, job.agentId), eq(agents.companyId, job.companyId), eq(jobs.id, job.id), eq(jobs.companyId, job.companyId), eq(jobs.status, 'running'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!current) return false;
  const { agent } = current;
  if (agent.kind === 'orchestrator') return true;
  if (agent.id === found.incident.agentId) return false;
  /* Operations see any employee's program, so they see its pictures too. */
  if (await ofOperations(db, agent, current.department)) return true;
  return reportRecipient(db, agent, job, found);
}

/* A case reference and a picture UUID are the entire interface: names, paths and target overrides grant no access. */
export async function agentCasePicture(ctx: Reader, job: ToolJob, ref: string, file: string): Promise<Buffer> {
  const caseId = ref.slice('operator-case:'.length);
  if (!z.uuid().safeParse(caseId).success || !z.uuid().safeParse(file).success) throw casePictureUnknown();
  const found = await casePicture(ctx, job.companyId, file, caseId);
  if (!found || !(await agentMayRead(ctx.db, job, found))) throw casePictureUnknown();
  return found.bytes;
}

/* A person sees the picture when they see the target employee, on the one rule of who sees whom. To anyone else it does
   not exist, as for an agent above: its refusal does not tell a real picture from a made up id. */
export async function personCasePicture(ctx: Reader, person: Person, id: string): Promise<Buffer> {
  const found = await casePicture(ctx, person.companyId, id);
  if (!found || !(await canViewAgent(ctx.db, person, found.target))) throw casePictureUnknown();
  return found.bytes;
}

export function sendCasePicture(reply: FastifyReply, bytes: Buffer): FastifyReply {
  return reply.header('x-content-type-options', 'nosniff')
    .header('x-file-name', 'program-question.png')
    .header('content-security-policy', "default-src 'none'")
    .header('cache-control', 'private, max-age=86400')
    .type('image/png').send(bytes);
}
