import { randomUUID } from 'node:crypto';
import type { Notification } from '@hornhoof/protocol';
import { OPERATOR_CASE_MS, OperatorNodeMessage, PROGRAM_OPERATOR_ROLE, type OperatorEvidence, type OperatorQuestion, type OperatorReason } from '@hornhoof/protocol/program-operator';
import { and, asc, desc, eq, isNull, lte, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, departments, jobs, programDeliveries, programInstances, programOperatorCases, programOperatorSignals, subscriptions } from '../../db/schema.js';
import { identityOf, nodeIdentity } from '../nodes/hub.js';
import { insertTurn, limitUntil, pump } from '../conversation/queue.js';
import { currentOperatorQuestion, liveFailureSignals, qualifyingReasons } from './policy.js';
import { operatorTransaction } from './transactions.js';
import { operatorNotification } from './notifications.js';

type Case = typeof programOperatorCases.$inferSelect;
type Signal = { agentKey: string; jobId: string | null; instance: string; reason: OperatorReason; evidenceKey: string; deliveryId: string | null };
const scope = (row: { agentId: string; instance: string }) => and(eq(programOperatorCases.agentId, row.agentId), eq(programOperatorCases.instance, row.instance));
const reasonNames: Record<OperatorReason, { en: string; ru: string }> = {
  assignment_unrecorded: { en: 'assignment words not recorded for sixty seconds', ru: 'слова поручения не записаны за минуту' },
  recorded_no_activity: { en: 'no first own event for five minutes after the receipt', ru: 'после квитанции нет первого своего события пять минут' },
  live_words_not_taken: { en: 'three consecutive live deliveries not taken', ru: 'три живые доставки подряд не взяты' },
  startup_exit: { en: 'program exited within a minute of launch', ru: 'программа завершилась в первую минуту запуска' },
  question_waiting: { en: 'program question waiting for thirty seconds', ru: 'вопрос программы ждет ответа тридцать секунд' },
};

/* Called with the agent row locked, inside the same transaction as its new evidence. */
export async function updateOperatorCases(ctx: Ctx, frame: OperatorEvidence, now: Date): Promise<void> {
  const facts = await instanceFacts(ctx, frame.agentKey, frame.instance);
  const qualified: Signal[] = qualifyingReasons(facts);
  const live = await ctx.db.select().from(programDeliveries).where(and(eq(programDeliveries.agentId, frame.agentKey), eq(programDeliveries.kind, 'live'))).orderBy(asc(programDeliveries.ordinal));
  const reset = live.reduce((ordinal, row) => row.outcome === 'taken' ? Math.max(ordinal, row.ordinal) : ordinal, 0);
  await resolveLiveBefore(ctx, frame.agentKey, reset);
  await markOldInstancesReadOnly(ctx, frame.agentKey);
  const consumed = await ctx.db.select({ id: programOperatorSignals.evidenceKey }).from(programOperatorSignals).where(and(eq(programOperatorSignals.agentId, frame.agentKey), eq(programOperatorSignals.reason, 'live_words_not_taken')));
  const consumedIds = new Set(consumed.map(row => row.id));
  for (const delivery of liveFailureSignals(live.filter(row => row.ordinal > reset).map(row => ({ ...row, instance: row.instance ?? '' })), consumedIds)) {
    if (delivery.instance && delivery.attemptedAt) qualified.push({ agentKey: delivery.agentId, jobId: delivery.jobId, instance: delivery.instance, reason: 'live_words_not_taken', evidenceKey: delivery.id, deliveryId: delivery.id });
  }
  await resolveUnqualifiedCases(ctx, frame, qualified);
  for (const signal of qualified) await consumeSignal(ctx, signal, now);
}

async function resolveUnqualifiedCases(ctx: Ctx, frame: OperatorEvidence, qualified: readonly Signal[]): Promise<void> {
  const open = await ctx.db.select().from(programOperatorCases).where(and(scope({ agentId: frame.agentKey, instance: frame.instance }), eq(programOperatorCases.status, 'open')));
  for (const row of open) if (!qualified.some(signal => signal.instance === row.instance && row.evidence.some(evidence => evidence.reason === signal.reason && evidence.evidenceKey === signal.evidenceKey))) await resolveCase(ctx, row);
}

