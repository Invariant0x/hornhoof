import { and, eq, gt, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { actsAsCeo, canDecide, notAllowed } from '../../auth/decisions.js';
import { runsDepartment } from '../../auth/departments.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agentInbox, agents, departments, jobs, machineAccess, machines, people } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { appendEvent, type WithEvent } from '../events/store.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { sayLive } from './live.js';
import { activeClickGrants, answeredWords, machineSpeaker, wordsForTurn } from './turn-words.js';
import { liveInputOf } from '../program-operator/input.js';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';

/* The orchestrator always acts as the active company owner. A head acts in its department with the rights of its
   named owner, or the active CEO if it has none. Turn words still record who spoke. */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'> | Tx;

/* The person a turn answers, and the message that says so; null when the turn started without a message. */
export type Principal = { personId: string; sourceSeq: number | null };

/* What the orchestrator or a head acts on when it takes a decision: its turn and the principal it found when it asked. */
export type Delegation = { agentId: string; jobId: string; personId: string; sourceSeq: number | null; standing?: true };

/* The agents whose turns answer a person: the orchestrator, and a department's head, which its department's people run. */
const ANSWERS_PEOPLE: readonly (typeof agents.$inferSelect)['kind'][] = ['orchestrator', 'head'];

/* The running turn of the orchestrator or a head and its incoming words, newest first; null for any other turn, or while
   words are on their way into it. */
async function turnWords(db: Reader, jobId: string, kinds = ANSWERS_PEOPLE) {
  const [job] = await db
    .select({ id: jobs.id, agentId: jobs.agentId, status: jobs.status, kind: jobs.kind, pending: jobs.decisionInputPending, createdBy: jobs.createdBy, answersCeo: jobs.answersCeo, inboxWake: jobs.inboxWake, agentKind: agents.kind, companyId: agents.companyId, departmentId: agents.departmentId })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(eq(jobs.id, jobId));
  if (!job || job.status !== 'running' || job.kind !== 'conversation' || !kinds.includes(job.agentKind) || job.pending) return null;
  return { job, said: await wordsForTurn({ db }, job.agentId!, jobId) };
}

type Words = NonNullable<Awaited<ReturnType<typeof turnWords>>>;

/* A head's current named owner, if still active in the same company with access to its own department. */
async function headOwner(db: Reader, companyId: string, departmentId: string): Promise<Principal | null> {
  const [dept] = await db.select({ ownerPersonId: departments.ownerPersonId }).from(departments)
    .where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId), isNull(departments.parentId)));
  if (!dept?.ownerPersonId) return null;
  const [owner] = await db.select({ id: people.id, companyId: people.companyId, status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate }).from(people)
    .where(and(eq(people.id, dept.ownerPersonId), eq(people.companyId, companyId), eq(people.status, 'active')));
  return owner && (await runsDepartment(db, owner, departmentId)) ? { personId: owner.id, sourceSeq: null } : null;
}

async function activeOwner(db: Reader, companyId: string): Promise<Principal | null> {
  const [owner] = await db.select(idOnly(people)).from(people)
    .where(and(eq(people.companyId, companyId), eq(people.isOwner, true), eq(people.status, 'active'))).limit(1);
  return owner ? { personId: owner.id, sourceSeq: null } : null;
}

/* A head's standing authority is the same in a conversation and when its program calls a tool between turns. */
export async function headStandingPrincipal(db: Reader, head: { companyId: string; departmentId: string | null }): Promise<Principal | null> {
  if (!head.departmentId) return null;
  return (await headOwner(db, head.companyId, head.departmentId)) ?? activeOwner(db, head.companyId);
}

/* Whom the turn answers by its words alone: what the marks of an Enter keep. */
async function wordsPrincipal(db: Reader, jobId: string): Promise<Principal | null> {
  const turn = await turnWords(db, jobId);
  return turn && answered(turn);
}

