import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents, testRuns } from '../../db/schema.js';
import type { RunJob } from '../tools/job.js';
import { startRun } from '../testruns/runs.js';
import { liveAgent, loadTask, move, refuse, submissionTask, submit, type Moved, type Task } from './engine.js';
import { assertAuthorCheckBinding, authorCheckBinding, pendingSubmission, type PendingSubmission } from './author-check-pending.js';
import { finishAuthorCheck } from './author-check-completion.js';
import { replayedSubmission, submissionOperation } from './echelons-operations.js';
import { captureReview, type Review, type ReviewSubmission } from './review-context.js';

export type AuthorCheckSubmission = { operationId?: string; summary: string; evidence: string; review?: z.infer<typeof ReviewSubmission> };

type SubmissionWithPlan = AuthorCheckSubmission & { review: z.infer<typeof ReviewSubmission> & { authorCheckPlan: string } };
type PinnedReview = Review & { commit: string; branch: string; source: NonNullable<Review['source']> };
type Run = typeof testRuns.$inferSelect;
const enabled = (ctx: Ctx, input: AuthorCheckSubmission): input is SubmissionWithPlan => Boolean(ctx.config.authorCheck && input.review?.authorCheckPlan);

export async function submitWithAuthorCheck(ctx: Ctx, job: RunJob, taskId: string, input: AuthorCheckSubmission): Promise<Moved> {
  if (!enabled(ctx, input)) return submit(ctx, job.agentId, taskId, input);
  const before = await loadTask(ctx.db, taskId);
  await liveAgent(ctx.db, before.companyId, job.agentId);
  const replay = await replayedSubmission(ctx.db, before, job.agentId, submissionOperation(input));
  if (replay) return replay;
  const task = await submissionTask(ctx, job.agentId, taskId);
  const pending = await samePending(ctx, task, input);
  if (pending) return { task: pending, wakes: [] };
  const binding = await authorCheckBinding(ctx.db, task, job.agentId);
  const review = await captureReview(ctx, { ...task, executorAgentId: job.agentId }, input.review);
  if (!validReview(review)) throw refuse(409, 'task_invalid', 'The author check needs an exact review commit and base comparison.');
  const run = await startAuthorRun(ctx, job, task, review, input.review.authorCheckPlan);
  const data: PendingSubmission = { version: 1, ...binding, operationId: input.operationId, runId: run.id, summary: input.summary, evidence: input.evidence, baseCommit: review.source.baseCommit, authorCheckPlan: input.review.authorCheckPlan, review };
  const row = await move(ctx, task, {
    status: 'working', silent: 0,
    externalWait: { reason: `Author check ${run.number} on ${review.commit}.`, since: new Date().toISOString(), until: new Date(Date.now() + run.timeoutMs).toISOString(), operation: randomUUID(), on: { kind: 'external', event: 'machine' }, run: run.id },
  }, { kind: 'updated', actor: { agentId: job.agentId }, text: `Author check ${run.number} runs on ${review.commit}.`, data: { authorCheckPending: data } }, tx => assertAuthorCheckBinding(tx, task, data, run));
  if (run.status !== 'running') return finishAuthorCheck(ctx, run.id);
  return { task: row, wakes: [] };
}

async function startAuthorRun(ctx: Ctx, job: RunJob, task: Task, review: PinnedReview, plan: string): Promise<Run> {
  const command = authorCommand(review.commit, review.source.baseCommit, plan);
  await startRun(ctx, job, { task: task.id, branch: review.branch ?? undefined, command, parts: 1, expectedCommit: review.commit, dedupe: true });
  return pinnedAuthorRun(ctx, task, job.agentId, review, command);
}

async function pinnedAuthorRun(ctx: Ctx, task: Task, agentId: string, review: PinnedReview, command: string): Promise<Run> {
  const [run] = await ctx.db.select().from(testRuns).where(and(eq(testRuns.taskId, task.id), eq(testRuns.companyId, task.companyId), eq(testRuns.agentId, agentId), eq(testRuns.branch, review.branch), eq(testRuns.command, command))).orderBy(desc(testRuns.number)).limit(1);
  if (!run || run.commitSha !== review.commit) throw refuse(409, 'task_changed', `#${task.number} moved while its author check was being pinned. Read the branch and submit again.`);
  return run;
}

function validReview(review: Review | null): review is PinnedReview {
  return Boolean(review?.commit && review.branch && review.source);
}

async function samePending(ctx: Ctx, task: Task, input: AuthorCheckSubmission): Promise<Task | null> {
  const runId = task.externalWait?.run;
  if (!runId || !input.review?.authorCheckPlan) return null;
  const events = await ctx.db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'updated'))).orderBy(desc(taskEvents.id));
  for (const event of events) {
    const pending = pendingSubmission(event.data);
    if (pending && matches(pending, input, runId)) {
      await assertAuthorCheckBinding(ctx.db, task, pending);
      return task;
    }
  }
  return null;
}

function matches(pending: PendingSubmission, input: AuthorCheckSubmission, runId: string): boolean {
  return pending.operationId === input.operationId && pending.runId === runId && pending.summary === input.summary && pending.evidence === input.evidence && pending.baseCommit === input.review!.baseCommit && pending.authorCheckPlan === input.review!.authorCheckPlan;
}

function authorCommand(commit: string, base: string, plan: string): string {
  const command = `npm run -s check:author -- --sha ${commit} --base ${base} --plan ${shellQuote(plan)}`;
  if (command.length > 4000) throw refuse(400, 'task_invalid', 'The author-check plan is too long for one remote run. Print a smaller plan with check:author.');
  return command;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
