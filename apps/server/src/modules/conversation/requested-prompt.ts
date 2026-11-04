import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs } from '../../db/schema.js';

type Asked = Pick<typeof jobs.$inferSelect, 'requestedPrompt' | 'prompt' | 'continueOf' | 'retryOf'>;
/* How far back a chain of continuations is followed to its first try. */
const CHAIN_MAX = 50;
/* The turn this one goes on from, or runs once more after a node restart cut it off. */
const before = (job: Asked): string | null => job.continueOf ?? job.retryOf;

/* Older turns kept only the sent prompt, so they run again as they did before. */
export const requestedPromptOf = (job: Pick<typeof jobs.$inferSelect, 'requestedPrompt' | 'prompt'>): string => job.requestedPrompt ?? job.prompt;

/* What the first try of a chain of continuations was asked. A continuation is asked only to go on, and a node restart runs
   a turn once more with a note before what it was given, so the work of the turn is that of its first try, not a retry of
   a retry. */
export async function originalPromptOf(ctx: Ctx, job: Asked): Promise<string> {
  let first = job;
  for (let hops = 0, id = before(job); id && hops < CHAIN_MAX; hops++, id = before(first)) {
    const [from] = await ctx.db.select({ requestedPrompt: jobs.requestedPrompt, prompt: jobs.prompt, continueOf: jobs.continueOf, retryOf: jobs.retryOf }).from(jobs).where(eq(jobs.id, id));
    if (!from) break;
    first = from;
  }
  return requestedPromptOf(first);
}
