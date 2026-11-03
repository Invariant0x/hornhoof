import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { actsAsCeo, canDecide, notAllowed } from '../../auth/decisions.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { appendEvent, type WithEvent } from '../events/store.js';
import type { NodeIdentity } from '../nodes/hub.js';
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

/* The orchestrator's running turn and its last two incoming words, newest first; null for any other turn, or while words
   are on their way into it. */
async function turnWords(db: Reader, jobId: string) {
  const [job] = await db
    .select({ agentId: jobs.agentId, status: jobs.status, kind: jobs.kind, pending: jobs.decisionInputPending, createdBy: jobs.createdBy, answersCeo: jobs.answersCeo, agentKind: agents.kind })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(eq(jobs.id, jobId));
  if (!job || job.status !== 'running' || job.kind !== 'conversation' || job.agentKind !== 'orchestrator' || job.pending) return null;
  const said = await db
    .select({ seq: agentEvents.seq, personId: agentEvents.personId, kind: agentEvents.kind })
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.agentId, job.agentId!), inArray(agentEvents.kind, ['message', 'typed']), incoming))
    .orderBy(desc(agentEvents.seq))
    .limit(2);
  return { job, said };
}

type Words = NonNullable<Awaited<ReturnType<typeof turnWords>>>;

export async function decisionPrincipal(db: Reader, jobId: string): Promise<Principal | null> {
  const turn = await turnWords(db, jobId);
  return turn && answered(turn);
}

/* Whom the turn answers by its last word: the person who said it; whoever started it when it has none. */
function answered({ job, said: [last] }: Words): Principal | null {
  if (last) return last.personId ? { personId: last.personId, sourceSeq: last.seq } : null;
  return job.createdBy ? { personId: job.createdBy, sourceSeq: null } : null;
}

/* Whose click Hornhoof's note that opened the turn tells of, as their order, while nothing came after it. */
const clickOf = ({ job, said: [last, before] }: Words): string | null => (last?.kind === 'message' && !before && job.answersCeo ? job.createdBy : null);

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

/* The person, if they are the CEO or the CEO delegate now. */
async function actingCeo(db: Reader, personId: string): Promise<string | null> {
  const [p] = await db
    .select({ status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate, companyId: people.companyId })
    .from(people)
    .where(eq(people.id, personId));
  return p && actsAsCeo(p) ? personId : null;
}

/* The CEO or the CEO delegate the turn answers now, or null. */
export async function ceoPrincipal(db: Reader, jobId: string): Promise<string | null> {
  const principal = await decisionPrincipal(db, jobId);
  return principal ? actingCeo(db, principal.personId) : null;
}

/* For the computer the CEO opened: the CEO or the CEO delegate the turn answers now, or whose click opening it the note
   that opened the turn tells of, while nothing came after it. A click answers no question, so it takes no decision and
   asks for nothing else. */
export async function computerPrincipal(db: Reader, jobId: string): Promise<string | null> {
  const turn = await turnWords(db, jobId);
  const personId = turn && (answered(turn)?.personId ?? clickOf(turn));
  return personId ? actingCeo(db, personId) : null;
}

/* Whether the turn answers the CEO or the CEO delegate, now. */
export const answersCeoOrDelegate = async (db: Reader, jobId: string): Promise<boolean> => (await ceoPrincipal(db, jobId)) !== null;

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
    return into ? keepLiveInput(into, keep) : null;
  });
}

class TurnStopped extends Error {}

/* The message and its turn check share a transaction, so Stop cannot move between the check and the write. */
async function liveInputKept(tx: Tx, jobId: string): Promise<void> {
  const [job] = await tx.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.id, jobId), or(isNull(jobs.error), ne(jobs.error, 'cancelled')))).for('update');
  if (!job) throw new TurnStopped();
  await inputKept(tx, jobId);
}

async function keepLiveInput(jobId: string, keep: (jobId: string, kept: WithEvent) => Promise<void>): Promise<string | null> {
  try {
    await keep(jobId, tx => liveInputKept(tx, jobId));
    return jobId;
  } catch (error) {
    if (error instanceof TurnStopped) return null;
    throw error;
  }
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

/* The agent's turn that runs with words of its own: not one that only starts the program, which a typed turn takes over. */
async function turnWithWords(db: Reader, where: SQL) {
  const [job] = await db
    .select({ id: jobs.id, companyId: jobs.companyId, agentId: agents.id, agentKind: agents.kind })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(and(where, eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), or(ne(jobs.prompt, ''), isNotNull(jobs.taskId))))
    .limit(1);
  return job;
}

type Turn = NonNullable<Awaited<ReturnType<typeof turnWithWords>>>;

/* The orchestrator's turn answers this person from now on, or nobody: marked once as long as it does. */
async function answersFromNow(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, turn: Turn, personId: string | null): Promise<void> {
  if (turn.agentKind !== 'orchestrator' || ((await decisionPrincipal(ctx.db, turn.id))?.personId ?? null) === personId) return;
  await appendEvent(ctx, { companyId: turn.companyId, agentId: turn.agentId, jobId: turn.id, kind: 'typed', data: {}, personId });
}

type Typing = Pick<Ctx, 'db' | 'bus' | 'templates' | 'terminals'>;

/* A person pressed Enter in the agent's terminal, settled under the lock before the keys go on. In the turn that runs,
   what they typed goes into it: the orchestrator's answers them from now on, and no Enter from before opens a turn after
   it. While none runs, or the program only starts, the Enter may open one turn of theirs. Never both. */
export async function enterPressed(ctx: Typing, agentId: string, personId: string, node: NodeIdentity): Promise<void> {
  await withInputLock(ctx, agentId, async () => {
    const turn = await turnWithWords(ctx.db, eq(jobs.agentId, agentId));
    if (!turn) return ctx.terminals.typing(agentId, personId, node);
    ctx.terminals.drop(agentId);
    await answersFromNow(ctx, turn, personId);
  });
}

/* A turn with words of its own started while an Enter waited to open one. What was typed may go into this turn instead,
   so it opens none later; and unless the orchestrator's turn answers that person already, it answers nobody until a
   person writes to it again. */
export async function turnStarted(ctx: Typing, agentId: string, jobId: string): Promise<void> {
  await withInputLock(ctx, agentId, async () => {
    const pressed = ctx.terminals.drop(agentId);
    const turn = pressed ? await turnWithWords(ctx.db, eq(jobs.id, jobId)) : undefined;
    if (turn && (await decisionPrincipal(ctx.db, turn.id))?.personId !== pressed) await answersFromNow(ctx, turn, null);
  });
}
