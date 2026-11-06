import { randomUUID } from 'node:crypto';
import { QuestionClassificationSnapshot, QuestionMutationGuard, QuestionRouteTarget, type QuestionClassificationInput, type SourceRef } from '@hornhoof/protocol';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, attachments, departments, requestInternal, requests, subscriptions, taskEvents, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { appendOutgoing } from '../events/store.js';
import { agentParty } from '../events/parties.js';
import { goesOnAfter, note, ownNote, published, taskSpot, type Request, type Task, type Tx, type Wake } from './engine.js';
import { recordCause } from './notification-cause.js';
import { keepWakes } from './outbox.js';
import { currentLeads, digestOf, internalRoute, operationConflict, questionAuthority, requireTriage, sourceClosed, staleRevision, staleRoute, type InternalRoute, type TriageCall } from './question-authority.js';
import { handOff } from './pulses.js';
import { endQuestionWait, syncQuestionWait } from './wait-producers.js';
import { endOpenSource, requestSourceKey } from './wait-state.js';

/* Every question of an agent starts inside the company: with its head, or the orchestrator. One row of requests keeps it from
   the first word to its end, with the words themselves in its private sidecar. A person sees it only once someone who may
   says it is for a person. */

export const routeUnavailable = () =>
  new ApiError(503, 'unavailable', 'internal_route_unavailable: Neither the head of this department nor the orchestrator can take a question now. Nothing was asked, so ask again when one is back.', 'internal_route_unavailable');

/* What the question is, without what the server fills in. */
type NewQuestion = Pick<typeof requests.$inferInsert, 'kind' | 'text'> & Partial<Pick<typeof requests.$inferInsert, 'commit' | 'options' | 'link' | 'decisionTopic' | 'approvalChannel' | 'approvalKind' | 'approvalAmount'>>;

export type Raise = {
  agentId: string;
  question: NewQuestion;
  /* explicit: an agent asks, and hears it when nobody can take it. silent: Hornhoof saw it stand still, and it is kept. */
  trigger: 'explicit' | 'silent';
  /* An episode that may be seen twice is named, so the second time adds nothing. */
  sourceKey?: string;
  sourceJobId?: string | null | undefined;
  plan?: WaitPlan | undefined;
};

export type Raised = { request: Request; route: InternalRoute | null; wakes: Wake[] };

/* The wake that makes whoever has the question look at it. It reads the question again when it runs. */
const questionWakes = (task: Pick<Task, 'id'>, asker: string, route: InternalRoute | null, requestId: string): Wake[] =>
  route && route.agentId !== asker ? [{ agentId: route.agentId, taskId: task.id, why: 'question', text: requestId }] : [];

/* In the write that moves the task. Returns null when this episode was raised before: it adds nothing, not even a notice. */
export async function raiseQuestion(tx: Tx, task: Task, raise: Raise): Promise<Raised | null> {
  const route = await internalRoute(tx, { companyId: task.companyId, departmentId: task.departmentId }, raise.agentId);
  if (!route && raise.trigger === 'explicit') throw routeUnavailable();
  const id = randomUUID();
  const [request] = await tx
    .insert(requests)
    .values({ ...raise.question, id, companyId: task.companyId, taskId: task.id, agentId: raise.agentId, audience: 'internal', sourceKey: raise.sourceKey ?? `task_request:${id}`, sourceJobId: raise.sourceJobId ?? null, triageAgentId: route?.agentId ?? null })
    .onConflictDoNothing({ target: [requests.companyId, requests.sourceKey] })
    .returning();
  if (!request) return null;
  await tx.insert(requestInternal).values({ requestId: id, companyId: task.companyId, technicalText: raise.question.text });
  await syncQuestionWait(tx, { taskId: task.id, requestId: id, expectedRevision: request.questionRevision, expectedRouteRevision: request.routeRevision, actor: { agentId: raise.agentId }, plan: raise.plan });
  const wakes = questionWakes(task, raise.agentId, route, id);
  await keepWakes(tx, task.companyId, wakes);
  return { request, route, wakes };
}

/* What the log says of a question inside; its words stay with those who may read them. */
export const ASKED_INSIDE = 'Asked inside the company.';

/* What a question shows those who see its task. Inside the company that is that it stands and nothing of what it says; before
   people, what whoever put it there wrote for them; what ended before questions started inside stays as it was. */
