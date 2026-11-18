import { and, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, tasks } from '../../db/schema.js';
import { ON_NODE } from '../jobs/requirements.js';
import { afterJob } from '../tasks/wake.js';
import { publishWorking } from '../events/store.js';
import { interruptionValue, type RestartCut } from './restart-evidence.js';
export const completionValue = (value: unknown, stopped: string | null): SQL => sql`case when ${jobs.error} = 'cancelled' then ${stopped} else ${value ?? null} end`;

/* Why a node restart cut a turn off, with the number of the task it was on; nothing for a turn that failed otherwise. */
export const cutOf = (cut?: RestartCut) =>
  cut ? { interruption: sql`(${interruptionValue(cut)}) || jsonb_build_object('task', (select ${tasks.number} from ${tasks} where ${tasks.id} = ${jobs.taskId}))` } : {};

/* Jobs of these nodes or subscriptions that a node had become failed with the reason, except the ones the node still runs.
   A failed turn goes into its conversation and the agent's next turn goes out. Turns a node restart cut off keep why,
   with the number of the task each was on. */
export async function failOpenJobs(ctx: Ctx, scope: SQL, error: string, stillRunning: string[] = [], cut?: RestartCut): Promise<string[]> {
  const conditions = [scope, ON_NODE];
  if (stillRunning.length) conditions.push(notInArray(jobs.id, stillRunning));
  const failed = await ctx.db
    .update(jobs)
    .set({ status: 'failed', error: completionValue(error, 'cancelled'), result: completionValue(jobs.result, 'Stopped.'), finishedAt: new Date(), ...cutOf(cut) })
    .where(and(...conditions))
    .returning({ id: jobs.id, companyId: jobs.companyId });
  for (const companyId of new Set(failed.map(j => j.companyId))) await publishWorking(ctx, companyId);
  for (const { id } of failed) await afterJob(ctx, id);
  return failed.map(j => j.id);
}
