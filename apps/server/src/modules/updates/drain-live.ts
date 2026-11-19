import { TOOL_QUIET_ALARM_MS, type TurnProgram } from '@hornhoof/protocol/map';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs, nodeConnections, nodes, tasks, testParts, testRuns } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { jobCheckLastEnd, jobCheckQueued } from '../nodes/check-slots.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { agentProgramState, signInTurn } from '../tasks/program-state.js';
import { SILENT_TURN_MS } from '../tasks/silent.js';
import { notStep } from '../tools/steps.js';

/* Same grace window checkTestTimes grants a running test part past its run timeout. */
const TEST_PART_LATE_MS = 2 * 60_000;
const TURN_ACTIVITY_KINDS = ['text', 'tool', 'tool_result', 'todo', 'proposal', 'applied', 'typed'] as const;

type RunningJob = typeof jobs.$inferSelect;
type RunningPart = { startedAt: Date | null; queuedAt: Date; timeoutMs: number };

function latest(times: Array<number | null | undefined>): number | null {
  const valid = times.filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  return valid.length ? Math.max(...valid) : null;
}

const jobTakenAt = (job: Pick<RunningJob, 'startedAt' | 'createdAt' | 'restartedAt'>): number =>
  Math.max((job.startedAt ?? job.createdAt).getTime(), job.restartedAt?.getTime() ?? 0);

/* When the node took the newest of the work it runs now. Work it took and ended says nothing of the turns it lost: a busy
   node takes and ends turns of other agents the whole time those hang. */
function lastTakenWorkAt(runningJobs: RunningJob[], runningParts: RunningPart[]): number | null {
  return latest([...runningJobs.map(jobTakenAt), ...runningParts.map(p => (p.startedAt ?? p.queuedAt).getTime())]);
}

async function persistedNodeSignAt(ctx: Ctx, node: NodeIdentity): Promise<number | null> {
  if (node.kind === 'builtin') return null;
  const [row] = await ctx.db.select(only(nodes, 'lastSeenAt')).from(nodes).where(eq(nodes.id, node.nodeId));
  const [conn] = await ctx.db
    .select(only(nodeConnections, 'connectedAt'))
    .from(nodeConnections)
    .where(eq(nodeConnections.nodeId, node.nodeId))
    .orderBy(desc(nodeConnections.connectedAt))
    .limit(1);
  return latest([row?.lastSeenAt?.getTime(), conn?.connectedAt.getTime()]);
}

async function latestTurnActivityAt(ctx: Ctx, jobIds: string[]): Promise<Map<string, number>> {
  const byJob = new Map<string, number>();
  if (!jobIds.length) return byJob;
  const rows = await ctx.db
    .select({ jobId: agentEvents.jobId, createdAt: agentEvents.createdAt })
    .from(agentEvents)
    .where(and(inArray(agentEvents.jobId, jobIds), inArray(agentEvents.kind, [...TURN_ACTIVITY_KINDS])))
    .orderBy(desc(agentEvents.createdAt));
  for (const row of rows) {
    if (row.jobId && !byJob.has(row.jobId)) byJob.set(row.jobId, row.createdAt.getTime());
  }
  return byJob;
}

function programLiveSign(job: RunningJob, program: TurnProgram | null): number {
  if (!program) return (job.startedAt ?? job.createdAt).getTime();
  const sign = signInTurn(program, job);
  return sign !== null ? sign : Math.max(program.since, program.screenAt);
}

function programStuck(program: TurnProgram | null, now: number): boolean {
  if (!program) return false;
  if (program.state === 'gone' || program.state === 'idle') return true;
  return program.state === 'retrying' && now - program.since >= SILENT_TURN_MS;
}

/* A turn that waits for something outside it: the external wait of its task, or a check of its own in line. */
function turnWaitsOutside(ctx: Ctx, job: RunningJob, externalUntil: string | null, now: number): boolean {
  return (!!externalUntil && Date.parse(externalUntil) > now) || jobCheckQueued(ctx, job.id, now);
}

/* The newest sign of a turn: of its program, a restart, the end of a check of its own, or a step it took. */
function lastTurnSign(ctx: Ctx, job: RunningJob, program: TurnProgram | null, activityAt: number | undefined, now: number): number {
  return latest([programLiveSign(job, program), job.restartedAt?.getTime(), jobCheckLastEnd(ctx, job.id, now), activityAt])!;
}

