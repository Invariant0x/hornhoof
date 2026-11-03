import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { actsAsCeo, canDecide, notAllowed } from '../../auth/decisions.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { appendEvent, type WithEvent } from '../events/store.js';
import { sayLive } from './live.js';

/* The orchestrator takes a decision for a person only in a turn that answers that person: the last message that came into
   the turn, or the last Enter a person pressed in its terminal, says who it is. A message of an agent or of Hornhoof itself answers nobody, so after it the turn takes no
   decision until a person with the right writes again. A turn that took no message answers whoever started it. Words on
   their way into the turn, or that went in without being kept, leave the turn without anyone's right. */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'> | Tx;

/* The person a turn answers, and the message that says so; null when the turn started without a message. */
export type Principal = { personId: string; sourceSeq: number | null };

/* What the orchestrator acts on when it takes a decision: its turn and the principal it found when it asked. */
export type Delegation = { agentId: string; jobId: string; personId: string; sourceSeq: number | null };

/* A copy of a letter kept on the lane of the agent that wrote it is no word to that agent. */
const incoming = sql`coalesce(${agentEvents.data}->'_message'->>'direction', 'in') <> 'out'`;

export async function decisionPrincipal(db: Reader, jobId: string): Promise<Principal | null> {
  const [job] = await db
    .select({ agentId: jobs.agentId, status: jobs.status, kind: jobs.kind, pending: jobs.decisionInputPending, createdBy: jobs.createdBy, agentKind: agents.kind })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(eq(jobs.id, jobId));
  if (!job || job.status !== 'running' || job.kind !== 'conversation' || job.agentKind !== 'orchestrator' || job.pending) return null;
  const [last] = await db
    .select({ seq: agentEvents.seq, personId: agentEvents.personId })
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.agentId, job.agentId!), inArray(agentEvents.kind, ['message', 'typed']), incoming))
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  if (last) return last.personId ? { personId: last.personId, sourceSeq: last.seq } : null;
  return job.createdBy ? { personId: job.createdBy, sourceSeq: null } : null;
}

export const contextMissing = () =>
  new ApiError(
    403,
    'forbidden',
    'This turn answers no person who may take this decision. Ask the person who takes it (the CEO, the CEO delegate or, for a department, its people) to decide it, or to tell you so here.',
    'decision_context_missing',
  );
const contextChanged = () => new ApiError(409, 'conflict', 'Someone else wrote into this turn meanwhile. Read it and decide again.', 'decision_context_changed');

/* The turn still answers the same person through the same message, at the moment the decision is kept. */
export async function checkDelegation(db: Reader, d: Delegation): Promise<void> {
  const now = await decisionPrincipal(db, d.jobId);
  if (!now) throw contextMissing();
  if (now.personId !== d.personId || now.sourceSeq !== d.sourceSeq) throw contextChanged();
}

/* The person as they are now, who may take the decision, or a refusal. */
export async function requireDecider(db: Reader, companyId: string, personId: string, subject: DecisionSubject): Promise<void> {
  const [p] = await db
    .select({ id: people.id, companyId: people.companyId, status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate })
    .from(people)
    .where(eq(people.id, personId));
  if (!p || !canDecide(subject, p, await accessOf(db, p), companyId)) throw notAllowed();
}

/* Whether the turn answers the CEO or the CEO delegate, now. */
export async function answersCeoOrDelegate(db: Reader, jobId: string): Promise<boolean> {
  const principal = await decisionPrincipal(db, jobId);
  if (!principal) return false;
  const [p] = await db
    .select({ status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate, companyId: people.companyId })
    .from(people)
    .where(eq(people.id, principal.personId));
  return Boolean(p && actsAsCeo(p));
}

/* One thing at a time per agent between words that go into its turn and a decision taken in that turn, so a decision
   never goes by a principal that new words changed already. Separate from the agent's queue line; nothing inside takes it
   again. The server is one process: its hub, the words waiting for the node and the agents' lines live in it too. */
