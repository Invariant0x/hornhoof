import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, type agents, type tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { insertTurn } from '../conversation/queue.js';
import { NoSubscription } from '../conversation/turn-records.js';
import { requestedPromptOf } from '../conversation/requested-prompt.js';
import { waitingTaskTurn, type TaskWake } from './wake-state.js';
import { repeatedTurn as repeatedWords, type RepeatedTurn } from '../conversation/turn-words.js';
import { logTurnFact } from './turn-log.js';

type Ended = { job: typeof jobs.$inferSelect; task: typeof tasks.$inferSelect; agent: typeof agents.$inferSelect; taskWake: TaskWake };
/* Which turn the new one runs again: once more after a node restart cut it off, or on in its session after it ended
   without recording its work. */
type Link = { retryOf: string } | { continueOf: string };

/* A turn on a task again, with a note of why: the turn that already waits on the task takes its place, the note before
   what it says; otherwise a new turn says the note and then what is given, by default what the turn was asked. None when
   the agent has no subscription to take it. Runs under the agent's lock. */
export async function turnAgain(ctx: Ctx, { job, task, agent, taskWake }: Ended, note: string, link: Link, prompt = `${note}\n\n${requestedPromptOf(job)}`, notBefore: Date | null = null, repeated?: RepeatedTurn): Promise<string | null> {
  const waiting = await waitingTaskTurn(ctx.db, agent.id, task.id);
  if (waiting) {
    const [kept] = await ctx.db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.id, waiting.id));
    await ctx.db.update(jobs).set({ ...link, notBefore, prompt: `${note}\n\n${kept!.prompt}` }).where(eq(jobs.id, waiting.id));
    return waiting.id;
  }
  try {
    const words = repeated ?? await repeatedWords(ctx, job);
    const source = { ...words, repeated: { ...words.repeated, data: Object.assign({}, words.repeated.data, { taskWake }) } };
    const id = await insertTurn(ctx, { companyId: job.companyId, agentId: agent.id, prompt, taskId: task.id, notBefore, ...link, ...source });
    if (!repeated) await logTurnFact(ctx, { ...job, id }, note);
    return id;
  } catch (err) {
    if (err instanceof NoSubscription) return null;
    throw err;
  }
}
