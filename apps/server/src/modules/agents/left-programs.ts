import type { ServerMessage } from '@hornhoof/protocol';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { identityOf, ownBuiltin, type NodeIdentity } from '../nodes/hub.js';

/* An agent moved to another plan leaves a program on the node of the old one, which nothing else there ends. That node hears of
   it, and closes the program once it is idle. It is told which turn was its last there, so a word that comes late closes nothing
   of a later turn: nothing is stored here, and a node that was away hears again when it says hello. */

/* What the node got: a turn that started there, or that went out and has not ended. One that failed before it reached the node
   ran no program there. */
const reachedNode = or(isNotNull(jobs.startedAt), inArray(jobs.status, ['queued', 'running']));

const release = (agentKey: string, jobId: string): ServerMessage => ({ type: 'agent.release', agentKey, jobId });

/* The node that ran the agent's turns on the plan it left, each of them if it ran on several. */
export async function releaseLeftProgram(ctx: Ctx, agentId: string, planId: string): Promise<void> {
  const last = await ctx.db
    .selectDistinctOn([jobs.nodeId, jobs.builtinMachine], { id: jobs.id, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, kind: subscriptions.kind })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.subscriptionId, planId), reachedNode))
    .orderBy(jobs.nodeId, jobs.builtinMachine, desc(jobs.createdAt));
  for (const { id, nodeId, builtinMachine, kind } of last) {
    const node = identityOf({ kind }, nodeId, builtinMachine, ownBuiltin(ctx.config));
    if (node) ctx.hub.send(node, release(agentId, id));
  }
}

/* One turn of an employee that this node got, with the plan it ran on and the plan the employee has now. */
type LastHere = { id: string; agentId: string; planId: string | null; current: string | null };

/* On a node: one probe of jobs_node_agent_conversation for each employee, the newest turn of the employee that the node got, and
   the employees whose plan has changed since. The probes cost the same however many turns the node ever ran; the pass over every
   job of the node that this was before took 270 ms of a 150,000-job table, on each hello of each node (#2022). */
export function lastOnNode(db: Ctx['db'], nodeId: string) {
  const latest = db
    .select({ id: jobs.id, planId: jobs.subscriptionId })
    .from(jobs)
    .where(and(eq(jobs.nodeId, nodeId), eq(jobs.agentId, agents.id), eq(jobs.kind, 'conversation'), reachedNode))
    .orderBy(desc(jobs.createdAt))
    .limit(1)
    .as('latest');
  return db
    .select({ id: latest.id, agentId: agents.id, planId: latest.planId, current: agents.subscriptionId })
    .from(agents)
    .innerJoinLateral(latest, sql`true`)
    .where(and(isNull(agents.removedAt), sql`${latest.planId} is distinct from ${agents.subscriptionId}`));
}

/* On a machine's built-in node, which runs the turns of API-key plans: the turns of those plans are few, and jobs_subscription_id
   finds them. */
async function lastOnBuiltin(ctx: Ctx, jobsHere: SQL): Promise<LastHere[]> {
  const last = await ctx.db
    .selectDistinctOn([jobs.agentId], { id: jobs.id, agentId: jobs.agentId, planId: jobs.subscriptionId, current: agents.subscriptionId })
    .from(jobs)
    .innerJoin(agents, and(eq(agents.id, jobs.agentId), isNull(agents.removedAt)))
    .where(and(jobsHere, eq(jobs.kind, 'conversation'), reachedNode))
    .orderBy(jobs.agentId, desc(jobs.createdAt));
  return last.flatMap(row => (row.agentId && row.planId !== row.current ? [{ ...row, agentId: row.agentId }] : []));
}

/* A node back from being away: of each agent whose last turn here was on a plan it has left since. */
export async function releaseProgramsOfLeftPlans(ctx: Ctx, node: NodeIdentity, jobsHere: SQL): Promise<void> {
  const left = node.kind === 'node' ? await lastOnNode(ctx.db, node.nodeId) : await lastOnBuiltin(ctx, jobsHere);
  for (const { id, agentId } of left) if (agentId) ctx.hub.send(node, release(agentId, id));
}