async function instanceFacts(ctx: Ctx, agentId: string, instance: string): Promise<OperatorEvidence[]> {
  const rows = await ctx.db.select({ data: agentEvents.data }).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), sql`${agentEvents.data}->'operatorEvidence'->>'instance' = ${instance}`))
    .orderBy(sql`(${agentEvents.data}->'operatorEvidence'->>'ordinal')::bigint`);
  return rows.flatMap(({ data }) => {
    const parsed = OperatorNodeMessage.safeParse((data as { operatorEvidence?: unknown }).operatorEvidence);
    return parsed.success && 'evidenceId' in parsed.data ? [parsed.data] : [];
  });
}

export async function operatorCaseMode(ctx: Ctx, row: Case): Promise<{ reason: OperatorReason; questionId?: string; question?: OperatorQuestion; readOnly: boolean }> {
  const facts = await instanceFacts(ctx, row.agentId, row.instance);
  const signal = qualifyingReasons(facts).find(signal => signal.reason === 'question_waiting' && row.evidence.some(evidence => evidence.reason === signal.reason && evidence.evidenceKey === signal.evidenceKey));
  if (!signal) return { reason: row.reason, readOnly: row.readOnly };
  const question = currentOperatorQuestion(facts, row.instance, row.jobId);
  const latest = await latestInstance(ctx, row.agentId);
  return { reason: 'question_waiting', questionId: signal.questionId ?? undefined, ...(question ? { question } : {}), readOnly: Boolean(latest && latest !== row.instance) };
}

async function consumeSignal(ctx: Ctx, signal: Signal, now: Date): Promise<void> {
  if (!signal.jobId) return;
  const [seen] = await ctx.db.select().from(programOperatorSignals).where(and(eq(programOperatorSignals.agentId, signal.agentKey), eq(programOperatorSignals.instance, signal.instance), eq(programOperatorSignals.reason, signal.reason), eq(programOperatorSignals.evidenceKey, signal.evidenceKey)));
  if (seen) return;
  const subject = await signalSubject(ctx, signal);
  if (!subject) return;
  const { job, instance } = subject;
  const existing = await caseForJob(ctx, signal, job.id);
  const evidence = { reason: signal.reason, evidenceKey: signal.evidenceKey, deliveryId: signal.deliveryId };
  const latest = await latestInstance(ctx, signal.agentKey);
  const readOnly = signalReadOnly(signal, latest);
  const row = existing ?? (await ctx.db.insert(programOperatorCases).values({ companyId: job.companyId, agentId: signal.agentKey, jobId: job.id, nodeId: instance.nodeId, instance: signal.instance, ...evidence, capability: randomUUID(), evidence: [], openedAt: now, deadlineAt: new Date(+now + OPERATOR_CASE_MS), readOnly }).returning())[0]!;
  await ctx.db.insert(programOperatorSignals).values({ companyId: row.companyId, agentId: row.agentId, instance: row.instance, ...evidence, caseId: row.id }).onConflictDoNothing();
  const [updated] = await ctx.db.update(programOperatorCases).set({ evidence: [...row.evidence, evidence], readOnly: row.readOnly || readOnly, revision: existing ? row.revision + 1 : row.revision }).where(eq(programOperatorCases.id, row.id)).returning();
  if (existing) return;
  const operator = await pickOperator(ctx, row.companyId, row.agentId);
  if (!operator) return escalateCase(ctx, updated!, 'operator_unavailable', now);
  const operatorJobId = await queueNotice(ctx, updated!, operator.id, false);
  await ctx.db.update(programOperatorCases).set({ operatorAgentId: operator.id, operatorJobId }).where(eq(programOperatorCases.id, row.id));
}

async function caseForJob(ctx: Ctx, signal: Signal, jobId: string): Promise<Case | undefined> {
  const [existing] = await ctx.db.select().from(programOperatorCases).where(and(scope({ agentId: signal.agentKey, instance: signal.instance }), eq(programOperatorCases.status, 'open')));
  if (existing && existing.jobId !== jobId) {
    await resolveCase(ctx, existing, { outcome: 'superseded', text: 'A newer turn owns this program. The previous operator capability was revoked.', image: existing.pictureId });
    return;
  }
  return existing;
}

