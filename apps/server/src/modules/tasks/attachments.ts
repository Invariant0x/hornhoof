import { Readable } from 'node:stream';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { canViewAgent, seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, departments, requests, tasks, turns, type RequestOption } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { appendEvent } from '../events/store.js';
import { jobOf, type RunJob, type ToolJob } from '../tools/job.js';
import { agentCasePicture, personCasePicture, sendCasePicture } from '../program-operator/attachments.js';
import { mayOpenRequest } from './decisions.js';
import { refuse, type Task } from './engine.js';
import { seesTask } from './sight.js';
import { agentSeesTask, taskByRef } from './views.js';

/* A screenshot fits comfortably; a turn sends a few dozen at most. */
export const PICTURE_BYTES = 3 * 1024 * 1024;
const PER_TURN = 30;
/* A file on a task: a build, a log or a data set fits, and the database still carries it. */
export const FILE_BYTES = 50 * 1024 * 1024;
const NAME_LENGTH = 200;
/* Every copy of the database carries the files, so one task holds this much and the company what its setting says. */
export const TASK_FILES_BYTES = 500 * 1024 * 1024;
/* The files of a turn go this long after it closed. */
const KEEP_FILES_MS = 30 * 24 * 60 * 60 * 1000;
/* A download leaves in pieces of this size, so the server never holds a whole file. */
const PIECE_BYTES = 1024 * 1024;

const GB = 1024 * 1024 * 1024;
const sizeText = (bytes: number) => (bytes >= GB ? `${Number((bytes / GB).toFixed(1))} GB` : `${Math.ceil(bytes / 1024 / 1024)} MB`);
const ELSEWHERE = 'Put a smaller file, or keep a big one outside Hornhoof and write where it is.';

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
export const onTask = (job: RunJob, t: Task) =>
  job.agentKind === 'orchestrator' || (job.departmentId != null && t.departmentId === job.departmentId) || [t.assigneeAgentId, t.executorAgentId, t.createdByAgentId].includes(job.agentId);

/* The files on a task, the newest under each name, without their bytes. */
export async function filesOf(db: Db, taskId: string): Promise<{ id: string; name: string; size: number; agentId: string; personId: string | null; at: Date }[]> {
  const rows = await db
    .select({ id: attachments.id, name: attachments.name, size: attachments.size, agentId: attachments.agentId, personId: attachments.personId, at: attachments.createdAt })
    .from(attachments)
    .where(and(eq(attachments.taskId, taskId), isNull(attachments.operatorCaseId)))
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
    ? await db.select({ id: attachments.id, requestId: attachments.requestId }).from(attachments).where(and(inArray(attachments.requestId, ids), isNull(attachments.operatorCaseId))).orderBy(asc(attachments.createdAt))
    : [];
  return new Map(rows.map(r => [r.id, found.filter(a => a.requestId === r.id && !r.options.some(o => o.image === a.id)).map(a => a.id)]));
}

/* Removes the files on the tasks of turns closed 30 days or more before now, and people's pictures sent as long ago or
   never sent, and says how many went. */
export async function dropOldFiles(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - KEEP_FILES_MS);
  const loose = await db
    .delete(attachments)
    .where(and(or(isNotNull(attachments.personId), and(isNull(attachments.requestId), isNotNull(attachments.name))), isNull(attachments.taskId), lt(attachments.createdAt, cutoff)))
    .returning({ id: attachments.id });
  const old = db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(turns, eq(turns.id, tasks.turnId))
    .where(and(eq(turns.status, 'closed'), lt(turns.closedAt, cutoff)));
  return loose.length + (await db.delete(attachments).where(inArray(attachments.taskId, old)).returning({ id: attachments.id })).length;
}

/* What counts towards what the company keeps: files on tasks, chat files and people's pictures. */
const kept = (companyId: string) => and(eq(attachments.companyId, companyId), or(isNotNull(attachments.taskId), isNotNull(attachments.personId), isNotNull(attachments.name)));

const companyFull = (inCompany: number, limit: number) =>
  new ApiError(413, 'validation', `The company's task files take ${sizeText(inCompany)} of the ${sizeText(limit)} Hornhoof keeps for them. The files of a turn go 30 days after it closes. ${ELSEWHERE}`, 'attachment_invalid');

