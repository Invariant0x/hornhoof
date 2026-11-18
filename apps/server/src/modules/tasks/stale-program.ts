import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, subscriptions, tasks, type jobs } from '../../db/schema.js';
import { publishWorking } from '../events/store.js';
import { identityOf, ownBuiltin } from '../nodes/hub.js';
import { agentProgramState, clearTurnProgram } from './program-state.js';
import { recordStale, repeatWake } from './wake-state.js';

/* The same policy that discards queued wakes also stops obsolete running work before a restart or an alarm. */
export async function stopStaleProgram(ctx: Ctx, job: typeof jobs.$inferSelect, run: string): Promise<boolean> {
  if (!job.taskId || !job.agentId) return false;
  const [found] = await ctx.db.select({ task: tasks, agent: agents }).from(tasks).innerJoin(agents, eq(agents.id, job.agentId)).where(eq(tasks.id, job.taskId));
  if (!found || await repeatWake(ctx.db, { job, ...found }, run)) return false;
  const program = agentProgramState(ctx, job).program;
  if (await recordStale(ctx.db, job.id, job.agentId, found.task, run, 'running', program)) {
    const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
    const node = sub && identityOf(sub, job.nodeId, job.builtinMachine, ownBuiltin(ctx.config));
    if (node) ctx.hub.send(node, { type: 'job.cancel', jobId: job.id });
    clearTurnProgram(ctx, job.id);
    await publishWorking(ctx, job.companyId);
  }
  return true;
}
