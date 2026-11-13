import { TOOL_QUIET_ALARM_MS, type TurnProgram } from '@hornhoof/protocol/map';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs, nodeConnections, nodes, tasks, testParts, testRuns } from '../../db/schema.js';
import { jobCheckLastEnd, jobCheckQueued } from '../nodes/check-slots.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { agentProgramState, signInTurn, SILENT_TURN_MS } from '../tasks/silent.js';

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

async function lastTakenWorkAt(ctx: Ctx, node: NodeIdentity, runningJobs: RunningJob[], runningParts: RunningPart[]): Promise<number | null> {
  const jobWhere = node.kind === 'builtin' ? isNull(jobs.nodeId) : eq(jobs.nodeId, node.nodeId);
  const partWhere = node.kind === 'builtin' ? eq(testParts.builtin, true) : eq(testParts.nodeId, node.nodeId);
  const [lastJob] = await ctx.db
    .select({ startedAt: jobs.startedAt, restartedAt: jobs.restartedAt })
    .from(jobs)
    .where(and(jobWhere, isNotNull(jobs.startedAt)))
    .orderBy(desc(jobs.startedAt))
    .limit(1);
  const [lastPart] = await ctx.db
    .select({ startedAt: testParts.startedAt })
    .from(testParts)
    .where(and(partWhere, isNotNull(testParts.startedAt)))
    .orderBy(desc(testParts.startedAt))
    .limit(1);
  return latest([
    ...runningJobs.map(jobTakenAt),
    ...runningParts.map(p => (p.startedAt ?? p.queuedAt).getTime()),
    lastJob?.startedAt?.getTime(),
    lastJob?.restartedAt?.getTime(),
    lastPart?.startedAt?.getTime(),
  ]);
}

async function persistedNodeSignAt(ctx: Ctx, node: NodeIdentity): Promise<number | null> {
  if (node.kind === 'builtin') return null;
  const [row] = await ctx.db.select({ lastSeenAt: nodes.lastSeenAt }).from(nodes).where(eq(nodes.id, node.nodeId));
  const [conn] = await ctx.db
    .select({ connectedAt: nodeConnections.connectedAt })
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

function isConversationLive(
  ctx: Ctx,
  job: RunningJob,
  externalUntil: string | null,
  activityAt: number | undefined,
  now: number,
): boolean {
  if (externalUntil && Date.parse(externalUntil) > now) return true;
  if (jobCheckQueued(ctx, job.id, now)) return true;
  const program = agentProgramState(ctx, job).program;
  if (program?.state === 'asking') return (job.startedAt ?? job.createdAt).getTime() + job.timeoutMs > now;
  if (programStuck(program, now)) return false;
  const limit = program?.state === 'tool' ? TOOL_QUIET_ALARM_MS : SILENT_TURN_MS;
  const lastSign = latest([programLiveSign(job, program), job.restartedAt?.getTime(), jobCheckLastEnd(ctx, job.id, now), activityAt])!;
  return now - lastSign < limit;
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
  const runningJobs = await ctx.db.select().from(jobs).where(and(eq(jobs.status, 'running'), jobWhere));
  const runningParts = await ctx.db
    .select({ startedAt: testParts.startedAt, queuedAt: testParts.queuedAt, timeoutMs: testRuns.timeoutMs })
    .from(testParts)
    .innerJoin(testRuns, eq(testRuns.id, testParts.runId))
    .where(and(eq(testParts.status, 'running'), partWhere));
  return { runningJobs, runningParts };
}

/* Whether running work on this node still holds a planned update back: a node silent past SILENT_TURN_MS or one that has
   taken no work for a full drain-and-retry cycle without any genuinely live turn or test part updates without waiting. */
export async function hasLiveDrainWork(ctx: Ctx, node: NodeIdentity, now: number): Promise<boolean> {
  const { runningJobs, runningParts } = await runningWorkOf(ctx, node);
  if (!runningJobs.length && !runningParts.length) return false;
  const activity = await latestTurnActivityAt(ctx, runningJobs.map(j => j.id));
  const takenAt = await lastTakenWorkAt(ctx, node, runningJobs, runningParts);
  const reportedAt = runningJobs.map(j => agentProgramState(ctx, j).program?.reportedAt);
  const nodeSignAt = latest([ctx.hub.lastSeenAt(node), ctx.hub.loadOf(node)?.at, await persistedNodeSignAt(ctx, node), ...reportedAt, ...activity.values()]) ?? takenAt;
  if (nodeSignAt !== null && now - nodeSignAt >= SILENT_TURN_MS) return false;
  const noWorkLimit = ctx.config.nodeDrainMs + ctx.config.nodeUpdateRetryMs;
  if (takenAt !== null && now - takenAt < noWorkLimit) return true;
  if (runningParts.some(p => (p.startedAt ?? p.queuedAt).getTime() + p.timeoutMs + TEST_PART_LATE_MS > now)) return true;
  const taskIds = [...new Set(runningJobs.flatMap(j => (j.taskId ? [j.taskId] : [])))];
  const externalWaits = await externalWaitByTask(ctx, taskIds);
  return runningJobs.some(j =>
    j.kind === 'conversation'
      ? isConversationLive(ctx, j, j.taskId ? (externalWaits.get(j.taskId) ?? null) : null, activity.get(j.id), now)
      : (j.startedAt ?? j.createdAt).getTime() + j.timeoutMs > now,
  );
}
