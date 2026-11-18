import { approvalNeeded } from '@hornhoof/protocol';
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, requests, tasks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { approvalRuleFor, departmentPolicyRow } from '../departments/approval-policy.js';

/* The answer route checks who may decide. Main and release take the person's answer or the orchestrator's answer for them. */
const acceptedAnswer = and(eq(requests.kind, 'approval'), eq(requests.status, 'approved'),
  isNotNull(requests.answeredBy), isNotNull(requests.answeredAt), isNull(requests.answeredByAssistantId),
  or(isNull(requests.answeredByAgentId), eq(agents.kind, 'orchestrator')));

/* Exact commits share one kind, including approvals made before a channel and kind were recorded. They have no amount. */
export async function commitApprovalRequired(db: Pick<Db, 'select'>, companyId: string, departmentId: string | null, hold = false): Promise<boolean> {
  if (hold && departmentId) await departmentPolicyRow(db, departmentId).for('share');
  const rule = await approvalRuleFor(db, departmentId, 'commit');
  const [known] = departmentId && rule.mode === 'new_kinds' ? await db.select(idOnly(requests)).from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .leftJoin(agents, eq(agents.id, requests.answeredByAgentId))
    .where(and(eq(requests.companyId, companyId), eq(tasks.departmentId, departmentId), isNotNull(requests.commit), acceptedAnswer)).limit(1) : [];
  return approvalNeeded(rule, { amount: null, known: Boolean(known) });
}

export async function exactCommitApproval(db: Pick<Db, 'select'>, companyId: string, taskId: string, commit: string, requestId?: string): Promise<string | null> {
  const [approval] = await db.select(idOnly(requests)).from(requests)
    .leftJoin(agents, eq(agents.id, requests.answeredByAgentId))
    .where(and(eq(requests.companyId, companyId), eq(requests.taskId, taskId), eq(requests.commit, commit), acceptedAnswer, requestId ? eq(requests.id, requestId) : undefined))
    .orderBy(desc(requests.answeredAt)).limit(1);
  return approval?.id ?? null;
}
