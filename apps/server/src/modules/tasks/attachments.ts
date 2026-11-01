import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { requirePerson } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { attachments, departments, requests, tasks, type RequestOption } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { jobOf } from '../tools/job.js';
import { refuse, taskSpot, type Task } from './engine.js';

/* A screenshot fits comfortably; a turn sends a few dozen at most. */
export const PICTURE_BYTES = 3 * 1024 * 1024;
const PER_TURN = 30;

/* Only pictures a browser shows as pictures: no SVG, which can carry script. */
export function pictureType(b: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/* Where a commit of the task's repository can be seen: on GitHub, from the product's repository, else the department's. */
export async function commitUrl(db: Db, task: Pick<Task, 'departmentId' | 'productId'>, commit: string | null): Promise<string | null> {
  if (!commit) return null;
  const ids = [task.productId, task.departmentId].filter((x): x is string => Boolean(x));
  if (!ids.length) return null;
  const rows = await db.select({ id: departments.id, repoUrl: departments.repoUrl }).from(departments).where(inArray(departments.id, ids));
  const repo = ids.map(id => rows.find(r => r.id === id)?.repoUrl).find(Boolean);
  if (!repo) return null;
  const url = new URL(repo);
  if (url.host !== 'github.com') return null;
  return `https://github.com${url.pathname.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${commit}`;
}

/* The pictures each request shows on its own, apart from those of its options, in the order they were sent. */
export async function picturesOf(db: Db, rows: { id: string; options: RequestOption[] }[]): Promise<Map<string, string[]>> {
  const ids = rows.map(r => r.id);
  const found = ids.length
    ? await db.select({ id: attachments.id, requestId: attachments.requestId }).from(attachments).where(inArray(attachments.requestId, ids)).orderBy(asc(attachments.createdAt))
    : [];
  return new Map(rows.map(r => [r.id, found.filter(a => a.requestId === r.id && !r.options.some(o => o.image === a.id)).map(a => a.id)]));
}

const IdParams = z.object({ id: z.uuid() });

export function attachmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* An agent's running turn sends a picture as raw bytes with its tool token, through hh-attach. */
  void app.register(async scope => {
    scope.addContentTypeParser(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: PICTURE_BYTES }, (_req, body, done) => done(null, body));
    scope.post('/api/attachments', { bodyLimit: PICTURE_BYTES }, async (req, reply) => {
      const job = await jobOf(ctx, req);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = pictureType(bytes);
      if (!type) throw new ApiError(400, 'validation', 'Send a PNG, JPEG or WebP picture.', 'attachment_invalid');
      const [sent] = await db.select({ n: count() }).from(attachments).where(eq(attachments.jobId, job.id));
      if (Number(sent?.n ?? 0) >= PER_TURN) throw refuse(409, 'task_invalid', `One turn sends at most ${PER_TURN} pictures.`);
      const [row] = await db.insert(attachments).values({ companyId: job.companyId, jobId: job.id, agentId: job.agentId, mediaType: type, bytes, size: bytes.length }).returning({ id: attachments.id });
      reply.code(201);
      return { id: row!.id };
    });
  });

  /* People see a picture once a request shows it, and only where they reach the request's task. */
  app.get('/api/attachments/:id', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const [found] = await db
      .select({ mediaType: attachments.mediaType, bytes: attachments.bytes, task: tasks })
      .from(attachments)
      .innerJoin(requests, eq(requests.id, attachments.requestId))
      .innerJoin(tasks, eq(tasks.id, requests.taskId))
      .where(and(eq(attachments.id, id), eq(attachments.companyId, me.companyId)));
    if (!found || !canReach(await accessOf(db, me), taskSpot(found.task))) throw new ApiError(404, 'not_found', 'There is no such picture.', 'attachment_unknown');
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('cache-control', 'private, max-age=86400')
      .type(found.mediaType)
      .send(Buffer.from(found.bytes));
  });
}
