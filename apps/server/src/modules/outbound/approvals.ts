import type { ApprovalChannel, ApprovalRule } from '@hornhoof/protocol';
import { approvalNeeded } from '@hornhoof/protocol';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { outboundApprovals, requests } from '../../db/schema.js';
import { departmentRules } from '../departments/approval-policy.js';
import { personParty } from '../events/parties.js';
import { appendOutgoing } from '../events/store.js';
import { decisionPerson } from '../tasks/decisions.js';
import { ask, taskSpot, type Tx } from '../tasks/engine.js';
import { wakeAll } from '../tasks/wake.js';
import { digestOf, moneyWithinLimit, type Money } from './checks.js';

/* An approval that can let a message go: of exact bytes or an exact approach, under the policy, the sources and the
   authority of that moment. Kept in its own row, made in the step that makes its request; a request with no such row, or
   with a kind that merely reads the same, approves nothing. */

export type Need = 'none' | 'approach' | 'message';
type Rules = { sending: ApprovalRule; price: ApprovalRule };
type Work = { audience: 'direct' | 'public'; money: readonly Money[]; escalated: boolean; hasSegment: boolean; autoSend?: boolean };

const asksEachTime = (rule: ApprovalRule, money: readonly Money[]): boolean => rule.mode === 'within_limits' ? !moneyWithinLimit(money, rule) : approvalNeeded(rule, { amount: null, known: true });

/* What a person must approve for this work under the rules of its department. A public post, a check that wants a person,
   and anything with no approach to name go one at a time, whatever the rules say. A channel its owner lets send by itself
   asks nothing for sending; a price still goes by its own rule. */
export function approvalNeed(rules: Rules, work: Work): Need {
  if (work.audience === 'public' || work.escalated) return 'message';
  const applying = [...(work.autoSend ? [] : [rules.sending]), ...(work.money.length ? [rules.price] : [])];
  if (!applying.length) return 'none';
  if (applying.some(rule => asksEachTime(rule, work.money))) return 'message';
  if (!applying.some(rule => rule.mode === 'new_kinds')) return 'none';
  return work.hasSegment ? 'approach' : 'message';
}

type Authority = { companyId: string; departmentId: string; productId: string | null; decider: string; channelGeneration: number; accountId: string; bindingGeneration: number; configGeneration: number };

/* Who may decide now and under which generations: another owner or a changed account makes an earlier approval stale. */
export const authorityFingerprint = (a: Authority): string => digestOf(a);

/* The person who decides approvals of this place now. */
export const deciderOf = (ctx: Pick<Ctx, 'db'>, place: { companyId: string; departmentId: string; productId: string | null }): Promise<string> =>
  decisionPerson(ctx, place.companyId, { source: 'request', kind: 'approval', topic: 'task', spot: taskSpot(place) });

const SENDING_CHANNEL: Record<Work['audience'], ApprovalChannel> = { direct: 'message', public: 'publication' };
export const sendingChannel = (audience: Work['audience']): ApprovalChannel => SENDING_CHANNEL[audience];

/* The rules a message of this audience goes by. */
export async function rulesFor(db: Pick<Db, 'select'>, departmentId: string, audience: Work['audience']): Promise<Rules> {
  const rules = await departmentRules(db, departmentId);
  const of = (channel: ApprovalChannel) => rules.find(r => r.channel === channel)!;
  return { sending: of(sendingChannel(audience)), price: of('price') };
}

export type Shared = { policyDigest: string; sourceRevisionsDigest: string; authorityFingerprint: string };
type ExactMessage = { kind: 'message'; messageId: string; messageRevision: number; contentDigest: string; accountId: string; bindingGeneration: number };
type ExactApproach = { kind: 'approach'; channelId: string; templateId: string; templateRevision: number; segmentId: string; locale: string };
export type Bound = (ExactMessage | ExactApproach) & Shared;