async function signalSubject(ctx: Ctx, signal: Signal) {
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, signal.jobId!), eq(jobs.agentId, signal.agentKey)));
  const [instance] = await ctx.db.select().from(programInstances).where(eq(programInstances.id, signal.instance));
  if (!job || !instance || job.error === 'cancelled' || job.error === 'stale') return;
  const [running] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, signal.agentKey), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'))).limit(1);
  if (running && running.id !== job.id) return;
  return { job, instance };
}

function signalReadOnly(signal: Signal, latest: string | null): boolean {
  return signal.reason === 'recorded_no_activity' || signal.reason === 'startup_exit' || Boolean(latest && latest !== signal.instance);
}

async function pickOperator(ctx: Ctx, companyId: string, target: string) {
  const [subject] = await ctx.db.select({ role: agents.roleKey }).from(agents).where(eq(agents.id, target));
  if (subject?.role === PROGRAM_OPERATOR_ROLE) return null;
  const candidates = await ctx.db.select({ agent: agents, sub: subscriptions }).from(agents)
    .innerJoin(departments, eq(departments.id, agents.departmentId)).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .where(and(eq(agents.companyId, companyId), eq(subscriptions.companyId, companyId), eq(departments.companyId, companyId), eq(departments.templateKey, 'operations'), eq(agents.roleKey, PROGRAM_OPERATOR_ROLE), eq(agents.kind, 'worker'), ne(agents.id, target), isNull(agents.removedAt), isNull(agents.switchedOffAt), isNull(subscriptions.removedAt), eq(subscriptions.status, 'ready'))).orderBy(asc(agents.createdAt));
  for (const { agent, sub } of candidates) {
    const node = identityOf(sub, agent.nodeId);
    if (!node || !ctx.hub.isReady(node) || limitUntil(sub.limits, sub.limitsUpdatedAt)) continue;
    const [stuck] = await ctx.db.select({ id: programOperatorCases.id }).from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agent.id), ne(programOperatorCases.status, 'resolved'))).limit(1);
    if (!stuck) return agent;
  }
  return null;
}

async function queueNotice(ctx: Ctx, row: Case, to: string, escalated: boolean): Promise<string> {
  const [target] = await ctx.db.select({ name: agents.name, taskId: jobs.taskId }).from(agents).innerJoin(jobs, eq(jobs.id, row.jobId)).where(and(eq(agents.id, row.agentId), eq(jobs.agentId, row.agentId), eq(jobs.companyId, row.companyId)));
  const name = target?.name ?? row.agentId, reason = reasonNames[row.reason];
  const text = noticeText(row, name, reason, escalated);
  const notification = await operatorNotification(ctx, { companyId: row.companyId, taskId: target?.taskId ?? null }, { en: `${name}: ${reason.en}`, ru: `${name}: ${reason.ru}` });
  const message = noticeMessage(row, text, notification);
  return insertTurn(ctx, { companyId: row.companyId, agentId: to, prompt: text, createdBy: null, message });
}

function noticeMessage(row: Case, text: string, notification: Notification) {
  const actor = row.resolution?.actor;
  return { personId: null, text, notification, ...(actor?.id ? { actor, from: 'agent' as const, by: actor.id, name: actor.name } : {}), ...(row.pictureId ? { pictures: [{ id: row.pictureId, name: 'program-question.png' }] } : {}), operatorQuestion: row.resolution?.question, programOperatorCase: row.id, targetAgentId: row.agentId, targetJobId: row.jobId, programInstanceId: row.instance, operatorReason: row.reason };
}

function noticeText(row: Case, name: string, reason: { en: string; ru: string }, escalated: boolean): string {
  return escalated ? escalationText(row, name, reason.en) : `Program operator case ${row.id} for ${name}: ${reason.en}. Read program_screen for employee ${row.agentId} and this case. Use program_keys for harmless setup or a current permission question, one key after each fresh snapshot. Follow your permission policy; leave work decisions to a person. Report needs_owner, failed or denied with tell_orchestrator. Deadline: ${row.deadlineAt.toISOString()}.`;
}

