import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { privateTurn } from '../tools/private-turns.js';
import { privateFilename, privateUpload } from '../tools/private-upload.js';
import { PRIVATE_TURN_LOST, type PrivateValues } from '@hornhoof/protocol';
import { canViewAgent, seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, attachments, departments, requests, tasks, turns, type RequestOption } from '../../db/schema.js';
import { countOnly, idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { appendEvent, sensitiveTurn } from '../events/store.js';
import { jobOf, type RunJob, type ToolJob } from '../tools/job.js';
import { agentCasePicture, personCasePicture, sendCasePicture } from '../program-operator/attachments.js';
import { mayOpenRequest } from './decisions.js';
import { refuse, type Task } from './engine.js';
import { seesTask } from './sight.js';
import { taskByRef } from './views.js';
import { attachmentJobOf, checkAttachmentTask } from './attachment-token.js';

/* A screenshot fits comfortably; a turn sends a few dozen at most. */
export const PICTURE_BYTES = 3 * 1024 * 1024;
const PER_TURN = 30;
/* A file on a task: a build, a log or a data set fits, and the database still carries it. A bigger one lives on the disk
   of the machine that took it, in the folder FILES_DIR names, under its id: its row keeps no bytes and its size, so it
   counts in the company's room, and it is in no copy of the database and no backup. It goes after 30 days, and is lost
   if that machine goes. */
export const FILE_BYTES = 50 * 1024 * 1024;
export const onDisk = sql<boolean>`(octet_length(${attachments.bytes}) = 0 and ${attachments.size} > 0)`;
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

/* An agent works on a task when it is a company employee (never a personal assistant) and runs the company, the task is
   its department's, or it holds, does, checks or made it. */
export const onTask = (job: RunJob, t: Task): boolean =>
  job.agentKind !== 'assistant' &&
  (job.agentKind === 'orchestrator' || (job.departmentId != null && t.departmentId === job.departmentId) || [t.assigneeAgentId, t.executorAgentId, t.createdByAgentId].includes(job.agentId));

/* The files on a task, the newest under each name, without their bytes. */
export async function filesOf(db: Db, taskId: string): Promise<{ id: string; name: string; size: number; agentId: string; personId: string | null; at: Date; big: boolean }[]> {
  const rows = await db
    .select({ id: attachments.id, name: attachments.name, size: attachments.size, agentId: attachments.agentId, personId: attachments.personId, at: attachments.createdAt, big: onDisk })
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

/* Removes the files on the tasks of turns closed 30 days or more before now, people's pictures sent as long ago or never
   sent, and big files as old, and says how many went. */
export async function dropOldFiles(ctx: Pick<Ctx, 'db' | 'config'>, now: Date): Promise<number> {
  const { db } = ctx;
  const cutoff = new Date(now.getTime() - KEEP_FILES_MS);
  const loose = await db
    .delete(attachments)
    .where(and(or(isNotNull(attachments.personId), and(isNull(attachments.requestId), isNotNull(attachments.name))), isNull(attachments.taskId), lt(attachments.createdAt, cutoff)))
    .returning({ id: attachments.id });
  const old = db
    .select(idOnly(tasks))
    .from(tasks)
    .innerJoin(turns, eq(turns.id, tasks.turnId))
    .where(and(eq(turns.status, 'closed'), lt(turns.closedAt, cutoff)));
  const ofTurns = await db.delete(attachments).where(inArray(attachments.taskId, old)).returning({ id: attachments.id });
  const big = await db.delete(attachments).where(and(onDisk, lt(attachments.createdAt, cutoff))).returning({ id: attachments.id });
  await dropOldDisk(ctx.config.filesDir, cutoff);
  return loose.length + ofTurns.length + big.length;
}

/* The big files on this machine's disk go when they are as old, also those whose row went before them. */
async function dropOldDisk(dir: string | undefined, cutoff: Date): Promise<void> {
  for (const name of dir ? await readdir(dir).catch(() => []) : []) {
    const path = join(dir!, name);
    if (((await stat(path).catch(() => null))?.mtime ?? cutoff) < cutoff) await rm(path, { force: true });
  }
}

/* A file as a request brings it: in memory up to FILE_BYTES, and a bigger one onto this machine's disk as it comes, never
   whole in memory. With no folder for files a bigger one is turned away. */
export type Taken = { bytes: Buffer; size: number; disk?: string };
type UploadRoom = { bytes: number; full: () => ApiError };
const smallerRoom = (a: UploadRoom, b: UploadRoom): UploadRoom => a.bytes <= b.bytes ? a : b;
const fileRoom: UploadRoom = { bytes: FILE_BYTES, full: () => new ApiError(413, 'validation', `A file is at most ${FILE_BYTES / 1024 / 1024} MB here.`, 'file_too_big') };
const pictureRoom: UploadRoom = { bytes: PICTURE_BYTES, full: () => new ApiError(413, 'validation', `A picture is at most ${PICTURE_BYTES / 1024 / 1024} MB. Put a bigger file on its task.`, 'attachment_invalid') };

function checkUploadRoom(room: UploadRoom, size: number): void {
  if (size > room.bytes) throw room.full();
}

/* The crossing chunk is inspected, never retained or written; closing the iterator leaves the tail unread. */
async function* boundedUpload(body: unknown, room: UploadRoom): AsyncGenerator<Buffer> {
  let size = 0;
  for await (const chunk of body instanceof Readable ? (body as AsyncIterable<Buffer>) : []) {
    size += chunk.length;
    checkUploadRoom(room, size);
    yield chunk;
  }
}
export async function received(dir: string | undefined, body: unknown, room: UploadRoom, values?: PrivateValues): Promise<Taken> {
  const chunks: Buffer[] = [];
  const limit = dir ? room : smallerRoom(room, fileRoom);
  let size = 0;
  let disk: { id: string; file: FileHandle } | undefined;
  /* Bound the raw input before the secret scanner retains a possible prefix or reads ahead. */
  const input = Readable.from(boundedUpload(body, limit), { highWaterMark: 0 });
  const safe = privateUpload(input, values) as AsyncIterable<Buffer>;
  try {
    for await (const chunk of safe) {
      size += chunk.length;
      if (!disk && size > FILE_BYTES) {
        await mkdir(dir!, { recursive: true });
        const id = randomUUID();
        disk = { id, file: await open(join(dir!, id), 'wx', 0o600) };
        await disk.file.writeFile(Buffer.concat(chunks));
        chunks.length = 0;
      }
      if (disk) await disk.file.writeFile(chunk);
      else chunks.push(chunk);
    }
    return disk ? { bytes: Buffer.alloc(0), size, disk: disk.id } : { bytes: Buffer.concat(chunks), size };
  } catch (err) {
    if (disk) await rm(join(dir!, disk.id), { force: true });
    throw err;
  } finally {
    await disk?.file.close();
  }
}

/* Keeps the row of a file taken, and takes a big one off the disk again when that fails. */
export async function keepTaken<T>(dir: string | undefined, taken: Taken, keep: () => Promise<T>): Promise<T> {
  try {
    return await keep();
  } catch (err) {
    if (taken.disk) await rm(join(dir!, taken.disk), { force: true });
    throw err;
  }
}

/* A file's bytes as they go out: from the database a piece at a time, or a big one from this machine's disk. */
export async function fileStream(ctx: Pick<Ctx, 'db' | 'config'>, id: string, length: number): Promise<Readable> {
  const [row] = await ctx.db.select({ onDisk }).from(attachments).where(eq(attachments.id, id));
  if (!row?.onDisk) return Readable.from(filePieces(ctx.db, id, length));
  const file = ctx.config.filesDir ? await open(join(ctx.config.filesDir, id)).catch(() => null) : null;
  if (!file) throw new ApiError(410, 'gone', 'A big file lives only on the machine that took it, and Hornhoof cannot reach it there now.', 'file_lost');
  return file.createReadStream();
}

/* What counts towards what the company keeps: files on tasks, chat files and people's pictures. */
const kept = (companyId: string) => and(eq(attachments.companyId, companyId), or(isNotNull(attachments.taskId), isNotNull(attachments.personId), isNotNull(attachments.name)));

const companyFull = (inCompany: number, limit: number) =>
  new ApiError(413, 'validation', `The company's task files take ${sizeText(inCompany)} of the ${sizeText(limit)} Hornhoof keeps for them. The files of a turn go 30 days after it closes. ${ELSEWHERE}`, 'attachment_invalid');

const companyRoom = (used: number, limit: number): UploadRoom => ({ bytes: limit - used, full: () => companyFull(used, limit) });

/* Refuses a person's picture of this size when the company has no room left for it, and returns the room left. */
export async function checkPictureRoom(ctx: Pick<Ctx, 'db' | 'config'>, companyId: string, size: number): Promise<UploadRoom> {
  const [used] = await ctx.db.select({ company: sql<string>`coalesce(sum(${attachments.size}), 0)` }).from(attachments).where(kept(companyId));
  const inCompany = Number(used!.company);
  const room = companyRoom(inCompany, ctx.config.taskFilesBytes);
  checkUploadRoom(room, size);
  return room;
}

/* Refuses a new file of this size on the task when the task or the company has no room left for it. */
export async function checkRoom(ctx: { db: Pick<Ctx['db'], 'select'>; config: Pick<Ctx['config'], 'taskFilesBytes'> }, companyId: string, task: Pick<Task, 'id' | 'number'>, size: number): Promise<UploadRoom> {
  const [used] = await ctx.db
    .select({
      task: sql<string>`coalesce(sum(${attachments.size}) filter (where ${attachments.taskId} = ${task.id}), 0)`,
      company: sql<string>`coalesce(sum(${attachments.size}), 0)`,
    })
    .from(attachments)
    .where(kept(companyId));
  const [onTask, inCompany] = [Number(used?.task ?? 0), Number(used?.company ?? 0)];
  const taskRoom: UploadRoom = { bytes: TASK_FILES_BYTES - onTask, full: () => new ApiError(413, 'validation', `Task ${task.number} holds ${sizeText(onTask)} of files, and one task holds at most ${sizeText(TASK_FILES_BYTES)}. ${ELSEWHERE}`, 'attachment_invalid') };
  const room = companyRoom(inCompany, ctx.config.taskFilesBytes);
  checkUploadRoom(taskRoom, size);
  checkUploadRoom(room, size);
  return smallerRoom(taskRoom, room);
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
async function* filePieces(db: Db, id: string, length: number) {
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
export async function sendFile(ctx: Pick<Ctx, 'db' | 'config'>, reply: FastifyReply, found: { id: string; name: string | null; length: number; mediaType?: string }, forPerson = false) {
  const [ordinary] = await ctx.db.select(idOnly(attachments)).from(attachments).where(and(eq(attachments.id, found.id), isNull(attachments.operatorCaseId)));
  if (!ordinary) throw new ApiError(404, 'not_found', 'There is no such file.', 'attachment_unknown');
  const bytes = await fileStream(ctx, found.id, found.length);
  if (savedByPerson(found, forPerson)) reply.header('content-disposition', `attachment; filename*=UTF-8''${headerName(found.name ?? 'file')}`);
  return reply
    .header('x-content-type-options', 'nosniff')
    .header('x-file-name', encodeURIComponent(found.name ?? ''))
    .header('content-security-policy', "default-src 'none'")
    .header('content-length', String(found.length))
    .type(sentType(found, forPerson))
    .send(bytes);
}

const IdParams = z.object({ id: z.uuid() });
const SendQuery = z.object({ task: z.string().optional(), chat: z.enum(['1', 'true']).optional(), name: z.string().optional() });
const FetchQuery = z.object({ task: z.string().min(1), file: z.string().min(1) });
/* What hh-fetch names instead of a task for a picture that came with a message. */
const MESSAGE_FILES = 'message';

/* A picture sent to this agent, or an employee's own chat file. Two clipboard pictures have one name, so the download
   name starts with its id. */
async function messagePicture(db: Db, job: ToolJob, id: string) {
  if (!z.uuid().safeParse(id).success) return undefined;
  const ownChat = job.agentKind === 'assistant' ? undefined : and(isNotNull(attachments.name), isNull(attachments.requestId));
  const [found] = await db
    .select({ id: attachments.id, name: attachments.name, length: attachments.size })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, job.companyId), eq(attachments.agentId, job.agentId), or(isNotNull(attachments.personId), ownChat), isNull(attachments.taskId), isNull(attachments.operatorCaseId)));
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
): Promise<{ id: string; name: string; mediaType: string; bytes: Buffer; big: boolean } | null> {
  if (person.status !== 'active') return null;
  let allowed: { id: string; name: string | null; mediaType: string } | null = null;
  try {
    allowed = await personFile(db, person, id);
  } catch {
    return null;
  }
  if (!allowed) return null;
  const [row] = await db
    .select({ bytes: attachments.bytes, big: onDisk })
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.companyId, person.companyId), isNull(attachments.operatorCaseId)));
  if (!row) return null;
  return {
    id,
    name: allowed.name ?? 'file',
    mediaType: personDownloadType(allowed),
    bytes: Buffer.from(row.bytes),
    big: row.big,
  };
}

