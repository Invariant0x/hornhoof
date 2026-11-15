import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, nodes, programOperatorCases, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

export type OperatorCaller = { id: string; companyId: string; agentId: string };
export const operatorRefused = () => new ApiError(403, 'forbidden', 'This operator turn cannot access that program case.', 'agent_not_ready');
const target = alias(agents, 'operator_target');
const targetJob = alias(jobs, 'operator_target_job');

/* The program operator reports the case it was given. The advertised role is no authority: every report reads the current
   employee, turn, assignment and program, of any plan, and never of a person's own assistant. */
export async function authorizeOperator(ctx: Ctx, caller: OperatorCaller, caseId: string, employee?: string, locked = false) {
  const query = ctx.db.select({ row: programOperatorCases, me: agents, target, job: targetJob }).from(programOperatorCases)
    .innerJoin(agents, eq(agents.id, programOperatorCases.operatorAgentId)).innerJoin(jobs, eq(jobs.id, programOperatorCases.operatorJobId))
    .innerJoin(departments, eq(departments.id, agents.departmentId)).innerJoin(target, eq(target.id, programOperatorCases.agentId))
    .innerJoin(targetJob, eq(targetJob.id, programOperatorCases.jobId)).innerJoin(subscriptions, eq(subscriptions.id, targetJob.subscriptionId)).innerJoin(nodes, eq(nodes.id, targetJob.nodeId))
    .where(and(eq(programOperatorCases.id, caseId), eq(programOperatorCases.companyId, caller.companyId), eq(agents.id, caller.agentId), eq(agents.companyId, caller.companyId), eq(jobs.id, caller.id), eq(jobs.companyId, caller.companyId), eq(jobs.agentId, agents.id), eq(jobs.status, 'running'), eq(agents.roleKey, PROGRAM_OPERATOR_ROLE), eq(agents.kind, 'worker'), eq(departments.companyId, caller.companyId), eq(departments.templateKey, 'operations'), isNull(agents.removedAt), isNull(agents.switchedOffAt), eq(target.companyId, caller.companyId), eq(targetJob.companyId, caller.companyId), eq(targetJob.agentId, target.id), eq(targetJob.kind, 'conversation'), eq(targetJob.nodeId, programOperatorCases.nodeId), eq(subscriptions.companyId, caller.companyId), eq(nodes.companyId, caller.companyId), ne(target.kind, 'assistant'), isNull(target.removedAt), isNull(subscriptions.removedAt)));
  const [checked] = locked ? await query.for('share') : await query;
  if (!checked || checked.row.agentId === checked.me.id || (employee && employee !== checked.row.agentId)) throw operatorRefused();
  return checked;
}