function escalationText(row: Case, name: string, reason: string): string {
  return `Program operator case ${row.id} for ${name}: ${reason}. Recovery needs attention: ${row.resolution?.outcome ?? 'operator_unavailable'}. ${row.resolution?.text ?? ''} ${row.resolution?.question ? `Request: ${row.resolution.question.text}.` : ''} ${row.pictureId ? `Picture: ${row.pictureId}. Download and inspect it with hh-fetch operator-case:${row.id} ${row.pictureId} program-question.png.` : 'A picture is unavailable; inspect the existing owner terminal.'}`;
}

async function resolveCase(ctx: Ctx, row: Case, resolution?: NonNullable<Case['resolution']>): Promise<void> {
  await ctx.db.update(programOperatorCases).set({ status: 'resolved', revision: row.revision + 1, recoveryHold: false, resolution: resolution ?? { outcome: 'received', text: 'The program supplied the required receipt or first own event.', image: row.pictureId } }).where(eq(programOperatorCases.id, row.id));
  if (row.operatorJobId) await ctx.db.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The program operator case was resolved.', finishedAt: new Date() }).where(and(eq(jobs.id, row.operatorJobId), eq(jobs.status, 'queued')));
}

export async function escalateCase(ctx: Ctx, row: Case, outcome: string, now: Date, report?: NonNullable<Case['resolution']>): Promise<void> {
  if (!canEscalate(row, outcome)) return;
  const recoveryHold = await needsRecoveryHold(ctx, row);
  const [updated] = await ctx.db.update(programOperatorCases).set({ status: 'escalated', revision: row.revision + 1, escalatedAt: now, recoveryHold, resolution: report ?? { outcome, text: `Program operator recovery ended: ${outcome}.`, image: row.pictureId } }).where(eq(programOperatorCases.id, row.id)).returning();
  await queueEscalation(ctx, updated!);
}

function canEscalate(row: Case, outcome: string): boolean {
  return row.status === 'open' || (outcome === 'denied' && row.status === 'resolved' && !row.escalationJobId);
}

async function needsRecoveryHold(ctx: Ctx, row: Case): Promise<boolean> {
  const [delivery] = row.deliveryId ? await ctx.db.select().from(programDeliveries).where(eq(programDeliveries.id, row.deliveryId)) : [];
  const [instance] = await ctx.db.select().from(programInstances).where(eq(programInstances.id, row.instance));
  const [target] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  const current = await latestInstance(ctx, row.agentId);
  return row.reason === 'assignment_unrecorded' && (!current || current === row.instance) && waitingForWords(delivery, instance, target, row.id);
}

function waitingForWords(delivery: typeof programDeliveries.$inferSelect | undefined, instance: typeof programInstances.$inferSelect | undefined, target: typeof jobs.$inferSelect | undefined, caseId: string): boolean {
  return !delivery?.receiptAt && !instance?.active && (target?.status === 'running' || matchingOperatorTimeout(target, caseId));
}

function matchingOperatorTimeout(job: typeof jobs.$inferSelect | undefined, caseId: string): boolean {
  if (!job || job.status !== 'failed' || job.error !== 'agent_failed') return false;
  const failure = job.failure;
  return failure?.kind === 'unknown' && failure.retryable === false && failure.text === `Program operator recovery ended: operator_timeout; case ${caseId}.`;
}

async function latestInstance(ctx: Ctx, agentId: string): Promise<string | null> {
  const [current] = await ctx.db.select({ instance: programInstances.id }).from(programInstances)
    .innerJoin(agentEvents, sql`${agentEvents.data}->'operatorEvidence'->>'instance' = ${programInstances.id}::text`)
    .innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(eq(programInstances.agentId, agentId), eq(agentEvents.agentId, agentId), eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), eq(jobs.nodeId, programInstances.nodeId), eq(jobs.companyId, programInstances.companyId)))
    .orderBy(desc(programInstances.createdAt)).limit(1);
  if (current) return current.instance;
  const [latest] = await ctx.db.select({ instance: programInstances.id }).from(programInstances).where(eq(programInstances.agentId, agentId)).orderBy(desc(programInstances.createdAt)).limit(1);
  return latest?.instance ?? null;
}

async function markOldInstancesReadOnly(ctx: Ctx, agentId: string): Promise<void> {
  const current = await latestInstance(ctx, agentId);
  if (!current) return;
  await ctx.db.update(programOperatorCases).set({ readOnly: true, revision: sql`${programOperatorCases.revision} + 1` })
    .where(and(eq(programOperatorCases.agentId, agentId), eq(programOperatorCases.status, 'open'), eq(programOperatorCases.readOnly, false), ne(programOperatorCases.instance, current)));
}