/* Reads a delivery's bytes only when both its sending agent and its recipient may read the file. */
export async function attachmentBytesForDelivery(ctx: Pick<Ctx, 'db'>, job: ToolJob, person: Person, id: string) {
  if (!(await agentCanReadAttachment(ctx, job, id))) return null;
  return attachmentBytesForPerson(ctx.db, person, id);
}

const PICTURE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const defaultPictureName = (id: string, mediaType: string): string => `${id}${PICTURE_EXT[mediaType] ?? ''}`;

/* Working employees of the company read files of any company task, never personal assistant work. */
async function companyTaskForAgent(ctx: Pick<Ctx, 'db'>, job: ToolJob, ref: string): Promise<Task | null> {
  if (job.agentKind === 'assistant') return null;
  const task = await taskByRef(ctx, job.companyId, ref);
  if (!task) return null;
  const ids = [task.assigneeAgentId, task.executorAgentId, task.createdByAgentId].filter((id): id is string => Boolean(id));
  const [personal] = ids.length ? await ctx.db.select(idOnly(agents)).from(agents).where(and(inArray(agents.id, ids), eq(agents.kind, 'assistant'))).limit(1) : [];
  return personal ? null : task;
}

function taskAttachmentMatch(db: Db, companyId: string, taskId: string, file: string) {
  if (!z.uuid().safeParse(file).success) return and(eq(attachments.taskId, taskId), eq(attachments.name, file));
  const onTaskRow = and(eq(attachments.taskId, taskId), or(eq(attachments.id, file), eq(attachments.name, file)));
  const taskRequests = db.select(idOnly(requests)).from(requests).where(and(eq(requests.companyId, companyId), eq(requests.taskId, taskId)));
  const onRequest = and(eq(attachments.id, file), isNull(attachments.taskId), isNull(attachments.personId), inArray(attachments.requestId, taskRequests));
  return or(onTaskRow, onRequest);
}

