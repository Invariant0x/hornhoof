import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, machines, nodes, taskEvents, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { enqueueTurn, NoSubscription, orchestratorOf } from '../conversation/queue.js';
import { ownMachine, type NodeIdentity } from '../nodes/hub.js';
import { failOpenJobs } from '../nodes/messages.js';
import { published } from './events.js';
import { when } from './silent.js';

/* A turn on a task whose machine Hornhoof cannot reach is not failed for that: the work on that machine is kept, and
   the turn goes on when the machine comes back. Whoever gave the task out hears of it once, and once more when the
   machine is in reach again; whether the task waits or goes to someone else is theirs to decide. A turn whose task
   went to someone else meanwhile is ended as handed on, so the machine stops it when it is back. */

type Job = typeof jobs.$inferSelect;
type Stage = 'away' | 'back' | 'ended';
/* host: the machine's name, for the screens; none for the server's own machine and for one with no name. */
type Noted = { job: string; stage: Stage; holder: string; host: string | null; since: string };

/* The name of the machine a node runs on; none for the server's own machine and for one that never said its name. */
async function hostOf(ctx: Ctx, node: NodeIdentity): Promise<string | null> {
  const { db } = ctx;
  if (node.kind === 'node') {
    const [row] = await db.select(only(machines, 'hostname')).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(nodes.id, node.nodeId));
    return row?.hostname || null;
  }
  if (node.machine === ownMachine(ctx.config)) return null;
  const [row] = await db.select(only(machines, 'hostname')).from(machines).where(eq(machines.networkId, node.machine));
  return row?.hostname || null;
}

/* The machine in words for an agent. */
const named = (ctx: Ctx, node: NodeIdentity, host: string | null): string =>
  host ?? (node.kind === 'builtin' && node.machine === ownMachine(ctx.config) ? "the server's own machine" : 'a machine with no name');

/* What was written down of this turn: that its machine went away, and that it came back or the turn ended. */
async function notedOf(ctx: Ctx, job: Pick<Job, 'id' | 'taskId'>): Promise<Noted[]> {
  const rows = await ctx.db
    .select(only(taskEvents, 'data'))
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, job.taskId!), eq(taskEvents.kind, 'away'), sql`${taskEvents.data} ->> 'job' = ${job.id}`))
    .orderBy(taskEvents.id);
  return rows.map(row => row.data as Noted);
}

/* The agent that hears of it: whoever gave the task out, else the orchestrator; never the agent whose turn it is, nor
   one that is gone. */
async function hearerOf(ctx: Ctx, task: typeof tasks.$inferSelect, job: Job): Promise<string | null> {
  for (const id of [task.createdByAgentId, (await orchestratorOf(ctx, task.companyId))?.id]) {
    if (!id || id === job.agentId) continue;
    const [agent] = await ctx.db.select(only(agents, 'removedAt')).from(agents).where(eq(agents.id, id));
    if (agent && !agent.removedAt) return id;
  }
  return null;
}

/* The line in the task's log is Hornhoof's own, of nobody's doing: it is no move of the task, and no sign of life of
   its holder. to: whether whoever gave the task out is told too. */
async function note(ctx: Ctx, task: typeof tasks.$inferSelect, job: Job, stage: Stage, host: string | null, since: string, log: string, text: string | null): Promise<void> {
  const data: Noted = { job: job.id, stage, holder: job.agentId!, host, since };
  await ctx.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'away', text: log, data });
  published(ctx, task);
  const to = text === null ? null : await hearerOf(ctx, task, job);
  if (!to || text === null) return;
  const message = { personId: null, text, notification: { source: 'machine' as const, tasks: [{ id: task.id, number: task.number }], detail: { en: host ?? `#${task.number}`, ru: host ?? `#${task.number}` } } };
  await enqueueTurn(ctx, { companyId: task.companyId, agentId: to, prompt: text, createdBy: null, message }).catch((err: unknown) => {
    if (!(err instanceof NoSubscription)) throw err;
  });
}

