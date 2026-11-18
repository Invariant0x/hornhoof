import { mapOf, turnPrograms, turnAlarms, signInTurn, type Job, type GoneProgram } from './program-state.js';
import { PROGRAM_SCREEN_MAX, QUIET_ALARM_MS, type NodeMessage } from '@hornhoof/protocol';
import { TOOL_QUIET_ALARM_MS, type TurnAlarm, type TurnAlarmReason, type TurnProgram } from '@hornhoof/protocol/map';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, departments, jobs, nodes, tasks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { enqueueTurn } from '../conversation/queue.js';
import { liveSubscription } from '../conversation/placement.js';
import { operationsStaff } from '../program-operator/staff.js';
import { headOf } from './failure-recipients.js';
import { sameProgram } from './program-history.js';
import { programRestartStatus } from './program-restarts.js';
import { logTurnFact } from './turn-log.js';
import { jobCheckQueued, jobCheckLastEnd } from '../nodes/check-slots.js';
import { builtinOf, nodeIdentity } from '../nodes/hub.js';
import { stopStaleProgram } from './stale-program.js';
import { lastTurnSigns } from './turn-signs.js';
export const SILENT_TURN_MS = QUIET_ALARM_MS;
/* Every program shows a spinner or a clock while it thinks, so its screen moves. A thinking program whose screen stood still
   this long waits on something the screen shows, most often a window of its own that asks what no hook tells of. */
const STILL_SCREEN_MS = 180_000;

export type { TurnAlarm, TurnAlarmReason, TurnProgram } from '@hornhoof/protocol/map';

type Agent = typeof agents.$inferSelect;
type ProgramReport = Extract<NodeMessage, { type: 'job.program' }>;
/* An alarm, and the wait that raised it. */
type Quiet = { alarm: TurnAlarm; wait: number };
type SilentTurn = Quiet & {
  job: Job;
  agent: Agent;
  task: { id: string; number: number; title: string } | null;
  program: TurnProgram | null;
};
const alertedTurns = new WeakMap<Ctx, Set<string>>();
const silentChains = new WeakMap<Ctx, Promise<void>>();

function alertedSet(ctx: Ctx): Set<string> {
  const set = alertedTurns.get(ctx) ?? new Set<string>();
  alertedTurns.set(ctx, set);
  return set;
}

export async function recordJobProgram(
  ctx: Ctx,
  msg: ProgramReport,
  now: Date,
  scope: SQL,
): Promise<void> {
  const [job] = await ctx.db
    .select({ id: jobs.id, companyId: jobs.companyId, agentId: jobs.agentId, sessionId: jobs.sessionId })
    .from(jobs)
    .where(and(eq(jobs.id, msg.jobId), eq(jobs.status, 'running'), eq(jobs.kind, 'conversation'), scope));
  if (!job) return;
  /* A node that restarts mid-turn cannot say so when the turn ends, and the turn goes on in this session. */
  if (msg.session && msg.session !== job.sessionId) await ctx.db.update(jobs).set({ sessionId: msg.session }).where(eq(jobs.id, job.id));
  await replaceProgram(ctx, job, msg, now);
  ctx.bus.publish(job.companyId, { type: 'org' });
}

/* The same state as the live map, without reports or terminal contents, kept only when it changes. */
export type ProgramChange = { program: Pick<TurnProgram, 'state' | 'since' | 'tool'> | null; alarm: TurnAlarm | null };
type HistoryJob = Pick<Job, 'id' | 'companyId' | 'agentId'>;

const historyOf = (program: TurnProgram | null, alarm: TurnAlarm | null): ProgramChange => ({
  program: program ? { state: program.state, since: program.since, tool: program.tool } : null,
  alarm,
});

async function keepProgramChange(ctx: Ctx, job: HistoryJob, program: TurnProgram | null, alarm: TurnAlarm | null, now: Date): Promise<void> {
  if (!job.agentId) return;
  await ctx.db.insert(agentEvents).values({ companyId: job.companyId, agentId: job.agentId, jobId: job.id,
    kind: 'program', data: historyOf(program, alarm), createdAt: now });
}