async function resolveLiveBefore(ctx: Ctx, agentId: string, ordinal: number): Promise<void> {
  if (!ordinal) return;
  const rows = await ctx.db.select({ incident: programOperatorCases }).from(programOperatorCases)
    .innerJoin(programDeliveries, eq(programDeliveries.id, programOperatorCases.deliveryId))
    .where(and(eq(programOperatorCases.agentId, agentId), eq(programOperatorCases.status, 'open'), eq(programOperatorCases.reason, 'live_words_not_taken'), lte(programDeliveries.ordinal, ordinal)));
  for (const { incident } of rows) if (incident.evidence.every(evidence => evidence.reason === 'live_words_not_taken')) await resolveCase(ctx, incident);
}

export async function queueEscalation(ctx: Ctx, row: Case): Promise<void> {
  if (row.escalationJobId) return;
  const to = await escalationRecipient(ctx, row);
  if (!to?.subscriptionId) return;
  const escalationJobId = await queueNotice(ctx, row, to.id, true);
  await ctx.db.update(programOperatorCases).set({ escalationJobId }).where(eq(programOperatorCases.id, row.id));
}

async function escalationRecipient(ctx: Ctx, row: Case) {
  const [target] = row.resolution?.outcome === 'denied' ? await ctx.db.select({ departmentId: agents.departmentId }).from(agents).where(eq(agents.id, row.agentId)) : [];
  const [head] = target?.departmentId ? await ctx.db.select().from(agents).where(and(eq(agents.companyId, row.companyId), eq(agents.departmentId, target.departmentId), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))) : [];
  const [orchestrator] = head?.subscriptionId ? [] : await ctx.db.select().from(agents).where(and(eq(agents.companyId, row.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  const to = head?.subscriptionId ? head : orchestrator;
  return to;
}

/* Replayed evidence restores persisted capabilities and wakes, without creating another turn or replaying a key. */
export async function syncOperatorCases(ctx: Ctx, agentId: string, now = new Date()): Promise<void> {
  const rows = await ctx.db.select().from(programOperatorCases).where(eq(programOperatorCases.agentId, agentId));
  for (const row of rows) {
    const node = nodeIdentity(row.nodeId);
    const mode = await operatorCaseMode(ctx, row);
    if (ctx.hub.hasProgramOperator(node)) ctx.hub.send(node, { type: 'program.operator_case', agentKey: row.agentId, jobId: row.jobId, instance: row.instance, case: row.id, capability: row.capability, disposition: row.status === 'open' ? 'open' : 'revoke', remainingMs: Math.min(OPERATOR_CASE_MS, Math.max(0, +row.deadlineAt - +now)), revision: row.revision, reason: mode.reason, questionId: mode.questionId, readOnly: mode.readOnly, closedBecause: row.status !== 'open' ? row.resolution?.outcome : undefined });
    await pumpCaseNotices(ctx, row);
  }
}

async function pumpCaseNotices(ctx: Ctx, row: Case): Promise<void> {
  for (const id of [row.operatorJobId, row.escalationJobId, row.continuationJobId]) {
    if (!id) continue;
    const [job] = await ctx.db.select({ agentId: jobs.agentId }).from(jobs).where(eq(jobs.id, id));
    if (job?.agentId) await pump(ctx, job.agentId);
  }
}

export async function expireOperatorCases(ctx: Ctx, now = new Date()): Promise<void> {
  const due = await ctx.db.select({ id: programOperatorCases.id, agentId: programOperatorCases.agentId }).from(programOperatorCases).where(and(eq(programOperatorCases.status, 'open'), lte(programOperatorCases.deadlineAt, now)));
  for (const entry of due) {
    await operatorTransaction(ctx, async (tx, inside) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, entry.agentId)).for('update');
      const [row] = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.id, entry.id), eq(programOperatorCases.status, 'open'))).for('update');
      if (row && +row.deadlineAt <= +now) await escalateCase(inside, row, 'operator_timeout', now);
    });
    await syncOperatorCases(ctx, entry.agentId, now);
  }
}