/* Refuses a person's picture of this size when the company has no room left for it. */
export async function checkPictureRoom(ctx: Pick<Ctx, 'db' | 'config'>, companyId: string, size: number): Promise<void> {
  const [used] = await ctx.db.select({ company: sql<string>`coalesce(sum(${attachments.size}), 0)` }).from(attachments).where(kept(companyId));
  const inCompany = Number(used!.company);
  if (inCompany + size > ctx.config.taskFilesBytes) throw companyFull(inCompany, ctx.config.taskFilesBytes);
}

/* Refuses a new file of this size on the task when the task or the company has no room left for it. */
export async function checkRoom(ctx: { db: Pick<Ctx['db'], 'select'>; config: Pick<Ctx['config'], 'taskFilesBytes'> }, companyId: string, task: Pick<Task, 'id' | 'number'>, size: number): Promise<void> {
  const [used] = await ctx.db
    .select({
      task: sql<string>`coalesce(sum(${attachments.size}) filter (where ${attachments.taskId} = ${task.id}), 0)`,
      company: sql<string>`coalesce(sum(${attachments.size}), 0)`,
    })
    .from(attachments)
    .where(kept(companyId));
  const [onTask, inCompany] = [Number(used?.task ?? 0), Number(used?.company ?? 0)];
  if (onTask + size > TASK_FILES_BYTES) {
    throw new ApiError(413, 'validation', `Task ${task.number} holds ${sizeText(onTask)} of files, and one task holds at most ${sizeText(TASK_FILES_BYTES)}. ${ELSEWHERE}`, 'attachment_invalid');
  }
  if (inCompany + size > ctx.config.taskFilesBytes) throw companyFull(inCompany, ctx.config.taskFilesBytes);
}

function personDownloadType(found: { name: string | null; mediaType?: string }): string {
  if (found.mediaType === 'text/plain') return 'text/plain; charset=utf-8';
  if (found.mediaType?.startsWith('image/')) return found.mediaType;
  const lower = (found.name ?? '').toLowerCase();
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.csv')) return 'text/csv; charset=utf-8';
  return 'application/octet-stream';
}

/* A file's name as a header carries it: every character past plain letters and digits encoded. */
export const headerName = (name: string) => encodeURIComponent(name).replace(/['()*!]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/* A file's bytes a piece at a time, each read as it goes out. */
export async function* filePieces(db: Db, id: string, length: number) {
  for (let at = 0; at < length; at += PIECE_BYTES) {
    const [piece] = await db
      .select({ bytes: sql<Uint8Array>`substring(${attachments.bytes} from ${at + 1} for ${PIECE_BYTES})` })
      .from(attachments)
      .where(and(eq(attachments.id, id), isNull(attachments.operatorCaseId)));
    if (!piece) throw new Error('The file was removed while it was being sent.');
    yield Buffer.from(piece.bytes);
  }
}

/* A person gets a text or a picture to look at, and any other file to save under its name. */
const savedByPerson = (found: { mediaType?: string }, forPerson: boolean): boolean =>
  forPerson && found.mediaType !== 'text/plain' && !found.mediaType?.startsWith('image/');

/* What a file goes out as: to a person by what it is; to an agent a text as text, anything else as bytes. */
function sentType(found: { name: string | null; mediaType?: string }, forPerson: boolean): string {
  if (forPerson) return personDownloadType(found);
  return found.mediaType === 'text/plain' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}

/* Sends a task or chat file in pieces, so the server never holds a whole one. */
export async function sendFile(db: Db, reply: FastifyReply, found: { id: string; name: string | null; length: number; mediaType?: string }, forPerson = false) {
  const [ordinary] = await db.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.id, found.id), isNull(attachments.operatorCaseId)));
  if (!ordinary) throw new ApiError(404, 'not_found', 'There is no such file.', 'attachment_unknown');
  if (savedByPerson(found, forPerson)) reply.header('content-disposition', `attachment; filename*=UTF-8''${headerName(found.name ?? 'file')}`);
  return reply
    .header('x-content-type-options', 'nosniff')
    .header('x-file-name', encodeURIComponent(found.name ?? ''))
    .header('content-security-policy', "default-src 'none'")
    .header('content-length', String(found.length))
    .type(sentType(found, forPerson))
    .send(Readable.from(filePieces(db, found.id, found.length)));
}

