import { and, count, desc, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentChanges, agents, jobs, requests, taskEvents, tasks } from '../../db/schema.js';
import { afterJob, cancelJob, insertTurn, liveSubscription, onAgent, orchestratorOf, pump } from '../conversation/queue.js';
import { appendEvent } from '../events/store.js';
import { CLOSED, GATE_ROUNDS, leaveWork, NOT_A_MOVE, published, rejoin, silentTurn, wentOn, type Actor, type Task, type Wake } from './engine.js';
import { settle, tell } from './turns.js';

export { SILENT_TURNS } from './engine.js';

type Agent = typeof agents.$inferSelect;

/* What finishes the task for whoever holds it, and what to do when that cannot happen. */
function nextStep(task: Task, agentId: string): { finish: string; stuck: string } {
  if (task.stage > 0 && task.panel.includes(agentId)) return { finish: 'give your verdict with your reasons', stuck: 'ask a person with ask_person' };
  if (task.executorAgentId === agentId) return { finish: 'submit it with what you did and the evidence (the commands you ran and what they showed)', stuck: 'say so with blocked' };
  /* Member work that waits with whoever gave it out, while nobody who does or checks it is on. */
  if (task.executorAgentId) return { finish: 'give it to someone who is on with update_task', stuck: 'tell the CEO it waits' };
  return { finish: 'report it', stuck: 'report it as not done, with what stands in the way' };
}

/* The turn's prompt: which task, why the agent wakes, and what is expected of it, then what else it should know. Always
   English, like the agents' instructions. */
export function wakePrompt(agent: Pick<Agent, 'kind'>, task: Task, w: Wake): string {
  const prompt = reason(agent, task, w);
  return w.note ? `${prompt}\n\n${w.note}` : prompt;
}

function reason(agent: Pick<Agent, 'kind'>, task: Task, w: Wake): string {
  const ref = `#${task.number} "${task.title}"`;
  const read = 'Read it with the task tool first: its body is the current truth and its log has the rest.';
  const said = w.text ? `:\n\n${w.text}\n\n` : '. ';
  const { finish, stuck } = nextStep(task, w.agentId);
  /* The orchestrator holds no task of his own: he runs the turn. */
  const own = agent.kind === 'orchestrator' ? 'the turn' : 'your own task';
  switch (w.why) {
    case 'assigned':
      if (task.executorAgentId) return `${ref} is yours to do. ${read} Do the work, then ${finish}. If you cannot go on, ${stuck}; if only a person can answer, use ask_person.`;
      if (agent.kind === 'orchestrator') return `${ref} is yours. ${read} Lay the work out as tasks for the departments with add_tasks or plan_turn, and report it when every part is done.`;
      return `${ref} is your department's. ${read} Split it into member tasks with create_task, each with its executor and gates, and report it when they are done.`;
    case 'review': {
      const together = task.panel.length > 1 ? ' Others of your role check it at the same time; give your own verdict.' : '';
      return `${ref} is at your gate. ${read} Check the work yourself, then give your verdict with your reasons: pass it, or send it back with what to change.${together}`;
    }
    case 'changes':
      return `${ref} came back to you with changes requested${said}Make them, then submit it again.`;
    case 'stuck_at_gate':
      return `${ref}, which you gave out, went back from the same gate ${GATE_ROUNDS} times. Read its log, then step in: rewrite it with update_task, give it another executor or other gates, or cancel it.`;
    case 'done':
      return `${ref}, which you gave out, passed its gates and is done. Read the result with the task tool, then go on with ${own}.`;
    case 'reported':
      return `${ref}, which you gave out, was reported done${said}Go on with ${own}.`;
    case 'blocked':
      /* The orchestrator does not rewrite a department's task: he gives the department a new one. */
      if (agent.kind === 'orchestrator') return `${ref}, which you gave out, cannot go on${said}Cancel it with cancel_task and give the department a task it can do with add_tasks, or tell the CEO what stands in the way.`;
      return `${ref}, which you gave out, cannot go on${said}Unblock it: rewrite it with update_task, give it to someone else, or cancel it.`;
    case 'cancelled':
      return `${ref}, which you gave out, was cancelled${said}Go on with ${own} without it.`;
    case 'answered':
      return `A person answered on ${ref}${said}Go on with it.`;
    case 'comment':
      return `A person commented on ${ref}${said}Take it into account and go on.`;
    case 'updated':
      return `${ref} was rewritten. Read it again with the task tool and go on from its new body.`;
    case 'reminder':
      return `You ended your last turn on ${ref} without moving it. Go on with the work, then ${finish}. If you cannot go on, ${stuck}.`;
    case 'go_on':
      return `Your last turn on ${ref} ended before the work did. Go on with the work from where you left off, then ${finish}. If you cannot go on, ${stuck}.`;
    case 'turn':
      return `${ref} is closed.`;
    case 'switched':
      /* Its text says what to do. */
      return `${ref}, which you gave out, has nobody on to go on with it${w.text ? `:\n\n${w.text}` : '. Give it to someone who is on with update_task, or tell the CEO it waits.'}`;
  }
}

