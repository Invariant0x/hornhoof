import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { actsAsCeo, canDecide, notAllowed } from '../../auth/decisions.js';
import { runsDepartment } from '../../auth/departments.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agentInbox, agents, jobs, machineAccess, machines, people, requests, tasks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { appendEvent, type WithEvent } from '../events/store.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { sayLive } from './live.js';
import { activeClickGrants, answeredWords, byPerson, incomingWords, machineSpeaker, wordsForTurn } from './turn-words.js';
import { liveInputOf } from '../program-operator/input.js';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';

/* The orchestrator, and a department's head inside its own department, take a decision for a person only in a turn that
   answers that person: the last person who wrote into the turn, or pressed Enter in its terminal, says who it is. Notices
   Hornhoof writes and messages from agents never change whom a turn answers, and a turn without a person's words answers
   nobody unless a person started it with none. Words on their way into the turn, or that went in without being kept, leave
   the turn without anyone's right. Their own work of running the company or a department goes on in any turn of theirs,
   for the last person who asked them: see standingPrincipal.
   What is not forbidden is allowed, and the orchestrator can do everything in the company (Ivan's rule of 16 November
   2026): in a turn that answers neither the CEO nor the CEO delegate it goes as the company's owner, so an employee's
   message, a notice of Hornhoof or a person who runs one department moves it as the CEO would. What a company wants it
   not to do is written in the company's notebook. Machines keep their own rule: see machinePrincipal. */

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'> | Tx;

/* The person a turn answers, and the message that says so; null when the turn started without a message. */
export type Principal = { personId: string; sourceSeq: number | null };

/* What the orchestrator or a head acts on when it takes a decision: its turn and the principal it found when it asked. */
export type Delegation = { agentId: string; jobId: string; personId: string; sourceSeq: number | null };

/* The agents whose turns answer a person: the orchestrator, and a department's head, which its department's people run. */
const ANSWERS_PEOPLE: readonly (typeof agents.$inferSelect)['kind'][] = ['orchestrator', 'head'];

/* The running turn of the orchestrator or a head and its incoming words, newest first; null for any other turn, or while
   words are on their way into it. */
async function turnWords(db: Reader, jobId: string, kinds = ANSWERS_PEOPLE) {
  const [job] = await db
    .select({ id: jobs.id, agentId: jobs.agentId, status: jobs.status, kind: jobs.kind, pending: jobs.decisionInputPending, createdBy: jobs.createdBy, answersCeo: jobs.answersCeo, inboxWake: jobs.inboxWake, agentKind: agents.kind, companyId: agents.companyId })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .where(eq(jobs.id, jobId));
  if (!job || job.status !== 'running' || job.kind !== 'conversation' || !kinds.includes(job.agentKind) || job.pending) return null;
  return { job, said: await wordsForTurn({ db }, job.agentId!, jobId) };
}

type Words = NonNullable<Awaited<ReturnType<typeof turnWords>>>;

/* The orchestrator's principal: the CEO or the CEO delegate its turn answers, or else the company's owner. A head's stays
   as it was found. */
async function asOwner(db: Reader, turn: Words, found: Principal | null): Promise<Principal | null> {
  if (turn.job.agentKind !== 'orchestrator') return found;
  if (found && (await actingCeo(db, found.personId))) return found;
  const [owner] = await db
    .select(idOnly(people))
    .from(people)
    .where(and(eq(people.companyId, turn.job.companyId), eq(people.isOwner, true), eq(people.status, 'active')))
    .limit(1);
  return owner ? { personId: owner.id, sourceSeq: null } : found;
}

/* Whom the turn answers by its words alone, before the orchestrator goes as the owner: what the marks of an Enter keep. */
async function wordsPrincipal(db: Reader, jobId: string): Promise<Principal | null> {
  const turn = await turnWords(db, jobId);
  return turn && answered(turn);
}

export async function decisionPrincipal(db: Reader, jobId: string): Promise<Principal | null> {
  const turn = await turnWords(db, jobId);
  return turn && asOwner(db, turn, answered(turn));
}

/* How a check finds the person a call goes for: decisionPrincipal, or standingPrincipal for running the company. */
export type FindPrincipal = (db: Reader, jobId: string) => Promise<Principal | null>;

/* The person whose words the orchestrator or a head carries out in any running turn of its own, when it runs the company or
   its department: whom the turn answers, or, when no person's words came into it, the last person who wrote or typed to
   it in an earlier turn. A turn that ended before a check came back takes nobody's word away. Words of agents and notices
   of Hornhoof still never stand for a person, and the routes still allow only what that person may do now. */
export async function standingPrincipal(db: Reader, jobId: string): Promise<Principal | null> {
  const turn = await turnWords(db, jobId);
  if (!turn) return null;
  const found = turn.said.some(byPerson) || (turn.said.length === 0 && turn.job.createdBy) ? answered(turn) : await earlierPrincipal(db, turn.job.agentId!);
  return asOwner(db, turn, found);
}

