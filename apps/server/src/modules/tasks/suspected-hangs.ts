import type { TurnProgram } from '@hornhoof/protocol/map';
import { and, asc, eq, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, nodes, requests, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { jobCheckLastEnd, jobCheckQueued } from '../nodes/check-slots.js';
import { builtinOf, nodeIdentity } from '../nodes/hub.js';
import { openPersonRequests } from './decisions.js';
import { agentProgramState } from './program-state.js';
import { CLOSED } from './state.js';
import { lastTurnSigns } from './turn-signs.js';

type Job = typeof jobs.$inferSelect;
type Task = typeof tasks.$inferSelect;
type Agent = typeof agents.$inferSelect;
type Turn = { job: Job; agent: Agent; task: Task | null };

/* A running turn with no sign of work for this long, while a task in work is on its agent, is a suspected hang. */
export const HANG_AFTER_MS = 10 * 60_000;
/* A task is in work while its agent is meant to be at it. */
const IN_WORK: readonly Task['status'][] = ['open', 'working'];

export type HangSignKind = 'event' | 'program_sign' | 'state_change' | 'check_end' | 'restart' | 'server_start' | 'turn_start';
export type SuspectedHang = {
  agentId: string;
  agent: string;
  turnId: string;
  task: { id: string; number: number; title: string };
  silentMs: number;
  silentMinutes: number;
  lastSign: { at: string; kind: HangSignKind };
  program: { state: string; tool: string | null } | null;
  /* What decides whether a reader may open the task, for whoever shows the entry. */
  sight: Pick<Task, 'status' | 'departmentId' | 'assigneeAgentId' | 'executorAgentId'>;
};

function runningTurns(ctx: Ctx, companyId: string): Promise<Turn[]> {
  return ctx.db.select({ job: jobs, agent: agents, task: tasks }).from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .leftJoin(nodes, eq(nodes.id, jobs.nodeId))
    /* A person's own assistant is theirs to watch, not Operations'. */
    .where(and(eq(jobs.companyId, companyId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), ne(agents.kind, 'assistant'), or(isNull(jobs.nodeId), eq(nodes.status, 'ready'))))
    .orderBy(asc(jobs.createdAt));
}

/* The tasks in work that these agents hold, for a turn that is on no task of its own. */
async function heldTasks(ctx: Ctx, turns: Turn[]): Promise<Task[]> {
  const loose = [...new Set(turns.filter(t => !t.job.taskId).map(t => t.agent.id))];
  if (!loose.length) return [];
  return ctx.db.select().from(tasks).where(and(inArray(tasks.status, [...IN_WORK]), or(inArray(tasks.assigneeAgentId, loose), inArray(tasks.executorAgentId, loose)))).orderBy(asc(tasks.number));
}

/* Which of these tasks are in work: not paused, not waiting for an outside event, for a person or for tasks before them.
   A task that waits has a silent turn on purpose. */
async function inWork(ctx: Ctx, rows: Task[]): Promise<Set<string>> {
  const active = rows.filter(t => IN_WORK.includes(t.status) && !t.paused && !t.externalWait);
  if (!active.length) return new Set();
  const before = [...new Set(active.flatMap(t => t.after))];
  const open = new Set(before.length ? (await ctx.db.select(only(tasks, 'id')).from(tasks).where(and(inArray(tasks.id, before), notInArray(tasks.status, [...CLOSED])))).map(r => r.id) : []);
  const asked = new Set((await ctx.db.select(only(requests, 'taskId')).from(requests).where(and(inArray(requests.taskId, active.map(t => t.id)), openPersonRequests()))).map(r => r.taskId));
  return new Set(active.filter(t => !asked.has(t.id) && !t.after.some(id => open.has(id))).map(t => t.id));
}

/* A turn whose machine Hornhoof cannot reach is silent for that reason, and nobody can look at its screen. A check that waits
   for a machine slot is silent on purpose. */
function unreachable(ctx: Ctx, job: Job, nowMs: number): boolean {
  const node = job.nodeId ? nodeIdentity(job.nodeId) : job.builtinMachine ? builtinOf(job.builtinMachine) : null;
  return (node !== null && ctx.hub.awaySince(node) !== null) || jobCheckQueued(ctx, job.id, nowMs);
}

/* The turn's last sign of work, whatever shows it: an event of its work its node streamed, a call of a Hornhoof tool, the
   node's own sign of its program (a hook, a tool call or its end, a line of output), a change of the program's state or
   tool, the end of a check it ran, or the program's restart. A redraw of the screen is none: every program animates a
   spinner or a clock while it hangs. Whichever comes first in this list wins a tie. */
function lastSign(ctx: Ctx, job: Job, program: TurnProgram | null, worked: number | undefined, nowMs: number): { at: number; kind: HangSignKind } {
  const signs: [HangSignKind, number | null | undefined][] = [
    ['event', worked],
    ['program_sign', program?.signAt],
    ['state_change', program?.since],
    ['check_end', jobCheckLastEnd(ctx, job.id, nowMs)],
    ['restart', job.restartedAt?.getTime()],
    /* Nothing was heard of the program since this server began: its quiet counts from then. */
    ['server_start', program ? undefined : ctx.startedAt.getTime()],
    ['turn_start', (job.startedAt ?? job.createdAt).getTime()],
  ];
  let last = { at: 0, kind: 'turn_start' as HangSignKind };
  for (const [kind, at] of signs) if (at && at > last.at) last = { at, kind };
  return last;
}

/* The task in work a turn is on: its own, or for a turn on no task, one in work its agent holds. None when it waits. */
function taskOfTurn({ job, agent, task: own }: Turn, held: Task[], working: ReadonlySet<string>): Task | null {
  if (job.taskId) return own && working.has(own.id) ? own : null;
  return held.find(t => working.has(t.id) && (t.assigneeAgentId === agent.id || t.executorAgentId === agent.id)) ?? null;
}

function hangOf({ job, agent }: Turn, task: Task, program: TurnProgram | null, sign: { at: number; kind: HangSignKind }, silentMs: number): SuspectedHang {
  return {
    agentId: agent.id, agent: agent.name, turnId: job.id,
    task: { id: task.id, number: task.number, title: task.title },
    silentMs, silentMinutes: Math.floor(silentMs / 60_000),
    lastSign: { at: new Date(sign.at).toISOString(), kind: sign.kind },
    program: program ? { state: program.state, tool: program.tool } : null,
    sight: { status: task.status, departmentId: task.departmentId, assigneeAgentId: task.assigneeAgentId, executorAgentId: task.executorAgentId },
  };
}

/* The running turns Hornhoof suspects to hang: no sign of work for 10 minutes while a task in work is on their agent. Code
   alone, for every program alike. Nothing is kept: an entry is gone the moment a sign comes or the turn ends. A turn on a
   task that waits is left out, and so is one on no task whose agent holds none in work. */
export async function suspectedHangs(ctx: Ctx, companyId: string, now = new Date()): Promise<SuspectedHang[]> {
  const nowMs = now.getTime();
  const turns = (await runningTurns(ctx, companyId)).filter(t => !unreachable(ctx, t.job, nowMs));
  if (!turns.length) return [];
  const held = await heldTasks(ctx, turns);
  const working = await inWork(ctx, [...held, ...turns.flatMap(t => (t.task ? [t.task] : []))]);
  const signs = await lastTurnSigns(ctx, turns.map(t => t.job.id));
  const hangs: SuspectedHang[] = [];
  for (const turn of turns) {
    const task = taskOfTurn(turn, held, working);
    if (!task) continue;
    const program = agentProgramState(ctx, turn.job).program;
    const sign = lastSign(ctx, turn.job, program, signs.get(turn.job.id), nowMs);
    const silentMs = Math.max(0, nowMs - sign.at);
    if (silentMs >= HANG_AFTER_MS) hangs.push(hangOf(turn, task, program, sign, silentMs));
  }
  return hangs.sort((a, b) => b.silentMs - a.silentMs || a.agent.localeCompare(b.agent));
}
