import { and, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { attachments } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { type RunJob } from '../tools/job.js';
import { type Task } from './state.js';
/* A screenshot fits comfortably; a turn sends a few dozen at most. */
export const PICTURE_BYTES = 3 * 1024 * 1024;
/* A file on a task: a build, a log or a data set fits, and the database still carries it. A bigger one lives on the disk
   of the machine that took it, in the folder FILES_DIR names, under its id: its row keeps no bytes and its size, so it
   counts in the company's room, and it is in no copy of the database and no backup. It goes after 30 days, and is lost
   if that machine goes. */
export const FILE_BYTES = 50 * 1024 * 1024;
/* Every copy of the database carries the files, so one task holds this much and the company what its setting says. */
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
