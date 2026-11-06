import { randomUUID } from 'node:crypto';
import { QuestionClassificationSnapshot, type QuestionClassificationInput } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, proposals } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { notificationMessage } from '../events/notifications.js';
import { hideCodes, publishEvent } from '../events/store.js';
import { enqueueTurn, orchestratorOf as liveOrchestrator, orchestratorState } from '../conversation/queue.js';
import type { ToolJob } from '../tools/job.js';
import { type Tx } from './engine.js';
import { cardAuthority, classificationRequired, digestOf, operationConflict, requireTriage, sourceClosed, staleRevision, staleRoute, type TriageCall } from './question-authority.js';
import { audited, noSuchSource, type QuestionResult, type ResolveInput, type Settled } from './question-lifecycle.js';

/* A card of the orchestrator is a question like any other: it starts inside the company and comes before a person only once it is
   said to be ready, in the turn that made it. It has no task, so what is done to it is kept in the orchestrator's events. */

export type Card = typeof proposals.$inferSelect;
type Guard = Pick<ResolveInput, 'operationId' | 'source' | 'expectedRevision' | 'expectedRouteRevision'>;

export const cardDigest = (c: Pick<Card, 'kind' | 'departmentId' | 'brief' | 'items'>): string => digestOf({ kind: c.kind, departmentId: c.departmentId, brief: c.brief, items: c.items });

/* What a new card starts with. */
export function newCard(job: Pick<ToolJob, 'id' | 'agentId'>) {
  const id = randomUUID();
  return { id, audience: 'internal' as const, triageAgentId: job.agentId, sourceJobId: job.id, sourceKey: `proposal:${id}` };
}

/* What the orchestrator hears, with what it takes to go on in the same turn. */
export function cardKept(card: Pick<Card, 'id' | 'kind' | 'departmentId' | 'brief' | 'items'>): string {
  const told = { id: card.id, kind: card.kind, digest: cardDigest(card) };
  return 'Kept inside the company, and nobody has seen it yet. When it is ready for the person who decides, call classify_human_intent with this card as source (kind proposal), expectedRevision 1, ' +
    `expectedRouteRevision 1, classification kind ready_result with artifact kind ${card.kind} and this digest, and humanEnvelope in plain words. A newer card replaces it. ${JSON.stringify(told)}`;
}

const resultOf = (c: Card): QuestionResult => ({
  source: { kind: 'proposal', id: c.id }, status: c.status, audience: c.audience, revision: c.questionRevision, routeRevision: c.routeRevision,
  ...(c.classification ? { classificationId: c.classification.classificationId, digest: c.classification.digest } : {}),
});

const inOrder = (r: QuestionResult): QuestionResult => ({
  source: { kind: r.source.kind, id: r.source.id }, status: r.status, audience: r.audience, revision: r.revision, routeRevision: r.routeRevision,
  ...(r.classificationId ? { classificationId: r.classificationId } : {}), ...(r.digest ? { digest: r.digest } : {}),
});

async function heldCard(tx: Tx, call: TriageCall, guard: Guard, may: 'resolve' | 'classify'): Promise<Card> {
  const [card] = await tx.select().from(proposals).where(and(eq(proposals.id, guard.source.id), eq(proposals.companyId, call.companyId))).for('update');
  if (!card) throw noSuchSource();
  await requireTriage(tx, call, { companyId: call.companyId, departmentId: null, triageAgentId: card.triageAgentId }, may);
  return card;
}

export async function doneBefore(tx: Tx, companyId: string, guard: Guard, inputDigest: string): Promise<QuestionResult | null> {
  const [done] = await tx.select({ data: agentEvents.data }).from(agentEvents)
    .where(and(eq(agentEvents.companyId, companyId), inArray(agentEvents.kind, ['proposal', 'applied', 'computer']), sql`${agentEvents.data}->'question'->>'operationId' = ${guard.operationId}`)).limit(1);
  if (!done) return null;
  const kept = (done.data as { question: { inputDigest: string; result: QuestionResult } }).question;
  if (kept.inputDigest !== inputDigest) throw operationConflict();
  return inOrder(kept.result);
}

function stillAsRead(card: Card, guard: Guard): void {
  if (card.status !== 'pending') throw sourceClosed();
  if (card.questionRevision !== guard.expectedRevision) throw staleRevision();
  if (card.routeRevision !== guard.expectedRouteRevision || card.audience !== 'internal') throw staleRoute();
}

const notThisCard = () => new ApiError(400, 'validation', 'A card is put before a person as a ready result of its own kind, with its own digest. Name exactly that.', 'task_invalid');

function requireTheCard(card: Card, classification: QuestionClassificationInput['classification']): void {
  if (classification.kind !== 'ready_result') throw notThisCard();
  const { artifact } = classification;
  if (artifact.kind !== card.kind || artifact.digest !== cardDigest(card)) throw notThisCard();
}