async function taskAttachmentForAgent(db: Db, companyId: string, taskId: string, file: string) {
  const [found] = await db
    .select({ id: attachments.id, name: attachments.name, mediaType: attachments.mediaType, length: attachments.size })
    .from(attachments)
    .innerJoin(agents, and(eq(agents.id, attachments.agentId), eq(agents.companyId, companyId), ne(agents.kind, 'assistant')))
    .where(and(eq(attachments.companyId, companyId), isNull(attachments.operatorCaseId), taskAttachmentMatch(db, companyId, taskId, file)))
    .orderBy(desc(attachments.createdAt))
    .limit(1);
  return found && { ...found, name: found.name ?? defaultPictureName(found.id, found.mediaType) };
}

/* The same task and message checks as hh-fetch, by id, before another tool shares a file or gives out its link. */
async function agentCanReadAttachment(ctx: Pick<Ctx, 'db'>, job: ToolJob, id: string): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  if (await messagePicture(ctx.db, job, id)) return true;
  const [file] = await ctx.db
    .select({ taskId: attachments.taskId, requestTaskId: requests.taskId })
    .from(attachments)
    .leftJoin(requests, eq(requests.id, attachments.requestId))
    .where(and(eq(attachments.id, id), eq(attachments.companyId, job.companyId), isNull(attachments.operatorCaseId)));
  const taskId = file?.taskId ?? file?.requestTaskId;
  if (!taskId) return false;
  const task = await companyTaskForAgent(ctx, job, taskId);
  /* By id alone: a file of the task named like this id is another file, and never vouches for this one. */
  return Boolean(task) && (await taskAttachmentForAgent(ctx.db, job.companyId, task!.id, id))?.id === id;
}

