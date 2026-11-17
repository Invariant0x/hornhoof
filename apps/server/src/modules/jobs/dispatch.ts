import type { SkillFile, Workspace } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { subscriptions } from '../../db/schema.js';
import { identityOf } from '../nodes/hub.js';
import { nodeTakesTurn } from '../updates/drain.js';

export const TEST_PROMPT = 'Reply with one word: ready';
export const TEST_TIMEOUT_MS = 120_000;

/* instructions, toolToken and the workspace go with an agent's turns; a test job has none of them. */
type JobToSend = {
  roleKey?: string | null;
  id: string;
  subscriptionId: string;
  /* The node of a plan's machine it goes to; an API key's go to the built-in node. */
  nodeId: string | null;
  prompt: string;
  sessionId: string | null;
  model?: string | null;
  effort?: string | null;
  /* How full Claude Code's context gets before it compacts; left out, its own window. */
  compactWindow?: number | null;
  timeoutMs: number;
  instructions: string | null;
  toolToken: string | null;
  workspace?: Workspace | null;
  /* The conversation from before, for a program that starts a new session on a turn that types nothing. */
  context?: string | null;
  /* Where the agent works, for such a turn too. */
  guidance?: string | null;
  /* The agent's skills, which the node writes as files. */
  skills?: SkillFile[];
};

/* Sends a job to its node. A personal plan's node signs in itself; an API key travels with the job to the built-in node. */
export async function dispatchJob(ctx: Ctx, job: JobToSend): Promise<boolean> {
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const node = sub && identityOf(sub, job.nodeId);
  if (!sub || sub.removedAt || !node || !nodeTakesTurn(ctx, node, job.roleKey)) return false;
  const secret = sub.kind === 'api_key' && sub.secretEnc ? decryptSecret(sub.secretEnc, ctx.config.secret) : null;
  return ctx.hub.send(node, {
    type: 'job.run',
    jobId: job.id,
    subscriptionId: sub.id,
    provider: sub.provider,
    prompt: job.prompt,
    sessionId: job.sessionId,
    model: job.model ?? null,
    effort: job.effort ?? null,
    ...(job.compactWindow ? { compactWindow: job.compactWindow } : {}),
    timeoutMs: job.timeoutMs,
    secret,
    instructions: job.instructions,
    toolToken: job.toolToken,
    ...(job.workspace ? { workspace: job.workspace } : {}),
    ...(job.context ? { context: job.context } : {}),
    ...(job.guidance ? { guidance: job.guidance } : {}),
    ...(job.skills ? { skills: job.skills } : {}),
  });
}