async function replaceProgram(ctx: Ctx, job: HistoryJob, msg: ProgramReport, now: Date): Promise<void> {
  const programs = mapOf(turnPrograms, ctx), previous = programs.get(job.id);
  const program = programOf(msg, now);
  const goneAt = program.state !== 'gone' ? null : previous?.goneAt ?? now.getTime();
  programs.set(job.id, { program, gone: goneProgram(msg), goneAt });
  if (!sameProgram(previous?.program, program)) await keepProgramChange(ctx, job, program, mapOf(turnAlarms, ctx).get(job.id) ?? null, now);
}

const programOf = (msg: ProgramReport, now: Date): TurnProgram => ({ state: msg.state, since: msg.since, tool: msg.tool ?? null, screenAt: msg.screenAt, signAt: msg.signAt ?? null, retry: msg.retry ?? null, reportedAt: now.getTime() });

function goneProgram(msg: ProgramReport): GoneProgram | null {
  if (msg.state !== 'gone') return null;
  return { state: 'gone', exitCode: msg.exitCode ?? null, signal: msg.signal ?? null, screen: msg.screen?.slice(-PROGRAM_SCREEN_MAX) || null };
}

export function failedProgramData(error: string | null, program: GoneProgram | null): { error: string | null; program?: GoneProgram; text?: string } {
  if (!program) return { error };
  const text = `No program. Exit code: ${program.exitCode ?? 'no data'}. Signal: ${program.signal ?? 'no data'}. Last screen:\n${program.screen ?? 'no data'}`;
  return { error, program, text };
}

/* When Hornhoof last heard of a turn: its node's last report of its program, or the turn's start before the first one,
   or the turn's last sign besides (worked): an event of its work or a call of a Hornhoof tool. A node that streams the
   work of a program with no screen is not silent, nor is a program that calls Hornhoof. */
const heardAt = (job: Pick<Job, 'startedAt' | 'createdAt'>, program: TurnProgram | null, worked: number | undefined): number =>
  Math.max(program?.reportedAt ?? (job.startedAt ?? job.createdAt).getTime(), worked ?? 0);

/* A running turn Hornhoof heard nothing of for SILENT_TURN_MS, the node_silent alarm: nothing tells when it ends, so
   nothing waits for it to end. worked: the turn's last sign besides its program's reports, as lastTurnSigns gives it. */
export function lostTurn(ctx: Ctx, job: Pick<Job, 'id' | 'startedAt' | 'createdAt'>, nowMs: number, worked: number | undefined): boolean {
  return nowMs - heardAt(job, mapOf(turnPrograms, ctx).get(job.id)?.program ?? null, worked) >= SILENT_TURN_MS;
}

const quietFor = (wait: number, since: number, nowMs: number): Quiet | null =>
  nowMs - since >= wait ? { alarm: { reason: 'program_stalled', since }, wait } : null;

function alarmForProgram(program: TurnProgram, signAt: number | null, nowMs: number): Quiet | null {
  if (signAt !== null) {
    if (program.state === 'asking') return null;
    return stillScreen(program, signAt, nowMs) ?? quietFor(program.state === 'tool' ? TOOL_QUIET_ALARM_MS : SILENT_TURN_MS, signAt, nowMs);
  }
  return quietFor(SILENT_TURN_MS, Math.max(program.since, program.screenAt), nowMs);
}

/* Counted from the last of its sign, its state and its screen's change. A tool runs with its screen still, and a retry or an
   idle program has its own waits. */
function stillScreen(program: TurnProgram, signAt: number, nowMs: number): Quiet | null {
  return program.state === 'thinking' ? quietFor(STILL_SCREEN_MS, Math.max(program.since, program.screenAt, signAt), nowMs) : null;
}

/* What the watchdog knows of a running turn: its program as its node reported it, and the turn's last sign besides. */
type Watched = { job: Job; program: TurnProgram | null; worked: number | undefined };

function alarmForTurn({ job, program, worked }: Watched, nowMs: number): Quiet | null {
  const heard = heardAt(job, program, worked);
  if (nowMs - heard >= SILENT_TURN_MS) return { alarm: { reason: 'node_silent', since: heard }, wait: SILENT_TURN_MS };
  return program ? alarmForProgram(program, signInTurn(program, job), nowMs) : null;
}

function alarmForTask(turn: Watched, task: { externalWait: typeof tasks.$inferSelect.externalWait } | null, nowMs: number): Quiet | null {
  return task?.externalWait ? null : alarmForTurn(turn, nowMs);
}