export function shownQuestion<R extends Pick<Request, 'audience' | 'text' | 'answer' | 'commit' | 'options' | 'link' | 'classification'>>(r: R): R {
  if (r.audience === 'internal') return { ...r, text: ASKED_INSIDE, answer: null, commit: null, options: [], link: null };
  const envelope = r.classification?.humanEnvelope;
  if (!envelope) return r;
  return { ...r, text: `${envelope.situation}\n\n${envelope.requiredAction}`, options: r.options.map((o, i) => ({ ...o, label: envelope.options[i]?.label ?? o.label })) };
}

/* What a screen is given besides: the plain words whole and what kind of thing it is, with no person, digest or source. */
export function humanView(r: Pick<Request, 'classification'>) {
  const snapshot = r.classification;
  if (!snapshot) return { envelope: null, purpose: null };
  const { purpose } = snapshot.authority;
  return { envelope: snapshot.humanEnvelope, purpose: purpose.kind === 'decision' ? { kind: purpose.kind, decisionKind: purpose.decisionKind } : purpose.kind === 'owner_login' ? { kind: purpose.kind, provider: purpose.provider } : { kind: purpose.kind } };
}

type Turn = { id: string; agentId: string; companyId: string };

/* The asker's own record of what it said and to whom. Asking itself, it says it to nobody. */
export async function recordInternalAsk(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, job: Turn, request: Pick<Request, 'triageAgentId'>, text: string): Promise<void> {
  if (!request.triageAgentId || request.triageAgentId === job.agentId) return;
  await appendOutgoing(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, text, to: await agentParty(ctx, job.companyId, request.triageAgentId) });
}

/* What the asker hears back. */
export async function askedWords(ctx: Pick<Ctx, 'db' | 'templates'>, job: { agentId: string; companyId: string }, request: Pick<Request, 'id' | 'triageAgentId'>, number: number): Promise<string> {
  if (request.triageAgentId === job.agentId) {
    return `This question (${request.id}) on #${number} is yours to settle, in this turn: settle it with resolve_question, or if only a person can take it now put it before them with classify_human_intent.`;
  }
  const who = request.triageAgentId ? (await agentParty(ctx, job.companyId, request.triageAgentId)).name : 'nobody yet';
  return `Asked ${who}. #${number} waits for the answer; you will be woken with it.`;
}

const Words = z.string().trim().min(1).max(4000);
export const ResolveInput = z.strictObject({ ...QuestionMutationGuard.shape, resolution: Words, executorInstruction: Words.optional() });
export type ResolveInput = z.infer<typeof ResolveInput>;
export const RouteInput = z.strictObject({ ...QuestionMutationGuard.shape, target: QuestionRouteTarget });
export type RouteInput = z.infer<typeof RouteInput>;

type Guard = z.infer<typeof QuestionMutationGuard>;
export type QuestionResult = { source: SourceRef; status: Request['status']; audience: Request['audience']; revision: number; routeRevision: number; classificationId?: string; digest?: string };
export type Settled = { result: QuestionResult; wakes: Wake[] };

const noSuchSource = () => new ApiError(404, 'not_found', 'There is no such question.', 'request_unknown');

const resultOf = (r: Request): QuestionResult => ({
  source: { kind: 'task_request', id: r.id }, status: r.status, audience: r.audience, revision: r.questionRevision, routeRevision: r.routeRevision,
  ...(r.classification ? { classificationId: r.classification.classificationId, digest: r.classification.digest } : {}),
});

/* The task and then its question, as a cancel takes them, and who is acting, all as they are now. */
async function heldQuestion(tx: Tx, call: TriageCall, guard: Guard, may: 'resolve' | 'classify'): Promise<{ task: Task; request: Request }> {
  const [found] = await tx.select({ taskId: requests.taskId }).from(requests).where(and(eq(requests.id, guard.source.id), eq(requests.companyId, call.companyId)));
  if (guard.source.kind !== 'task_request' || !found) throw noSuchSource();
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, found.taskId)).for('update');
  const [request] = await tx.select().from(requests).where(eq(requests.id, guard.source.id)).for('update');
  await requireTriage(tx, call, { companyId: task!.companyId, departmentId: task!.departmentId, triageAgentId: request!.triageAgentId }, may);
  return { task: task!, request: request! };
}