export async function decisionPrincipal(db: Reader, jobId: string): Promise<Principal | null> {
  const [job] = await db.select({ kind: agents.kind, companyId: jobs.companyId, departmentId: agents.departmentId, status: jobs.status, step: jobs.kind, pending: jobs.decisionInputPending })
    .from(jobs).innerJoin(agents, and(eq(agents.id, jobs.agentId), eq(agents.companyId, jobs.companyId)))
    .where(and(eq(jobs.id, jobId), isNull(agents.removedAt)));
  if (!job) return null;
  if (job.kind === 'orchestrator') return activeOwner(db, job.companyId);
  if (job.kind !== 'head' || job.status !== 'running' || job.step !== 'conversation' || job.pending || !job.departmentId) return null;
  return headStandingPrincipal(db, job);
}

export type FindPrincipal = (db: Reader, jobId: string) => Promise<Principal | null>;
export const standingPrincipal = decisionPrincipal;

const answered = ({ job, said }: Words): Principal | null => answeredWords(job.createdBy, said);

export const contextMissing = () =>
  new ApiError(
    403,
    'forbidden',
    'This turn answers no person who may take this decision. Ask the person who takes it (the CEO, the CEO delegate or, for a department, its people) to decide it, or to tell you so here.',
    'decision_context_missing',
  );
const contextChanged = () => new ApiError(409, 'conflict', 'Someone else wrote into this turn meanwhile. Read it and decide again.', 'decision_context_changed');