/* What the window of the orchestrator shows of a card, as it always did. */
const shownCard = (c: Card) => (c.kind === 'staff' ? { proposalId: c.id, kind: 'staff', department: c.departmentId, brief: c.brief, people: c.items } : { proposalId: c.id, brief: c.brief, items: c.items });

const told = async (ctx: Ctx, card: Card, eventId: string | null): Promise<void> => {
  if (eventId) await publishEvent(ctx, card.companyId, card.agentId, eventId);
  ctx.bus.publish(card.companyId, { type: 'requests', spot: { departmentId: null } });
};

type Done = { result: QuestionResult; card: Card | null; eventId: string | null };

const insertEvent = async (tx: Tx, card: Card, jobId: string, kind: 'proposal' | 'applied', data: unknown): Promise<string> =>
  (await tx.insert(agentEvents).values({ companyId: card.companyId, agentId: card.agentId, jobId, kind, data: hideCodes(data), personId: null }).returning({ id: agentEvents.id }))[0]!.id;

/* The card before the person who decides, everything it rests on written down with it. It decides nothing by itself. */
export async function classifyProposal(ctx: Ctx, call: TriageCall, input: QuestionClassificationInput): Promise<Settled> {
  const inputDigest = digestOf(input);
  const done = await ctx.db.transaction(async (tx): Promise<Done> => {
    const card = await heldCard(tx, call, input, 'classify');
    const again = await doneBefore(tx, call.companyId, input, inputDigest);
    if (again) return { result: again, card: null, eventId: null };
    stillAsRead(card, input);
    requireTheCard(card, input.classification);
    const sealed = {
      source: input.source, revision: card.questionRevision, routeRevision: card.routeRevision,
      sourceBinding: { companyId: card.companyId, authorAgentId: card.agentId, sourceJobId: card.sourceJobId, sourceSequence: card.sourceSequence, taskAssignment: null },
      classification: input.classification, humanEnvelope: input.humanEnvelope, authority: await cardAuthority(tx, card), materialRevision: 1, materialDigest: cardDigest(card),
    };
    const classification = QuestionClassificationSnapshot.parse({ ...sealed, classificationId: randomUUID(), digest: digestOf(sealed) });
    const [promoted] = await tx.update(proposals).set({ audience: 'human', classification }).where(eq(proposals.id, card.id)).returning();
    const result = resultOf(promoted!);
    const eventId = await insertEvent(tx, promoted!, call.jobId, 'proposal', { ...shownCard(promoted!), ...audited('classified', input, inputDigest, result) });
    return { result, card: promoted!, eventId };
  });
  if (done.card) await told(ctx, done.card, done.eventId);
  return { result: done.result, wakes: [] };
}

/* Whoever made it puts it aside, and it is over. */
export async function resolveProposal(ctx: Ctx, call: TriageCall, input: ResolveInput): Promise<Settled> {
  const inputDigest = digestOf(input);
  const done = await ctx.db.transaction(async (tx): Promise<Done> => {
    const card = await heldCard(tx, call, input, 'resolve');
    const again = await doneBefore(tx, call.companyId, input, inputDigest);
    if (again) return { result: again, card: null, eventId: null };
    stillAsRead(card, input);
    const [closed] = await tx.update(proposals).set({ status: 'dismissed' }).where(eq(proposals.id, card.id)).returning();
    const result = resultOf(closed!);
    const eventId = await insertEvent(tx, closed!, call.jobId, 'applied', { proposalId: card.id, kind: card.kind, ...audited('resolved', input, inputDigest, result) });
    return { result, card: closed!, eventId };
  });
  if (done.card) await told(ctx, done.card, done.eventId);
  return { result: done.result, wakes: [] };
}

async function staleCard(tx: Tx, card: Card): Promise<boolean> {
  const snapshot = card.classification;
  if (!snapshot) return false;
  if (snapshot.revision !== card.questionRevision || snapshot.routeRevision !== card.routeRevision || snapshot.materialDigest !== cardDigest(card)) return true;
  const now = await cardAuthority(tx, card).then(a => a.authorityDigest, (err: unknown) => {
    if (err instanceof ApiError) return null;
    throw err;
  });
  return now !== snapshot.authority.authorityDigest;
}

const orchestratorOf = async (tx: Tx, companyId: string): Promise<string | null> =>
  (await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt))))[0]?.id ?? null;

/* A card has no task to wake it on: the orchestrator gets a turn of its own. */
async function tellOrchestrator(ctx: Ctx, companyId: string, text: string): Promise<void> {
  const orchestrator = await liveOrchestrator(ctx, companyId);
  if (!orchestrator || !(await orchestratorState(ctx, companyId)).ready) return;
  const message = await notificationMessage(ctx, companyId, 'question', text);
  await enqueueTurn(ctx, { companyId, agentId: orchestrator.id, prompt: message.text, createdBy: null, message });
}