/* The same operation again is what it was the first time; the same id with other words is refused. */
/* Key order is part of what a retry returned: the stored row is JSONB, which keeps its own. */
const inOrder = ({ source, status, audience, revision, routeRevision, classificationId, digest }: QuestionResult): QuestionResult => ({
  source: { kind: source.kind, id: source.id }, status, audience, revision, routeRevision, ...(classificationId ? { classificationId } : {}), ...(digest ? { digest } : {}),
});

async function alreadyDone(tx: Tx, taskId: string, guard: Guard, inputDigest: string): Promise<QuestionResult | null> {
  const [done] = await tx.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, taskId), sql`${taskEvents.data}->'question'->>'operationId' = ${guard.operationId}`)).limit(1);
  if (!done) return null;
  const kept = done.data.question as { inputDigest: string; result: QuestionResult };
  if (kept.inputDigest !== inputDigest) throw operationConflict();
  return inOrder(kept.result);
}

function stillAsRead(request: Request, guard: Guard): void {
  if (request.status !== 'open') throw sourceClosed();
  if (request.questionRevision !== guard.expectedRevision) throw staleRevision();
  if (request.routeRevision !== guard.expectedRouteRevision || request.audience !== 'internal') throw staleRoute();
}

const questionGuard = (task: Task, request: Request, agentId: string) => ({ taskId: task.id, requestId: request.id, expectedRevision: request.questionRevision, expectedRouteRevision: request.routeRevision, actor: { agentId } });

const audited = (transition: string, guard: Guard, inputDigest: string, result: QuestionResult) => ({ question: { transition, operationId: guard.operationId, inputDigest, result } });

/* Whoever has the question settles it: the real one is kept beside it, never as a person who answered, and it approves or grants
   nothing. What it says goes to whoever goes on with the task, and to nobody else. */
export async function answerInternal(ctx: Ctx, call: TriageCall, input: ResolveInput): Promise<Settled> {
  const inputDigest = digestOf(input);
  const moved = await ctx.db.transaction(async (tx): Promise<Settled & { task: Task | null }> => {
    const { task, request } = await heldQuestion(tx, call, input, 'resolve');
    const again = await alreadyDone(tx, task.id, input, inputDigest);
    if (again) return { result: again, wakes: [], task: null };
    stillAsRead(request, input);
    await endQuestionWait(tx, { ...questionGuard(task, request, call.agentId), outcome: 'resolved', proofRef: `question:${request.id}:resolved` });
    const [closed] = await tx.update(requests).set({ status: 'resolved_internal', answer: input.resolution }).where(and(eq(requests.id, request.id), eq(requests.status, 'open'))).returning();
    await tx.update(requestInternal).set({ resolvedByAgentId: call.agentId, resolvedByJobId: call.jobId, resolvedAt: new Date(), executorInstruction: input.executorInstruction ?? null, recoveryIntent: null }).where(eq(requestInternal.requestId, request.id));
    const result = resultOf(closed!);
    const event = await note(tx, task, { kind: 'answered', actor: { agentId: call.agentId }, text: 'Settled inside the company.', data: { requestId: request.id, kind: request.kind, status: 'resolved_internal', ...audited('resolved', input, inputDigest, result) } });
    const said = input.executorInstruction ? `${input.resolution}\n\nHow: ${input.executorInstruction}` : input.resolution;
    const wakes = await goesOnAfter(tx, task, request, task, { why: 'resolved', text: said });
    recordCause(wakes, { kind: 'answered', actor: { agentId: call.agentId }, text: 'Settled inside the company.', data: { status: 'resolved_internal' } }, event.id, task);
    await keepWakes(tx, task.companyId, wakes);
    return { result, wakes, task };
  });
  if (moved.task) await afterMove(ctx, moved.task, call.agentId);
  return { result: moved.result, wakes: moved.wakes };
}

async function afterMove(ctx: Ctx, task: Task, agentId: string): Promise<void> {
  const [now] = await ctx.db.select().from(tasks).where(eq(tasks.id, task.id));
  published(ctx, now!);
  await handOff(ctx, { agentId }, now!);
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
}

/* Who is on call in Operations: its head, or else the first of its people who is there. */
async function operationsAgent(tx: Tx, companyId: string): Promise<string | null> {
  const here = await tx.select({ id: agents.id, kind: agents.kind }).from(agents).innerJoin(departments, eq(departments.id, agents.departmentId))
    .where(and(eq(agents.companyId, companyId), eq(departments.templateKey, 'operations'), sql`${agents.removedAt} is null`)).orderBy(agents.createdAt);
  return (here.find(a => a.kind === 'head') ?? here[0])?.id ?? null;
}