/* A running turn on a task whose machine has been away as long as Hornhoof waits before it counts a machine as gone.
   since: when the machine went away, in ms. elsewhere: whether the queue would run the agent's next turn on another
   machine now. True when the turn is kept, or was ended here as handed on; false when it is the caller's to end as any
   turn on a machine that is gone. */
export async function turnAway(ctx: Ctx, job: Job, node: NodeIdentity, since: number, elsewhere: () => Promise<boolean>): Promise<boolean> {
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, job.taskId!));
  if (!task || !job.agentId) return false;
  const last = (await notedOf(ctx, job)).at(-1);
  if (last?.stage === 'away') {
    /* The task went to someone else while this machine was away: the turn is over, and the machine stops it when
       it is back. */
    if (task.assigneeAgentId !== job.agentId) await failOpenJobs(ctx, eq(jobs.id, job.id), 'handed_on');
    return true;
  }
  /* Only the turn of whoever holds the task is kept, and only while it can go on nowhere else. */
  if (task.assigneeAgentId !== job.agentId || (await elsewhere())) return false;
  const [agent] = await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, job.agentId));
  const [host, at] = [await hostOf(ctx, node), new Date(since).toISOString()];
  const [who, where] = [agent?.name ?? 'An employee', named(ctx, node, host)];
  const text =
    `Hornhoof: ${who}'s turn on #${task.number} "${task.title}" runs on ${where}, which Hornhoof cannot reach since ${when(at)}. ` +
    `The work on that machine is kept, not lost, and the turn goes on when the machine comes back. #${task.number} stays with ${who}. ` +
    `Hand #${task.number} to someone else only if it cannot wait for that machine: someone is blocked by it, or it was promised for a date. ` +
    'A new holder starts from what was handed in or pushed; what stayed only on that machine stays there until it is back.';
  await note(ctx, task, job, 'away', host, at, `${who}'s turn runs on ${where}, which Hornhoof cannot reach since ${when(at)}. The work there is kept.`, text);
  return true;
}

/* A running turn on a task whose machine is in reach: when it was told of as away, it is told of once as back. */
export async function turnBack(ctx: Ctx, job: Job, node: NodeIdentity, now: Date): Promise<void> {
  const last = (await notedOf(ctx, job)).at(-1);
  if (last?.stage !== 'away') return;
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, job.taskId!));
  if (!task || !job.agentId) return;
  const [agent] = await ctx.db.select(only(agents, 'name')).from(agents).where(eq(agents.id, job.agentId));
  const [host, at] = [await hostOf(ctx, node), now.toISOString()];
  const [who, where] = [agent?.name ?? 'An employee', named(ctx, node, host)];
  const text = `Hornhoof: ${where} is in reach again, and ${who}'s turn on #${task.number} "${task.title}" goes on there.`;
  await note(ctx, task, job, 'back', host, at, `${where[0]!.toUpperCase()}${where.slice(1)} is in reach again; ${who}'s turn goes on there.`, text);
}

/* A turn that was told of as away and runs no more, whichever way it ended: its machine came back without it, it was
   done meanwhile, or the task went to someone else. The log says so once, so no line is left that still promises the
   turn goes on; whoever gave the task out hears how it ended the way they hear of any turn. */
export async function settleAwayNotes(ctx: Ctx): Promise<void> {
  const open = await ctx.db
    .select({ job: jobs, data: taskEvents.data })
    .from(taskEvents)
    .innerJoin(jobs, sql`${jobs.id}::text = ${taskEvents.data} ->> 'job'`)
    .where(and(eq(taskEvents.kind, 'away'), sql`${taskEvents.data} ->> 'stage' = 'away'`, sql`${jobs.status} <> 'running'`,
      sql`NOT EXISTS (SELECT 1 FROM task_events later WHERE later.task_id = ${taskEvents.taskId} AND later.kind = 'away' AND later.id > ${taskEvents.id} AND later.data ->> 'job' = ${taskEvents.data} ->> 'job')`));
  for (const { job, data } of open) {
    const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, job.taskId!));
    if (!task || !job.agentId) continue;
    const host = (data as Noted).host;
    await note(ctx, task, job, 'ended', host, new Date().toISOString(), `The turn that ran on ${host ?? 'that machine'} is over.`, null);
  }
}
