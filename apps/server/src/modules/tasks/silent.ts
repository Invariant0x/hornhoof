import { PROGRAM_SCREEN_MAX, QUIET_ALARM_MS, type NodeMessage } from '@hornhoof/protocol';
import type { TurnAlarm, TurnAlarmReason, TurnProgram } from '@hornhoof/protocol/map';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, departments, jobs, tasks } from '../../db/schema.js';
import { enqueueTurn, liveSubscription } from '../conversation/queue.js';

export const SILENT_TURN_MS = QUIET_ALARM_MS;

export type { TurnAlarm, TurnAlarmReason, TurnProgram } from '@hornhoof/protocol/map';

type Agent = typeof agents.$inferSelect;
type Job = typeof jobs.$inferSelect;
type ProgramReport = Extract<NodeMessage, { type: 'job.program' }>;
type GoneProgram = { state: 'gone'; exitCode: number | null; signal: string | null; screen: string | null };
type StoredProgram = { program: TurnProgram; gone: GoneProgram | null };
type SilentTurn = {
  job: Job;
  agent: Agent;
  task: { id: string; number: number; title: string } | null;
  program: TurnProgram | null;
  alarm: TurnAlarm;
};

const turnPrograms = new WeakMap<Ctx, Map<string, StoredProgram>>();
const turnAlarms = new WeakMap<Ctx, Map<string, TurnAlarm>>();
const alertedTurns = new WeakMap<Ctx, Set<string>>();
const silentChains = new WeakMap<Ctx, Promise<void>>();

function mapOf<V>(store: WeakMap<Ctx, Map<string, V>>, ctx: Ctx): Map<string, V> {
  const map = store.get(ctx) ?? new Map<string, V>();
  store.set(ctx, map);
  return map;
}

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
    .select({ id: jobs.id, companyId: jobs.companyId })
    .from(jobs)
    .where(and(eq(jobs.id, msg.jobId), eq(jobs.status, 'running'), eq(jobs.kind, 'conversation'), scope));
  if (!job) return;
  mapOf(turnPrograms, ctx).set(job.id, { program: programOf(msg, now), gone: goneProgram(msg) });
  ctx.bus.publish(job.companyId, { type: 'org' });
}

const programOf = (msg: ProgramReport, now: Date): TurnProgram => ({ state: msg.state, since: msg.since, tool: msg.tool ?? null, screenAt: msg.screenAt, reportedAt: now.getTime() });

function goneProgram(msg: ProgramReport): GoneProgram | null {
  if (msg.state !== 'gone') return null;
  return { state: 'gone', exitCode: msg.exitCode ?? null, signal: msg.signal ?? null, screen: msg.screen?.slice(-PROGRAM_SCREEN_MAX) || null };
}

/* Take the end's details before clearing the live state; they belong to the failed event, not to the next turn. */
export function clearTurnProgram(ctx: Ctx, jobId: string): GoneProgram | null {
  const gone = mapOf(turnPrograms, ctx).get(jobId)?.gone ?? null;
  mapOf(turnPrograms, ctx).delete(jobId);
  mapOf(turnAlarms, ctx).delete(jobId);
  return gone;
}

export function failedProgramData(error: string | null, program: GoneProgram | null): { error: string | null; program?: GoneProgram; text?: string } {
  if (!program) return { error };
  const text = `No program. Exit code: ${program.exitCode ?? 'no data'}. Signal: ${program.signal ?? 'no data'}. Last screen:\n${program.screen ?? 'no data'}`;
  return { error, program, text };
}

export function agentProgramState(
  ctx: Ctx,
  running: { id: string } | null | undefined,
  visible?: boolean,
): { program: TurnProgram | null; alarm: TurnAlarm | null } {
  if (visible === false || !running) return { program: null, alarm: null };
  return {
    program: mapOf(turnPrograms, ctx).get(running.id)?.program ?? null,
    alarm: mapOf(turnAlarms, ctx).get(running.id) ?? null,
  };
}

function alarmForProgram(program: TurnProgram, nowMs: number): TurnAlarm | null {
  if (nowMs - program.reportedAt >= SILENT_TURN_MS) return { reason: 'node_silent', since: program.reportedAt };
  const lastChange = Math.max(program.since, program.screenAt);
  return nowMs - lastChange >= SILENT_TURN_MS ? { reason: 'program_stalled', since: lastChange } : null;
}

function alarmForTurn(job: Job, program: TurnProgram | null, nowMs: number): TurnAlarm | null {
  if (program) return alarmForProgram(program, nowMs);
  const startedAt = (job.startedAt ?? job.createdAt).getTime();
  return nowMs - startedAt >= SILENT_TURN_MS ? { reason: 'node_silent', since: startedAt } : null;
}

function alarmForTask(job: Job, program: TurnProgram | null, task: { externalWait: typeof tasks.$inferSelect.externalWait } | null, nowMs: number): TurnAlarm | null {
  return task?.externalWait ? null : alarmForTurn(job, program, nowMs);
}

const sameAlarm = (a: TurnAlarm | null, b: TurnAlarm | null) => a?.reason === b?.reason && a?.since === b?.since;