async function routeTarget(tx: Tx, task: Task, target: RouteInput['target']): Promise<string | null> {
  if (target === 'operations') return operationsAgent(tx, task.companyId);
  return (await currentLeads(tx, { companyId: task.companyId, departmentId: task.departmentId }))[target];
}

/* It goes to someone else inside the company: a new revision of its route, so that what was read before no longer acts on it. Being
   handed work gives Operations the work, and no right to put it before a person. */
export async function routeInternal(ctx: Ctx, call: TriageCall, input: RouteInput): Promise<Settled> {
  const inputDigest = digestOf(input);
  return ctx.db.transaction(async tx => {
    const { task, request } = await heldQuestion(tx, call, input, 'resolve');
    const again = await alreadyDone(tx, task.id, input, inputDigest);
    if (again) return { result: again, wakes: [] };
    stillAsRead(request, input);
    const to = await routeTarget(tx, task, input.target);
    if (!to) throw new ApiError(503, 'unavailable', `internal_route_unavailable: Nobody of ${input.target} can take this now.`, 'internal_route_unavailable');
    const [moved] = await tx.update(requests).set({ triageAgentId: to, routeRevision: request.routeRevision + 1 }).where(eq(requests.id, request.id)).returning();
    await syncQuestionWait(tx, questionGuard(task, moved!, call.agentId));
    const result = resultOf(moved!);
    await note(tx, task, { kind: 'asked', actor: { agentId: call.agentId }, text: 'Handed on inside the company.', data: audited('routed', input, inputDigest, result) });
    const wakes = questionWakes(task, call.agentId, { target: 'head', agentId: to }, request.id);
    await keepWakes(tx, task.companyId, wakes);
    return { result, wakes };
  });
}

/* Exactly what a person is shown of the work, as bytes: a later change is another decision. */
async function materialStamp(tx: Tx, request: Request): Promise<{ materialRevision: number; materialDigest: string }> {
  if (request.materialRevision !== null && request.materialDigest !== null) return { materialRevision: request.materialRevision, materialDigest: request.materialDigest };
  const files = await tx.select({ id: attachments.id, sha256: sql<string>`encode(sha256(${attachments.bytes}), 'hex')` }).from(attachments).where(eq(attachments.requestId, request.id)).orderBy(attachments.id);
  return { materialRevision: 1, materialDigest: digestOf({ commit: request.commit, link: request.link, options: request.options, files }) };
}

/* What a department's approval is of, as the server keeps it: the digest a caller names has to be of this and nothing else. */
export const approvalDigest = (r: Pick<Request, 'id' | 'taskId' | 'text' | 'link' | 'approvalChannel' | 'approvalKind' | 'approvalAmount'>): string =>
  digestOf({ request: r.id, task: r.taskId, channel: r.approvalChannel, kind: r.approvalKind, amount: r.approvalAmount, text: r.text, link: r.link });

const notThisResult = (what: string) => new ApiError(400, 'validation', `${what} Name exactly what this question shows.`, 'task_invalid');

const asksToApprove = (request: Request, sha: string): boolean => request.kind === 'approval' && request.commit === sha;

const asksThePolicy = (request: Request, digest: string): boolean => request.kind === 'approval' && request.approvalChannel !== null && digest === approvalDigest(request);

async function showsThePictures(tx: Tx, request: Request, imageIds: readonly string[]): Promise<boolean> {
  const shown = await tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.requestId, request.id));
  return shown.length === imageIds.length && shown.every(f => imageIds.includes(f.id));
}

type ReadyResult = Extract<QuestionClassificationInput['classification'], { kind: 'ready_result' }>['artifact'];

/* What is wrong with naming this as what the question shows, if anything. */
async function notWhatItShows(tx: Tx, request: Request, artifact: ReadyResult): Promise<string | null> {
  if (artifact.kind === 'commit') return asksToApprove(request, artifact.sha) ? null : 'This question does not ask to approve that commit.';
  if (artifact.kind === 'policy') return asksThePolicy(request, artifact.digest) ? null : 'This is not the approval this question asks for.';
  if (artifact.kind === 'design') return (await showsThePictures(tx, request, artifact.imageIds)) ? null : 'These are not the pictures this question shows.';
  return 'A card of the orchestrator is not a question on a task.';
}

