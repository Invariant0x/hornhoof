import { eq } from 'drizzle-orm';
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