/* A switched-off agent with no turn running hands its work back; the person who switched it off moved it. */
export async function leaveIfOff(ctx: Ctx, agentId: string): Promise<void> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent?.switchedOffAt || agent.kind === 'orchestrator') return;
  const [running] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'running'))).limit(1);
  if (running) return;
  const [change] = await ctx.db
    .select({ personId: agentChanges.personId, byOrchestrator: agentChanges.byOrchestrator })
    .from(agentChanges)
    .where(and(eq(agentChanges.agentId, agentId), eq(agentChanges.field, 'switch')))
    .orderBy(desc(agentChanges.createdAt))
    .limit(1);
  const orchestrator = change?.byOrchestrator ? await orchestratorOf(ctx, agent.companyId) : null;
  const actor = change?.personId ? { personId: change.personId } : { agentId: orchestrator?.id ?? agentId };
  const { wakes, handed, closed } = await leaveWork(ctx, actor, agent);
  /* Turns it would have taken on work it no longer holds would only confuse it once it is on again. */
  if (handed.length) {
    await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'switched_off', finishedAt: new Date() })
      .where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'), inArray(jobs.taskId, handed)));
  }
  /* A gate it left may have finished the last task of the open turn. */
  let all = wakes;
  for (const task of closed) {
    const settled = await settle(ctx, task);
    if (settled) all = tell(all, settled, (await orchestratorOf(ctx, agent.companyId))?.id ?? null, task.id);
  }
  await wakeAll(ctx, all);
}

/* An agent switched on again picks up the gates that waited for someone of its role, and the turns it missed go out. */
export async function backOn(ctx: Ctx, actor: Actor, agentId: string): Promise<void> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.switchedOffAt) return;
  await wakeAll(ctx, await rejoin(ctx, actor, agent));
  await pump(ctx, agentId);
}

/* Queues a turn for every agent a task move needs, one per agent and task: a turn already waiting reads the task as it is
   when it runs. Removed agents and agents without a subscription are left out. */