/* A ready result is the exact thing the question shows, and not something like it. */
async function requireTheResult(tx: Tx, request: Request, classification: QuestionClassificationInput['classification']): Promise<void> {
  if (classification.kind !== 'ready_result') return;
  const wrong = await notWhatItShows(tx, request, classification.artifact);
  if (wrong) throw notThisResult(wrong);
}

const offerMismatch = () => new ApiError(400, 'validation', 'A choice is put before a person with its ways, each one once, in their order.', 'task_invalid');

/* The one way a question of an agent comes before a person: someone who may says it is a ready result or what only a person can do,
   and everything it rests on is written down with it. It approves, pays and grants nothing by itself. */
export async function classifyInternal(ctx: Ctx, call: TriageCall, input: QuestionClassificationInput): Promise<Settled> {
  const inputDigest = digestOf(input);
  const moved = await ctx.db.transaction(async (tx): Promise<Settled & { task: Task | null }> => {
    const { task, request } = await heldQuestion(tx, call, input, 'classify');
    const again = await alreadyDone(tx, task.id, input, inputDigest);
    if (again) return { result: again, wakes: [], task: null };
    stillAsRead(request, input);
    if (request.kind === 'choice' && input.humanEnvelope.options.length !== request.options.length) throw offerMismatch();
    await requireTheResult(tx, request, input.classification);
    const authority = await questionAuthority(tx, task, request, input.classification);
    const stamp = input.classification.kind === 'ready_result' ? await materialStamp(tx, request) : { materialRevision: request.materialRevision, materialDigest: request.materialDigest };
    const sealed = {
      source: input.source, revision: request.questionRevision, routeRevision: request.routeRevision,
      sourceBinding: { companyId: task.companyId, authorAgentId: request.agentId, sourceJobId: request.sourceJobId, sourceSequence: request.sourceSequence, taskAssignment: { taskId: task.id, taskVersion: task.version, assigneeAgentId: task.assigneeAgentId, executorAgentId: task.executorAgentId, stage: task.stage } },
      classification: input.classification, humanEnvelope: input.humanEnvelope, authority, ...stamp,
    };
    const classification = QuestionClassificationSnapshot.parse({ ...sealed, classificationId: randomUUID(), digest: digestOf(sealed) });
    const [promoted] = await tx.update(requests).set({ audience: 'human', classification }).where(and(eq(requests.id, request.id), eq(requests.status, 'open'), eq(requests.audience, 'internal'))).returning();
    await syncQuestionWait(tx, questionGuard(task, promoted!, call.agentId));
    const result = resultOf(promoted!);
    await note(tx, task, { kind: 'asked', actor: { agentId: call.agentId }, text: 'Put before a person.', data: { requestId: request.id, classification: input.classification.kind, ...audited('classified', input, inputDigest, result) } });
    return { result, wakes: [], task };
  });
  if (moved.task) ctx.bus.publish(moved.task.companyId, { type: 'requests', spot: taskSpot(moved.task) });
  return { result: moved.result, wakes: moved.wakes };
}

type Sealed = NonNullable<Request['classification']>;

const sameRevisions = (request: Request, snapshot: Sealed): boolean => snapshot.revision === request.questionRevision && snapshot.routeRevision === request.routeRevision;

const sameHolder = (task: Task, snapshot: Sealed): boolean => {
  const was = snapshot.sourceBinding.taskAssignment;
  return was?.assigneeAgentId === task.assigneeAgentId && was?.executorAgentId === task.executorAgentId && was?.stage === task.stage;
};

/* What the authority comes to now, or nothing if there is no longer anyone who could take it. */
const authorityNow = (tx: Tx, task: Task, request: Request, snapshot: Sealed): Promise<string | null> =>
  questionAuthority(tx, task, request, snapshot.classification).then(a => a.authorityDigest, (err: unknown) => {
    if (err instanceof ApiError) return null;
    throw err;
  });

/* Whether what a person was shown is still what it rested on: the same source, the same hands on the task, the same people to take
   it and the same work. */
export async function staleClassification(tx: Tx, task: Task, request: Request): Promise<boolean> {
  const snapshot = request.classification;
  if (!snapshot) return false;
  if (!sameRevisions(request, snapshot) || !sameHolder(task, snapshot)) return true;
  if ((await authorityNow(tx, task, request, snapshot)) !== snapshot.authority.authorityDigest) return true;
  return snapshot.classification.kind === 'ready_result' && (await materialStamp(tx, request)).materialDigest !== snapshot.materialDigest;
}

