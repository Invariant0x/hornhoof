import type { NodeMessage, ProgramState } from '@hornhoof/protocol';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { enqueueTurn } from '../conversation/queue.js';
import { identityOf, keyOf, type NodeIdentity } from '../nodes/hub.js';
import { failOpenJobs, jobsOf } from '../nodes/messages.js';
import { agentProgramState, alreadyAlerted, screenReader } from './silent.js';
import { logTurnFact } from './turn-log.js';

type Job = typeof jobs.$inferSelect;

/* A turn is asked about once it has run this long: by then its node has it, as the turn went out or its words were typed. */
export const ASK_AFTER_MS = 2 * 60_000;
/* A node reports a program that runs a turn at least once a minute. A report this fresh that the program works keeps its
   turn, whatever the node says; idle at its prompt or gone is no work. */
export const PULSE_MS = 2 * 60_000;
/* How long a program may stand idle in a running turn while the agent's next messages wait, before Operations hear of it. */
export const STALL_MS = 5 * 60_000;

const WORKING: ReadonlySet<ProgramState> = new Set(['thinking', 'tool', 'asking', 'retrying']);

const NOT_HELD = 'Hornhoof ended this turn as interrupted: its machine said it no longer runs this turn, and its program gave no sign of work for 2 minutes. The next waiting turn goes out.';
const NO_MACHINE = 'Hornhoof ended this turn as interrupted: it went out to no machine of its plan, so no machine can run it or end it. The next waiting turn goes out.';

/* Its program reported work a moment ago: it thinks, runs a tool, asks or retries. */
function working(ctx: Ctx, job: Job, now: number): boolean {
  const program = agentProgramState(ctx, job).program;
  return Boolean(program && WORKING.has(program.state) && now - program.reportedAt < PULSE_MS);
}

/* The turn ends as one its machine lost, as when a node connects again without it: what was going on in it goes on in the
   agent's next turn, its task's turn runs again, and the next waiting turn goes out. */
async function endLost(ctx: Ctx, job: Job, why: string): Promise<void> {
  const ended = await failOpenJobs(ctx, and(eq(jobs.id, job.id), eq(jobs.status, 'running'))!, 'machine_restarted');
  if (ended.length) await logTurnFact(ctx, job, why, { lostTurn: true });
}

const runningTurns = (ctx: Ctx, before?: Date) =>
  ctx.db.select({ job: jobs, plan: subscriptions.kind }).from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), before ? lte(jobs.startedAt, before) : undefined));

/* Each connected node is asked which of the turns it was given it still runs; a turn no machine can run ends at once. A node
   that is away is not asked: it answers with its hello when it is back, and one away too long loses its turns anyway. */
export async function askOfRunningTurns(ctx: Ctx, now: Date): Promise<void> {
  const asks = new Map<string, { node: NodeIdentity; jobIds: string[] }>();
  for (const { job, plan } of await runningTurns(ctx, new Date(now.getTime() - ASK_AFTER_MS))) {
    const node = identityOf({ kind: plan }, job.nodeId);
    if (!node) await endLost(ctx, job, NO_MACHINE);
    else if (ctx.hub.isReady(node)) {
      const ask = asks.get(keyOf(node)) ?? { node, jobIds: [] };
      ask.jobIds.push(job.id);
      asks.set(keyOf(node), ask);
    }
  }
  for (const { node, jobIds } of asks.values()) for (let i = 0; i < jobIds.length; i += 100) ctx.hub.send(node, { type: 'jobs.check', jobIds: jobIds.slice(i, i + 100) });
}

/* What the node answered: a turn it was asked about and no longer runs, whose program shows no work, is over. A node speaks
   only of its own turns, and only of the ones asked about once they ran long enough to have reached it. */
export async function turnsHeld(ctx: Ctx, id: NodeIdentity, msg: Extract<NodeMessage, { type: 'jobs.held' }>, now = new Date()): Promise<void> {
  const held = new Set(msg.held);
  const gone = msg.asked.filter(jobId => !held.has(jobId));
  if (!gone.length) return;
  const lost = await ctx.db.select().from(jobs).where(and(inArray(jobs.id, gone), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), jobsOf(id, ctx), lte(jobs.startedAt, new Date(now.getTime() - ASK_AFTER_MS))));
  for (const job of lost) if (!working(ctx, job, now.getTime())) await endLost(ctx, job, NOT_HELD);
}

/* The program stands idle at its prompt in a turn its node still runs, as its node reports, and the agent's next messages
   have waited behind that turn as long: the turn takes in nothing more, so Operations hear of it once, not a person. */
async function stalled(ctx: Ctx, job: Job, now: number): Promise<Job | null> {
  const program = agentProgramState(ctx, job).program;
  if (!job.agentId || program?.state !== 'idle' || now - program.reportedAt >= PULSE_MS || now - program.since < STALL_MS) return null;
  const [waiting] = await ctx.db.select().from(jobs)
    .where(and(eq(jobs.agentId, job.agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued'), lte(jobs.createdAt, new Date(now - STALL_MS))))
    .orderBy(asc(jobs.createdAt)).limit(1);
  return waiting ?? null;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

function stalledText(name: string, agentId: string, job: Job, waiting: Job, now: number): string {
  return `Hornhoof: the queue of ${name} stands still. Its program stands idle at its prompt in turn ${job.id}, which its machine still runs, ` +
    `and its next messages have waited since ${waiting.createdAt.toISOString()} (${minutes(now - waiting.createdAt.getTime())} minutes): they do not reach the program. ` +
    `Read program_screen for employee ${agentId} and bring the program back yourself: stop that turn with stop_employee, or restart its program, so the queue goes on. ` +
    'Ask no person to do it. When nothing you may do helps, tell your head what the screen shows.';
}

/* Operations hear once of each running turn whose program stands idle while the agent's messages wait behind it. */
export async function tellOfStalledQueues(ctx: Ctx, now: Date): Promise<void> {
  const turns = await runningTurns(ctx);
  const busy = new Set(turns.flatMap(t => (t.job.agentId ? [t.job.agentId] : [])));
  for (const { job } of turns) {
    const waiting = await stalled(ctx, job, now.getTime());
    const caseId = `${job.id}:queue`;
    if (!waiting || !job.agentId || await alreadyAlerted(ctx, caseId)) continue;
    const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, job.agentId));
    const to = agent && await screenReader(ctx, job.companyId, agent.id, busy);
    if (!agent || !to) continue;
    const text = stalledText(agent.name, agent.id, job, waiting, now.getTime());
    await enqueueTurn(ctx, {
      companyId: job.companyId,
      agentId: to.id,
      prompt: text,
      createdBy: null,
      message: { personId: null, text, silentJob: caseId, silentReason: 'program_stalled', notification: { source: 'program_alarm', tasks: [], detail: { en: `${agent.name}: queue stands still`, ru: `${agent.name}: очередь стоит` } } },
    });
    await logTurnFact(ctx, job, `${to.name} was told the queue stands still behind this turn.`, { stalledQueue: caseId, to: to.id });
  }
}
