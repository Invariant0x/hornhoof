import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs } from '../../db/schema.js';

type Asked = Pick<typeof jobs.$inferSelect, 'requestedPrompt' | 'prompt' | 'continueOf'>;
/* How far back a chain of continuations is followed to its first try. */
const CHAIN_MAX = 50;

/* Older turns kept only the sent prompt, so they run again as they did before. */
export const requestedPromptOf = (job: Pick<typeof jobs.$inferSelect, 'requestedPrompt' | 'prompt'>): string => job.requestedPrompt ?? job.prompt;

/* What the first try of a chain of continuations was asked. A continuation is asked only to go on, so the work of the turn
   it goes on from is that of its first try, not a retry of a retry. */
export async function originalPromptOf(ctx: Ctx, job: Asked): Promise<string> {
  let first = job;
  for (let hops = 0; first.continueOf && hops < CHAIN_MAX; hops++) {
    const [from] = await ctx.db.select({ requestedPrompt: jobs.requestedPrompt, prompt: jobs.prompt, continueOf: jobs.continueOf }).from(jobs).where(eq(jobs.id, first.continueOf));
    if (!from) break;
    first = from;
  }
  return requestedPromptOf(first);
}