function alarmWithCheckQueue(ctx: Ctx, turn: Watched, task: { externalWait: typeof tasks.$inferSelect.externalWait } | null, nowMs: number): Quiet | null {
  const { job, program } = turn;
  const detected = alarmForTask(turn, task, nowMs);
  if (missingProgramReport(detected)) return detected;
  if (jobCheckQueued(ctx, job.id, nowMs)) return null;
  return afterQueuedCheck(program, detected, jobCheckLastEnd(ctx, job.id, nowMs), nowMs);
}

const missingProgramReport = (quiet: Quiet | null): boolean => quiet?.alarm.reason === 'node_silent';

function afterQueuedCheck(program: TurnProgram | null, quiet: Quiet | null, checkEnd: number | null, now: number): Quiet | null {
  const threshold = program?.state === 'tool' ? TOOL_QUIET_ALARM_MS : SILENT_TURN_MS;
  return checkEnd !== null && now - checkEnd < threshold ? null : quiet;
}

const sameAlarm = (a: TurnAlarm | null, b: TurnAlarm | null) => a?.reason === b?.reason && a?.since === b?.since;

async function updateTurnAlarm(ctx: Ctx, job: Job, alarm: TurnAlarm | null, now: Date): Promise<void> {
  const alarms = mapOf(turnAlarms, ctx);
  const prev = alarms.get(job.id) ?? null;
  if (alarm) alarms.set(job.id, alarm);
  else alarms.delete(job.id);
  await changedAlarm(ctx, job, prev, alarm, now);
}

async function changedAlarm(ctx: Ctx, job: Job, before: TurnAlarm | null, alarm: TurnAlarm | null, now: Date): Promise<void> {
  if (sameAlarm(before, alarm)) return;
  await keepProgramChange(ctx, job, mapOf(turnPrograms, ctx).get(job.id)?.program ?? null, alarm, now);
  ctx.bus.publish(job.companyId, { type: 'org' });
}

async function findSilentTurns(ctx: Ctx, now: Date): Promise<SilentTurn[]> {
  const rows = await ctx.db
    .select({ job: jobs, agent: agents, task: { id: tasks.id, number: tasks.number, title: tasks.title, externalWait: tasks.externalWait } })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .leftJoin(nodes, eq(nodes.id, jobs.nodeId))
    .where(
      and(
        eq(jobs.kind, 'conversation'),
        eq(jobs.status, 'running'),
        /* A person's assistant is theirs to watch, not Operations'. */
        ne(agents.kind, 'assistant'),
        or(ne(jobs.prompt, ''), isNotNull(jobs.taskId), isNotNull(jobs.createdBy)),
        or(isNull(jobs.nodeId), eq(nodes.status, 'ready')),
      ),
    )
    .orderBy(asc(jobs.createdAt));
  const programs = mapOf(turnPrograms, ctx);
  const nowMs = now.getTime();
  const signs = await lastTurnSigns(ctx, rows.map(r => r.job.id));
  const silent: SilentTurn[] = [];
  for (const { job, agent, task } of rows) {
    const program = programs.get(job.id)?.program ?? null;
    /* A program on a machine Hornhoof cannot reach is silent for that reason, and nobody can look at its screen: no
       alarm is raised for it until the machine is back. */
    const node = job.nodeId ? nodeIdentity(job.nodeId) : job.builtinMachine ? builtinOf(job.builtinMachine) : null;
    const turn = { job, program, worked: signs.get(job.id) };
    const quiet = node && ctx.hub.awaySince(node) !== null ? null : alarmWithCheckQueue(ctx, turn, task, nowMs);
    await updateTurnAlarm(ctx, job, quiet?.alarm ?? null, now);
    if (quiet) silent.push({ job, agent, task: task?.id ? task : null, program, ...quiet });
  }
  return silent;
}

