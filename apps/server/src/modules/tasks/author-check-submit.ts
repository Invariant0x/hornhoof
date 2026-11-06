import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents, testRuns } from '../../db/schema.js';
import type { RunJob } from '../tools/job.js';
import { startRun } from '../testruns/runs.js';
import { loadTask, move, refuse, submissionTask, submit, type Moved, type Task } from './engine.js';
import { AuthorCheckPending, pendingSubmission, type PendingSubmission } from './author-check-pending.js';
import { finishAuthorCheck } from './author-check-completion.js';
import { captureReview, type ReviewSubmission } from './review-context.js';

export type AuthorCheckSubmission = { summary: string; evidence: string; review?: z.infer<typeof ReviewSubmission> };

export async function submitWithAuthorCheck(ctx: Ctx, job: RunJob, taskId: string, input: AuthorCheckSubmission): Promise<Moved> {
  if (!ctx.config.authorCheck || !input.review?.authorCheckPlan) return submit(ctx, job.agentId, taskId, input);
  const pending = await samePending(ctx, taskId, input);
  if (pending) return { task: pending, wakes: [] };
  const task = await submissionTask(ctx, job.agentId, taskId);
  if (task.merging) return submit(ctx, job.agentId, taskId, input);
  const review = await captureReview(ctx, task, input.review);
  if (!review?.commit || !review.source) throw refuse(409, 'task_invalid', 'The author check needs an exact review commit and base comparison.');
  const command = authorCommand(review.commit, review.source.baseCommit, input.review.authorCheckPlan);
  await startRun(ctx, job, { task: task.id, branch: review.branch ?? undefined, command, parts: 1, expectedCommit: review.commit, dedupe: true });
  const [run] = await ctx.db.select().from(testRuns).where(and(eq(testRuns.taskId, task.id), eq(testRuns.command, command))).orderBy(desc(testRuns.number)).limit(1);
  if (!run || run.commitSha !== review.commit) throw refuse(409, 'task_changed', `#${task.number} moved while its author check was being pinned. Read the branch and submit again.`);
  const until = new Date(Date.now() + run.timeoutMs).toISOString();
  const data: PendingSubmission = { version: 1, runId: run.id, summary: input.summary, evidence: input.evidence, baseCommit: review.source.baseCommit, authorCheckPlan: input.review.authorCheckPlan, review };
  const row = await move(ctx, task, {
    status: 'working', silent: 0,
    externalWait: { reason: `Author check ${run.number} on ${review.commit}.`, since: new Date().toISOString(), until, operation: randomUUID(), on: { kind: 'external', event: 'machine' }, run: run.id },
  }, { kind: 'updated', actor: { agentId: job.agentId }, text: `Author check ${run.number} runs on ${review.commit}.`, data: { authorCheckPending: data } });
  if (run.status !== 'running') return finishAuthorCheck(ctx, run.id);
  return { task: row, wakes: [] };
}

async function samePending(ctx: Ctx, taskId: string, input: AuthorCheckSubmission): Promise<Task | null> {
  const task = await loadTask(ctx.db, taskId);
  const runId = task.externalWait?.run;
  if (!runId || !input.review?.authorCheckPlan) return null;
  const events = await ctx.db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'updated'))).orderBy(desc(taskEvents.id));
  for (const event of events) {
    const pending = pendingSubmission(event.data);
    if (pending && pending.runId === runId && pending.summary === input.summary && pending.evidence === input.evidence && pending.baseCommit === input.review.baseCommit && pending.authorCheckPlan === input.review.authorCheckPlan) return task;
  }
  return null;
}

function authorCommand(commit: string, base: string, plan: string): string {
  const command = `npm run -s check:author -- --sha ${commit} --base ${base} --plan ${shellQuote(plan)}`;
  if (command.length > 4000) throw refuse(400, 'task_invalid', 'The author-check plan is too long for one remote run. Print a smaller plan with check:author.');
  return command;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export { AuthorCheckPending };
