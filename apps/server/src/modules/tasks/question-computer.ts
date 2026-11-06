import { randomUUID } from 'node:crypto';
import { QuestionClassificationSnapshot, type QuestionClassificationInput } from '@hornhoof/protocol';
import { and, eq, lt, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { agentEvents, agents, companies, computerAccessIntents } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { ACCESS_MS, onMachine, serverMachine, type Asked } from '../computer/access.js';
import { enqueueTurn, orchestratorState, orchestratorOf as liveOrchestrator } from '../conversation/queue.js';
import { notificationMessage } from '../events/notifications.js';
import { personParty } from '../events/parties.js';
import { appendOutgoing, hideCodes, publishEvent } from '../events/store.js';
import { builtinMachine } from '../nodes/nodes.js';
import type { ToolJob } from '../tools/job.js';
import { decisionPerson } from './decisions.js';
import type { Tx } from './engine.js';
import { computerAuthority, digestOf, notAllowed, requireTriage, sourceClosed, staleRevision, staleRoute, type TriageCall } from './question-authority.js';
import { audited, humanView, noSuchSource, type QuestionResult, type ResolveInput, type Settled } from './question-lifecycle.js';
import { doneBefore } from './question-proposals.js';

/* The orchestrator asking for the computer is a question like any other: it starts inside the company, and only the CEO's own click
   opens anything. The click and the control file cannot share a transaction, so what it will do is written down first, carried out
   against the file, and read back; what a crash leaves is settled from the file, never carried out again. */

export type Intent = typeof computerAccessIntents.$inferSelect;
type Guard = Pick<ResolveInput, 'operationId' | 'source' | 'expectedRevision' | 'expectedRouteRevision'>;

/* What a crash may have left is looked at only after this, so that an operation just written down is not taken for one. */
const SETTLES_AFTER_MS = 60_000;

const stillGoing = (companyId: string) => and(eq(computerAccessIntents.companyId, companyId), eq(computerAccessIntents.status, 'open'));

export async function raiseComputerIntent(ctx: Ctx, job: Pick<ToolJob, 'id' | 'agentId' | 'companyId'>, reason: string): Promise<Intent> {
  const id = randomUUID();
  const intent = await ctx.db.transaction(async tx => {
    await tx.update(computerAccessIntents).set({ status: 'withdrawn', updatedAt: new Date() }).where(stillGoing(job.companyId));
    const [row] = await tx.insert(computerAccessIntents).values({ id, companyId: job.companyId, agentId: job.agentId, technicalText: reason, audience: 'internal', triageAgentId: job.agentId, sourceJobId: job.id, sourceKey: `computer_access:${id}` }).returning();
    return row!;
  });
  ctx.bus.publish(job.companyId, { type: 'computer' });
  ctx.bus.publish(job.companyId, { type: 'requests', spot: { departmentId: null } });
  return intent;
}

export const intentKept = (intent: Pick<Intent, 'id'>): string =>
  'Kept inside the company, and nobody has seen it yet. Only if nothing but the computer itself will do, put it before the CEO with classify_human_intent: this request as source (kind computer_access), expectedRevision 1, ' +
  `expectedRouteRevision 1, classification kind human_only_action with actionBinding kind ceo_permission and resourceId server, and humanEnvelope in plain words with no commands. It opens nothing by itself; you get a note when the CEO opens it. Until then go on with other work or end your turn. ${JSON.stringify({ id: intent.id })}`;

const resultOf = (i: Intent): QuestionResult => ({
  source: { kind: 'computer_access', id: i.id }, status: i.status, audience: i.audience, revision: i.questionRevision, routeRevision: i.routeRevision,
  ...(i.classification ? { classificationId: i.classification.classificationId, digest: i.classification.digest } : {}),
});

async function heldIntent(tx: Tx, call: TriageCall, guard: Guard, may: 'resolve' | 'classify'): Promise<Intent> {
  const [intent] = await tx.select().from(computerAccessIntents).where(and(eq(computerAccessIntents.id, guard.source.id), eq(computerAccessIntents.companyId, call.companyId))).for('update');
  if (!intent) throw noSuchSource();
  await requireTriage(tx, call, { companyId: call.companyId, departmentId: null, triageAgentId: intent.triageAgentId }, may);
  return intent;
}

function stillAsRead(intent: Intent, guard: Guard): void {
  if (intent.status !== 'open') throw sourceClosed();
  if (intent.questionRevision !== guard.expectedRevision) throw staleRevision();
  if (intent.routeRevision !== guard.expectedRouteRevision || intent.audience !== 'internal') throw staleRoute();
}

const notThisAction = () => new ApiError(400, 'validation', 'Access to the computer is put before a person as what only they can do: human_only_action, actionBinding kind ceo_permission, resourceId server.', 'task_invalid');

function requireTheAction(classification: QuestionClassificationInput['classification']): void {
  if (classification.kind !== 'human_only_action' || classification.actionBinding.kind !== 'ceo_permission' || classification.actionBinding.resourceId !== 'server') throw notThisAction();
}

const inWords = (i: Pick<Intent, 'classification'>): string => i.classification!.humanEnvelope.situation;

/* Puts it before the people who can open the computer, for a date fixed now: what they read is exactly what they would grant. */
export async function classifyComputerIntent(ctx: Ctx, call: TriageCall, input: QuestionClassificationInput): Promise<Settled> {
  const inputDigest = digestOf(input);
  const machine = await serverMachine(ctx, call.companyId);
  const done = await ctx.db.transaction(async tx => {
    const intent = await heldIntent(tx, call, input, 'classify');
    const again = await doneBefore(tx, call.companyId, input, inputDigest);
    if (again) return { result: again, intent: null };
    stillAsRead(intent, input);
    requireTheAction(input.classification);
    const hosted = await builtinMachine(tx as unknown as Ctx['db'], ctx.config.hostId, call.companyId);
    const until = new Date(Math.floor((Date.now() + ACCESS_MS) / 1000) * 1000).toISOString();
    const sealed = {
      source: input.source, revision: intent.questionRevision, routeRevision: intent.routeRevision,
      sourceBinding: { companyId: intent.companyId, authorAgentId: intent.agentId, sourceJobId: intent.sourceJobId, sourceSequence: intent.sourceSequence, taskAssignment: null },
      classification: input.classification, humanEnvelope: input.humanEnvelope, authority: await computerAuthority(tx, intent.companyId, hosted?.id ?? null, until), materialRevision: null, materialDigest: null,
    };
    const classification = QuestionClassificationSnapshot.parse({ ...sealed, classificationId: randomUUID(), digest: digestOf(sealed) });
    const [promoted] = await tx.update(computerAccessIntents).set({ audience: 'human', classification, updatedAt: new Date() }).where(eq(computerAccessIntents.id, intent.id)).returning();
    const result = resultOf(promoted!);
    const [event] = await tx.insert(agentEvents).values({ companyId: intent.companyId, agentId: intent.agentId, jobId: call.jobId, kind: 'computer', data: hideCodes({ state: 'asked', reason: inWords(promoted!), ...onMachine(machine), ...audited('classified', input, inputDigest, result) }), personId: null }).returning({ id: agentEvents.id });
    return { result, intent: promoted!, eventId: event!.id };
  });
  if (done.intent) {
    await publishEvent(ctx, done.intent.companyId, done.intent.agentId, done.eventId!);
    ctx.bus.publish(call.companyId, { type: 'computer' });
    ctx.bus.publish(call.companyId, { type: 'requests', spot: { departmentId: null } });
    const personId = await decisionPerson(ctx, call.companyId, { source: 'computer_access' });
    await appendOutgoing(ctx, { companyId: call.companyId, agentId: done.intent.agentId, jobId: call.jobId, text: inWords(done.intent), to: await personParty(ctx, call.companyId, personId) });
  }
  return { result: done.result, wakes: [] };
}

/* Settled inside, with the one who did it kept: it opens nothing and answers for no person. */
export async function resolveComputerIntent(ctx: Ctx, call: TriageCall, input: ResolveInput): Promise<Settled> {
  const inputDigest = digestOf(input);
  const done = await ctx.db.transaction(async tx => {
    const intent = await heldIntent(tx, call, input, 'resolve');
    const again = await doneBefore(tx, call.companyId, input, inputDigest);
    if (again) return { result: again, intent: null };
    stillAsRead(intent, input);
    const [closed] = await tx.update(computerAccessIntents).set({ status: 'resolved_internal', resolvedByAgentId: call.agentId, resolvedByJobId: call.jobId, resolvedAt: new Date(), updatedAt: new Date() }).where(eq(computerAccessIntents.id, intent.id)).returning();
    const result = resultOf(closed!);
    await tx.insert(agentEvents).values({ companyId: intent.companyId, agentId: intent.agentId, jobId: call.jobId, kind: 'applied', data: hideCodes({ proposalId: null, ...audited('resolved', input, inputDigest, result) }), personId: null });
    return { result, intent: closed! };
  });
  if (done.intent) ctx.bus.publish(call.companyId, { type: 'computer' });
  return { result: done.result, wakes: [] };
}

/* What people read: only what was put before them, and only in the words it was put in. */
export async function computerAsked(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<(Asked & ReturnType<typeof humanView>) | null> {
  const [intent] = await ctx.db.select().from(computerAccessIntents).where(and(stillGoing(companyId), eq(computerAccessIntents.audience, 'human')));
  return intent ? { reason: inWords(intent), at: intent.createdAt.toISOString(), ...humanView(intent) } : null;
}

export async function internalIntents(ctx: Pick<Ctx, 'db'>, job: Pick<ToolJob, 'companyId' | 'agentKind'>) {
  if (job.agentKind !== 'orchestrator') return [];
  const rows = await ctx.db.select().from(computerAccessIntents).where(and(stillGoing(job.companyId), eq(computerAccessIntents.audience, 'internal')));
  return rows.map(i => ({ source: { kind: 'computer_access' as const, id: i.id }, text: i.technicalText, revision: i.questionRevision, routeRevision: i.routeRevision, at: i.createdAt.toISOString() }));
}

const orchestratorIdOf = async (tx: Tx, companyId: string): Promise<string | null> =>
  (await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'))))[0]?.id ?? null;

export async function staleIntent(tx: Tx, intent: Intent, now = Date.now()): Promise<boolean> {
  const snapshot = intent.classification!;
  const purpose = snapshot.authority.purpose;
  if (purpose.kind !== 'ceo_permission' || snapshot.revision !== intent.questionRevision || snapshot.routeRevision !== intent.routeRevision || Date.parse(purpose.until) <= now) return true;
  const current = await computerAuthority(tx, intent.companyId, purpose.machineId, purpose.until).catch((err: unknown) => {
    if (err instanceof ApiError) return null;
    throw err;
  });
  return current?.authorityDigest !== snapshot.authority.authorityDigest;
}

async function tellOrchestrator(ctx: Ctx, companyId: string, text: string): Promise<void> {
  const orchestrator = await liveOrchestrator(ctx, companyId);
  if (!orchestrator || !(await orchestratorState(ctx, companyId)).ready) return;
  const message = await notificationMessage(ctx, companyId, 'question', text);
  await enqueueTurn(ctx, { companyId, agentId: orchestrator.id, prompt: message.text, createdBy: null, message });
}

const notApplied = () => new ApiError(409, 'conflict', 'Access was changed meanwhile, so nothing was opened. Look at it again.', 'stale_route');

/* The answer to what is before the person, when there is one: written down, carried out against the file and read back, in that
   order. Null when nothing is before them, and their click is then their own. */
export async function grantComputerIntent(ctx: Ctx, me: Person): Promise<{ until: string; reason: string } | null> {
  const fence = ctx.computer.control().revision;
  const sealed = await ctx.db.transaction(async tx => {
    const [intent] = await tx.select().from(computerAccessIntents).where(and(stillGoing(me.companyId), eq(computerAccessIntents.audience, 'human'))).for('update');
    if (!intent) return null;
    if (await staleIntent(tx, intent)) {
      const [back] = await tx.update(computerAccessIntents).set({ audience: 'internal', classification: null, routeRevision: intent.routeRevision + 1, triageAgentId: await orchestratorIdOf(tx, me.companyId), updatedAt: new Date() }).where(eq(computerAccessIntents.id, intent.id)).returning();
      return { back: back! };
    }
    if (!intent.classification!.authority.recipientPersonIds.includes(me.id)) throw notAllowed();
    const purpose = intent.classification!.authority.purpose as { until: string };
    const [row] = await tx.update(computerAccessIntents).set({ status: 'apply_unknown', applyOperationId: randomUUID(), applyRevision: intent.questionRevision, applyRouteRevision: intent.routeRevision, applyControlRevision: fence, applyTargetUntil: new Date(purpose.until), updatedAt: new Date() }).where(eq(computerAccessIntents.id, intent.id)).returning();
    return { reserved: row! };
  });
  if (!sealed) return null;
  if ('back' in sealed) {
    ctx.bus.publish(me.companyId, { type: 'computer' });
    await tellOrchestrator(ctx, me.companyId, 'Your request for the computer went back inside the company: who may open it, or the date it named, changed. Read it with internal_questions and put it before them again if it still stands.');
    throw staleRoute();
  }
  const { reserved } = sealed;
  const op = { operationId: reserved.applyOperationId!, fence, until: reserved.applyTargetUntil! };
  const applied = ctx.computer.applyGrant(op) === 'applied' && ctx.computer.readBack(op.operationId, op.until);
  await ctx.db.update(computerAccessIntents).set(applied ? { status: 'granted', appliedAt: new Date(), updatedAt: new Date() } : { status: 'withdrawn', updatedAt: new Date() }).where(and(eq(computerAccessIntents.id, reserved.id), eq(computerAccessIntents.status, 'apply_unknown')));
  if (!applied) throw notApplied();
  return { until: op.until.toISOString(), reason: reserved.technicalText };
}

/* Says no to what is before them; false when nothing is. The person who did is on the line in the window. */
export async function declineComputerIntent(ctx: Pick<Ctx, 'db'>, me: Pick<Person, 'companyId'>): Promise<boolean> {
  const closed = await ctx.db.update(computerAccessIntents).set({ status: 'declined', updatedAt: new Date() }).where(and(stillGoing(me.companyId), eq(computerAccessIntents.audience, 'human'))).returning({ id: computerAccessIntents.id });
  return closed.length > 0;
}

/* What a crash left between writing an operation down and hearing of it: the file says what happened, and nothing is carried out again
   or extended, and nobody goes on. */
export async function settleComputerIntents(ctx: Ctx): Promise<void> {
  const left = await ctx.db.select().from(computerAccessIntents).where(and(eq(computerAccessIntents.status, 'apply_unknown'), lt(computerAccessIntents.updatedAt, new Date(Date.now() - SETTLES_AFTER_MS))));
  for (const intent of left) {
    const applied = ctx.computer.readBack(intent.applyOperationId!, intent.applyTargetUntil!);
    await ctx.db.update(computerAccessIntents).set(applied ? { status: 'granted', appliedAt: new Date(), updatedAt: new Date() } : { status: 'withdrawn', updatedAt: new Date() }).where(and(eq(computerAccessIntents.id, intent.id), inArray(computerAccessIntents.status, ['apply_unknown'])));
    ctx.bus.publish(intent.companyId, { type: 'computer' });
  }
}

/* A request kept in the control file from before goes inside once. It opens nothing, and people no longer read it from there. */
export async function importAskedFromFile(ctx: Ctx): Promise<void> {
  const { asked } = ctx.computer.view();
  if (!asked) return;
  const here = await ctx.db.select({ id: companies.id }).from(companies).limit(2);
  if (here.length !== 1) return;
  const companyId = here[0]!.id;
  const orchestrator = await liveOrchestrator(ctx, companyId);
  if (!orchestrator) return;
  const [kept] = await ctx.db.insert(computerAccessIntents).values({ companyId, agentId: orchestrator.id, technicalText: asked.reason, audience: 'internal', triageAgentId: orchestrator.id, sourceKey: `legacy:computer_access:${asked.at}` }).onConflictDoNothing().returning({ id: computerAccessIntents.id });
  ctx.computer.clearAsked();
  if (kept) await tellOrchestrator(ctx, companyId, `Your request for the computer from before is still inside the company: ${kept.id}. Read it with internal_questions, and put it before the CEO if it still stands, or put it aside with resolve_question.`);
}

