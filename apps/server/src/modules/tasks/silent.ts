import { lastBytes, type JobState } from '@hornhoof/protocol';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx, Db } from '../../app.js';
import { agentEvents, agents, departments, jobs, subscriptions, taskEvents, tasks } from '../../db/schema.js';
import { enqueueTurn, liveSubscription, orchestratorOf } from '../conversation/queue.js';
import { publishWorking } from '../events/store.js';
import { identityOf, type NodeIdentity } from '../nodes/hub.js';
import { afterJob } from './wake.js';

export const SILENT_CHECK_MS = 10 * 60_000;
export const SILENT_TURN_MS = 30 * 60_000;
export const SILENT_ORCHESTRATOR_MS = 2 * 3_600_000;

type Agent = typeof agents.$inferSelect;
type Job = typeof jobs.$inferSelect;
type Threshold = '30m' | '2h';
type TurnActivity = { lastAt: Date; lastText: string; openTool: { name: string; at: Date } | null };
type SilentTurn = {
  job: Job;
  agent: Agent;
  task: { id: string; number: number; title: string } | null;
  lastAt: Date;
  openTool: { name: string; at: Date } | null;
  closed: boolean;
};

const LOST_ENDING_TAIL = 'Turn closed after waiting at its prompt without events (lost_ending).';
const alertedTurns = new WeakMap<Ctx, Set<string>>();
const silentChains = new WeakMap<Ctx, Promise<void>>();

function alertedSet(ctx: Ctx): Set<string> {
  const set = alertedTurns.get(ctx) ?? new Set<string>();
  alertedTurns.set(ctx, set);
  return set;
}

const alarmKey = (jobId: string, threshold: Threshold) => `${jobId}:${threshold}`;