/* What a person may take: nothing still inside, and nothing whose reasons changed since. That goes back inside in a write of its own,
   so that the refusal does not undo it. */
export async function refuseChangedCard(ctx: Ctx, companyId: string, id: string): Promise<void> {
  const back = await ctx.db.transaction(async tx => {
    const [card] = await tx.select().from(proposals).where(and(eq(proposals.id, id), eq(proposals.companyId, companyId))).for('update');
    if (!card || card.status !== 'pending') return null;
    if (card.audience === 'internal') throw classificationRequired();
    if (!(await staleCard(tx, card))) return null;
    const [moved] = await tx.update(proposals).set({ audience: 'internal', classification: null, routeRevision: card.routeRevision + 1, triageAgentId: await orchestratorOf(tx, companyId) }).where(eq(proposals.id, id)).returning();
    const [event] = await tx.insert(agentEvents).values({ companyId, agentId: card.agentId, kind: 'applied', data: { proposalId: id, kind: card.kind, question: { transition: 'back_inside', classificationId: card.classification!.classificationId, routeRevision: moved!.routeRevision } }, personId: null }).returning({ id: agentEvents.id });
    return { card: moved!, eventId: event!.id };
  });
  if (!back) return;
  await told(ctx, back.card, back.eventId);
  await tellOrchestrator(ctx, companyId, `Your card ${id} went back inside the company: who decides it changed. Read it with internal_questions and put it before them again if it still stands.`);
  throw staleRoute();
}

/* A card left from before questions went inside: it is the orchestrator's now, and it hears of it once. */
export async function claimProposals(ctx: Ctx): Promise<void> {
  const open = await ctx.db.select({ id: proposals.id, companyId: proposals.companyId }).from(proposals).where(and(eq(proposals.status, 'pending'), eq(proposals.audience, 'internal'), isNull(proposals.triageAgentId)));
  for (const { id, companyId } of open) {
    const claimed = await ctx.db.transaction(async tx => {
      const orchestrator = await orchestratorOf(tx, companyId);
      if (!orchestrator) return false;
      const [card] = await tx.update(proposals).set({ triageAgentId: orchestrator, routeRevision: sql`${proposals.routeRevision} + 1` }).where(and(eq(proposals.id, id), isNull(proposals.triageAgentId))).returning({ id: proposals.id });
      return Boolean(card);
    });
    if (claimed) await tellOrchestrator(ctx, companyId, `A card of yours from before is still inside the company: ${id}. Read it with internal_questions, and put it before the person who decides if it still stands, or put it aside with resolve_question.`);
  }
}

/* What the orchestrator reads: its cards still inside. Nobody else has any. */
export async function internalCards(ctx: Pick<Ctx, 'db'>, job: Pick<ToolJob, 'companyId' | 'agentKind'>) {
  if (job.agentKind !== 'orchestrator') return [];
  const rows = await ctx.db.select().from(proposals).where(and(eq(proposals.companyId, job.companyId), eq(proposals.status, 'pending'), eq(proposals.audience, 'internal')));
  return rows.map(c => ({ source: { kind: 'proposal' as const, id: c.id }, kind: c.kind, departmentId: c.departmentId, brief: c.brief, items: c.items, revision: c.questionRevision, routeRevision: c.routeRevision, digest: cardDigest(c), at: c.createdAt.toISOString() }));
}


type Line = { role: string; name?: string | undefined; product?: string | null | undefined; team?: string | null | undefined; model?: string | undefined; subscription?: string | null | undefined };
type CardLine = Line & { checked?: boolean };
const stated = (onCard: unknown, given: unknown): boolean => onCard === undefined || onCard === null || onCard === given;
const isOnCard = (line: Line, c: CardLine): boolean => c.role === line.role && stated(c.name, line.name) && stated(c.product, line.product) && stated(c.team, line.team) && stated(c.model, line.model) && stated(c.subscription, line.subscription);
const ticked = (card: Pick<Card, 'items'>): CardLine[] => (card.items as CardLine[]).filter(c => c.checked !== false);

/* Whether what is hired is what the card says, or less of it. */
export const withinCard = (lines: readonly Line[], card: Pick<Card, 'items'>): boolean => lines.every(line => ticked(card).some(c => isOnCard(line, c)));

/* What a person decided on a card, as they decided it: they may change it, and that is theirs. */
export function decisionOnCard(card: Card, decided: unknown, edited: boolean) {
  return { classificationId: card.classification?.classificationId ?? null, cardDigest: cardDigest(card), decided: digestOf(decided), edited };
}

/* An agent that takes a card for a person takes it as it stands: changing it is the person's alone. */
export const cardAsItStands = () => new ApiError(403, 'forbidden', 'A card taken for a person is taken as it stands: only a person changes it on the card. Show a newer card instead.', 'decision_not_allowed');
