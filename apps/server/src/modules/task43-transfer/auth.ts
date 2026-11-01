import { TASK43_TRANSFER_V1, type Task43Policy } from '@hornhoof/protocol';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, subscriptions, tasks, turns } from '../../db/schema.js';
import { identityOf, type NodeConnectionRef } from '../nodes/hub.js';
import { task43Error, wrongContext } from './errors.js';

export type Task43AuthContext = {
  companyId: string;
  jobId: string;
  actorAgentId: string;
  taskId: string;
  taskNumber: number;
  taskVersion: number;
  jobStatus: string;
  actorKind: string;
  actorRole: string;
  departmentTemplate: string;
  taskStatus: string;
  taskStage: number;
  sourceSubscriptionId: string;
  targetSubscriptionId: string;
  sourceConnection: NodeConnectionRef;
  targetConnection: NodeConnectionRef;
};

export async function authorizeTask43(ctx: Pick<Ctx, 'db' | 'hub'>, toolJobId: string, policy: Task43Policy = TASK43_TRANSFER_V1): Promise<Task43AuthContext> {
  const [row] = await ctx.db
    .select({
      companyId: jobs.companyId,
      jobId: jobs.id,
      jobStatus: jobs.status,
      actorAgentId: agents.id,
      actorKind: agents.kind,
      actorRole: agents.roleKey,
      departmentTemplate: departments.templateKey,
      taskId: tasks.id,
      taskNumber: tasks.number,
      taskVersion: tasks.version,
      taskStatus: tasks.status,
      taskStage: tasks.stage,
      turnId: tasks.turnId,
    })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .innerJoin(tasks, eq(tasks.id, jobs.taskId))
    .innerJoin(departments, eq(departments.id, tasks.departmentId))
    .where(and(
      eq(jobs.id, toolJobId),
      eq(jobs.status, 'running'),
      eq(jobs.companyId, agents.companyId),
      eq(jobs.companyId, tasks.companyId),
      eq(tasks.number, policy.taskNumber),
      eq(tasks.status, 'working'),
      eq(tasks.stage, 0),
      isNull(tasks.closedAt),
      eq(agents.id, tasks.assigneeAgentId),
      eq(agents.kind, 'head'),
      eq(agents.roleKey, 'OPS-HEAD'),
      isNull(agents.removedAt),
      eq(agents.departmentId, tasks.departmentId),
      eq(departments.templateKey, 'operations'),
    ));
  if (!row) throw wrongContext();
  if (row.turnId) {
    const [turn] = await ctx.db.select({ id: turns.id }).from(turns).where(and(eq(turns.id, row.turnId), eq(turns.companyId, row.companyId), eq(turns.status, 'open')));
    if (!turn) throw wrongContext();
  }
  const mappings = await ctx.db
    .select({ agentId: agents.id, subscriptionId: subscriptions.id, kind: subscriptions.kind })
    .from(agents)
    .innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .where(and(
      inArray(agents.id, [policy.sourceAgentId, policy.targetAgentId]),
      eq(agents.companyId, row.companyId),
      eq(subscriptions.companyId, row.companyId),
      eq(subscriptions.status, 'ready'),
      isNull(agents.removedAt),
      isNull(subscriptions.removedAt),
    ));
  if (mappings.length !== 2) throw wrongContext();
  const pin = (agentId: string): NodeConnectionRef => {
    const mapping = mappings.find(item => item.agentId === agentId)!;
    const identity = identityOf({ id: mapping.subscriptionId, kind: mapping.kind });
    if (!ctx.hub.isReady(identity)) throw task43Error('unavailable', 'node_offline', 'A required node is offline.');
    const connection = ctx.hub.pinTask43(identity);
    if (!connection) throw task43Error('unavailable', 'unsupported_node', 'A required node does not support this transfer.');
    return connection;
  };
  return {
    companyId: row.companyId,
    jobId: row.jobId,
    actorAgentId: row.actorAgentId,
    taskId: row.taskId,
    taskNumber: row.taskNumber,
    taskVersion: row.taskVersion,
    jobStatus: row.jobStatus,
    actorKind: row.actorKind,
    actorRole: row.actorRole!,
    departmentTemplate: row.departmentTemplate!,
    taskStatus: row.taskStatus,
    taskStage: row.taskStage,
    sourceSubscriptionId: mappings.find(item => item.agentId === policy.sourceAgentId)!.subscriptionId,
    targetSubscriptionId: mappings.find(item => item.agentId === policy.targetAgentId)!.subscriptionId,
    sourceConnection: pin(policy.sourceAgentId),
    targetConnection: pin(policy.targetAgentId),
  };
}

export function sameTask43Authorization(a: Task43AuthContext, b: Task43AuthContext): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