async function alreadyAlerted(ctx: Ctx, jobId: string, threshold: Threshold): Promise<boolean> {
  const key = alarmKey(jobId, threshold);
  const seen = alertedSet(ctx);
  if (seen.has(key)) return true;
  const [row] = await ctx.db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(and(eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->>'silentJob' = ${jobId}`, sql`${agentEvents.data}->>'silentThreshold' = ${threshold}`))
    .limit(1);
  if (row) seen.add(key);
  return Boolean(row);
}

export async function lastTurnEventAt(db: Db, job: { id: string; agentId: string; startedAt: Date | null; createdAt: Date }): Promise<Date> {
  return (await turnActivity(db, job)).lastAt;
}

function stepToolState(openTools: { name: string; at: Date }[], kind: string, data: unknown, at: Date): void {
  if (kind === 'tool') {
    const name = typeof (data as { name?: unknown })?.name === 'string' ? (data as { name: string }).name : 'tool';
    openTools.push({ name, at });
  } else if (kind === 'tool_result') {
    openTools.shift();
  } else if (kind === 'text') {
    openTools.length = 0;
  }
}

async function turnActivity(db: Db, job: { id: string; agentId: string; startedAt: Date | null; createdAt: Date }): Promise<TurnActivity> {
  const startedAt = job.startedAt ?? job.createdAt;
  const rows = await db
    .select({ kind: agentEvents.kind, data: agentEvents.data, at: agentEvents.createdAt })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, job.agentId), ne(agentEvents.kind, 'message'), or(eq(agentEvents.jobId, job.id), gte(agentEvents.createdAt, startedAt))))
    .orderBy(asc(agentEvents.createdAt), asc(agentEvents.seq));
  let lastAt = startedAt;
  let lastText = '';
  const openTools: { name: string; at: Date }[] = [];
  for (const r of rows) {
    if (r.at > lastAt) lastAt = r.at;
    if (r.kind === 'text' && typeof (r.data as { text?: unknown })?.text === 'string') lastText = (r.data as { text: string }).text;
    stepToolState(openTools, r.kind, r.data, r.at);
  }
  return { lastAt, lastText, openTool: openTools[openTools.length - 1] ?? null };
}

async function askNodeState(ctx: Ctx, job: Job): Promise<void> {
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const node = sub ? identityOf(sub, job.nodeId) : null;
  if (node) ctx.hub.send(node, { type: 'job.check', jobId: job.id });
}

async function closeLostEnding(ctx: Ctx, job: Job, lastText: string, now: Date): Promise<boolean> {
  const tail = lastBytes(job.tail ? `${job.tail}\n${LOST_ENDING_TAIL}` : LOST_ENDING_TAIL);
  const [ended] = await ctx.db
    .update(jobs)
    .set({ status: 'failed', error: 'lost_ending', result: lastText, tail, finishedAt: now })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')))
    .returning({ id: jobs.id });
  if (!ended) return false;
  if (job.taskId) {
    await ctx.db.insert(taskEvents).values({
      companyId: job.companyId,
      taskId: job.taskId,
      kind: 'interrupted',
      agentId: job.agentId,
      text: `Turn ${job.id} waited at its prompt without events and was closed (lost_ending).`,
      data: { job: job.id, reason: 'lost_ending', error: 'lost_ending' },
      createdAt: now,
    });
  }
  await publishWorking(ctx, job.companyId);
  await afterJob(ctx, job.id);
  return true;
}

export async function handleJobState(ctx: Ctx, _id: NodeIdentity, jobId: string, state: JobState, now: Date, scope: SQL): Promise<void> {
  if (state !== 'waiting' && state !== 'gone') return;
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.kind, 'conversation'), scope));
  if (!job?.agentId) return;
  const activity = await turnActivity(ctx.db, { ...job, agentId: job.agentId });
  if (activity.openTool) return;
  await closeLostEnding(ctx, job, activity.lastText, now);
}

const isWatchdogOrTimerTurn = (agent: Agent, job: { taskId: string | null }) =>
  agent.roleKey === 'OPS-WATCH' || (agent.timerMinutes !== null && job.taskId === null);

async function closeWatchdogTurn(ctx: Ctx, job: Job, lastText: string, now: Date): Promise<boolean> {
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const node = sub ? identityOf(sub, job.nodeId) : null;
  if (node) ctx.hub.send(node, { type: 'job.cancel', jobId: job.id });
  return closeLostEnding(ctx, job, lastText || 'Stopped after 30 minutes without events.', now);
}

async function inspectRunningTurn(
  ctx: Ctx,
  row: { job: Job; agent: Agent; task: { id: string; number: number; title: string } | null },
  now: Date,
): Promise<SilentTurn | null> {
  const { job, agent, task } = row;
  const activity = await turnActivity(ctx.db, { ...job, agentId: agent.id });
  const silentMs = now.getTime() - activity.lastAt.getTime();
  if (silentMs < SILENT_CHECK_MS) return null;
  if (!activity.openTool) await askNodeState(ctx, job);
  if (silentMs < SILENT_TURN_MS) return null;
  const closed = !activity.openTool && isWatchdogOrTimerTurn(agent, job) && (await closeWatchdogTurn(ctx, job, activity.lastText, now));
  return { job, agent, task: task?.id ? task : null, lastAt: activity.lastAt, openTool: activity.openTool, closed };
}

async function findSilentTurns(ctx: Ctx, now: Date, onlyAgentId?: string): Promise<SilentTurn[]> {
  const rows = await ctx.db
    .select({ job: jobs, agent: agents, task: { id: tasks.id, number: tasks.number, title: tasks.title } })
    .from(jobs)
    .innerJoin(agents, eq(agents.id, jobs.agentId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(
      and(
        eq(jobs.kind, 'conversation'),
        eq(jobs.status, 'running'),
        onlyAgentId ? eq(jobs.agentId, onlyAgentId) : undefined,
        or(ne(jobs.prompt, ''), isNotNull(jobs.taskId), isNotNull(jobs.createdBy)),
      ),
    )
    .orderBy(asc(jobs.createdAt));
  const silent: SilentTurn[] = [];
  for (const row of rows) {
    const found = await inspectRunningTurn(ctx, row, now);
    if (found) silent.push(found);
  }
  return silent;
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

function alarmBody(s: SilentTurn, mins: number): string {
  if (s.openTool) return `Tool ${s.openTool.name} has been running for ${mins} minutes without a result.`;
  if (s.closed) return `Hornhoof closed turn ${s.job.id} so ${s.agent.name}'s timer can go on. Check why it stalled.`;
  return `Check ${s.agent.name} and nudge it with message_employee or tell your head.`;
}

function silentAlarmText(ctx: Ctx, s: SilentTurn, now: Date): string {
  const who = agentLabel(ctx, s.agent);
  const where = s.task ? `on #${s.task.number} "${s.task.title}"` : 'outside any task';
  const mins = Math.floor((now.getTime() - s.lastAt.getTime()) / 60_000);
  const iso = s.lastAt.toISOString();
  return `Hornhoof: ${who} has had no events for ${mins} minutes in turn ${s.job.id} (${where}). Last event: ${when(iso)} (${iso}). ${alarmBody(s, mins)}`;
}

async function dispatchAlarm(ctx: Ctx, s: SilentTurn, to: Agent, threshold: Threshold, now: Date): Promise<void> {
  if (await alreadyAlerted(ctx, s.job.id, threshold)) return;
  alertedSet(ctx).add(alarmKey(s.job.id, threshold));
  const text = silentAlarmText(ctx, s, now);
  const task = s.task ? { id: s.task.id, number: s.task.number } : undefined;
  const tool = s.openTool ? { tool: s.openTool.name } : undefined;
  const alarmId = await enqueueTurn(ctx, {
    companyId: s.job.companyId,
    agentId: to.id,
    prompt: text,
    createdBy: null,
    message: { personId: null, text, ...(task ? { task } : {}), ...(tool ?? {}), silentJob: s.job.id, silentThreshold: threshold },
  });
  if (now.getTime() > Date.now()) {
    await ctx.db.update(jobs).set({ startedAt: now }).where(and(eq(jobs.id, alarmId), eq(jobs.status, 'running')));
  }
}

async function sendTurnAlarms(ctx: Ctx, s: SilentTurn, unavailable: ReadonlySet<string>, now: Date): Promise<void> {
  const able = await operationsWatchers(ctx, s.job.companyId);
  const opsTo = pickOpsRecipient(able, s.agent.id, unavailable);
  if (opsTo) await dispatchAlarm(ctx, s, opsTo, '30m', now);
  if (now.getTime() - s.lastAt.getTime() < SILENT_ORCHESTRATOR_MS) return;
  const orch = await orchestratorOf(ctx, s.job.companyId);
  if (orch && orch.id !== s.agent.id) await dispatchAlarm(ctx, s, orch, '2h', now);
}

export function checkSilentTurns(ctx: Ctx, now = new Date(), onlyAgentId?: string): Promise<void> {
  const prev = silentChains.get(ctx) ?? Promise.resolve();
  const run = prev.then(async () => {
    const busy = await busyAgentIds(ctx);
    const silent = await findSilentTurns(ctx, now, onlyAgentId);
    const unavailable = new Set([...busy, ...silent.map(s => s.agent.id)]);
    for (const s of silent) await sendTurnAlarms(ctx, s, unavailable, now);
  });
  const settled = run.catch(() => undefined);
  silentChains.set(ctx, settled);
  return run;
}