function updateTurnAlarm(ctx: Ctx, job: Job, alarm: TurnAlarm | null): void {
  const alarms = mapOf(turnAlarms, ctx);
  const prev = alarms.get(job.id) ?? null;
  if (alarm) alarms.set(job.id, alarm);
  else alarms.delete(job.id);
  if (!sameAlarm(prev, alarm)) ctx.bus.publish(job.companyId, { type: 'org' });
}

async function findSilentTurns(ctx: Ctx, now: Date): Promise<SilentTurn[]> {
  const rows = await ctx.db
    .select({ job: jobs, agent: agents, task: { id: tasks.id, number: tasks.number, title: tasks.title, externalWait: tasks.externalWait } })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(
      and(
        eq(jobs.kind, 'conversation'),
        eq(jobs.status, 'running'),
        or(ne(jobs.prompt, ''), isNotNull(jobs.taskId), isNotNull(jobs.createdBy)),
      ),
    )
    .orderBy(asc(jobs.createdAt));
  const programs = mapOf(turnPrograms, ctx);
  const nowMs = now.getTime();
  const silent: SilentTurn[] = [];
  for (const { job, agent, task } of rows) {
    const program = programs.get(job.id)?.program ?? null;
    const alarm = alarmForTask(job, program, task, nowMs);
    updateTurnAlarm(ctx, job, alarm);
    if (alarm) silent.push({ job, agent, task: task?.id ? task : null, program, alarm });
  }
  return silent;
}

async function alreadyAlerted(ctx: Ctx, jobId: string): Promise<boolean> {
  const seen = alertedSet(ctx);
  if (seen.has(jobId)) return true;
  const [row] = await ctx.db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(and(eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'silentJob' = ${jobId}`))
    .limit(1);
  if (row) seen.add(jobId);
  return Boolean(row);
}

async function operationsWatchers(ctx: Ctx, companyId: string): Promise<Agent[]> {
  const ops = ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const rows = await ctx.db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        or(
          inArray(agents.departmentId, ops),
          inArray(agents.departmentId, ctx.db.select({ id: departments.id }).from(departments).where(inArray(departments.parentId, ops))),
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
    .select({ agentId: jobs.agentId })
    .from(jobs)
    .where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'), isNotNull(jobs.agentId)));
  return new Set(rows.map(r => r.agentId!));
}

const isFreeWatchdog = (a: Agent, stuckId: string, unavailable: ReadonlySet<string>) =>
  a.roleKey === 'OPS-WATCH' && a.id !== stuckId && !unavailable.has(a.id);
const isOpsHead = (a: Agent, stuckId: string) => (a.kind === 'head' || a.roleKey === 'OPS-HEAD') && a.id !== stuckId;

function pickOpsRecipient(able: Agent[], stuckAgentId: string, unavailable: ReadonlySet<string>): Agent | null {
  return able.find(a => isFreeWatchdog(a, stuckAgentId, unavailable)) ?? able.find(a => isOpsHead(a, stuckAgentId)) ?? null;
}

const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

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

const reasonLabel = (reason: TurnAlarmReason) =>
  reason === 'program_stalled'
    ? 'program_stalled (program state and screen unchanged for 30 minutes)'
    : 'node_silent (node has not reported for 30 minutes)';

function silentAlarmText(ctx: Ctx, s: SilentTurn): string {
  const who = agentLabel(ctx, s.agent);
  const where = s.task ? `on #${s.task.number} "${s.task.title}"` : 'outside any task';
  const iso = new Date(s.alarm.since).toISOString();
  return (
    `Hornhoof: ${who} triggered a 30-minute turn alarm in turn ${s.job.id} (${where}). ` +
    `Program state: ${programLabel(s.program)}. Last change: ${when(iso)} (${iso}). ` +
    `Reason: ${reasonLabel(s.alarm.reason)}. Check ${s.agent.name} and nudge it with message_employee or tell your head.`
  );
}

async function dispatchAlarm(ctx: Ctx, s: SilentTurn, to: Agent, now: Date): Promise<void> {
  if (await alreadyAlerted(ctx, s.job.id)) return;
  const text = silentAlarmText(ctx, s);
  const task = s.task ? { id: s.task.id, number: s.task.number } : undefined;
  const alarmId = await enqueueTurn(ctx, {
    companyId: s.job.companyId,
    agentId: to.id,
    prompt: text,
    createdBy: null,
    message: { personId: null, text, ...(task ? { task } : {}), silentJob: s.job.id, silentReason: s.alarm.reason },
  });
  alertedSet(ctx).add(s.job.id);
  if (now.getTime() > Date.now()) {
    await ctx.db.update(jobs).set({ startedAt: now }).where(and(eq(jobs.id, alarmId), eq(jobs.status, 'running')));
  }
}

async function sendTurnAlarm(ctx: Ctx, s: SilentTurn, unavailable: ReadonlySet<string>, now: Date): Promise<void> {
  const able = await operationsWatchers(ctx, s.job.companyId);
  const opsTo = pickOpsRecipient(able, s.agent.id, unavailable);
  if (opsTo) await dispatchAlarm(ctx, s, opsTo, now);
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