/* The turn still goes for the same person through the same message, at the moment the decision is kept. */
export async function checkDelegation(db: Reader, d: Delegation, find: FindPrincipal = decisionPrincipal): Promise<void> {
  if (d.standing) return;
  const now = await find(db, d.jobId);
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
export async function actingCeo(db: Reader, personId: string): Promise<string | null> {
  const [p] = await db
    .select({ status: people.status, scopeKind: people.scopeKind, isOwner: people.isOwner, isCeoDelegate: people.isCeoDelegate, companyId: people.companyId })
    .from(people)
    .where(eq(people.id, personId));
  return p && actsAsCeo(p) ? personId : null;
}

/* The CEO or the CEO delegate the turn answers now, or null. */
export async function ceoPrincipal(db: Reader, jobId: string, find: FindPrincipal = decisionPrincipal): Promise<string | null> {
  const principal = await find(db, jobId);
  return principal ? actingCeo(db, principal.personId) : null;
}

/* The person the turn answers now, if they run this department as the CEO does: the CEO, the CEO delegate or the owner the
   CEO named for it. Null for anyone else. */
export async function departmentPrincipal(db: Reader, jobId: string, departmentId: string, find: FindPrincipal = decisionPrincipal): Promise<string | null> {
  const principal = await find(db, jobId);
  if (!principal) return null;
  const [p] = await db.select().from(people).where(eq(people.id, principal.personId));
  return p && (await runsDepartment(db, p, departmentId)) ? p.id : null;
}

/* Who may direct commands on a machine: the CEO or the CEO delegate, who direct the orchestrator, or the machine's own
   owner while active. */
async function activeMachinePerson(db: Reader, personId: string, ownerPersonId: string): Promise<string | null> {
  if (personId !== ownerPersonId) return actingCeo(db, personId);
  const [owner] = await db.select(only(people, 'status')).from(people).where(eq(people.id, personId));
  return owner?.status === 'active' ? personId : null;
}

/* For workers the machine's grant must cover every agent. The current speaker check below is for workers and heads. */
async function machineTurnAllowed(db: Reader, turn: Words, ownerPersonId: string, machineId: string | undefined): Promise<boolean> {
  if (turn.job.agentKind !== 'worker') return true;
  if (!machineId) return false;
  const [opened] = await db.select(idOnly(machines)).from(machines).innerJoin(machineAccess, eq(machineAccess.machineId, machines.id))
    .where(and(eq(machines.id, machineId), eq(machines.companyId, turn.job.companyId), eq(machines.personId, ownerPersonId), isNull(machines.revokedAt), eq(machineAccess.scope, 'all_agents'), gt(machineAccess.until, new Date())));
  return Boolean(opened);
}

export async function machinePrincipal(db: Reader, jobId: string, ownerPersonId: string, machineId?: string): Promise<string | null> {
  const turn = await turnWords(db, jobId, ['head', 'worker']);
  if (!turn) return null;
  if (!(await machineTurnAllowed(db, turn, ownerPersonId, machineId))) return null;
  const said = turn.said.map(machineSpeaker).find(speaker => speaker !== undefined);
  const spoke = said !== undefined ? said : await lettersSpeaker(db, turn.job);
  if (spoke === null) return null;
  const starter = turn.said.length === 0 ? turn.job.createdBy : null;
  return activeMachinePerson(db, spoke ?? starter ?? ownerPersonId, ownerPersonId);
}

/* Who wrote the letters that woke an inbox turn, before any words came into it: a person who sent one, as a notice of what
   they did; nobody when only employees and Hornhoof did, or a click opened a machine; not known when several people did. */
async function lettersSpeaker(db: Reader, job: { id: string; agentId: string | null; inboxWake: boolean }): Promise<string | null | undefined> {
  if (!job.inboxWake || !job.agentId) return undefined;
  const letters = await db
    .select({ personId: agentInbox.senderPersonId })
    .from(agentInbox)
    .where(and(eq(agentInbox.agentId, job.agentId), eq(agentInbox.jobId, job.id), eq(agentInbox.senderKind, 'person'), or(isNull(agentInbox.source), ne(agentInbox.source, 'computer_access'))));
  const people = new Set(letters.map(letter => letter.personId));
  if (!people.size) return undefined;
  const [only] = people;
  return people.size === 1 && only ? only : null;
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
  return withInputLock(ctx, agentId, () => deliverLockedInput(ctx, agentId, text, on, keep));
}

/* The caller already owns the input lock; callers that also need the agent line take input first. */
export async function deliverLockedInput(
  ctx: Ctx,
  agentId: string,
  text: string,
  on: { taskId?: string; source?: { personId?: string | null; data?: unknown } },
  keep: (jobId: string, kept: WithEvent) => Promise<void>,
): Promise<string | null> {
  const into = await sayLive(ctx, agentId, text, on.taskId, on.source, jobId => inputPending(ctx.db, jobId));
  const delivery = liveInputOf(on.source?.data, agentId)?.delivery;
  return into ? keepLiveInput(into, (jobId, kept) => keep(jobId, keepOperatorDelivery(kept, delivery))) : null;
}

function keepOperatorDelivery(kept: WithEvent, delivery: OperatorDelivery | undefined): WithEvent {
  return async (tx, stored) => {
    await kept(tx, stored);
    if (delivery) await tx.update(agentEvents).set({ data: sql`${agentEvents.data} || jsonb_build_object('operatorDelivery', ${JSON.stringify(delivery)}::jsonb)` }).where(eq(agentEvents.seq, stored.seq));
  };
}

class TurnStopped extends Error {}

/* The message and its turn check share a transaction, so Stop cannot move between the check and the write. */
async function liveInputKept(tx: Tx, jobId: string): Promise<void> {
  const [job] = await tx.select(idOnly(jobs)).from(jobs)
    .where(and(eq(jobs.id, jobId), or(isNull(jobs.error), ne(jobs.error, 'cancelled')))).for('no key update');
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

/* A head's department principal is checked again. For the orchestrator the job records who acted. */
export function delegationOf(me: { id: string; via?: string; viaHead?: true; decision?: { jobId: string; sourceSeq: number | null } }): Delegation | undefined {
  if (!me.via || (!me.viaHead && !me.decision)) return undefined;
  if (!me.decision) throw contextMissing();
  return { agentId: me.via, personId: me.id, ...me.decision, ...(!me.viaHead ? { standing: true as const } : {}) };
}

/* A head's decision is kept under its input lock. */
export const lockedFor = <T>(ctx: Pick<Ctx, 'db'>, on: Delegation | undefined, fn: () => Promise<T>): Promise<T> => (on && !on.standing ? withInputLock(ctx, on.agentId, fn) : fn());

/* At the moment a decision is kept: the turn still goes for the same person, who still may take it. */
export async function stillDecides(db: Reader, companyId: string, personId: string, subject: DecisionSubject, on: Delegation | undefined, find: FindPrincipal = decisionPrincipal): Promise<void> {
  if (on) await checkDelegation(db, on, find);
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

async function hasClickGrant(db: Reader, jobId: string): Promise<boolean> {
  const turn = await turnWords(db, jobId);
  return Boolean(turn && (await activeClickGrants(db, turn.job, turn.said)).length);
}

/* The turn of the orchestrator or a head answers this person from now on, or nobody: marked once as long as it does. The
   mark goes by the words of the turn, not by the owner the orchestrator acts as when no CEO wrote. */
async function keepSpeaker(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, turn: Turn, personId: string | null): Promise<void> {
  await appendEvent(ctx, { companyId: turn.companyId, agentId: turn.agentId, jobId: turn.id, kind: 'typed', data: {}, personId });
}

async function answersFromNow(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, turn: Turn, personId: string | null): Promise<void> {
  if (turn.agentKind === 'worker') return keepSpeaker(ctx, turn, personId);
  if (!ANSWERS_PEOPLE.includes(turn.agentKind)) return;
  const current = (await wordsPrincipal(ctx.db, turn.id))?.personId ?? null;
  if (current === personId && (personId !== null || !(await hasClickGrant(ctx.db, turn.id)))) return;
  await keepSpeaker(ctx, turn, personId);
}

type Typing = Pick<Ctx, 'db' | 'bus' | 'templates' | 'terminals'>;

/* A person pressed Enter in the agent's terminal, settled under the lock before the keys go on. In the turn that runs,
   what they typed goes into it: the orchestrator's or a head's answers them from now on, and no Enter from before opens a
   turn after it. The Enter stays known with that turn, as the program may queue the words for after it, and is the turn to
   tell the node of. While none runs, or the program only starts, the Enter may open one turn of theirs. Never both. */
export async function enterPressed(ctx: Typing, agentId: string, personId: string, node: NodeIdentity): Promise<string | null> {
  return withInputLock(ctx, agentId, async () => {
    const turn = await turnWithWords(ctx.db, eq(jobs.agentId, agentId));
    if (!turn) {
      ctx.terminals.typing(agentId, personId, node);
      return null;
    }
    ctx.terminals.drop(agentId);
    ctx.terminals.pressedIn(agentId, turn.id, personId, node);
    await answersFromNow(ctx, turn, personId);
    return turn.id;
  });
}

/* What a person typed came out of the program's queue into a turn that runs by then: it answers that person from now on. */
export async function typedWentIn(ctx: Typing, agentId: string, personId: string): Promise<void> {
  await withInputLock(ctx, agentId, async () => {
    const turn = await turnWithWords(ctx.db, eq(jobs.agentId, agentId));
    if (turn) await answersFromNow(ctx, turn, personId);
  });
}

/* A turn with words of its own started while an Enter waited to open one. What was typed may go into this turn instead,
   so it opens none later; and unless the turn of the orchestrator or a head answers that person already, it answers nobody
   until a person writes to it again. */
export async function turnStarted(ctx: Typing, agentId: string, jobId: string): Promise<void> {
  await withInputLock(ctx, agentId, async () => {
    const pressed = ctx.terminals.drop(agentId);
    const turn = pressed ? await turnWithWords(ctx.db, eq(jobs.id, jobId)) : undefined;
    if (turn && (await wordsPrincipal(ctx.db, turn.id))?.personId !== pressed) await answersFromNow(ctx, turn, null);
  });
}