/* A person cannot take what changed under it. It goes back to whoever has questions there now, kept and told; nothing of what they
   were shown decides anything. Its record of what it was stays in the log. */
export async function refuseWhatChanged(ctx: Pick<Ctx, 'db' | 'bus'>, requestId: string): Promise<void> {
  const task = await ctx.db.transaction(async (tx): Promise<Task | null> => {
    const [found] = await tx.select({ taskId: requests.taskId }).from(requests).where(eq(requests.id, requestId));
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, found!.taskId)).for('update');
    const [request] = await tx.select().from(requests).where(eq(requests.id, requestId)).for('update');
    if (request!.status !== 'open' || !(await staleClassification(tx, task!, request!))) return null;
    const route = await internalRoute(tx, { companyId: task!.companyId, departmentId: task!.departmentId }, request!.agentId);
    const [back] = await tx.update(requests).set({ audience: 'internal', classification: null, routeRevision: request!.routeRevision + 1, triageAgentId: route?.agentId ?? null }).where(eq(requests.id, requestId)).returning();
    await syncQuestionWait(tx, questionGuard(task!, back!, request!.agentId));
    await note(tx, task!, { kind: 'asked', actor: { agentId: request!.agentId }, text: 'Back inside the company: what it rested on changed.', data: { question: { transition: 'back_inside', classificationId: request!.classification!.classificationId, digest: request!.classification!.digest, routeRevision: back!.routeRevision } } });
    await keepWakes(tx, task!.companyId, questionWakes(task!, request!.agentId, route, requestId));
    return task!;
  });
  if (!task) return;
  ctx.bus.publish(task.companyId, { type: 'requests', spot: taskSpot(task) });
  throw staleRoute();
}

/* Whether whoever has it can still look at it: still here, and if a head then of this place or of the Operations it was handed to. */
async function stillHeld(tx: Tx, task: Task, request: Request): Promise<boolean> {
  if (!request.triageAgentId) return false;
  const [who] = await tx.select({ kind: agents.kind, removedAt: agents.removedAt, switchedOffAt: agents.switchedOffAt, planGone: subscriptions.removedAt, template: departments.templateKey }).from(agents)
    .leftJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).leftJoin(departments, eq(departments.id, agents.departmentId))
    .where(eq(agents.id, request.triageAgentId));
  if (!who || who.removedAt || who.switchedOffAt || who.planGone) return false;
  if (who.kind !== 'head' || who.template === 'operations') return true;
  return (await currentLeads(tx, { companyId: task.companyId, departmentId: task.departmentId })).head === request.triageAgentId;
}

/* A question nobody can look at now goes to who can, under a new revision: one kept from when nobody could, one whose head has gone,
   and one from before questions started inside, whose old wait on a person ends here. Nothing happens until there is someone. */
export async function claimQuestion(ctx: Pick<Ctx, 'db'>, id: string): Promise<Wake[]> {
  return ctx.db.transaction(async tx => {
    const [found] = await tx.select({ taskId: requests.taskId }).from(requests).where(eq(requests.id, id));
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, found!.taskId)).for('update');
    const [request] = await tx.select().from(requests).where(eq(requests.id, id)).for('update');
    if (request!.status !== 'open' || request!.audience !== 'internal' || await stillHeld(tx, task!, request!)) return [];
    const route = await internalRoute(tx, { companyId: task!.companyId, departmentId: task!.departmentId }, request!.agentId);
    if (!route) return [];
    const [moved] = await tx.update(requests).set({ triageAgentId: route.agentId, routeRevision: request!.routeRevision + 1 }).where(eq(requests.id, id)).returning();
    const actor = { agentId: route.agentId };
    await endOpenSource(tx, { taskId: task!.id, kind: 'person', sourceKey: requestSourceKey(id), outcome: 'superseded', proofRef: `question:${id}:route:${moved!.routeRevision}`, actor });
    await syncQuestionWait(tx, questionGuard(task!, moved!, route.agentId));
    if (task!.status === 'open' || task!.status === 'working') await tx.update(tasks).set({ status: 'waiting', version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, task!.id));
    await ownNote(tx, task!, { kind: 'asked', text: 'Now with someone who can look at it.', data: { question: { transition: 'claimed', routeRevision: moved!.routeRevision } } });
    const wakes = questionWakes(task!, request!.agentId, route, id);
    await keepWakes(tx, task!.companyId, wakes);
    return wakes;
  });
}