const held = new WeakMap<object, Map<string, Promise<unknown>>>();

export function withInputLock<T>(ctx: Pick<Ctx, 'db'>, agentId: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.get(ctx.db) ?? new Map<string, Promise<unknown>>();
  held.set(ctx.db, mine);
  const run = (mine.get(agentId) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => undefined);
  mine.set(agentId, settled);
  void settled.then(() => {
    if (mine.get(agentId) === settled) mine.delete(agentId);
  });
  return run;
}

/* Marks the running turn's words as on their way, before they go: a decision in it waits for them to be kept. */
export async function inputPending(db: Pick<Db, 'update'>, jobId: string): Promise<void> {
  await db.update(jobs).set({ decisionInputPending: true }).where(eq(jobs.id, jobId));
}

/* The words are kept with their message, in the same transaction: decisions go by them from now on. */
export async function inputKept(tx: Pick<Tx, 'update'>, jobId: string): Promise<void> {
  await tx.update(jobs).set({ decisionInputPending: false }).where(eq(jobs.id, jobId));
}

/* Words for the agent's running turn go in under its lock: the turn has no principal from before the words are typed until
   their message is kept, in the same transaction as keep's own. A turn the words may have reached without their message
   being kept stays without one until it ends. */
export function deliverLive(
  ctx: Ctx,
  agentId: string,
  text: string,
  on: { taskId?: string; source?: { personId?: string | null; data?: unknown } },
  keep: (jobId: string, kept: WithEvent) => Promise<void>,
): Promise<string | null> {
  return withInputLock(ctx, agentId, async () => {
    const into = await sayLive(ctx, agentId, text, on.taskId, on.source, jobId => inputPending(ctx.db, jobId));
    if (into) await keep(into, tx => inputKept(tx, into));
    return into;
  });
}

/* What is kept with a message, and the end of its turn's wait for it. */
export const alsoKept =
  (first: WithEvent | undefined, then: WithEvent): WithEvent =>
  async (tx, stored) => {
    await first?.(tx, stored);
    await then(tx, stored);
  };

/* What a call of the orchestrator decides on: the person its turn answers, found by Hornhoof. Its call of its own, as the
   owner, decides nothing. A person's own screen gives none. */
export function delegationOf(me: { id: string; via?: string; decision?: { jobId: string; sourceSeq: number | null } }): Delegation | undefined {
  if (!me.via) return undefined;
  if (!me.decision) throw contextMissing();
  return { agentId: me.via, personId: me.id, ...me.decision };
}

/* The decision is kept under the orchestrator's input lock when it takes it, and at once from a person's screen. */
export const lockedFor = <T>(ctx: Pick<Ctx, 'db'>, on: Delegation | undefined, fn: () => Promise<T>): Promise<T> => (on ? withInputLock(ctx, on.agentId, fn) : fn());

/* At the moment a decision is kept: the turn still answers the same person, who still may take it. */
export async function stillDecides(db: Reader, companyId: string, personId: string, subject: DecisionSubject, on: Delegation | undefined): Promise<void> {
  if (on) await checkDelegation(db, on);
  await requireDecider(db, companyId, on?.personId ?? personId, subject);
}

/* A person pressed Enter in the terminal of the orchestrator's running turn: what they typed is their word in it, so the
   turn answers them from now on. Kept under the lock before the keys go on, once as long as the turn answers them. */
export async function typedInto(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, agentId: string, personId: string): Promise<void> {
  await withInputLock(ctx, agentId, async () => {
    const [job] = await ctx.db
      .select({ id: jobs.id, companyId: jobs.companyId })
      .from(jobs)
      .innerJoin(agents, eq(agents.id, jobs.agentId))
      .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), eq(agents.kind, 'orchestrator')))
      .limit(1);
    if (!job || (await decisionPrincipal(ctx.db, job.id))?.personId === personId) return;
    await appendEvent(ctx, { companyId: job.companyId, agentId, jobId: job.id, kind: 'typed', data: {}, personId });
  });
}