/* A file's name, which a file for a task or the chat needs; a picture for a request goes without one. */
function uploadName(asFile: boolean, rawName: string | undefined): string | null {
  if (!asFile) return null;
  const name = fileName(rawName ?? '');
  if (!name) throw new ApiError(400, 'validation', 'Name the file: name=<file name>.', 'attachment_invalid');
  return name;
}

function checkUploadSize(size: number, asFile: boolean): void {
  if (!size) throw new ApiError(400, 'validation', 'This file is empty.', 'file_empty');
  if (!asFile && size > PICTURE_BYTES) {
    throw pictureRoom.full();
  }
}

/* What an upload is kept as: a picture as its own type, unless it goes on a task, where every file is bytes. */
function uploadType(asFile: boolean, hasTask: boolean, pic: string | null): string | null {
  if (!asFile) return pic;
  return !hasTask && pic ? pic : 'application/octet-stream';
}

function checkedUploadMeta(taken: Taken, asFile: boolean, hasTask: boolean, rawName: string | undefined) {
  const name = uploadName(asFile, rawName);
  checkUploadSize(taken.size, asFile);
  const pic = pictureType(taken.bytes);
  const type = uploadType(asFile, hasTask, pic);
  if (!type) throw new ApiError(400, 'validation', 'Send a PNG, JPEG or WebP picture, or name the task a file is for.', 'attachment_invalid');
  return { name, pic, type };
}

