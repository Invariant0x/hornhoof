import { cleanDiagnostic } from '@hornhoof/protocol/redaction';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { jobs } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError, type ErrorReason } from '../../errors.js';
import { appendEvent } from '../events/store.js';

/* The error of a turn Hornhoof failed because the message it carried could not go out or wait its line. */
export const NOT_DELIVERED = 'message_not_delivered';

/* An employee's message that neither went into a turn nor waits in its recipient's line: why, as a code a failure collector
   groups by, to whom, and the task the sender named. */
export type Undelivered = { reason: string; recipient: string; task: number | string | null };

/* What Hornhoof keeps of it with the sender's turn, as the result of the call that sent it. */
export const UndeliveredRecord = z.object({
  summary: z.string(),
  undelivered: z.object({ reason: z.string(), recipient: z.string(), task: z.union([z.number(), z.string()]).nullable() }),
});

/* The task a sender named: its number, else the reference as given, with no credential and no private path in it. */
export function taskNamed(ref: number | string | null | undefined): number | string | null {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === 'number') return ref;
  const given = ref.trim();
  return /^#?\d+$/.test(given) ? Number(given.replace('#', '')) : cleanDiagnostic(given);
}

/* What the sender and a failure collector read of such a message, cleaned as a whole. */
export function undeliveredLine(u: Undelivered): string {
  const task = u.task === null ? 'none' : typeof u.task === 'number' ? `#${u.task}` : u.task;
  return cleanDiagnostic(`Not delivered: reason ${u.reason}, recipient ${u.recipient}, task ${task}.`);
}

/* The refusal of a message whose turn could not go out, or not wait its line; the screens know it by agent_not_ready. */
export const messageNotDelivered = (reason: string): ApiError =>
  new ApiError(409, 'conflict', 'The message did not reach the employee. Check its window and try again.', 'agent_not_ready', { undelivered: reason });

async function runningTurn(ctx: Pick<Ctx, 'db'>, agentId: string): Promise<string | null> {
  const [turn] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'))).limit(1);
  return turn?.id ?? null;
}

type Sender = { companyId: string; agentId: string; jobId?: string };

/* Keeps a message that did not go out with the turn of the employee that sent it, where failures reads it, and gives its line. */
export async function keepUndelivered(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, sender: Sender, u: Undelivered): Promise<string> {
  const undelivered = { reason: cleanDiagnostic(u.reason), recipient: cleanDiagnostic(u.recipient), task: taskNamed(u.task) };
  const summary = undeliveredLine(undelivered);
  const jobId = sender.jobId ?? (await runningTurn(ctx, sender.agentId));
  await appendEvent(ctx, { companyId: sender.companyId, agentId: sender.agentId, jobId, kind: 'tool_result', data: { ok: false, summary, undelivered } });
  return summary;
}

/* The refusals that say why a message did not go: its recipient could not take it, or its task could not carry it. */
const REFUSALS: ReadonlySet<ErrorReason> = new Set(['agent_not_ready', 'task_unknown', 'task_invalid', 'task_not_yours', 'task_paused']);

/* An employee's message that was refused, kept where failures reads it: its sender hears the refusal with the code, the
   recipient and the task added, all of it cleaned. Any other error goes on as it came. */
export async function refusedMessage(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, sender: Sender, to: { recipient: string; task?: number | string }, error: unknown): Promise<unknown> {
  if (!(error instanceof ApiError) || !error.reason || !REFUSALS.has(error.reason)) return error;
  const reason = typeof error.details?.undelivered === 'string' ? error.details.undelivered : error.reason;
  const line = await keepUndelivered(ctx, sender, { reason, recipient: to.recipient, task: to.task ?? null });
  return new ApiError(error.status, error.code, cleanDiagnostic(`${error.message}\n${line}`), error.reason, { ...error.details, undelivered: reason });
}
