import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { type RunJob } from '../tools/job.js';
import { type Task } from './state.js';

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
/* A screenshot fits comfortably; a turn sends a few dozen at most. */
export const PICTURE_BYTES = 3 * 1024 * 1024;
/* A file that comes whole in one request, as a run's file or a long text does, is at most this; one on a task comes as a
   stream and may be bigger. Telegram passes no bigger file on either, so one goes there as a link. */
export const FILE_BYTES = 50 * 1024 * 1024;
/* Every machine that holds the company's files keeps each of them, so one task holds this much and the company what its
   setting says. */
export const TASK_FILES_BYTES = 500 * 1024 * 1024;

export const GB = 1024 * 1024 * 1024;
export const sizeText = (bytes: number) => (bytes >= GB ? `${Number((bytes / GB).toFixed(1))} GB` : `${Math.ceil(bytes / 1024 / 1024)} MB`);
export const ELSEWHERE = 'Put a smaller file, or keep a big one outside Hornhoof and write where it is.';

/* An agent works on a task when it is a company employee (never a personal assistant) and runs the company, the task is
   its department's, or it holds, does, checks or made it. */
export const onTask = (job: RunJob, t: Task): boolean =>
  job.agentKind !== 'assistant' &&
  (job.agentKind === 'orchestrator' || (job.departmentId != null && t.departmentId === job.departmentId) || [t.assigneeAgentId, t.executorAgentId, t.createdByAgentId].includes(job.agentId));
export type UploadRoom = { bytes: number; full: () => ApiError };
export const smallerRoom = (a: UploadRoom, b: UploadRoom): UploadRoom => a.bytes <= b.bytes ? a : b;

export function checkUploadRoom(room: UploadRoom, size: number): void {
  if (size > room.bytes) throw room.full();
}

/* What counts towards what the company keeps: files on tasks, chat files and people's pictures. */
export const kept = (companyId: string) => and(eq(attachments.companyId, companyId), or(isNotNull(attachments.taskId), isNotNull(attachments.personId), isNotNull(attachments.name)));

export const companyFull = (inCompany: number, limit: number) =>
  new ApiError(413, 'validation', `The company's task files take ${sizeText(inCompany)} of the ${sizeText(limit)} Hornhoof keeps for them. The files of a turn go 30 days after it closes. ${ELSEWHERE}`, 'attachment_invalid');

export const companyRoom = (used: number, limit: number): UploadRoom => ({ bytes: limit - used, full: () => companyFull(used, limit) });

/* What the company keeps: each kept row by its own size, however many rows name the same content. A room counted by
   content would grow by less when the same bytes come again, and so tell whoever sends a file whether one of those very
   bytes is kept somewhere in the company, as its hash, which nobody but the file's readers sees, would. */
const companyUse = (companyId: string) => sql<string>`(SELECT coalesce(sum(a.size), 0) FROM attachments a
  WHERE a.company_id = ${companyId} AND (a.task_id IS NOT NULL OR a.person_id IS NOT NULL OR a.name IS NOT NULL))`;

/* What the company keeps at most: TASK_FILES_MB, 2 GB unless set. */
const companyLimit = (ctx: { config: Pick<Ctx['config'], 'taskFilesBytes'> }): number => ctx.config.taskFilesBytes;

/* Refuses a person's picture of this size when the company has no room left for it, and returns the room left. */
export async function checkPictureRoom(ctx: Pick<Ctx, 'db' | 'config'>, companyId: string, size: number): Promise<UploadRoom> {
  /* One row however many files the company keeps, none among them. */
  const [used] = rowsOf<{ company: string }>(await ctx.db.execute(sql`SELECT ${companyUse(companyId)} AS company`));
  const inCompany = Number(used?.company ?? 0);
  const room = companyRoom(inCompany, companyLimit(ctx));
  checkUploadRoom(room, size);
  return room;
}

/* Refuses a new file of this size on the task when the task or the company has no room left for it. */
export async function checkRoom(ctx: { db: Pick<Ctx['db'], 'select' | 'execute'>; config: Ctx['config'] }, companyId: string, task: Pick<Task, 'id' | 'number'>, size: number): Promise<UploadRoom> {
  const [used] = await ctx.db
    .select({
      task: sql<string>`coalesce(sum(${attachments.size}) filter (where ${attachments.taskId} = ${task.id}), 0)`,
      company: companyUse(companyId),
    })
    .from(attachments)
    .where(kept(companyId));
  const [onTask, inCompany] = [Number(used?.task ?? 0), Number(used?.company ?? 0)];
  const taskRoom: UploadRoom = { bytes: TASK_FILES_BYTES - onTask, full: () => new ApiError(413, 'validation', `Task ${task.number} holds ${sizeText(onTask)} of files, and one task holds at most ${sizeText(TASK_FILES_BYTES)}. ${ELSEWHERE}`, 'attachment_invalid') };
  const room = companyRoom(inCompany, companyLimit(ctx));
  checkUploadRoom(taskRoom, size);
  checkUploadRoom(room, size);
  return smallerRoom(taskRoom, room);
}