const IdParams = z.object({ id: z.uuid() });
const SendQuery = z.object({ task: z.string().optional(), chat: z.enum(['1', 'true']).optional(), name: z.string().optional() });
const FetchQuery = z.object({ task: z.string().min(1), file: z.string().min(1) });
/* What hh-fetch names instead of a task for a picture that came with a message. */
const MESSAGE_FILES = 'message';

/* A picture a person sent this agent, for this agent alone. Two pictures pasted from the clipboard have one name, so the
   file's name starts with its id. */
async function messagePicture(db: Db, job: ToolJob, id: string) {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [found] = await db
    .select({ id: attachments.id, name: attachments.name, length: sql<number>`octet_length(${attachments.bytes})`.mapWith(Number) })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, job.companyId), eq(attachments.agentId, job.agentId), isNotNull(attachments.personId), isNull(attachments.taskId), isNull(attachments.operatorCaseId)));
  return found && { ...found, name: `${found.id.slice(0, 8)}-${found.name ?? 'picture'}` };
}

/* A file of a task goes with its task and with who wrote it: a person, or an agent this person sees. A picture shown with a
   request answers to the request instead, as below. */
async function taskFileForPerson(db: Db, me: Person, id: string) {
  const [found] = await db.select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, length: attachments.size, personId: attachments.personId, agentId: attachments.agentId, task: tasks }).from(attachments)
    .innerJoin(tasks, eq(tasks.id, attachments.taskId))
    .where(and(eq(attachments.id, id), eq(attachments.companyId, me.companyId), eq(tasks.companyId, me.companyId), isNull(attachments.requestId), isNull(attachments.operatorCaseId)));
  if (!found) return null;
  const viewer = await viewerOf(db, me);
  if (!seesTask(viewer, found.task) || !(found.personId || seesAgentId(viewer, found.agentId))) throw new ApiError(404, 'not_found', 'There is no such file.', 'attachment_unknown');
  return found;
}

/* A file an agent attached to its chat reply (hh-attach --chat FILE): only people who may see that agent download it. */
async function chatFileForPerson(db: Db, me: Person, id: string) {
  const [found] = await db
    .select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, length: attachments.size, agent: agents })
    .from(attachments)
    .innerJoin(agents, eq(agents.id, attachments.agentId))
    .where(
      and(
        eq(attachments.id, id),
        eq(attachments.companyId, me.companyId),
        isNull(attachments.personId),
        isNull(attachments.taskId),
        isNull(attachments.requestId),
        isNull(attachments.operatorCaseId),
        isNotNull(attachments.name),
      ),
    );
  if (!found) return null;
  if (!(await canViewAgent(db, me, found.agent))) throw new ApiError(404, 'not_found', 'There is no such file.', 'attachment_unknown');
  return found;
}

/* A file of a task or of an agent's chat that this person may download; it throws when they may not see it. */
const personFile = async (db: Db, me: Person, id: string) => (await taskFileForPerson(db, me, id)) ?? (await chatFileForPerson(db, me, id));

/* The same visibility for the interface and a person's assistant: ordinary task/chat files, then attachments of messages
   and requests. Program screenshots have neither a person nor a request's task; operator cases use their own route. */
type PersonAttachment = { id: string; name: string | null; mediaType: string; length: number; picture: boolean };
export async function attachmentForPerson(db: Db, me: Person, id: string): Promise<PersonAttachment | null> {
  const file = await personFile(db, me, id);
  if (file) return { ...file, picture: false };
  const [found] = await db
    .select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, length: attachments.size, personId: attachments.personId, agent: agents, task: tasks, request: requests })
    .from(attachments)
    .innerJoin(agents, eq(agents.id, attachments.agentId))
    .leftJoin(requests, eq(requests.id, attachments.requestId))
    .leftJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(attachments.id, id), eq(attachments.companyId, me.companyId), isNull(attachments.operatorCaseId)));
  if (!found || (!found.personId && !found.task)) return null;
  if (!(found.personId ? await canViewAgent(db, me, found.agent) : await mayOpenRequest(db, me, found.request!, found.task!))) {
    throw new ApiError(404, 'not_found', 'There is no such picture.', 'attachment_unknown');
  }
  return { ...found, picture: true };
}

