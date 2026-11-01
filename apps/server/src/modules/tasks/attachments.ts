import { and, asc, count, desc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { requirePerson } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { attachments, departments, requests, tasks, type RequestOption } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { jobOf, type ToolJob } from '../tools/job.js';
import { refuse, taskSpot, type Task } from './engine.js';
import { taskByRef } from './views.js';

/* A screenshot fits comfortably; a turn sends a few dozen at most. */
export const PICTURE_BYTES = 3 * 1024 * 1024;
const PER_TURN = 30;
/* A file on a task: a build, a log or a data set fits, and the database still carries it. */
export const FILE_BYTES = 50 * 1024 * 1024;
const NAME_LENGTH = 200;

/* A file's name on its task: the last part of what was sent, never a folder, without control characters. */
export function fileName(raw: string): string | null {
  const name = (raw.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_LENGTH);
  return name && name !== '.' && name !== '..' ? name : null;
}

/* Text that carries a file instead of words: 1000 or more characters of base64 or hex in a row, on one line or wrapped in
   lines of 60 or more, with letters and digits both, so a long line of dashes is no file. */
const ENCODED_RUN = 1000;
const ENCODED_LINE = 60;
const CODE = /[A-Za-z0-9+/=_-]+/g;
const mixed = (run: string) => /[0-9]/.test(run) && /[A-Za-z]/.test(run);
export function carriesFile(text: string): boolean {
  if ((text.match(CODE) ?? []).some(run => run.length >= ENCODED_RUN && mixed(run))) return true;
  let wrapped = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    wrapped = t.length >= ENCODED_LINE && t.match(CODE)?.[0] === t && mixed(t) ? wrapped + t.length : 0;
    if (wrapped >= ENCODED_RUN) return true;
  }
  return false;
}

/* What an agent hears when it pastes a file into what it writes. */
export const encodedHint = (task?: number) =>
  `This text carries an encoded file. Put the file on ${task ? `the task with hh-attach --task ${task} FILE` : 'the task it is for with hh-attach --task <task number> FILE'} and write its name instead: anyone downloads it with hh-fetch.`;

/* An agent works on a task when it runs the company, the task is its department's, or it holds, does, checks or made it. */
const onTask = (job: ToolJob, t: Task) =>
  job.agentKind === 'orchestrator' || (job.departmentId !== null && t.departmentId === job.departmentId) || [t.assigneeAgentId, t.executorAgentId, t.createdByAgentId, ...t.gates, ...t.panel].includes(job.agentId);

/* The files on a task, the newest under each name, without their bytes. */
export async function filesOf(db: Db, taskId: string): Promise<{ id: string; name: string; size: number; agentId: string; at: Date }[]> {
  const rows = await db
    .select({ id: attachments.id, name: attachments.name, size: attachments.size, agentId: attachments.agentId, at: attachments.createdAt })
    .from(attachments)
    .where(eq(attachments.taskId, taskId))
    .orderBy(desc(attachments.createdAt));
  const newest = new Map<string, (typeof rows)[number] & { name: string }>();
  for (const r of rows) if (r.name !== null && !newest.has(r.name)) newest.set(r.name, { ...r, name: r.name });
  return [...newest.values()];
}

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
const SendQuery = z.object({ task: z.string().optional(), name: z.string().optional() });
const FetchQuery = z.object({ task: z.string().min(1), file: z.string().min(1) });

export function attachmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* An agent's running turn sends a picture as raw bytes with its tool token, through hh-attach; or, naming a task it
     works on (?task=12&name=build.tar.gz), a file of any kind for that task. */
  void app.register(async scope => {
    scope.addContentTypeParser(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: FILE_BYTES }, (_req, body, done) => done(null, body));
    scope.post('/api/attachments', { bodyLimit: FILE_BYTES }, async (req, reply) => {
      const job = await jobOf(ctx, req);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { task: ref, name: raw } = SendQuery.parse(req.query);
      const task = ref === undefined ? null : await taskByRef(ctx, job.companyId, ref);
      if (ref !== undefined && (!task || !onTask(job, task))) throw new ApiError(404, 'not_found', `There is no task ${ref} you work on.`, 'task_unknown');
      const name = task ? fileName(raw ?? '') : null;
      if (task && !name) throw new ApiError(400, 'validation', 'Name the file: name=<file name>.', 'attachment_invalid');
      if (!task && bytes.length > PICTURE_BYTES) throw new ApiError(413, 'validation', `A picture is at most ${PICTURE_BYTES / 1024 / 1024} MB. Put a bigger file on its task.`, 'attachment_invalid');
      const type = task ? 'application/octet-stream' : pictureType(bytes);
      if (!type) throw new ApiError(400, 'validation', 'Send a PNG, JPEG or WebP picture, or name the task a file is for.', 'attachment_invalid');
      const [sent] = await db.select({ n: count() }).from(attachments).where(eq(attachments.jobId, job.id));
      if (Number(sent?.n ?? 0) >= PER_TURN) throw refuse(409, 'task_invalid', `One turn sends at most ${PER_TURN} pictures and files.`);
      const [row] = await db
        .insert(attachments)
        .values({ companyId: job.companyId, jobId: job.id, agentId: job.agentId, taskId: task?.id ?? null, name, mediaType: type, bytes, size: bytes.length })
        .returning({ id: attachments.id });
      reply.code(201);
      return task ? { id: row!.id, name } : { id: row!.id };
    });
  });

  /* Any agent of the company downloads a task's file, by its name or id, with its tool token, through hh-fetch. A name
     put on twice gives the newest. */
  app.get('/api/attachments/file', async (req, reply) => {
    const job = await jobOf(ctx, req);
    const { task: ref, file } = FetchQuery.parse(req.query);
    const task = await taskByRef(ctx, job.companyId, ref);
    const byId = z.uuid().safeParse(file).success;
    const [found] = task
      ? await db
          .select({ name: attachments.name, bytes: attachments.bytes })
          .from(attachments)
          .where(and(eq(attachments.taskId, task.id), byId ? or(eq(attachments.id, file), eq(attachments.name, file)) : eq(attachments.name, file)))
          .orderBy(desc(attachments.createdAt))
          .limit(1)
      : [];
    if (!found) throw new ApiError(404, 'not_found', `Task ${ref} has no file ${file}. Its card lists its files.`, 'attachment_unknown');
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('x-file-name', encodeURIComponent(found.name ?? ''))
      .type('application/octet-stream')
      .send(Buffer.from(found.bytes));
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