function isConversationLive(
  ctx: Ctx,
  job: RunningJob,
  externalUntil: string | null,
  activityAt: number | undefined,
  now: number,
): boolean {
  if (turnWaitsOutside(ctx, job, externalUntil, now)) return true;
  const program = agentProgramState(ctx, job).program;
  if (program?.state === 'asking') return jobTakenAt(job) + job.timeoutMs > now;
  if (programStuck(program, now)) return false;
  const limit = program?.state === 'tool' ? TOOL_QUIET_ALARM_MS : SILENT_TURN_MS;
  return now - lastTurnSign(ctx, job, program, activityAt, now) < limit;
}

async function externalWaitByTask(ctx: Ctx, taskIds: string[]): Promise<Map<string, string>> {
  const waits = new Map<string, string>();
  if (!taskIds.length) return waits;
  const rows = await ctx.db.select({ id: tasks.id, externalWait: tasks.externalWait }).from(tasks).where(inArray(tasks.id, taskIds));
  for (const row of rows) {
    if (row.externalWait?.until) waits.set(row.id, row.externalWait.until);
  }
  return waits;
}

async function runningWorkOf(ctx: Ctx, node: NodeIdentity): Promise<{ runningJobs: RunningJob[]; runningParts: RunningPart[] }> {
  const jobWhere = node.kind === 'builtin' ? isNull(jobs.nodeId) : eq(jobs.nodeId, node.nodeId);
  const partWhere = node.kind === 'builtin' ? eq(testParts.builtin, true) : eq(testParts.nodeId, node.nodeId);
  const runningJobs = await ctx.db.select().from(jobs).where(and(eq(jobs.status, 'running'), jobWhere, notStep));
  const runningParts = await ctx.db
    .select({ startedAt: testParts.startedAt, queuedAt: testParts.queuedAt, timeoutMs: testRuns.timeoutMs })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(and(eq(testParts.status, 'running'), partWhere));
  return { runningJobs, runningParts };
}

/* The newest sign of the node itself: a frame or its load since this server started, a connection the database keeps, a
   program report or a step of one of its turns. Without any, the time it took its newest running work. */
async function nodeSignAt(ctx: Ctx, node: NodeIdentity, runningJobs: RunningJob[], activity: Map<string, number>, takenAt: number | null): Promise<number | null> {
  const reportedAt = runningJobs.map(j => agentProgramState(ctx, j).program?.reportedAt);
  return latest([ctx.hub.lastSeenAt(node), ctx.hub.loadOf(node)?.at, await persistedNodeSignAt(ctx, node), ...reportedAt, ...activity.values()]) ?? takenAt;
}

/* An uncapped part stays live while its node reports in. A capped part also gets the grace after its limit. */
const partLive = (now: number) => (p: RunningPart): boolean =>
  p.timeoutMs === 0 ? p.startedAt !== null : (p.startedAt ?? p.queuedAt).getTime() + p.timeoutMs + TEST_PART_LATE_MS > now;

function jobLive(ctx: Ctx, job: RunningJob, externalUntil: string | null, activityAt: number | undefined, now: number): boolean {
  if (job.kind !== 'conversation') return job.timeoutMs === 0 || jobTakenAt(job) + job.timeoutMs > now;
  return isConversationLive(ctx, job, externalUntil, activityAt, now);
}

async function anyJobLive(ctx: Ctx, runningJobs: RunningJob[], activity: Map<string, number>, now: number): Promise<boolean> {
  const waits = await externalWaitByTask(ctx, [...new Set(runningJobs.flatMap(j => (j.taskId ? [j.taskId] : [])))]);
  return runningJobs.some(j => jobLive(ctx, j, j.taskId ? (waits.get(j.taskId) ?? null) : null, activity.get(j.id), now));
}

/* Work a node took this recently counts as live whatever it shows, as long as the node is heard from: an hour and three
   quarters, past the 99th percentile of the turns that ended well (5438 s in a week of them on 2026-11-04). */
const RECENT_WORK_MS = 105 * 60_000;

/* Whether running work on this node still holds a planned update back: a node silent past SILENT_TURN_MS, or one whose
   newest running work it took more than RECENT_WORK_MS ago without any genuinely live turn or test part, updates without
   waiting. */
export async function hasLiveDrainWork(ctx: Ctx, node: NodeIdentity, now: number): Promise<boolean> {
  const { runningJobs, runningParts } = await runningWorkOf(ctx, node);
  if (!runningJobs.length && !runningParts.length) return false;
  const activity = await latestTurnActivityAt(ctx, runningJobs.map(j => j.id));
  const takenAt = lastTakenWorkAt(runningJobs, runningParts);
  const signAt = await nodeSignAt(ctx, node, runningJobs, activity, takenAt);
  if (signAt !== null && now - signAt >= SILENT_TURN_MS) return false;
  if (takenAt !== null && now - takenAt < RECENT_WORK_MS) return true;
  return runningParts.some(partLive(now)) || anyJobLive(ctx, runningJobs, activity, now);
}
