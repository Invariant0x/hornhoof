import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { subscriptions } from '../../db/schema.js';
import { identityOf } from '../nodes/hub.js';

export const TEST_PROMPT = 'Reply with one word: ready';
export const TEST_TIMEOUT_MS = 120_000;

type JobToSend = { id: string; subscriptionId: string; prompt: string; sessionId: string | null; timeoutMs: number };

/* Sends a job to the node that runs its subscription. A personal plan's node signs in itself; an API key travels with the job to the built-in node. */
export async function dispatchJob(ctx: Ctx, job: JobToSend): Promise<boolean> {
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  if (!sub || sub.removedAt) return false;
  const secret = sub.kind === 'api_key' && sub.secretEnc ? decryptSecret(sub.secretEnc, ctx.config.secret) : null;
  return ctx.hub.send(identityOf(sub), {
    type: 'job.run',
    jobId: job.id,
    subscriptionId: sub.id,
    provider: sub.provider,
    prompt: job.prompt,
    sessionId: job.sessionId,
    model: null,
    timeoutMs: job.timeoutMs,
    secret,
    instructions: null,
    toolToken: null,
  });
}
