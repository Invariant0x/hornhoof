import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { taskEvents, testParts, testRuns } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { endWaitForRun } from './external-wait.js';
import { endRunWaits } from './wait-state.js';
import { failAuthorCheck, loadTask, refuse, submit, type AuthorCheckOutcome, type Moved, type Task, type Tx } from './engine.js';
import { outcomeRun, pendingSubmission, type PendingSubmission } from './author-check-pending.js';
import { captureReview } from './review-context.js';
import { AuthorCheckInput, authorQuality, recordAuthorCheck, type AuthorCheckResult } from './review-quality.js';

export async function pendingAuthorCheckRun(tx: Tx, taskId: string, runId: string): Promise<boolean> {
  const events = await tx.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'updated'))).orderBy(desc(taskEvents.id));
  return events.some(event => pendingSubmission(event.data)?.runId === runId);
}

export async function endAuthorCheckWait(tx: Tx, run: typeof testRuns.$inferSelect, task: Task): Promise<void> {
  await endRunWaits(tx, { taskId: task.id, runId: run.id, outcome: run.status === 'stopped' ? 'cancelled' : 'resolved', proofRef: `run:${run.id}:${run.status}`, actor: { agentId: run.agentId } });
  await endWaitForRun(tx, task.id, run.agentId, { id: run.id, label: `Author check ${run.number}` });
}

export async function finishAuthorCheck(ctx: Ctx, runId: string): Promise<Moved> {
  const [run] = await ctx.db.select().from(testRuns).where(eq(testRuns.id, runId));
  if (!run) throw refuse(404, 'task_unknown', `There is no author-check run ${runId}.`);
  const task = await loadTask(ctx.db, run.taskId);
  const events = await ctx.db.select({ data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(desc(taskEvents.id));
  const pending = events.map(event => pendingSubmission(event.data)).find(value => value?.runId === run.id);
  if (!pending) throw refuse(409, 'task_invalid', `Run ${run.number} has no author-check submission.`);
  if (events.some(event => outcomeRun(event.data)?.runId === run.id)) {
    if (task.externalWait?.run === run.id) await ctx.db.transaction(async tx => endAuthorCheckWait(tx, run, task));
    return { task: await loadTask(ctx.db, task.id), wakes: [] };
  }
  try {
    return await complete(ctx, run, task, pending, events);
  } catch (error) {
    if (error instanceof ApiError) {
      const current = await loadTask(ctx.db, task.id);
      const latest = await ctx.db.select({ data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(desc(taskEvents.id));
      if (latest.some(event => outcomeRun(event.data)?.runId === run.id)) return { task: current, wakes: [] };
    }
    throw error;
  }
}

async function complete(ctx: Ctx, run: typeof testRuns.$inferSelect, task: Task, pending: PendingSubmission, events: { data: Record<string, unknown> }[]): Promise<Moved> {
  const parts = await ctx.db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(testParts.part);
  const printed = readAuthorCheck(run.id, parts);
  if (printed) await recordAuthorCheck(ctx.db, task.id, printed);
  const quality = printed ? await authorQuality(ctx.db, task.id, run.commitSha) : null;
  const output = parts.map(part => part.tail).filter(Boolean).join('\n') || `Author check ${run.number} ended without a structured result.`;
  const failures = events.filter(event => outcomeRun(event.data)?.status === 'failed').length;
  const outcome: AuthorCheckOutcome = { version: 1, runId: run.id, attempt: failures + 1, status: 'failed', reason: printed ? quality?.status ?? 'record-unavailable' : 'output-unavailable' };
  if (printed && run.status === 'passed' && quality && (quality.status === 'passed' || quality.status === 'partial')) {
    const review = await captureReview(ctx, task, { baseCommit: pending.baseCommit, authorCheckPlan: pending.authorCheckPlan });
    if (review?.commit === run.commitSha) {
      const accepted: AuthorCheckOutcome = { ...outcome, status: quality.status, reason: null };
      return submit(ctx, run.agentId, task.id, { summary: pending.summary, evidence: pending.evidence }, { review: { ...review, quality }, outcome: accepted });
    }
    outcome.reason = 'commit-changed';
  }
  return failAuthorCheck(ctx, run.agentId, task.id, { outcome, text: `Author check ${run.number} failed on ${run.commitSha}.\n\n${output}` });
}

function readAuthorCheck(runId: string, parts: (typeof testParts.$inferSelect)[]): AuthorCheckResult | null {
  const part = parts[0];
  if (!part) return null;
  const lines = (part.tail ?? '').split('\n').filter(line => line.startsWith('AUTHOR_CHECK '));
  for (const line of lines.reverse()) {
    try {
      const value: unknown = JSON.parse(line.slice('AUTHOR_CHECK '.length));
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const raw = value as Record<string, unknown>;
      const stages = Array.isArray(raw.stages) ? raw.stages.map(stage => stage && typeof stage === 'object' && !Array.isArray(stage) ? { ...stage, partId: part.id } : stage) : raw.stages;
      const parsed = AuthorCheckInput.safeParse({ ...raw, runId, stages });
      if (parsed.success) return parsed.data;
    } catch { /* A malformed line is unavailable output, never a manufactured record. */ }
  }
  return null;
}
