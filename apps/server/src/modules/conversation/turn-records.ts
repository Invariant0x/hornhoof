import { only } from '../../db/selections.js';
import { and, eq, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
/* The turn that goes on from this one's words, whichever way it came: a retry after a restart or a continuation. */
export async function turnGoingOn(ctx: Ctx, jobId: string): Promise<{ id: string; error: string | null } | null> {
  const [next] = await ctx.db.select({ id: jobs.id, error: jobs.error }).from(jobs).where(or(eq(jobs.retryOf, jobId), eq(jobs.continueOf, jobId))).limit(1);
  return next ?? null;
}

/* A turn its words went into as it ran. */
export async function runsNow(ctx: Ctx, jobId: string): Promise<boolean> {
  const [job] = await ctx.db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, jobId));
  return job?.status === 'running';
}

/* Thrown before anything is stored, so the caller may undo what it did for the turn. */
export class NoSubscription extends Error {
  constructor() {
    super('The agent has no subscription.');
  }
}

export async function orchestratorOf(ctx: Ctx, companyId: string) {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator')));
  return agent ?? null;
}
