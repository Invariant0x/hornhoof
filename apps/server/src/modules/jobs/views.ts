import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { jobs, machines, nodes, subscriptions, type JOB_STATUSES } from '../../db/schema.js';

type Job = typeof jobs.$inferSelect;

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
export async function jobView(db: Db, id: string): Promise<(JobView & { subscriptionId: string; ownerId: string; createdBy: string | null; companyId: string; kind: Job['kind']; agentId: string | null }) | null> {
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
      companyId: jobs.companyId,
      kind: jobs.kind,
      agentId: jobs.agentId,
    })
    .from(jobs)
    .innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId))
    .leftJoin(nodes, eq(nodes.id, jobs.nodeId))
    .leftJoin(machines, eq(machines.id, nodes.machineId))
    .where(eq(jobs.id, id));
  return row ? { ...row, machine: row.machine ?? null } : null;
}

export const publicJob = ({ subscriptionId: _s, ownerId: _o, createdBy: _c, companyId: _co, kind: _k, agentId: _a, ...view }: NonNullable<Awaited<ReturnType<typeof jobView>>>): JobView => view;
