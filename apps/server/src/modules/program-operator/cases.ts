import { randomUUID } from 'node:crypto';
import type { Notification } from '@hornhoof/protocol';
import { OPERATOR_CASE_MS, OperatorNodeMessage, PROGRAM_OPERATOR_ROLE, type OperatorEvidence, type OperatorQuestion, type OperatorReason, type ProgramView } from '@hornhoof/protocol/program-operator';
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, attachments, departments, jobs, programDeliveries, programInstances, programOperatorCases, programOperatorSignals, subscriptions, type CaseReason } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { nodeIdentity, ownBuiltin } from '../nodes/hub.js';
import { planNodes } from '../nodes/nodes.js';
import { insertTurn, pump } from '../conversation/queue.js';
import { modelLimitUntil } from '../conversation/limits.js';
import { takesTurns } from '../conversation/placement.js';
import { appendEvent } from '../events/store.js';
import { nodeHeld } from '../updates/drain.js';
import { firstOfRun, outcomeOfOperatorTry } from './failure-run.js';
import { fromStart } from './not-started.js';
import { currentOperatorQuestion, liveFailureSignals, qualifyingReasons } from './policy.js';
import { unavailableOperatorHold } from './recovery-state.js';
import { operatorTransaction } from './transactions.js';
import { operatorNotification } from './notifications.js';
import { saying, wordsFor } from '../../locales/index.js';

type Case = typeof programOperatorCases.$inferSelect;
/* A case of what a node saw of a program, which that node holds too. */
type ProgramCase = Case & { reason: OperatorReason };
const ofProgram = (row: Case): row is ProgramCase => !fromStart(row);
type Signal = { agentKey: string; jobId: string | null; instance: string; reason: OperatorReason; evidenceKey: string; deliveryId: string | null };
type Seen = { frame: OperatorEvidence; png: Buffer | null };
const scope = (row: { agentId: string; instance: string }) => and(eq(programOperatorCases.agentId, row.agentId), eq(programOperatorCases.instance, row.instance));
/* A case's reason in every language, as its notice carries it; the English reads in the words an agent is given. */
const reasonNames = (reason: CaseReason) => ({ en: wordsFor('en').operator.cases[reason], named: (name: string) => saying(words => words.operator.named(name, words.operator.cases[reason])) });

/* Called with the agent row locked, inside the same transaction as its new evidence. */
export async function updateOperatorCases(ctx: Ctx, frame: OperatorEvidence, now: Date, png: Buffer | null = null): Promise<void> {
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
  for (const signal of qualified) await consumeSignal(ctx, signal, now, { frame, png });
}

async function resolveUnqualifiedCases(ctx: Ctx, frame: OperatorEvidence, qualified: readonly Signal[]): Promise<void> {
  const open = await ctx.db.select().from(programOperatorCases).where(and(scope({ agentId: frame.agentKey, instance: frame.instance }), eq(programOperatorCases.status, 'open')));
  for (const row of open) if (!qualified.some(signal => signal.instance === row.instance && row.evidence.some(evidence => evidence.reason === signal.reason && evidence.evidenceKey === signal.evidenceKey))) await resolveCase(ctx, row);
}

async function instanceFacts(ctx: Ctx, agentId: string, instance: string): Promise<OperatorEvidence[]> {
  const rows = await ctx.db
    .select(only(agentEvents, 'data'))
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), sql`${agentEvents.data}->>'operatorEvidenceId' is not null`, sql`${agentEvents.data}->'operatorEvidence'->>'instance' = ${instance}`));
  return rows
    .flatMap(({ data }) => {
      const parsed = OperatorNodeMessage.safeParse((data as { operatorEvidence?: unknown }).operatorEvidence);
      return parsed.success && 'evidenceId' in parsed.data ? [parsed.data] : [];
    })
    .sort((a, b) => a.ordinal - b.ordinal);
}

const hasQuestionEvidence = (row: Pick<Case, 'evidence'>): boolean => row.evidence.some(evidence => evidence.reason === 'question_waiting');

export async function operatorCaseMode<Row extends Case>(ctx: Ctx, row: Row): Promise<{ reason: Row['reason'] | 'question_waiting'; questionId?: string; question?: OperatorQuestion; readOnly: boolean }> {
  if (!hasQuestionEvidence(row)) return { reason: row.reason, readOnly: row.readOnly };
  const facts = await instanceFacts(ctx, row.agentId, row.instance);
  const signal = qualifyingReasons(facts).find(signal => signal.reason === 'question_waiting' && row.evidence.some(evidence => evidence.reason === signal.reason && evidence.evidenceKey === signal.evidenceKey));
  if (!signal) return { reason: row.reason, readOnly: row.readOnly };
  const question = currentOperatorQuestion(facts, row.instance, row.jobId);
  const latest = await latestInstance(ctx, row.agentId);
  return { reason: 'question_waiting', questionId: signal.questionId ?? undefined, ...(question ? { question } : {}), readOnly: Boolean(latest && latest !== row.instance) };
}

