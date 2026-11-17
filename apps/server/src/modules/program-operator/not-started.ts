import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, programInstances, programOperatorCases, START_REASONS, type CaseReason } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { pump, pumpWaiting } from '../conversation/queue.js';
import type { MessageParty } from '../events/parties.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { callOperations, type HoldWords } from './hold-watch.js';
import { sayAgain, tellAgainWentAlong } from './recovery.js';
import { operatorTransaction } from './transactions.js';

type Case = typeof programOperatorCases.$inferSelect;
type Agent = typeof agents.$inferSelect;
type End = { outcome: string; text: string; actor?: MessageParty };

const NODE: CaseReason = 'node_cannot_work';
const STARTS = new Set<string>(START_REASONS);
/* A hold of a turn that ended before its program started: no program on the node has a case for it. */
export const fromStart = (row: Pick<Case, 'reason'>): boolean => STARTS.has(row.reason);

/* What each node last said of its work folder: why it cannot write there, while it says so. A node says it again in each
   hello, so a server that starts anew hears it again. */
const workErrors = new WeakMap<Ctx['hub'], Map<string, string>>();
function workErrorsOf(ctx: Ctx): Map<string, string> {
  const known = workErrors.get(ctx.hub) ?? new Map<string, string>();
  workErrors.set(ctx.hub, known);
  return known;
}

const nodeWords = (row: Case) => row.reason === NODE
  ? `The node cannot write its work folder, so no turn of any agent goes to it now: they all wait. It lifts the hold by itself once a write there works again. `
  : '';

export const notStartedWords: HoldWords = {
  text: (row, name, to) =>
    `Hornhoof: a turn of ${name} ended before its program started, on node ${row.nodeId}: ${row.resolution?.text ?? 'no reason was given'}. ` +
    `Case ${row.id}, turn ${row.jobId}. ${nodeWords(row)}${name}'s next turns wait too, so they do not fail the same way one after another. Nothing is lost: the words of that turn and the turns after it wait in the queue. ` +
    (to.kind === 'orchestrator' ? `Neither the program operator nor the head of Operations can take this now: they are off, without a plan or on a hold of their own. ` : '') +
    `Look at the machine with program_screen for employee ${row.agentId} and the machine tools you have, find what broke and repair it. ` +
    `Then release the hold with program_recovery_release, this case and your reason: the waiting turns go on.`,
  detail: name => ({ en: `${name}: a turn ended before its program started`, ru: `${name}: ход закончился до запуска программы` }),
};

/* The program a case of the agent is about: its last one, or a placeholder for an agent whose program never started. */
async function instanceFor(ctx: Ctx, agent: Agent, nodeId: string): Promise<string> {
  const [latest] = await ctx.db.select(idOnly(programInstances)).from(programInstances).where(eq(programInstances.agentId, agent.id)).orderBy(desc(programInstances.createdAt)).limit(1);
  if (latest) return latest.id;
  const id = randomUUID();
  await ctx.db.insert(programInstances).values({ id, companyId: agent.companyId, agentId: agent.id, nodeId });
  return id;
}

/* A turn ended before its program started. Its words go on later, and the agent's next turns wait on a recovery hold, with
   all turns of the node when the node said it cannot write its work folder, until Operations releases it. Operations hears
   once, whatever more ends so under the same hold. */
export async function holdNotStarted(ctx: Ctx, nodeId: string, jobId: string, said: string, now = new Date()): Promise<void> {
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.nodeId, nodeId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'failed')));
  if (!job?.agentId || job.error === 'cancelled' || job.error === 'stale') return;
  const workError = workErrorsOf(ctx).get(nodeId);
  const reason: CaseReason = workError ? NODE : 'not_started';
  const text = workError ?? (said.trim() || 'no reason was given');
  await operatorTransaction(ctx, async (tx, inside) => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, job.agentId!)).for('update');
    if (!agent || agent.kind === 'assistant' || agent.removedAt) return;
    const scope = reason === NODE ? eq(programOperatorCases.nodeId, nodeId) : eq(programOperatorCases.agentId, agent.id);
    const [held] = await tx.select().from(programOperatorCases).where(and(scope, eq(programOperatorCases.reason, reason), eq(programOperatorCases.recoveryHold, true))).limit(1).for('update');
    const fact = { reason, evidenceKey: job.id, deliveryId: null };
    const row = held
      ? (await tx.update(programOperatorCases).set({ evidence: [...held.evidence, fact] }).where(eq(programOperatorCases.id, held.id)).returning())[0]!
      : (await tx.insert(programOperatorCases).values({ companyId: job.companyId, agentId: agent.id, jobId: job.id, nodeId, instance: await instanceFor(inside, agent, nodeId), reason, evidenceKey: job.id, capability: randomUUID(), evidence: [fact], status: 'escalated', openedAt: now, deadlineAt: now, escalatedAt: now, recoveryHold: true, resolution: { outcome: reason, text, image: null } }).returning())[0]!;
    const continuation = await sayAgain(inside, job, now, job.requestedPrompt ?? job.prompt, { operatorRecovery: row.id });
    await tellAgainWentAlong(inside, job, now, words => words);
    await logTurnFact(inside, job, `The turn ended before its program started: ${text}. Its words wait with the next turns until Operations looks.`, { operatorRecovery: row.id, continuation });
    if (held) return;
    await tx.update(programOperatorCases).set({ continuationJobId: continuation }).where(eq(programOperatorCases.id, row.id));
    const told = await callOperations(inside, row, now, notStartedWords);
    if (told) await tx.update(programOperatorCases).set({ escalationJobId: told }).where(eq(programOperatorCases.id, row.id));
  });
}

