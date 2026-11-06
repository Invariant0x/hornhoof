import type { ModelCheckKind, ModelIdentity, ProviderId, SkillFile, Workspace } from '@hornhoof/protocol';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { subscriptions } from '../../db/schema.js';
import { identityOf } from '../nodes/hub.js';
import { nodeHeldFrom } from '../updates/drain.js';

export const TEST_PROMPT = 'Reply with one word: ready';
export const TEST_TIMEOUT_MS = 120_000;

/* instructions, toolToken and the workspace go with an agent's turns; a test job has none of them. */
type JobToSend = {
  id: string;
  subscriptionId: string;
  /* The node of a plan's machine it goes to; an API key's go to the built-in node. */
  nodeId: string | null;
  /* The role of the agent it is for: the one role that may go to a node waiting for an update. */
  role?: string | null;
  /* It is for the orchestrator or a head, whom a node that waits for an update holds up to a limit. */
  leader?: boolean;
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
  operatorDelivery?: OperatorDelivery;
  operatorSourceDelivery?: OperatorDelivery;
};

/* What goes along only when the job has it. */
const jobExtras = (job: JobToSend) => ({
  ...(job.compactWindow ? { compactWindow: job.compactWindow } : {}),
  ...(job.operatorDelivery ? { operatorDelivery: job.operatorDelivery } : {}),
  ...(job.operatorSourceDelivery ? { operatorSourceDelivery: job.operatorSourceDelivery } : {}),
  ...(job.workspace ? { workspace: job.workspace } : {}),
  ...(job.context ? { context: job.context } : {}),
  ...(job.guidance ? { guidance: job.guidance } : {}),
  ...(job.skills ? { skills: job.skills } : {}),
});

/* Sends a job to its node. A personal plan's node signs in itself; an API key travels with the job to the built-in node. */
export async function dispatchJob(ctx: Ctx, job: JobToSend): Promise<boolean> {
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const node = sub && identityOf(sub, job.nodeId);
  if (!sub || sub.removedAt || !node || nodeHeldFrom(ctx, node, job.role, job.leader)) return false;
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
    timeoutMs: job.timeoutMs,
    secret,
    instructions: job.instructions,
    toolToken: job.toolToken,
    ...jobExtras(job),
  });
}

export type FreshModelRequest = { readonly kind: ModelCheckKind; readonly expectedModel: ModelIdentity; readonly systemPrompt: string; readonly userPayload: string };
export type FreshModelResponse = { readonly status: 'ok'; readonly reviewer: ModelIdentity; readonly rawOutput: string; readonly isolated: true } | { readonly status: 'unavailable' };
type FreshOptions = { endpoints?: Partial<Record<ProviderId, string>>; timeoutMs?: number };

export const FRESH_INFERENCE_HASH = '0'.repeat(64);
export const freshModelCheck = (_ctx: Ctx, _options: FreshOptions = {}) => async (_request: FreshModelRequest): Promise<FreshModelResponse> => ({ status: 'unavailable' });