/* Reads an attachment's bytes for a person only when that active person is allowed to see it on its task or agent chat. */
export async function attachmentBytesForPerson(
  db: Db,
  person: Person,
  id: string,
): Promise<{ id: string; name: string; mediaType: string; bytes: Buffer } | null> {
  if (person.status !== 'active') return null;
  let allowed: { id: string; name: string | null; mediaType: string } | null = null;
  try {
    allowed = await personFile(db, person, id);
  } catch {
    return null;
  }
  if (!allowed) return null;
  const [row] = await db
    .select({ bytes: attachments.bytes })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, person.companyId), isNull(attachments.operatorCaseId)));
  if (!row) return null;
  return {
    id,
    name: allowed.name ?? 'file',
    mediaType: personDownloadType(allowed),
    bytes: Buffer.from(row.bytes),
  };
}

/* Ordinary uploaded files keep their sharing rule; automatic plain-text logs keep the task's read boundary. */
function readsTaskFile(job: ToolJob, task: Task | null, file: { mediaType: string }): boolean {
  return file.mediaType !== 'text/plain' || (task !== null && agentSeesTask({ id: job.agentId, kind: job.agentKind, departmentId: job.departmentId }, task));
}

/* A file's name, which a file for a task or the chat needs; a picture for a request goes without one. */
function uploadName(asFile: boolean, rawName: string | undefined): string | null {
  if (!asFile) return null;
  const name = fileName(rawName ?? '');
  if (!name) throw new ApiError(400, 'validation', 'Name the file: name=<file name>.', 'attachment_invalid');
  return name;
}

function checkUploadSize(bytes: Buffer, asFile: boolean, toChat: boolean): void {
  if (toChat && !bytes.length) throw new ApiError(400, 'validation', 'This file is empty.', 'file_empty');
  if (!asFile && bytes.length > PICTURE_BYTES) {
    throw new ApiError(413, 'validation', `A picture is at most ${PICTURE_BYTES / 1024 / 1024} MB. Put a bigger file on its task.`, 'attachment_invalid');
  }
}

/* What an upload is kept as: a picture as its own type, unless it goes on a task, where every file is bytes. */
function uploadType(asFile: boolean, hasTask: boolean, pic: string | null): string | null {
  if (!asFile) return pic;
  return !hasTask && pic ? pic : 'application/octet-stream';
}

function checkedUploadMeta(bytes: Buffer, asFile: boolean, toChat: boolean, hasTask: boolean, rawName: string | undefined) {
  const name = uploadName(asFile, rawName);
  checkUploadSize(bytes, asFile, toChat);
  const pic = pictureType(bytes);
  const type = uploadType(asFile, hasTask, pic);
  if (!type) throw new ApiError(400, 'validation', 'Send a PNG, JPEG or WebP picture, or name the task a file is for.', 'attachment_invalid');
  return { name, pic, type };
}

async function checkAttachmentSpace(ctx: Ctx, companyId: string, task: Task | null, toChat: boolean, size: number) {
  if (task) await checkRoom(ctx, companyId, task, size);
  else if (toChat) await checkPictureRoom(ctx, companyId, size);
}