async function consumeSignal(ctx: Ctx, signal: Signal, now: Date, nodeSaw: Seen): Promise<void> {
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
  const told = await recordLook(ctx, updated!, signal, nodeSaw);
  if (!existing) await callOperator(ctx, told, now);
}

/* What the node saw as this signal fell due goes on its case before anyone hears of it, so the notice shows it. It tells no
   one by itself, and it leaves no snapshot to press keys on. */
async function recordLook(ctx: Ctx, row: Case, signal: Signal, { frame, png }: Seen): Promise<Case> {
  const look = lookOf(frame, signal);
  if (!look) return row;
  const picture = png ? await casePicture(ctx, row, png) : null;
  const evidence = row.evidence.map(fact => fact.reason === signal.reason && fact.evidenceKey === signal.evidenceKey ? { ...fact, input: look.input } : fact);
  const [updated] = await ctx.db.update(programOperatorCases).set({ evidence, pictureId: picture ?? row.pictureId }).where(eq(programOperatorCases.id, row.id)).returning();
  return updated!;
}

async function casePicture(ctx: Ctx, row: Case, png: Buffer): Promise<string> {
  const kept = await ctx.files.putBytes(ctx.db, png);
  const [picture] = await ctx.db.insert(attachments).values({ companyId: row.companyId, jobId: row.jobId, agentId: row.agentId, operatorCaseId: row.id, mediaType: 'image/png', sha256: kept.sha256, size: kept.size }).returning({ id: attachments.id });
  return picture!.id;
}

const lookOf = (frame: OperatorEvidence, signal: Signal) =>
  frame.type === 'program.operator_needed' && frame.reason === signal.reason && frame.evidenceKey === signal.evidenceKey ? frame.check : undefined;

/* One case wakes one operator, unless one already failed to get these words through in this run. */
async function callOperator(ctx: Ctx, row: Case, now: Date): Promise<void> {
  const tried = await outcomeOfOperatorTry(ctx, row, now);
  if (tried) return escalateCase(ctx, row, tried, now);
  const operator = await pickOperator(ctx, row.companyId, row.agentId);
  if (!operator) return escalateCase(ctx, row, 'operator_unavailable', now);
  const operatorJobId = await queueNotice(ctx, row, operator.id, false);
  await ctx.db.update(programOperatorCases).set({ operatorAgentId: operator.id, operatorJobId }).where(eq(programOperatorCases.id, row.id));
}

async function caseForJob(ctx: Ctx, signal: Signal, jobId: string): Promise<Case | undefined> {
  const [existing] = await ctx.db.select().from(programOperatorCases).where(and(scope({ agentId: signal.agentKey, instance: signal.instance }), eq(programOperatorCases.status, 'open')));
  if (existing && existing.jobId !== jobId) {
    await resolveCase(ctx, existing, { outcome: 'superseded', text: 'A newer turn owns this program.', image: existing.pictureId });
    return;
  }
  return existing;
}

/* The turn a signal is of, on an employee: a person's own assistant's program is its owner's alone, and no case opens on it. */
async function signalSubject(ctx: Ctx, signal: Signal) {
  const employee = ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.id, signal.agentKey), ne(agents.kind, 'assistant')));
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, signal.jobId!), inArray(jobs.agentId, employee)));
  const [instance] = await ctx.db.select().from(programInstances).where(eq(programInstances.id, signal.instance));
  if (!job || !instance || job.error === 'cancelled' || job.error === 'stale') return;
  const [running] = await ctx.db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, signal.agentKey), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'))).limit(1);
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
    if (!(await planCanTakeTurn(ctx, sub)) || modelLimitUntil(sub, agent.model)) continue;
    const [stuck] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases).where(and(eq(programOperatorCases.agentId, agent.id), or(eq(programOperatorCases.status, 'open'), eq(programOperatorCases.recoveryHold, true)))).limit(1);
    if (!stuck) return agent;
  }
  return null;
}

/* An operator's turn goes where anyone's would: to a machine of its plan that can take a turn, whichever it was on before,
   and before its first turn it was on none. A machine that restarts for an update comes back: the turn waits for it. */