/* Whether a failed turn ended before its program started under a hold: its words go on with it, so nothing else decides. */
export async function keptBeforeStart(ctx: Ctx, jobId: string): Promise<boolean> {
  const [kept] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases)
    .where(and(inArray(programOperatorCases.reason, [...START_REASONS]), sql`${programOperatorCases.evidence} @> ${JSON.stringify([{ evidenceKey: jobId }])}::jsonb`)).limit(1);
  return Boolean(kept);
}

/* The nodes of these that cannot write their work folder, as they say or as a hold keeps: no turn goes to them meanwhile. */
export async function nodesOnHold(ctx: Ctx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await ctx.db.selectDistinct({ id: programOperatorCases.nodeId }).from(programOperatorCases)
    .where(and(inArray(programOperatorCases.nodeId, ids), eq(programOperatorCases.reason, NODE), eq(programOperatorCases.recoveryHold, true)));
  const said = workErrorsOf(ctx);
  return new Set([...rows.map(row => row.id), ...ids.filter(id => said.has(id))]);
}

/* Ends a hold of a turn that ended before its program started, with the turn's log saying how. The caller holds the agent. */
async function liftLocked(ctx: Ctx, id: string, end: End, data: Record<string, unknown> = {}): Promise<boolean> {
  const [row] = await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.id, id), eq(programOperatorCases.recoveryHold, true))).for('update');
  if (!row) return false;
  await ctx.db.update(programOperatorCases).set({ status: 'resolved', recoveryHold: false, revision: row.revision + 1, resolution: { ...(row.resolution ?? { image: null }), ...end } }).where(eq(programOperatorCases.id, id));
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  if (job) await logTurnFact(ctx, job, end.text, { operatorRecovery: id, ...data });
  return true;
}

/* Lifts the hold and lets the turns that waited on it go. */
async function lift(ctx: Ctx, row: Case, end: End, data?: Record<string, unknown>): Promise<boolean> {
  const lifted = await operatorTransaction(ctx, async (tx, inside) => {
    await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, row.agentId)).for('update');
    return liftLocked(inside, row.id, end, data);
  });
  if (lifted) await (row.reason === NODE ? pumpWaiting(ctx) : pump(ctx, row.agentId));
  return lifted;
}

/* Operations releases the hold: nothing on a node to ask first, as no program of it started. What the node said of its work
   folder holds no more either: a turn there that ends the same way tells it again. */
export async function releaseStartHold(ctx: Ctx, me: Agent, row: Case, reason: string, actor: MessageParty): Promise<boolean> {
  const at = new Date().toISOString();
  if (row.reason === NODE) workErrorsOf(ctx).delete(row.nodeId);
  return lift(ctx, row, { outcome: 'released', text: `${me.name} released the hold: ${reason}`, actor },
    { recoveryRelease: { actor: { id: me.id, name: me.name, role: me.roleKey }, reason, at, action: 'release', case: row.id, job: row.jobId, result: 'released' } });
}

/* What a node says of its work folder in its hello or status. Once it writes there again, what its failure held goes on. */
export async function noteWorkFolder(ctx: Ctx, nodeId: string, error: string | null | undefined): Promise<void> {
  if (error === undefined) return;
  const known = workErrorsOf(ctx);
  if (error) {
    known.set(nodeId, error);
    return;
  }
  known.delete(nodeId);
  const held = await ctx.db.select().from(programOperatorCases).where(and(eq(programOperatorCases.nodeId, nodeId), eq(programOperatorCases.reason, NODE), eq(programOperatorCases.recoveryHold, true)));
  for (const row of held) await lift(ctx, row, { outcome: 'writes_again', text: 'The node writes its work folder again, so the turns that waited go on.' });
}
