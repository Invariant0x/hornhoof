import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, type agents, type tasks } from '../../db/schema.js';
import { insertTurn, NoSubscription } from '../conversation/queue.js';

type Ended = { job: typeof jobs.$inferSelect; task: typeof tasks.$inferSelect; agent: typeof agents.$inferSelect };
/* Which turn the new one runs again: once more after a node restart cut it off, or on in its session after it ended
   without recording its work. */
type Link = { retryOf: string } | { continueOf: string };

/* A turn on a task again, with a note of why: the turn that already waits on the task takes its place, the note before
   what it says; otherwise a new turn says the note and then what is given, by default what the turn was asked. None when
   the agent has no subscription to take it. Runs under the agent's lock. */
export async function turnAgain(ctx: Ctx, { job, task, agent }: Ended, note: string, link: Link, prompt = `${note}\n\n${job.prompt}`): Promise<string | null> {
  const [waiting] = await ctx.db.select().from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.taskId, task.id), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt)).limit(1);
  if (waiting) {
    await ctx.db.update(jobs).set({ ...link, prompt: `${note}\n\n${waiting.prompt}` }).where(eq(jobs.id, waiting.id));
    return waiting.id;
  }
  try {
    return await insertTurn(ctx, { companyId: job.companyId, agentId: agent.id, prompt, createdBy: null, taskId: task.id, ...link, message: { personId: null, text: prompt, task: { id: task.id, number: task.number } } });
  } catch (err) {
    if (err instanceof NoSubscription) return null;
    throw err;
  }
}
