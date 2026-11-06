import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { attachments, taskEvents, testParts, testRuns } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { endWaitForRun } from './external-wait.js';
import { endRunWaits } from './wait-state.js';
import { failAuthorCheck, loadTask, refuse, submit, type AuthorCheckOutcome, type Moved, type Task, type Tx } from './engine.js';
import { outcomeRun, pendingSubmission, type PendingSubmission } from './author-check-pending.js';
import { captureReview } from './review-context.js';
import { AuthorCheckInput, authorQuality, recordAuthorCheck, type AuthorCheckResult, type Quality } from './review-quality.js';

type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
type Event = { data: Record<string, unknown> };

export async function pendingAuthorCheckRun(tx: Tx, taskId: string, runId: string): Promise<boolean> {
  const events = await tx.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'updated'))).orderBy(desc(taskEvents.id));
  return events.some(event => pendingSubmission(event.data)?.runId === runId);
}

export async function endAuthorCheckWait(tx: Tx, run: Run, task: Task): Promise<void> {
  await endRunWaits(tx, { taskId: task.id, runId: run.id, outcome: run.status === 'stopped' ? 'cancelled' : 'resolved', proofRef: `run:${run.id}:${run.status}`, actor: { agentId: run.agentId } });
  await endWaitForRun(tx, task.id, run.agentId, { id: run.id, label: `Author check ${run.number}` });
}

export async function finishAuthorCheck(ctx: Ctx, runId: string): Promise<Moved> {
  const [run] = await ctx.db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) throw refuse(404, 'task_unknown', `There is no author-check run ${runId}.`);
  const task = await loadTask(ctx.db, run.taskId);
  const events = await taskLog(ctx, task.id);
  const pending = events.map(event => pendingSubmission(event.data)).find(value => value?.runId === run.id);
  if (!pending) throw refuse(409, 'task_invalid', `Run ${run.number} has no author-check submission.`);
  if (hasOutcome(events, run.id)) return existingOutcome(ctx, run, task);
  try {
    return await complete(ctx, run, task, pending, events);
  } catch (error) {
    return afterCompletionRace(ctx, error, run, task);
  }
}

async function existingOutcome(ctx: Ctx, run: Run, task: Task): Promise<Moved> {
  if (task.externalWait?.run === run.id) await ctx.db.transaction(async tx => endAuthorCheckWait(tx, run, task));
  return { task: await loadTask(ctx.db, task.id), wakes: [] };
}

async function afterCompletionRace(ctx: Ctx, error: unknown, run: Run, task: Task): Promise<Moved> {
  if (!(error instanceof ApiError)) throw error;
  const latest = await taskLog(ctx, task.id);
  if (!hasOutcome(latest, run.id)) throw error;
  return { task: await loadTask(ctx.db, task.id), wakes: [] };
}

async function complete(ctx: Ctx, run: Run, task: Task, pending: PendingSubmission, events: Event[]): Promise<Moved> {
  const parts = await ctx.db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(testParts.part);
  const files = await logFiles(ctx, run, task, parts);
  const printed = readAuthorCheck(run, parts, files);
  if (printed) await recordAuthorCheck(ctx.db, task.id, printed);
  const quality = printed ? await authorQuality(ctx.db, task.id, run.commitSha) : null;
  const outcome = failedOutcome(run, events, printed, quality);
  if (acceptedQuality(printed, run, quality)) {
    const review = await captureReview(ctx, task, { baseCommit: pending.baseCommit, authorCheckPlan: pending.authorCheckPlan });
    if (review?.commit === run.commitSha) {
      const accepted: AuthorCheckOutcome = { ...outcome, status: quality.status, reason: null };
      return submit(ctx, run.agentId, task.id, { summary: pending.summary, evidence: pending.evidence }, { review: { ...review, quality }, outcome: accepted });
    }
    outcome.reason = 'commit-changed';
  }
  const output = parts.map(part => part.tail).filter(Boolean).join('\n') || `Author check ${run.number} ended without a structured result.`;
  return failAuthorCheck(ctx, run.agentId, task.id, { outcome, text: `Author check ${run.number} failed on ${run.commitSha}.\n\n${output}` });
}

function acceptedQuality(printed: AuthorCheckResult | null, run: Run, quality: Quality | null): quality is Quality & { status: 'passed' | 'partial' } {
  return Boolean(printed && run.status === 'passed' && quality && ['passed', 'partial'].includes(quality.status));
}

function failedOutcome(run: Run, events: Event[], printed: AuthorCheckResult | null, quality: Quality | null): AuthorCheckOutcome {
  const failures = events.filter(event => outcomeRun(event.data)?.status === 'failed').length;
  return { version: 1, runId: run.id, attempt: failures + 1, status: 'failed', reason: printed ? quality?.status ?? 'record-unavailable' : 'output-unavailable' };
}

async function taskLog(ctx: Ctx, taskId: string): Promise<Event[]> {
  return ctx.db.select({ data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, taskId)).orderBy(desc(taskEvents.id));
}

function hasOutcome(events: Event[], runId: string): boolean {
  return events.some(event => outcomeRun(event.data)?.runId === runId);
}

async function logFiles(ctx: Ctx, run: Run, task: Task, parts: Part[]): Promise<(typeof attachments.$inferSelect)[]> {
  const names = parts.map(part => `tests-${run.number}-${part.part}.log`);
  if (!names.length) return [];
  return ctx.db.select().from(attachments).where(and(eq(attachments.taskId, task.id), inArray(attachments.name, names)));
}

function readAuthorCheck(run: Run, parts: Part[], files: (typeof attachments.$inferSelect)[]): AuthorCheckResult | null {
  const part = parts[0];
  if (!part) return null;
  const file = files.find(candidate => candidate.name === `tests-${run.number}-${part.part}.log`);
  const log = file ? Buffer.from(file.bytes).toString('utf8') : (part.tail ?? '');
  for (const line of log.split('\n').filter(line => line.startsWith('AUTHOR_CHECK ')).reverse()) {
    const parsed = parseAuthorCheckLine(line, run, part);
    if (parsed) return parsed;
  }
  return null;
}

function parseAuthorCheckLine(line: string, run: Run, part: Part): AuthorCheckResult | null {
  try {
    const value: unknown = JSON.parse(line.slice('AUTHOR_CHECK '.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const stages = Array.isArray(raw.stages) ? raw.stages.map(stage => withPartId(stage, part.id)) : raw.stages;
    return AuthorCheckInput.safeParse({ ...raw, runId: run.id, stages }).data ?? null;
  } catch {
    return null;
  }
}

function withPartId(stage: unknown, partId: string): unknown {
  return stage && typeof stage === 'object' && !Array.isArray(stage) ? { ...stage, partId } : stage;
}
