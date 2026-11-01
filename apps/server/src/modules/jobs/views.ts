import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { jobs, machines, subscriptions, type JOB_STATUSES } from '../../db/schema.js';

export type JobView = {
  id: string;
  status: (typeof JOB_STATUSES)[number];
  result: string | null;
  tail: string;
  error: string | null;
  machine: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/* The job with the hostname of the machine its subscription runs on. The prompt and session stay on the server. */
export async function jobView(db: Db, id: string): Promise<(JobView & { subscriptionId: string; ownerId: string; createdBy: string | null }) | null> {
  const [row] = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      result: jobs.result,
      tail: jobs.tail,
      error: jobs.error,
      machine: machines.hostname,
      createdAt: jobs.createdAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      subscriptionId: jobs.subscriptionId,
      ownerId: subscriptions.ownerPersonId,
      createdBy: jobs.createdBy,
    })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .leftJoin(machines, eq(machines.id, subscriptions.machineId))
    .where(eq(jobs.id, id));
  return row ? { ...row, machine: row.machine ?? null } : null;
}

export const publicJob = ({ subscriptionId: _s, ownerId: _o, createdBy: _c, ...view }: NonNullable<Awaited<ReturnType<typeof jobView>>>): JobView => view;

export const JOB_METADATA_MAX_ROWS = 40;

export type JobMetadata = {
  id: string;
  kind: (typeof jobs.$inferSelect)['kind'];
  status: (typeof JOB_STATUSES)[number];
  error: string | null;
  subscription_id: string;
  session_id: string | null;
  instructions_hash: string | null;
  created_by: string | null;
  task_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  prompt_characters: number;
  prompt_md5: string;
  empty_start: boolean;
  recovery_prefix: boolean;
  predecessor_before_window: boolean;
};

/* Bounded diagnostic metadata only. Prompt text, results, tails and tool tokens stay in the database. */
export async function jobMetadata(db: Db, agentId: string, from: string, to: string): Promise<JobMetadata[]> {
  const result = await db.execute<JobMetadata>(sql`
    WITH bounds AS (
      SELECT ${agentId}::uuid AS agent_id, ${from}::timestamptz AS lo, ${to}::timestamptz AS hi
    ), predecessor AS (
      SELECT j.id FROM public.jobs j CROSS JOIN bounds b
      WHERE j.agent_id = b.agent_id AND j.kind = 'conversation'
        AND j.finished_at < b.lo
        AND (j.status = 'done' OR (j.status = 'failed' AND j.error IN ('timeout', 'cancelled') AND j.session_id IS NOT NULL))
      ORDER BY j.finished_at DESC LIMIT 1
    ), rows AS (
      SELECT j.id, j.kind, j.status, j.error, j.subscription_id, j.session_id,
             j.instructions_hash, j.created_by, j.task_id,
             to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
             to_char(j.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
             to_char(j.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at,
             char_length(j.prompt) AS prompt_characters,
             md5(j.prompt) AS prompt_md5,
             (j.prompt = '') AS empty_start,
             (j.prompt LIKE 'Earlier in this conversation, in another session you cannot see:%') AS recovery_prefix,
             (j.id IN (SELECT id FROM predecessor)) AS predecessor_before_window
      FROM public.jobs j CROSS JOIN bounds b
      WHERE j.agent_id = b.agent_id
        AND (j.created_at BETWEEN b.lo AND b.hi
          OR j.started_at BETWEEN b.lo AND b.hi
          OR j.finished_at BETWEEN b.lo AND b.hi
          OR j.id IN (SELECT id FROM predecessor))
      ORDER BY j.created_at, j.id
      LIMIT ${JOB_METADATA_MAX_ROWS + 1}
    )
    SELECT * FROM rows
  `);
  return (result as { rows: JobMetadata[] }).rows;
}