export async function wakeAll(ctx: Ctx, wakes: Wake[]): Promise<void> {
  const seen = new Set<string>();
  for (const w of wakes) {
    const key = `${w.agentId}:${w.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await queueWake(ctx, w)) await pump(ctx, w.agentId);
  }
}

/* An agent back on a subscription: the wakes it missed without one were left out, so every task waiting on it gets a turn. */
export async function resumeAgent(ctx: Ctx, agentId: string): Promise<void> {
  const held = await ctx.db.select().from(tasks).where(and(eq(tasks.assigneeAgentId, agentId), inArray(tasks.status, ['open', 'working', 'review'])));
  await wakeAll(
    ctx,
    held.map(t => ({ agentId, taskId: t.id, why: t.status === 'review' ? 'review' : 'assigned' })),
  );
}

/* Turns on cancelled tasks end: a waiting one at once, a running one through its node. The agent that cancelled keeps its own. */
export async function stopTurns(ctx: Ctx, taskIds: string[], keep?: string): Promise<void> {
  if (!taskIds.length) return;
  const open = await ctx.db
    .select({ id: jobs.id, status: jobs.status, agentId: jobs.agentId })
    .from(jobs)
    .where(and(inArray(jobs.taskId, taskIds), inArray(jobs.status, ['queued', 'running'])));
  for (const job of open) {
    if (keep && job.agentId === keep) continue;
    if (job.status === 'running') {
      await cancelJob(ctx, job.id);
      continue;
    }
    const [ended] = await ctx.db
      .update(jobs)
      .set({ status: 'failed', error: 'cancelled', result: 'Stopped.', finishedAt: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
      .returning({ id: jobs.id });
    if (ended) await afterJob(ctx, ended.id);
  }
}

async function queueWake(ctx: Ctx, w: Wake): Promise<boolean> {
  const { db } = ctx;
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, w.agentId), isNull(agents.removedAt)));
  if (!agent || !(await liveSubscription(ctx, agent.id))) return false;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, w.taskId));
  if (!task) return false;
  /* One at a time per agent, so two moves at once still queue one turn. */
  return onAgent(ctx, agent.id, async () => {
    const [waiting] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.agentId, agent.id), eq(jobs.taskId, task.id), eq(jobs.status, 'queued')))
      .limit(1);
    if (waiting) return false;
    const prompt = wakePrompt(agent, task, w);
    const jobId = await insertTurn(ctx, { companyId: agent.companyId, agentId: agent.id, prompt, createdBy: null, taskId: task.id });
    await appendEvent(ctx, { companyId: agent.companyId, agentId: agent.id, jobId, kind: 'message', data: { text: prompt, task: { id: task.id, number: task.number } } });
    return true;
  });
}

/* A turn on a task went out: an open task is being worked on now. */
export async function startWork(ctx: Ctx, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ taskId: jobs.taskId, agentId: jobs.agentId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job?.taskId || !job.agentId) return;
  const [row] = await ctx.db
    .update(tasks)
    .set({ status: 'working', version: sql`${tasks.version} + 1`, updatedAt: new Date() })
    .where(and(eq(tasks.id, job.taskId), eq(tasks.status, 'open'), eq(tasks.assigneeAgentId, job.agentId)))
    .returning();
  if (row) published(ctx, row);
}

/* The open task the agent holds after a turn about this one: the task itself, or the task it gave this one out from. */
async function heldTask(ctx: Ctx, agentId: string, taskId: string): Promise<Task | null> {
  const holds = (t: Task | undefined) => (t && (t.assigneeAgentId === agentId || t.panel.includes(agentId)) && !CLOSED.includes(t.status) ? t : null);
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;
  if (holds(task)) return task;
  if (!task.parentId) return null;
  const [parent] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.parentId));
  return holds(parent);
}

/* After a turn on a task: an agent that went idle holding the task without moving it is reminded, and after
   SILENT_TURNS such turns a person is asked. A failed turn counts as silent; a turn a person stopped does not count. One
   that worked until its time ran out, or said in the task how far it got, goes on, up to GOING_ON_TURNS in a row.
   Nothing is checked while the agent has another turn waiting on the task, or while the task waits on its subtasks or on people. */
export async function checkLiveness(ctx: Ctx, jobId: string): Promise<void> {
  const { db } = ctx;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job?.taskId || !job.agentId || !job.startedAt || job.error === 'cancelled') return;
  const agentId = job.agentId;
  const task = await heldTask(ctx, agentId, job.taskId);
  if (!task || !['open', 'working', 'review'].includes(task.status)) return;
  /* A turn already waiting on this task, or on one it gave out, comes back to it anyway. */
  const [next] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), or(eq(tasks.id, task.id), eq(tasks.parentId, task.id))))
    .limit(1);
  if (next) return;
  const [subtasks] = await db.select({ n: count() }).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED])));
  const [asked] = await db.select({ n: count() }).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open')));
  if (Number(subtasks?.n ?? 0) || Number(asked?.n ?? 0)) return;
  const [moves] = await db
    .select({ n: count() })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), gte(taskEvents.createdAt, job.startedAt), notInArray(taskEvents.kind, [...NOT_A_MOVE])));
  if (Number(moves?.n ?? 0)) {
    if (task.silent) await db.update(tasks).set({ silent: 0 }).where(eq(tasks.id, task.id));
    return;
  }
  /* A turn that worked until its time ran out, or that said in the task how far it got, did not stand still. */
  const [told] = await db
    .select({ n: count() })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.agentId, agentId), gte(taskEvents.createdAt, job.startedAt), eq(taskEvents.kind, 'comment')));
  const working = job.error === 'timeout' || Number(told?.n ?? 0) > 0;
  const moved = await (working ? wentOn : silentTurn)(ctx, agentId, task).catch((err: { reason?: string }) => {
    /* Someone moved the task meanwhile: that answers the question. */
    if (err.reason === 'task_changed') return null;
    throw err;
  });
  if (moved) await wakeAll(ctx, moved.wakes);
}