async function planCanTakeTurn(ctx: Ctx, sub: typeof subscriptions.$inferSelect): Promise<boolean> {
  if (sub.kind === 'api_key') return ctx.hub.isReady(ownBuiltin(ctx.config)) || nodeHeld(ctx, ownBuiltin(ctx.config));
  return (await planNodes(ctx.db, [sub.id])).some(node => takesTurns(ctx, node) || nodeHeld(ctx, nodeIdentity(node.id)));
}

async function queueNotice(ctx: Ctx, row: Case, to: string, escalated: boolean): Promise<string> {
  const [target] = await ctx.db.select({ name: agents.name, taskId: jobs.taskId }).from(agents).innerJoin(jobs, eq(jobs.id, row.jobId)).where(and(eq(agents.id, row.agentId), eq(jobs.agentId, row.agentId), eq(jobs.companyId, row.companyId)));
  const name = target?.name ?? row.agentId, reason = reasonNames(row.reason);
  const text = `${noticeText(row, name, reason, escalated)}${inputNote(row)}`;
  const notification = await operatorNotification(ctx, { companyId: row.companyId, taskId: target?.taskId ?? null }, reason.named(name));
  const message = noticeMessage(row, text, notification);
  return insertTurn(ctx, { companyId: row.companyId, agentId: to, prompt: text, createdBy: null, message });
}

const inputNote = (row: Case) => row.evidence.some(fact => fact.input === 'text') ? " When the node stopped waiting, the program's input line held text that was not sent." : '';

function noticeMessage(row: Case, text: string, notification: Notification) {
  const actor = row.resolution?.actor;
  return { personId: null, text, notification, ...(actor?.id ? { actor, from: 'agent' as const, by: actor.id, name: actor.name } : {}), ...(row.pictureId ? { pictures: [{ id: row.pictureId, name: 'program-question.png' }] } : {}), operatorQuestion: row.resolution?.question, programOperatorCase: row.id, targetAgentId: row.agentId, targetJobId: row.jobId, programInstanceId: row.instance, operatorReason: row.reason };
}

function noticeText(row: Case, name: string, reason: { en: string }, escalated: boolean): string {
  return escalated ? escalationText(row, name, reason.en) : `Program operator case ${row.id} for ${name}: ${reason.en}. Read program_screen for employee ${row.agentId}. Use program_keys with a fresh snapshot for actions within your authority. Report with tell_orchestrator: cleared once the program works again, needs_owner for personal consent or terms, failed for a failed repair, or denied after denying a permission. Keep private input out of your report.`;
}

function escalationText(row: Case, name: string, reason: string): string {
  return `Program operator case ${row.id} for ${name}: ${reason}. Recovery needs attention: ${row.resolution?.outcome ?? 'operator_unavailable'}. ${row.resolution?.text ?? ''} ${row.resolution?.question ? `Request: ${row.resolution.question.text}.` : ''} ${row.pictureId ? `Picture: ${row.pictureId}. Download and inspect it with hh-fetch operator-case:${row.id} ${row.pictureId} program-question.png.` : 'A picture is unavailable; inspect the existing owner terminal.'}`;
}

/* A case of a waiting question alone: once the question is gone and the program goes on, nothing of it stands. */
const ofAQuestion = (row: Case) => row.reason === 'question_waiting' && row.evidence.every(fact => fact.reason === 'question_waiting');
const questionGone = (image: string | null) => ({ outcome: 'question_gone', text: "The program's question went away and the program went on.", image });

/* How a case closes by itself, from the program's own facts. */
const ownResolution = (row: Case) => ofAQuestion(row) ? questionGone(row.pictureId) : { outcome: 'received', text: 'The program supplied the required receipt or first own event.', image: row.pictureId };

export async function resolveCase(ctx: Ctx, row: Case, resolution?: NonNullable<Case['resolution']>): Promise<void> {
  await ctx.db.update(programOperatorCases).set({ status: 'resolved', revision: row.revision + 1, recoveryHold: false, resolution: resolution ?? ownResolution(row) }).where(eq(programOperatorCases.id, row.id));
  if (row.operatorJobId) await ctx.db.update(jobs).set({ status: 'failed', error: 'cancelled', result: 'The program operator case was resolved.', finishedAt: new Date() }).where(and(eq(jobs.id, row.operatorJobId), eq(jobs.status, 'queued')));
}

/* A fresh screen of the program at work that asks nothing closes its open question cases, whoever looked and whether or not
   the node's own fact of it has come yet, with that screen as their picture. Called with the agent row locked. */