export function attachmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* An agent's running turn sends a picture as raw bytes with its tool token, through hh-attach; or, naming a task it
     works on (?task=12&name=build.tar.gz) or the chat (?chat=1&name=contacts.xlsx), a file of any kind. */
  void app.register(async scope => {
    scope.addContentTypeParser(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'], { parseAs: 'buffer', bodyLimit: FILE_BYTES }, (_req, body, done) => done(null, body));
    scope.post('/api/attachments', { bodyLimit: FILE_BYTES }, async (req, reply) => {
      const job = await jobOf(ctx, req);
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { task: ref, chat, name: raw } = SendQuery.parse(req.query);
      const toChat = chat === '1' || chat === 'true';
      const task = ref === undefined ? null : await taskByRef(ctx, job.companyId, ref);
      if (ref !== undefined && (!task || !onTask(job, task))) throw new ApiError(404, 'not_found', `There is no task ${ref} you work on.`, 'task_unknown');
      const { name, pic, type } = checkedUploadMeta(bytes, ref !== undefined || toChat, toChat, ref !== undefined, raw);
      const [sent] = await db.select({ n: count() }).from(attachments).where(eq(attachments.jobId, job.id));
      if (Number(sent?.n ?? 0) >= PER_TURN) throw refuse(409, 'task_invalid', `One turn sends at most ${PER_TURN} pictures and files.`);
      await checkAttachmentSpace(ctx, job.companyId, task, toChat, bytes.length);
      const [row] = await db
        .insert(attachments)
        .values({ companyId: job.companyId, jobId: job.id, agentId: job.agentId, taskId: task?.id ?? null, name, mediaType: type, bytes, size: bytes.length })
        .returning({ id: attachments.id });
      if (toChat && name) {
        await appendEvent(ctx, {
          companyId: job.companyId,
          agentId: job.agentId,
          jobId: job.id,
          kind: 'text',
          data: { text: '', pictures: [{ id: row!.id, name, ...(pic ? {} : { file: true }) }] },
        });
      }
      reply.code(201);
      return name ? { id: row!.id, name } : { id: row!.id };
    });
  });

  /* Any agent of the company downloads an ordinary task file; automatic log files require access to their task, by its name or id, with its tool token, through hh-fetch. A name
     put on twice gives the newest. "message" in place of the task gets a picture that came with a message to this agent. */
  app.get('/api/attachments/file', async (req, reply) => {
    const job = await jobOf(ctx, req);
    const { task: ref, file } = FetchQuery.parse(req.query);
    if (ref.startsWith('operator-case:')) return sendCasePicture(reply, await agentCasePicture(db, job, ref, file));
    if (ref === MESSAGE_FILES) {
      const picture = await messagePicture(db, job, file);
      if (!picture) throw new ApiError(404, 'not_found', `You have no picture or file ${file}. One goes only to the agent it was sent to.`, 'attachment_unknown');
      return sendFile(db, reply, picture);
    }
    const task = await taskByRef(ctx, job.companyId, ref);
    const byId = z.uuid().safeParse(file).success;
    const [found] = task
      ? await db
          .select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, length: sql<number>`octet_length(${attachments.bytes})`.mapWith(Number) })
          .from(attachments)
          .where(and(eq(attachments.taskId, task.id), isNull(attachments.operatorCaseId), byId ? or(eq(attachments.id, file), eq(attachments.name, file)) : eq(attachments.name, file)))
          .orderBy(desc(attachments.createdAt))
          .limit(1)
      : [];
    if (!found || !readsTaskFile(job, task, found)) throw new ApiError(404, 'not_found', `Task ${ref} has no file ${file}. Its card lists its files.`, 'attachment_unknown');
    return sendFile(db, reply, found);
  });

  /* People see a picture of a request they read with its work, or of an open one that is theirs to answer; one a person
     sends an agent, when they see that agent. A file that is no picture downloads under its name instead of showing. */
  app.get('/api/attachments/:id', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const file = await attachmentForPerson(db, me, id);
    if (file && !file.picture) return sendFile(db, reply, file, true);
    const [picture] = await db.select({ operatorCaseId: attachments.operatorCaseId }).from(attachments).where(and(eq(attachments.id, id), eq(attachments.companyId, me.companyId)));
    if (picture?.operatorCaseId) return sendCasePicture(reply, await personCasePicture(db, me, id));
    if (!file) throw new ApiError(404, 'not_found', 'There is no such picture.', 'attachment_unknown');
    if (!file.mediaType.startsWith('image/')) reply.header('content-disposition', `attachment; filename*=UTF-8''${headerName(file.name ?? 'file')}`);
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('cache-control', 'private, max-age=86400')
      .type(file.mediaType)
      .send(Readable.from(filePieces(db, file.id, file.length)));
  });
}