const messageIs = (b: ExactMessage) => [eq(outboundApprovals.messageId, b.messageId), eq(outboundApprovals.messageRevision, b.messageRevision), eq(outboundApprovals.contentDigest, b.contentDigest), eq(outboundApprovals.accountId, b.accountId), eq(outboundApprovals.bindingGeneration, b.bindingGeneration)];
const approachIs = (b: ExactApproach) => [eq(outboundApprovals.channelId, b.channelId), eq(outboundApprovals.templateId, b.templateId), eq(outboundApprovals.templateRevision, b.templateRevision), eq(outboundApprovals.segmentId, b.segmentId), eq(outboundApprovals.locale, b.locale)];

export type ApprovalState = 'approved' | 'waiting' | 'declined' | 'missing';

const exactly = (companyId: string, bound: Bound) => [
  eq(outboundApprovals.companyId, companyId), eq(outboundApprovals.kind, bound.kind), eq(outboundApprovals.policyDigest, bound.policyDigest), eq(outboundApprovals.sourceRevisionsDigest, bound.sourceRevisionsDigest),
  eq(outboundApprovals.authorityFingerprint, bound.authorityFingerprint), ...(bound.kind === 'message' ? messageIs(bound) : approachIs(bound)),
];

/* What people said of exactly this. One yes is enough; a later change is another tuple and finds nothing. since: for a
   message that came back with a restored database only what was asked after this moment counts, open or answered with
   a yes: a question from before it shows the words of before, and its yes may be the one the restore lost. A no ends
   the message whenever it was said. */
export async function approvalState(db: Pick<Db, 'select'>, companyId: string, bound: Bound, since: Date | null = null): Promise<ApprovalState> {
  const rows = await db
    .select({ status: requests.status, createdAt: requests.createdAt })
    .from(outboundApprovals)
    .innerJoin(requests, eq(requests.id, outboundApprovals.requestId))
    .where(and(...exactly(companyId, bound)));
  const said = rows.filter(r => r.status === 'declined' || !since || r.createdAt > since).map(r => r.status);
  if (said.includes('approved')) return 'approved';
  if (said.includes('open')) return 'waiting';
  return said.includes('declined') ? 'declined' : 'missing';
}

const ASKED_BEFORE_RESTORE = 'Hornhoof was restored from a backup after this was asked, so it is asked again.';

/* The questions about exactly this that were asked before the restore and still wait: closed, saying why, so nobody
   answers the words of before. The gate asks anew with what the person needs to know. */
export async function withdrawAskedBefore(tx: Tx, companyId: string, bound: Bound, since: Date, now: Date): Promise<void> {
  const asked = tx.select({ id: outboundApprovals.requestId }).from(outboundApprovals).where(and(...exactly(companyId, bound)));
  await tx.update(requests).set({ status: 'withdrawn', answer: ASKED_BEFORE_RESTORE, answeredAt: now }).where(and(eq(requests.status, 'open'), lte(requests.createdAt, since), inArray(requests.id, asked)));
}

export type Asking = { companyId: string; taskId: string; authorAgentId: string; authorJobId: string | null; channel: ApprovalChannel; kindName: string; text: string; bound: Bound };

/* Puts this before the person who decides, with its row made in the step that makes the request. */
export async function askApproval(ctx: Ctx, a: Asking): Promise<void> {
  const moved = await ask(ctx, a.authorAgentId, a.taskId, {
    kind: 'approval',
    text: a.text,
    approval: { channel: a.channel, kind: a.kindName, amount: null },
    topic: 'task',
    onCreated: async (tx, request) => {
      await tx.insert(outboundApprovals).values({ companyId: a.companyId, requestId: request.id, ...a.bound });
    },
  });
  if (a.authorJobId) {
    const personId = await decisionPerson(ctx, a.companyId, { source: 'request', kind: 'approval', topic: moved.request.decisionTopic, spot: taskSpot(moved.task) });
    await appendOutgoing(ctx, { companyId: a.companyId, agentId: a.authorAgentId, jobId: a.authorJobId, text: a.text, to: await personParty(ctx, a.companyId, personId) });
  }
  await wakeAll(ctx, moved.wakes);
}
