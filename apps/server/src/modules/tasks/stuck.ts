import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, requestInternal, requests, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { CLOSED, move, refuse, taskSpot, type Actor, type Answer, type Request, type Task, type Wake } from './engine.js';
import { stuckRecipient } from './stuck-route.js';
import { routeOf } from './echelons-store.js';
import { endRequest } from './wait-producers.js';

type ToolJob = { id: string; companyId: string; agentId: string };
type Found = { request: Request; task: Task; asker: typeof agents.$inferSelect };

async function load(ctx: Ctx, requestId: string): Promise<Found | undefined> {
  const [found] = await ctx.db
    .select({ request: requests, task: tasks, asker: agents })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .innerJoin(agents, eq(agents.id, requests.agentId))
    .where(eq(requests.id, requestId))
    .limit(1);
  return found;
}

function requireRequestRecipient(job: ToolJob, found: Found): void {
  if (found.request.status !== 'open') throw refuse(409, 'request_closed', 'This request is answered already.');
  if (found.request.companyId !== job.companyId || found.request.triageAgentId !== job.agentId) throw refuse(403, 'decision_not_allowed', 'This stuck request belongs to another agent.');
}

async function requireResolverJob(ctx: Ctx, job: ToolJob): Promise<void> {
  const [running] = await ctx.db
    .select(idOnly(jobs))
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(and(eq(jobs.id, job.id), eq(jobs.companyId, job.companyId), eq(jobs.agentId, job.agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), inArray(agents.kind, ['head', 'orchestrator'])))
    .limit(1);
  if (!running) throw refuse(403, 'decision_context_missing', 'The current head or orchestrator answers an internal stuck request from its own running turn.');
}

async function answeringJob(ctx: Ctx, job: ToolJob, found: Found): Promise<void> {
  requireRequestRecipient(job, found);
  await requireResolverJob(ctx, job);
  const current = await stuckRecipient(ctx.db, found.asker, found.task);
  if (current?.id !== job.agentId) throw refuse(409, 'task_changed', 'The stuck request has another addressee now. Read it again.');
}

function instructionOf(a: Answer): string {
  const instruction = a.answer?.trim() || (a.retry ? 'Try again.' : '');
  if (!instruction || a.approve !== undefined || a.pick !== undefined) throw refuse(400, 'task_invalid', 'Write an answer or retry the stuck task.');
  return instruction;
}

async function continuation(ctx: Ctx, found: Found, instruction: string): Promise<{ set: Partial<Task>; wakes: Wake[] }> {
  const goesOn = found.task.assigneeAgentId;
  const wakes: Wake[] = CLOSED.includes(found.task.status) || !goesOn ? [] : [{ agentId: goesOn, taskId: found.task.id, why: 'answered', text: instruction }];
  const route = await routeOf(ctx.db, found.task);
  const checking = ['review', 'security', 'cleanup'].includes(route.state.stage ?? '');
  const set: Partial<Task> = { silent: 0, ...(found.task.status === 'waiting' ? { status: checking ? 'review' : 'working' } : {}) };
  return { set, wakes };
}

/* Internal only: the general human answer and its delegation guard stay unchanged. */
export async function resolveStuck(ctx: Ctx, job: ToolJob, requestId: string, a: Answer): Promise<{ request: Request; task: Task; wakes: Wake[] } | null> {
  const found = await load(ctx, requestId);
  if (!found || found.request.kind !== 'stuck' || found.request.audience !== 'internal') return null;
  await answeringJob(ctx, job, found);
  const instruction = instructionOf(a);
  const actor: Actor = { agentId: job.agentId };
  const { set, wakes } = await continuation(ctx, found, instruction);
  let resolved: Request | undefined;
  const row = await move(ctx, found.task, set, { kind: 'answered', actor, text: instruction, data: { requestId, kind: 'stuck', status: 'resolved_internal' } }, async tx => {
    [resolved] = await tx
      .update(requests)
      .set({ status: 'resolved_internal', answer: a.answer?.trim() || null })
      .where(and(eq(requests.id, requestId), eq(requests.status, 'open'), eq(requests.audience, 'internal'), eq(requests.triageAgentId, job.agentId)))
      .returning();
    if (!resolved) throw refuse(409, 'request_closed', 'This request is answered already.');
    await endRequest(tx, resolved, 'resolved_internal', actor);
    await tx.insert(requestInternal).values({ requestId, companyId: found.task.companyId, executorInstruction: instruction, resolvedByAgentId: job.agentId, resolvedByJobId: job.id, resolvedAt: new Date() })
      .onConflictDoUpdate({ target: requestInternal.requestId, set: { executorInstruction: instruction, resolvedByAgentId: job.agentId, resolvedByJobId: job.id, resolvedAt: new Date() } });
  }, wakes);
  ctx.bus.publish(found.task.companyId, { type: 'requests', spot: taskSpot(found.task) });
  return { request: resolved!, task: row, wakes };
}

export async function resolveStuckComment(ctx: Ctx, job: ToolJob, taskId: string, text: string): Promise<{ request: Request; task: Task; wakes: Wake[] } | null> {
  const [found] = await ctx.db.select(idOnly(requests)).from(requests)
    .where(and(eq(requests.taskId, taskId), eq(requests.kind, 'stuck'), eq(requests.audience, 'internal'), eq(requests.status, 'open'), eq(requests.triageAgentId, job.agentId)))
    .orderBy(desc(requests.createdAt)).limit(1);
  return found ? resolveStuck(ctx, job, found.id, { answer: text }) : null;
}
