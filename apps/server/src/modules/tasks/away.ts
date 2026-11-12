import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, machines, nodes, taskEvents, tasks } from '../../db/schema.js';
import { enqueueTurn, NoSubscription, orchestratorOf } from '../conversation/queue.js';
import { ownMachine, type NodeIdentity } from '../nodes/hub.js';
import { failOpenJobs } from '../nodes/messages.js';
import { published } from './engine.js';
import { when } from './silent.js';

/* A turn on a task whose machine Hornhoof cannot reach is not failed for that: the work on that machine is kept, and
   the turn goes on when the machine comes back. Whoever gave the task out hears of it once, and once more when the
   machine is in reach again; whether the task waits or goes to someone else is theirs to decide. A turn whose task
   went to someone else meanwhile is ended as handed on, so the machine stops it when it is back. */

type Job = typeof jobs.$inferSelect;
type Stage = 'away' | 'back';
/* host: the machine's name, for the screens; none for the server's own machine and for one with no name. */
type Noted = { job: string; stage: Stage; holder: string; host: string | null; since: string };

/* The name of the machine a node runs on; none for the server's own machine and for one that never said its name. */
async function hostOf(ctx: Ctx, node: NodeIdentity): Promise<string | null> {
  const { db } = ctx;
  if (node.kind === 'node') {
    const [row] = await db.select({ hostname: machines.hostname }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(nodes.id, node.nodeId));
    return row?.hostname || null;
  }
  if (node.machine === ownMachine(ctx.config)) return null;
  const [row] = await db.select({ hostname: machines.hostname }).from(machines).where(eq(machines.networkId, node.machine));
  return row?.hostname || null;
}

/* The machine in words for an agent. */
const named = (ctx: Ctx, node: NodeIdentity, host: string | null): string =>
  host ?? (node.kind === 'builtin' && node.machine === ownMachine(ctx.config) ? "the server's own machine" : 'a machine with no name');

/* What was written down of this turn: that its machine went away, and that it came back. */
async function notedOf(ctx: Ctx, job: Job): Promise<Noted[]> {
  const rows = await ctx.db
    .select({ data: taskEvents.data })
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, job.taskId!), eq(taskEvents.kind, 'away'), sql`${taskEvents.data} ->> 'job' = ${job.id}`))
    .orderBy(taskEvents.id);
  return rows.map(row => row.data as Noted);
}

/* The agent that hears of it: whoever gave the task out, else the orchestrator; nobody when that is the agent whose
   turn it is, or one that is gone. */
async function hearerOf(ctx: Ctx, task: typeof tasks.$inferSelect, job: Job): Promise<string | null> {
  const id = task.createdByAgentId ?? (await orchestratorOf(ctx, task.companyId))?.id ?? null;
  if (!id || id === job.agentId) return null;
  const [agent] = await ctx.db.select({ removedAt: agents.removedAt }).from(agents).where(eq(agents.id, id));
  return agent && !agent.removedAt ? id : null;
}

async function tell(ctx: Ctx, task: typeof tasks.$inferSelect, job: Job, stage: Stage, host: string | null, since: string, text: string, log: string): Promise<void> {
  const data: Noted = { job: job.id, stage, holder: job.agentId!, host, since };
  await ctx.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'away', agentId: job.agentId, text: log, data });
  published(ctx, task);
  const to = await hearerOf(ctx, task, job);
  if (!to) return;
  const message = { personId: null, text, notification: { source: 'machine' as const, tasks: [{ id: task.id, number: task.number }], detail: { en: host ?? `#${task.number}`, ru: host ?? `#${task.number}` } } };
  await enqueueTurn(ctx, { companyId: task.companyId, agentId: to, prompt: text, createdBy: null, message }).catch((err: unknown) => {
    if (!(err instanceof NoSubscription)) throw err;
  });
}

/* A running turn on a task whose machine has been away as long as Hornhoof waits before it counts a machine as gone.
   since: when the machine went away, in ms. */
export async function turnAway(ctx: Ctx, job: Job, node: NodeIdentity, since: number): Promise<void> {
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, job.taskId!));
  if (!task || !job.agentId) return;
  const noted = await notedOf(ctx, job);
  const last = noted.at(-1);
  /* The task went to someone else while this machine was away: the turn is over, and the machine stops it when it is
     back. Only a turn of the one who held the task when its machine went away ends so. */
  if (last?.stage === 'away' && last.holder === job.agentId && task.assigneeAgentId !== job.agentId) {
    await failOpenJobs(ctx, eq(jobs.id, job.id), 'handed_on');
    return;
  }
  if (last?.stage === 'away' || task.assigneeAgentId !== job.agentId) return;
  const [agent] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, job.agentId));
  const [host, at] = [await hostOf(ctx, node), new Date(since).toISOString()];
  const [who, where] = [agent?.name ?? 'An employee', named(ctx, node, host)];
  const text =
    `Hornhoof: ${who}'s turn on #${task.number} "${task.title}" runs on ${where}, which Hornhoof cannot reach since ${when(at)}. ` +
    `The work on that machine is kept, not lost, and the turn goes on when the machine comes back. #${task.number} stays with ${who}.`;
  await tell(ctx, task, job, 'away', host, at, text, `${who}'s turn runs on ${where}, which Hornhoof cannot reach since ${when(at)}. The work there is kept.`);
}

/* A running turn on a task whose machine is in reach: when it was told of as away, it is told of once as back. */
export async function turnBack(ctx: Ctx, job: Job, node: NodeIdentity, now: Date): Promise<void> {
  const noted = await notedOf(ctx, job);
  const last = noted.at(-1);
  if (last?.stage !== 'away') return;
  const [task] = await ctx.db.select().from(tasks).where(eq(tasks.id, job.taskId!));
  if (!task || !job.agentId) return;
  const [agent] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, job.agentId));
  const [host, at] = [await hostOf(ctx, node), now.toISOString()];
  const [who, where] = [agent?.name ?? 'An employee', named(ctx, node, host)];
  const text = `Hornhoof: ${where} is in reach again, and ${who}'s turn on #${task.number} "${task.title}" goes on there.`;
  await tell(ctx, task, job, 'back', host, at, text, `${where[0]!.toUpperCase()}${where.slice(1)} is in reach again; ${who}'s turn goes on there.`);
}