export async function alreadyAlerted(ctx: Ctx, jobId: string): Promise<boolean> {
  const seen = alertedSet(ctx);
  if (seen.has(jobId)) return true;
  const [row] = await ctx.db
    .select(idOnly(agentEvents))
    .from(agentEvents)
    .where(and(eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'silentJob' = ${jobId}`))
    .limit(1);
  if (row) seen.add(jobId);
  return Boolean(row);
}

export async function operationsWatchers(ctx: Ctx, companyId: string): Promise<Agent[]> {
  const ops = ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const rows = await ctx.db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        or(
          inArray(agents.departmentId, ops),
          inArray(agents.departmentId, ctx.db.select(idOnly(departments)).from(departments).where(inArray(departments.parentId, ops))),
          inArray(agents.roleKey, ['OPS-WATCH', 'OPS-HEAD']),
        ),
        isNull(agents.removedAt),
        isNull(agents.switchedOffAt),
      ),
    )
    .orderBy(asc(agents.createdAt));
  const able: Agent[] = [];
  for (const a of rows) if (await liveSubscription(ctx, a.id)) able.push(a);
  return able;
}

async function busyAgentIds(ctx: Ctx): Promise<Set<string>> {
  const rows = await ctx.db
    .select(only(jobs, 'agentId'))
    .from(jobs)
    .where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), isNotNull(jobs.agentId)));
  return new Set(rows.map(r => r.agentId!));
}

const isFreeWatchdog = (a: Agent, stuckId: string, unavailable: ReadonlySet<string>) =>
  a.roleKey === 'OPS-WATCH' && a.id !== stuckId && !unavailable.has(a.id);
const isOpsHead = (a: Agent, stuckId: string) => (a.kind === 'head' || a.roleKey === 'OPS-HEAD') && a.id !== stuckId;

export function pickOpsRecipient(able: Agent[], stuckAgentId: string, unavailable: ReadonlySet<string>): Agent | null {
  return able.find(a => isFreeWatchdog(a, stuckAgentId, unavailable)) ?? able.find(a => isOpsHead(a, stuckAgentId)) ?? null;
}

export const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function roleOf(ctx: Ctx, agent: Agent): string | null {
  if (agent.roleKey) return ctx.templates.roles.get(agent.roleKey)?.title.en ?? null;
  return agent.kind === 'orchestrator' ? 'Orchestrator' : null;
}

function agentLabel(ctx: Ctx, agent: Agent): string {
  const role = roleOf(ctx, agent);
  return role && role !== agent.name ? `${agent.name} (${role})` : agent.name;
}

function programLabel(program: TurnProgram | null): string {
  if (!program) return 'unreported';
  return program.tool ? `${program.state} (${program.tool})` : program.state;
}

const QUIET_MINUTES = SILENT_TURN_MS / 60_000;
const reasonLabel = (reason: TurnAlarmReason) =>
  reason === 'program_stalled'
    ? `program_stalled (program state and screen unchanged for ${QUIET_MINUTES} minutes)`
    : `node_silent (node has not reported for ${QUIET_MINUTES} minutes)`;
const STILL_LABEL = `program_stalled (its screen stood still for ${STILL_SCREEN_MS / 60_000} minutes while it thinks: a window of the program may wait for an answer)`;

function alarmLabel(s: SilentTurn): string {
  if (s.wait === STILL_SCREEN_MS) return STILL_LABEL;
  return s.program?.signAt != null && s.alarm.reason === 'program_stalled' ? 'program_stalled (program gave no sign of life)' : reasonLabel(s.alarm.reason);
}

async function silentAlarmText(ctx: Ctx, s: SilentTurn, now: Date): Promise<string> {
  const who = agentLabel(ctx, s.agent);
  const where = s.task ? `on #${s.task.number} "${s.task.title}"` : 'outside any task';
  const iso = new Date(s.alarm.since).toISOString();
  const program = s.program;
  const stateSince = program ? new Date(program.since).toISOString() : 'unreported';
  const signAt = program ? signInTurn(program, s.job) : null;
  const start = (s.job.startedAt ?? s.job.createdAt).getTime();
  const sign = signAt === null ? 'unreported by this node' : program!.signAt === 0 ? `none since the turn started at ${new Date(start).toISOString()}` : new Date(signAt).toISOString();
  const retry = program?.retry ? `${program.retry.attempt} of ${program.retry.max ?? 'an unknown maximum'}, next at ${program.retry.nextAt === null ? 'an unknown time' : new Date(program.retry.nextAt).toISOString()}` : 'none reported';
  const restart = await programRestartStatus(ctx, s.job.companyId, s.agent.id, +now);
  const restartLine = restart.allowed ? 'restart_program is allowed now, for a wait the screen shows dead.' : `restart_program is not allowed now: ${restart.reason}`;
  const action = `Read program_screen for employee ${s.agent.id} and do at its screen what it needs to go on. ${restartLine} When nothing you may do helps, tell your head what the screen shows.`;
  const reason = alarmLabel(s);
  /* The reason and who come first: an inbox turn shows each letter cut at 300 characters. */
  return (
    `Hornhoof: turn alarm, reason ${reason}: ${who}, in turn ${s.job.id} (${where}). ` +
    `Program state: ${programLabel(program)}, since ${stateSince}. Last change: ${when(iso)} (${iso}). ` +
    `Last sign: ${sign}. Program retry: ${retry}. ${action}`
  );
}

async function dispatchAlarm(ctx: Ctx, s: SilentTurn, to: Agent, now: Date, caseId = s.job.id): Promise<void> {
  if (await alreadyAlerted(ctx, caseId)) return;
  const text = await silentAlarmText(ctx, s, now);
  const task = s.task ? { id: s.task.id, number: s.task.number } : undefined;
  const alarmId = await enqueueTurn(ctx, {
    companyId: s.job.companyId,
    agentId: to.id,
    prompt: text,
    createdBy: null,
    message: { personId: null, text, ...(task ? { task } : {}), silentJob: caseId, silentReason: s.alarm.reason, notification: { source: 'program_alarm', tasks: task ? [task] : [], detail: { en: `${s.agent.name}: ${s.alarm.reason}`, ru: `${s.agent.name}: ${s.alarm.reason}` } } },
  });
  alertedSet(ctx).add(caseId);
  await logTurnFact(ctx, s.job, `${to.name} was told about the silent program: ${text}`, { silentCase: caseId, to: to.id });
  if (now.getTime() > Date.now()) {
    await ctx.db.update(jobs).set({ startedAt: now }).where(and(eq(jobs.id, alarmId), eq(jobs.status, 'running')));
  }
}

async function sendTurnAlarm(ctx: Ctx, s: SilentTurn, unavailable: ReadonlySet<string>, now: Date): Promise<void> {
  if (await stopStaleProgram(ctx, s.job, 'silent')) return;
  if (s.job.restartedAt) {
    const since = Math.max(+s.job.restartedAt, s.program?.signAt ?? 0);
    if (+now - since < SILENT_TURN_MS) return;
    const to = await headOf(ctx, s.agent);
    if (to && to.id !== s.agent.id) await dispatchAlarm(ctx, s, to, now, `${s.job.id}:after_restart`);
    return;
  }
  const to = await screenReader(ctx, s.job.companyId, s.agent.id, unavailable);
  if (to) await dispatchAlarm(ctx, s, to, now, quietCase(s, now));
}

/* Whoever hears of a quiet program must see its screen: a free program operator, or else the head of Operations, or else
   an operator at work. Never the employee whose program it is. */
export async function screenReader(ctx: Ctx, companyId: string, of: string, unavailable: ReadonlySet<string>): Promise<Agent | null> {
  const staff: Agent[] = [];
  for (const a of await operationsStaff(ctx, companyId)) if (a.id !== of && await liveSubscription(ctx, a.id)) staff.push(a);
  const operators = staff.filter(a => a.kind === 'worker');
  return operators.find(a => !unavailable.has(a.id)) ?? staff.find(a => a.kind === 'head') ?? operators[0] ?? null;
}

/* One call when the quiet begins and one more each time it doubles, so a program nobody brought back is looked at again.
   The quiet is counted in the wait that raised the alarm. */
function quietCase(s: SilentTurn, now: Date): string {
  const doubled = Math.floor(Math.log2(Math.max(1, (now.getTime() - s.alarm.since) / s.wait)));
  return doubled ? `${s.job.id}:quiet:${doubled}` : s.job.id;
}

export function checkSilentTurns(ctx: Ctx, now = new Date()): Promise<void> {
  const prev = silentChains.get(ctx) ?? Promise.resolve();
  const run = prev.then(async () => {
    const busy = await busyAgentIds(ctx);
    const silent = await findSilentTurns(ctx, now);
    const unavailable = new Set([...busy, ...silent.map(s => s.agent.id)]);
    for (const s of silent) await sendTurnAlarm(ctx, s, unavailable, now);
  });
  const settled = run.catch(() => undefined);
  silentChains.set(ctx, settled);
  return run;
}
export { agentProgramState, clearTurnProgram, programGoneSince, signInTurn } from './program-state.js';
