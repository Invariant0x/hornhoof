import { randomUUID } from 'node:crypto';
import { NEXT_TURN_WORDS } from '@hornhoof/protocol';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, jobs, people, subscriptions, telegramReplies } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { identityOf, ownBuiltin, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { incomingEnvelope } from '../events/parties.js';
import { addressed, FIRST_CONTACT_ACTION } from './prompt.js';
import { cancelUnattemptedLive, cancelUnsentDelivery, reserveDelivery, wordsDigest } from '../program-operator/deliveries.js';
import { liveInputOf, rememberLiveInput } from '../program-operator/input.js';

/* How long Hornhoof waits for the node to say the words went in before it gives them the agent's next turn. */
const SAY_WAIT_MS = 15_000;
/* Leave time for both network trips and the node's Enter check. */
const SAY_MARGIN_MS = 5_000;

type Waiting = { node: NodeIdentity; done: (ok: boolean) => void };
type MessageSource = { personId?: string | null; data?: unknown };
const waiting = new WeakMap<Ctx, Map<string, Waiting>>();

const nothingBefore = async (): Promise<void> => {};

function liveEnvelope(ctx: Ctx, companyId: string, agentId: string, source?: MessageSource) {
  return incomingEnvelope(ctx, companyId, agentId, source?.personId, source?.data);
}

/* Words for an agent whose turn runs in a live terminal go into that turn at once, typed as a person types; with taskId,
   only into a turn on that task. The running turn's job, or null when none runs or the words could not go in, which then
   wait in the agent's line for its next turn. before runs once the turn is found, before the words go. */
export async function sayLive(
  ctx: Ctx,
  agentId: string,
  text: string,
  taskId?: string,
  source?: MessageSource,
  before: (jobId: string) => Promise<void> = nothingBefore,
): Promise<string | null> {
  const [running] = await ctx.db
    .select({ id: jobs.id, companyId: jobs.companyId, taskId: jobs.taskId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, createdBy: jobs.createdBy, sub: subscriptions, agentKind: agents.kind })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), isNull(jobs.error)))
    .limit(1);
  const node = running && identityOf(running.sub, running.nodeId, running.builtinMachine, ownBuiltin(ctx.config));
  if (!running || !node || (taskId && running.taskId !== taskId)) return null;
  if (!takesLiveWords(ctx, node, running.sub.provider)) return null;
  if (running.agentKind === 'orchestrator' && await repliesToOnePerson(ctx, running.id, source)) return null;
  if (await answersSomeoneElse(ctx, running, source)) return null;
  const message = await liveEnvelope(ctx, running.companyId, agentId, source);
  await before(running.id);
  return (await waitForWords(ctx, node, agentId, addressed(text, message), running, source)) ? running.id : null;
}

/* First contact and personal assistant replies have one recipient. Keep other words in the queue. */
async function repliesToOnePerson(ctx: Pick<Ctx, 'db'>, jobId: string, source?: MessageSource): Promise<boolean> {
  if (source?.data && typeof source.data === 'object' && 'channel' in source.data && source.data.channel === 'assistant') return true;
  const [privateMessage] = await ctx.db.select(only(agentEvents, 'seq')).from(agentEvents).where(and(
    eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'),
    or(sql`${agentEvents.data}->>'action' = ${FIRST_CONTACT_ACTION}`, sql`${agentEvents.data}->>'channel' = 'assistant'`),
  )).limit(1);
  return Boolean(privateMessage);
}

/* Whether a person's words would go into a turn that answers someone else in Telegram. Every word of a turn goes back to
   each Telegram chat a message of the turn came from, so words of one person typed into another's turn would carry the
   answer to the one into the chat of the other, and the agent could not tell whose question each answer is for. Such words
   wait for a turn of their own: the words of a turn whose Telegram chats are all the person's own, or, from Telegram, of a
   turn that is not another person's. Words that are no person's, and words between people in the window, go in as before. */