export async function settleAnsweredQuestions(ctx: Ctx, agentId: string, seen: Pick<ProgramView, 'state' | 'question' | 'instance'>, png: Buffer): Promise<string[]> {
  if (seen.state !== 'working' || seen.question || !seen.instance) return [];
  const open = await ctx.db.select().from(programOperatorCases).where(and(scope({ agentId, instance: seen.instance }), eq(programOperatorCases.status, 'open')));
  const settled = open.filter(ofAQuestion);
  for (const row of settled) {
    const pictureId = await casePicture(ctx, row, png);
    await ctx.db.update(programOperatorCases).set({ pictureId }).where(eq(programOperatorCases.id, row.id));
    await resolveCase(ctx, row, questionGone(pictureId));
  }
  return settled.map(row => row.id);
}

export async function escalateCase(ctx: Ctx, row: Case, outcome: string, now: Date, report?: NonNullable<Case['resolution']>): Promise<void> {
  if (!canEscalate(row, outcome)) return;
  const recoveryHold = await needsRecoveryHold(ctx, row);
  const [updated] = await ctx.db.update(programOperatorCases).set({ status: 'escalated', revision: row.revision + 1, escalatedAt: now, recoveryHold, resolution: report ?? { outcome, text: `Program operator recovery ended: ${outcome}.`, image: row.pictureId } }).where(eq(programOperatorCases.id, row.id)).returning();
  await queueEscalation(ctx, updated!);
}

function canEscalate(row: Case, outcome: string): boolean {
  return row.status === 'open' || takesLateDenial(row, outcome);
}

/* A denial the operator made still reaches the head after its case closed by itself, once. */
export function takesLateDenial(row: Case, outcome: string): boolean {
  return outcome === 'denied' && row.status === 'resolved' && !row.escalationJobId;
}

async function needsRecoveryHold(ctx: Ctx, row: Case): Promise<boolean> {
  const [delivery] = row.deliveryId ? await ctx.db.select().from(programDeliveries).where(eq(programDeliveries.id, row.deliveryId)) : [];
  const [target] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  const current = await latestInstance(ctx, row.agentId);
  return row.reason === 'assignment_unrecorded' && (!current || current === row.instance) && waitingForWords(delivery, target, row.id);
}

/* The facts of these words, not of the program: one that goes on its session did plenty before them. */
function waitingForWords(delivery: typeof programDeliveries.$inferSelect | undefined, target: typeof jobs.$inferSelect | undefined, caseId: string): boolean {
  return !delivery?.receiptAt && !delivery?.firstActivityAt && (target?.status === 'running' || matchingOperatorTimeout(target, caseId));
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
    .where(and(eq(programInstances.agentId, agentId), eq(agentEvents.agentId, agentId), sql`${agentEvents.data}->>'operatorEvidenceId' is not null`, eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), eq(jobs.nodeId, programInstances.nodeId), eq(jobs.companyId, programInstances.companyId)))
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
  if (row.escalationJobId || unavailableOperatorHold(row)) return;
  const first = await firstOfRun(ctx, row);
  return first ? shareEscalation(ctx, row, first) : openEscalation(ctx, row);
}

async function openEscalation(ctx: Ctx, row: Case): Promise<void> {
  const target = await failedAgent(ctx, row);
  const ofOrchestrator = target?.kind === 'orchestrator';
  if (ofOrchestrator) await tellPeople(ctx, row, target.name);
  const to = await escalationRecipient(ctx, row, target);
  if (!to?.subscriptionId) return;
  /* The head of Operations hears of the orchestrator's program without its picture, which people have. */
  const escalationJobId = await queueNotice(ctx, ofOrchestrator ? { ...row, pictureId: null } : row, to.id, true);
  await ctx.db.update(programOperatorCases).set({ escalationJobId }).where(eq(programOperatorCases.id, row.id));
}

/* The notice of the run's first case stands for this one too. While it waits for a recipient this case waits with it. */
async function shareEscalation(ctx: Ctx, row: Case, first: Case): Promise<void> {
  if (first.escalationJobId) await ctx.db.update(programOperatorCases).set({ escalationJobId: first.escalationJobId }).where(eq(programOperatorCases.id, row.id));
}

async function failedAgent(ctx: Ctx, row: Case) {
  const [target] = await ctx.db.select({ name: agents.name, kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, row.agentId));
  return target;
}