/* The last person who wrote or typed to the agent; null when nobody did, or an Enter cleared it. */
async function earlierPrincipal(db: Reader, agentId: string): Promise<Principal | null> {
  const words = await db
    .select({ seq: agentEvents.seq, personId: agentEvents.personId, kind: agentEvents.kind, data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), inArray(agentEvents.kind, ['message', 'typed']), incomingWords, or(isNotNull(agentEvents.personId), eq(agentEvents.kind, 'typed'))))
    .orderBy(desc(agentEvents.seq))
    .limit(20);
  const last = words.find(byPerson);
  return last?.personId ? { personId: last.personId, sourceSeq: last.seq } : null;
}

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

/* For a machine whose owner keeps its access open, the orchestrator works there in any running turn of its own: one a
   notice, an employee's letter or a wake started, a retry and every later turn, with no new word of the CEO. Only the last
   person whose words came into the turn can take it away: someone who may not direct commands there, as an Enter in the
   terminal or words that may have gone in unkept do, since whose they were is not known. A notice of a person's task,
   comment or answer, and a letter of theirs that woke an inbox turn, are their words; words of an origin Hornhoof cannot
   name, with no person, no sender or a notice of a kind it does not know, take it away too. A turn no words came into goes
   by whoever started it. Who the commands go for: that person, or the owner. A click answers no question, so this takes
   no decision and asks for nothing else. */
async function machineTurnAllowed(db: Reader, turn: Words, ownerPersonId: string, machineId: string | undefined): Promise<boolean> {
  if (turn.job.agentKind !== 'worker') return true;
  if (!machineId) return false;
  const [opened] = await db.select(idOnly(machines)).from(machines).innerJoin(machineAccess, eq(machineAccess.machineId, machines.id))
    .where(and(eq(machines.id, machineId), eq(machines.companyId, turn.job.companyId), eq(machines.personId, ownerPersonId), isNull(machines.revokedAt), eq(machineAccess.scope, 'all_agents'), gt(machineAccess.until, new Date())));
  return Boolean(opened);
}

export async function machinePrincipal(db: Reader, jobId: string, ownerPersonId: string, machineId?: string): Promise<string | null> {
  const turn = await turnWords(db, jobId, [...ANSWERS_PEOPLE, 'worker']);
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

/* The CEO or the CEO delegate who gave their own answer in a task's card to a question about machines, while that task is
   still open, or null. Their recorded answer lets the orchestrator change machines for that task as their words in its
   own turn would; it is no permission for anything else. */
export async function cardPrincipal(db: Reader, companyId: string, requestId: string): Promise<string | null> {
  const [found] = await db
    .select({ topic: requests.decisionTopic, status: requests.status, answeredBy: requests.answeredBy, byAgent: requests.answeredByAgentId, task: tasks.status })
    .from(requests)
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.id, requestId), eq(requests.companyId, companyId)));
  if (!found || found.topic !== 'machines' || !['answered', 'approved'].includes(found.status)) return null;
  if (!found.answeredBy || found.byAgent || found.task === 'done' || found.task === 'cancelled') return null;
  return actingCeo(db, found.answeredBy);
}

/* Whether the turn answers the CEO or the CEO delegate, now. */
export const answersCeoOrDelegate = async (db: Reader, jobId: string, find: FindPrincipal = decisionPrincipal): Promise<boolean> => (await ceoPrincipal(db, jobId, find)) !== null;

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

/* What a call of the orchestrator or a head decides on: the person its turn answers, found by Hornhoof. The orchestrator's
   call of its own decides as the owner, with no turn to check. A person's own screen gives none. */
export function delegationOf(me: { id: string; via?: string; viaHead?: true; decision?: { jobId: string; sourceSeq: number | null } }): Delegation | undefined {
  if (!me.via || (!me.viaHead && !me.decision)) return undefined;
  if (!me.decision) throw contextMissing();
  return { agentId: me.via, personId: me.id, ...me.decision };
}

/* The decision is kept under the input lock of the orchestrator or head that takes it, and at once from a person's screen. */
export const lockedFor = <T>(ctx: Pick<Ctx, 'db'>, on: Delegation | undefined, fn: () => Promise<T>): Promise<T> => (on ? withInputLock(ctx, on.agentId, fn) : fn());

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
async function answersFromNow(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, turn: Turn, personId: string | null): Promise<void> {
  if (!ANSWERS_PEOPLE.includes(turn.agentKind)) return;
  const current = (await wordsPrincipal(ctx.db, turn.id))?.personId ?? null;
  if (current === personId && (personId !== null || !(await hasClickGrant(ctx.db, turn.id)))) return;
  await appendEvent(ctx, { companyId: turn.companyId, agentId: turn.agentId, jobId: turn.id, kind: 'typed', data: {}, personId });
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