export async function answersSomeoneElse(ctx: Pick<Ctx, 'db'>, running: { id: string; createdBy: string | null }, source?: MessageSource): Promise<boolean> {
  const personId = source?.personId;
  if (!personId) return false;
  const chats = await ctx.db.select(only(telegramReplies, 'chatId')).from(telegramReplies).where(eq(telegramReplies.jobId, running.id));
  if (chats.length) {
    const [me] = await ctx.db.select({ telegram: people.telegramUserId }).from(people).where(eq(people.id, personId));
    if (chats.some(c => c.chatId !== me?.telegram)) return true;
  }
  return fromTelegram(source?.data) && running.createdBy !== null && running.createdBy !== personId;
}

const fromTelegram = (data: unknown): boolean => !!data && typeof data === 'object' && 'channel' in data && data.channel === 'telegram';

/* A node without live terminals never takes words into a turn, nor a program that takes typed words as a turn of its own:
   they wait for the next one. */
const takesLiveWords = (ctx: Ctx, node: NodeIdentity, provider: string): boolean => ctx.hub.hasTerminals(node) && !NEXT_TURN_WORDS.includes(provider);

type Words = { agentKey: string; text: string; ref: string };

const tracksLiveOperator = (ctx: Ctx, node: NodeIdentity, agentKind: string): node is Extract<NodeIdentity, { kind: 'node' }> =>
  agentKind !== 'assistant' && node.kind === 'node' && ctx.hub.hasProgramOperator(node);

/* The delivery of these words on a node that tracks them: the one they have in this turn already, when they are tried again. */
async function liveDelivery(ctx: Ctx, node: NodeIdentity, words: Words, running: { id: string; companyId: string; agentKind: string }, source?: MessageSource): Promise<OperatorDelivery | undefined> {
  if (!tracksLiveOperator(ctx, node, running.agentKind)) return undefined;
  const { agentKey: agentId, text, ref } = words;
  const digest = wordsDigest(text);
  const previous = liveInputOf(source?.data, agentId);
  const delivery = previous?.jobId === running.id && previous.digest === digest ? previous.delivery : await reserveDelivery(ctx.db, { companyId: running.companyId, agentId, jobId: running.id, nodeId: node.nodeId, kind: 'live', words: text, reference: `live:${ref}` });
  rememberLiveInput(source?.data, agentId, { delivery, jobId: running.id, digest });
  return delivery;
}

/* Sends the words and waits for the node's word on them. sent: they left for the node. refused: the node said no. */
async function typeWords(ctx: Ctx, node: NodeIdentity, words: Words, operatorDelivery?: OperatorDelivery) {
  const deadline = Date.now() + SAY_WAIT_MS;
  const map = waiting.get(ctx) ?? new Map<string, Waiting>();
  waiting.set(ctx, map);
  const typed = { went: false, sent: false, refused: false };
  typed.went = await new Promise<boolean>(done => {
    const timer = setTimeout(() => done(false), SAY_WAIT_MS);
    const end = (went: boolean) => {
      clearTimeout(timer);
      done(went && Date.now() < deadline);
    };
    map.set(words.ref, { node, done: went => { typed.refused = !went; end(went); } });
    try {
      typed.sent = ctx.hub.send(node, { type: 'agent.say', ...words, within: SAY_WAIT_MS - SAY_MARGIN_MS, ...(operatorDelivery ? { operatorDelivery } : {}) });
      if (!typed.sent) end(false);
    } catch {
      end(false);
    }
  }).finally(() => map.delete(words.ref));
  return typed;
}

async function waitForWords(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, running: { id: string; companyId: string; agentKind: string }, source?: MessageSource): Promise<boolean> {
  const words = { agentKey: agentId, text, ref: randomUUID() };
  const delivery = await liveDelivery(ctx, node, words, running, source);
  const typed = await typeWords(ctx, node, words, delivery);
  if (delivery && !typed.sent) await cancelUnsentDelivery(ctx.db, delivery);
  else if (delivery && typed.refused) await cancelUnattemptedLive(ctx.db, delivery);
  return typed.went;
}

/* The node's word on words Hornhoof sent it to type. */
export function said(ctx: Ctx, node: NodeIdentity, ref: string, ok: boolean): void {
  const w = waiting.get(ctx)?.get(ref);
  if (w && sameNode(w.node, node)) w.done(ok);
}