/* No turn can tell the orchestrator of its own program, so people read it in its window, once for each case that speaks. */
async function tellPeople(ctx: Ctx, row: Case, name: string): Promise<void> {
  const [told] = await ctx.db.select(idOnly(agentEvents)).from(agentEvents).where(and(eq(agentEvents.agentId, row.agentId), sql`${agentEvents.data}->>'operatorEscalation' = ${row.id}`)).limit(1);
  if (told) return;
  const reason = reasonNames(row.reason);
  const text = `${name}'s program needs a person: ${reason.en}. Recovery ended: ${row.resolution?.outcome}. No turn goes to ${name} about this, and the words it was given wait for its next turn that works. Open its terminal to see what stops it.`;
  const notification = await operatorNotification(ctx, { companyId: row.companyId, taskId: null }, reason.named(name));
  await appendEvent(ctx, { companyId: row.companyId, agentId: row.agentId, jobId: row.jobId, kind: 'message', data: { text, turnFact: true, notification, operatorEscalation: row.id, ...(row.pictureId ? { pictures: [{ id: row.pictureId, name: 'program-screen.png' }] } : {}) } });
}

/* Who hears of a program that failed, never its own agent: a turn of that program would fail the same way. */
async function escalationRecipient(ctx: Ctx, row: Case, target: Awaited<ReturnType<typeof failedAgent>>) {
  const present = and(eq(agents.companyId, row.companyId), ne(agents.id, row.agentId), isNull(agents.removedAt), isNull(agents.switchedOffAt));
  if (target?.kind === 'orchestrator') return operationsHead(ctx, present);
  const [head] = row.resolution?.outcome === 'denied' && target?.departmentId ? await ctx.db.select().from(agents).where(and(present, eq(agents.departmentId, target.departmentId), eq(agents.kind, 'head'))) : [];
  if (head?.subscriptionId) return head;
  const [orchestrator] = await ctx.db.select().from(agents).where(and(present, eq(agents.kind, 'orchestrator')));
  return orchestrator;
}

async function operationsHead(ctx: Ctx, present: ReturnType<typeof and>) {
  const [head] = await ctx.db.select({ agent: agents }).from(agents).innerJoin(departments, eq(departments.id, agents.departmentId))
    .where(and(present, eq(departments.templateKey, 'operations'), eq(agents.kind, 'head')));
  return head?.agent;
}

/* Replayed evidence sends each case's state to its node again and pumps its queued notices, without creating another turn. */
export async function syncOperatorCases(ctx: Ctx, agentId: string, now = new Date()): Promise<void> {
  const rows = await ctx.db.select().from(programOperatorCases).where(eq(programOperatorCases.agentId, agentId));
  for (const row of rows) {
    const node = nodeIdentity(row.nodeId);
    if (ofProgram(row) && ctx.hub.hasProgramOperator(node)) {
      const mode = await operatorCaseMode(ctx, row);
      ctx.hub.send(node, { type: 'program.operator_case', agentKey: row.agentId, jobId: row.jobId, instance: row.instance, case: row.id, capability: row.capability, disposition: row.status === 'open' ? 'open' : 'revoke', remainingMs: Math.min(OPERATOR_CASE_MS, Math.max(0, +row.deadlineAt - +now)), revision: row.revision, reason: mode.reason, questionId: mode.questionId, readOnly: mode.readOnly, closedBecause: row.status !== 'open' ? row.resolution?.outcome : undefined });
    }
    await pumpCaseNotices(ctx, row);
  }
}

const caseNoticeIds = (row: Case): Array<string | null | undefined> => [
  row.operatorJobId, row.escalationJobId, row.continuationJobId,
  row.resolution?.holdCall?.job, ...Object.values(row.resolution?.holdNoticeJobs ?? {}),
];

async function pumpCaseNotices(ctx: Ctx, row: Case): Promise<void> {
  for (const id of caseNoticeIds(row)) {
    if (!id) continue;
    const [job] = await ctx.db.select(only(jobs, 'agentId')).from(jobs).where(eq(jobs.id, id));
    if (job?.agentId) await pump(ctx, job.agentId);
  }
}

export async function expireOperatorCases(ctx: Ctx, now = new Date()): Promise<void> {
  const due = await ctx.db.select({ id: programOperatorCases.id, agentId: programOperatorCases.agentId }).from(programOperatorCases).where(and(eq(programOperatorCases.status, 'open'), lte(programOperatorCases.deadlineAt, now)));
  for (const entry of due) {
    await operatorTransaction(ctx, async (tx, inside) => {
      await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, entry.agentId)).for('update');
      const [row] = await tx.select().from(programOperatorCases).where(and(eq(programOperatorCases.id, entry.id), eq(programOperatorCases.status, 'open'))).for('update');
      if (row && +row.deadlineAt <= +now) await escalateCase(inside, row, 'operator_timeout', now);
    });
    await syncOperatorCases(ctx, entry.agentId, now);
  }
}
