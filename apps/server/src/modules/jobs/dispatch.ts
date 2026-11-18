import { apiEndpoint, type ProviderId, type SkillFile, type Workspace } from '@hornhoof/protocol';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import { subscriptions } from '../../db/schema.js';
import { identityOf, ownBuiltin } from '../nodes/hub.js';
import { nodeHeldFrom } from '../updates/drain.js';
export const TEST_PROMPT = 'Reply with one word: ready';
export const TEST_TIMEOUT_MS = 120_000;

/* instructions, toolToken and the workspace go with an agent's turns; a test job has none of them. */
type JobToSend = {
  id: string;
  subscriptionId: string;
  /* The node of a plan's machine it goes to; an API key's go to a built-in node: the one of the machine named, or this
     app's own. */
  nodeId: string | null;
  builtinMachine?: string | null;
  /* The role of the agent it is for: the one role that may go to a node waiting for an update. */
  role?: string | null;
  /* It is for the orchestrator or a head, whom a node that waits for an update holds up to a limit. */
  leader?: boolean;
  prompt: string;
  /* An assistant's whole conversation, which the node types in place of the prompt when the session begins anew there. */
  freshPrompt?: string | null;
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
  /* The agent's skills, which the node writes as files. */
  skills?: SkillFile[];
  operatorDelivery?: OperatorDelivery;
  operatorSourceDelivery?: OperatorDelivery;
  /* A one-shot call, which the node runs once in its program's one-call mode. */
  call?: boolean;
};

/* What goes along only when the job has it. */
const jobExtras = (job: JobToSend) => ({
  ...(job.compactWindow ? { compactWindow: job.compactWindow } : {}),
  ...(job.freshPrompt ? { freshPrompt: job.freshPrompt } : {}),
  ...(job.operatorDelivery ? { operatorDelivery: job.operatorDelivery } : {}),
  ...(job.operatorSourceDelivery ? { operatorSourceDelivery: job.operatorSourceDelivery } : {}),
  ...(job.workspace ? { workspace: job.workspace } : {}),
  ...(job.context ? { context: job.context } : {}),
  ...(job.skills ? { skills: job.skills } : {}),
  ...(job.call ? { call: true as const } : {}),
});

/* OpenRouter and a compatible API run only the models their connection was given, so a turn that names none takes the
   first: the program's own default is a model of its maker, which such an API may not have. */
const secretOf = (ctx: Ctx, sub: { secretEnc: string | null }): string | null => (sub.secretEnc ? decryptSecret(sub.secretEnc, ctx.config.secret) : null);

const ownModel = (sub: { provider: ProviderId; models: { id: string }[] | null }): string | null =>
  (sub.provider === 'openrouter' || sub.provider === 'custom_api') && sub.models?.length ? sub.models[0]!.id : null;

/* Sends a job to its node. A personal plan's node signs in itself; an API key travels with the job to the built-in node. */
export async function dispatchJob(ctx: Ctx, job: JobToSend): Promise<boolean> {
  const [sub] = await ctx.db.select().from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const node = sub && identityOf(sub, job.nodeId, job.builtinMachine ?? null, ownBuiltin(ctx.config));
  if (!sub || sub.removedAt || !node || nodeHeldFrom(ctx, node, job.role, job.leader)) return false;
  const secret = sub.kind === 'api_key' ? secretOf(ctx, sub) : null;
  const api = sub.kind === 'api_key' ? apiEndpoint(sub.provider, { baseUrl: sub.baseUrl, protocol: sub.apiProtocol }) : null;
  return ctx.hub.send(node, {
    type: 'job.run',
    jobId: job.id,
    subscriptionId: sub.id,
    provider: sub.provider,
    prompt: job.prompt,
    sessionId: job.sessionId,
    model: job.model || (ownModel(sub) ?? job.model ?? null),
    effort: job.effort ?? null,
    timeoutMs: job.timeoutMs,
    secret,
    instructions: job.instructions,
    toolToken: job.toolToken,
    ...(api ? { api } : {}),
    ...jobExtras(job),
  });
}
export { ON_NODE } from './requirements.js';