async function checkAttachmentSpace(ctx: Ctx, companyId: string, task: Task | null, toChat: boolean, size: number) {
  if (task) return checkRoom(ctx, companyId, task, size);
  if (toChat) return checkPictureRoom(ctx, companyId, size);
  return pictureRoom;
}

export function attachmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  /* An agent's running turn sends a picture as raw bytes with its tool token, through hh-attach; or, naming a task it
     works on (?task=12&name=build.tar.gz) or the chat (?chat=1&name=contacts.xlsx), a file of any kind and size. Its bytes
     are read as they come, once the turn and the room for them are checked. */
  void app.register(async scope => {
    scope.addContentTypeParser(['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp'], (_req, body, done) => done(null, body));
    scope.post('/api/attachments', async (req, reply) => {
      const job = await attachmentJobOf(ctx, req);
      const values = await uploadValues(db, job.id);
      const { task: ref, chat, name: raw } = SendQuery.parse(req.query);
      const toChat = chat === '1' || chat === 'true';
      const task = ref === undefined ? null : await taskByRef(ctx, job.companyId, ref);
      checkAttachmentTask(job, task, toChat);
      if (ref !== undefined && (!task || !onTask(job, task))) throw new ApiError(404, 'not_found', `There is no task ${ref} you work on.`, 'task_unknown');

      const [sent] = await db.select(countOnly()).from(attachments).where(eq(attachments.jobId, job.id));
      if (Number(sent?.n ?? 0) >= PER_TURN) throw refuse(409, 'task_invalid', `One turn sends at most ${PER_TURN} pictures and files.`);
      const room = await checkAttachmentSpace(ctx, job.companyId, task, toChat, Number(req.headers['content-length'] ?? 0) || 0);
      const taken = await received(ctx.config.filesDir, req.body, room, values);
      const row = await keepTaken(ctx.config.filesDir, taken, async () => {
        const { name, pic, type } = checkedUploadMeta(taken, ref !== undefined || toChat, ref !== undefined, privateFilename(values, raw));
        await checkAttachmentSpace(ctx, job.companyId, task, toChat, taken.size);
        const [kept] = await db
          .insert(attachments)
          .values({ ...(taken.disk ? { id: taken.disk } : {}), companyId: job.companyId, jobId: job.id, agentId: job.agentId, taskId: task?.id ?? null, name, mediaType: type, bytes: taken.bytes, size: taken.size })
          .returning({ id: attachments.id });
        return { id: kept!.id, name, pic };
      });
      if (toChat && row.name) {
        await appendEvent(ctx, {
          companyId: job.companyId,
          agentId: job.agentId,
          jobId: job.id,
          kind: 'text',
          data: { text: '', pictures: [{ id: row.id, name: row.name, ...(row.pic ? {} : { file: true }), ...(taken.disk ? { big: true } : {}) }] },
        });
      }
      reply.code(201);
      return row.name ? { id: row.id, name: row.name } : { id: row.id };
    });
  });

  /* Any working employee of the company downloads files and request pictures of a company task by name or id, with its tool
     token, through hh-fetch. A name put on twice gives the newest. "message" in place of the task gets a picture that came
     with a message to this agent. */
  app.get('/api/attachments/file', async (req, reply) => {
    const job = await jobOf(ctx, req);
    const { task: ref, file } = FetchQuery.parse(req.query);
    if (ref.startsWith('operator-case:')) return sendCasePicture(reply, await agentCasePicture(db, job, ref, file));
    if (ref === MESSAGE_FILES) {
      const picture = await messagePicture(db, job, file);
      if (!picture) throw new ApiError(404, 'not_found', `You have no picture or file ${file}. One goes only to the agent it was sent to.`, 'attachment_unknown');
      return sendFile(ctx, reply, picture);
    }
    const task = await companyTaskForAgent(ctx, job, ref);
    const found = task ? await taskAttachmentForAgent(db, job.companyId, task.id, file) : undefined;
    if (!found) throw new ApiError(404, 'not_found', `Task ${ref} has no file ${file}. Its card lists its files.`, 'attachment_unknown');
    return sendFile(ctx, reply, found);
  });

  /* People see a picture of a request they read with its work, or of an open one that is theirs to answer; one a person
     sends an agent, when they see that agent. A file that is no picture downloads under its name instead of showing. */
  app.get('/api/attachments/:id', async (req, reply) => {
    const me = await requirePerson(req, db);
    const { id } = IdParams.parse(req.params);
    const file = await attachmentForPerson(db, me, id);
    if (file && !file.picture) return sendFile(ctx, reply, file, true);
    const [picture] = await db.select(only(attachments, 'operatorCaseId')).from(attachments).where(and(eq(attachments.id, id), eq(attachments.companyId, me.companyId)));
    if (picture?.operatorCaseId) return sendCasePicture(reply, await personCasePicture(db, me, id));
    if (!file) throw new ApiError(404, 'not_found', 'There is no such picture.', 'attachment_unknown');
    if (!file.mediaType.startsWith('image/')) reply.header('content-disposition', `attachment; filename*=UTF-8''${headerName(file.name ?? 'file')}`);
    return reply
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('cache-control', 'private, max-age=86400')
      .type(file.mediaType)
      .send(await fileStream(ctx, file.id, file.length));
  });
}

async function uploadValues(db: Db, jobId: string) {
  const values = privateTurn(db, jobId)?.values;
  if (!values && await sensitiveTurn(db, jobId, true)) throw new ApiError(409, 'conflict', PRIVATE_TURN_LOST, 'attachment_invalid');
  return values;
}
