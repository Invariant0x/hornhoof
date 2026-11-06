import { createHash } from 'node:crypto';
import { canonicalJson, type ModelCheckKind, type ModelIdentity, type ProviderId, type SkillFile, type Workspace } from '@hornhoof/protocol';
import type { OperatorDelivery } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
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
  const secret = sub.kind === 'api_key' ? secretOf(ctx, sub) : null;
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

const FRESH_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 1024;
const FRESH_SETTINGS = { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS };
/* What a certified model is bound to: an answer from other settings is an answer from another check. */
export const FRESH_INFERENCE_HASH = createHash('sha256').update(canonicalJson(FRESH_SETTINGS)).digest('hex');

const unavailable: FreshModelResponse = { status: 'unavailable' };

const FromAnthropic = z.object({ model: z.string(), content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]) });
const FromOpenAi = z.object({ model: z.string(), choices: z.tuple([z.object({ message: z.object({ content: z.string() }) })]) });
type Spoken = { model: string; text: string };
type Direct = { vendorId: string; url: string; call: (request: FreshModelRequest, key: string) => { headers: Record<string, string>; body: object }; heard: (answer: unknown) => Spoken | null };

const parsedWith = <T>(schema: z.ZodType<T>, read: (value: T) => Spoken) => (answer: unknown): Spoken | null => {
  const parsed = schema.safeParse(answer);
  return parsed.success ? read(parsed.data) : null;
};

/* These two providers take one plain call over HTTP. Nothing is passed that could give a model a tool, a session or anyone's history. */
const DIRECT: Partial<Record<ProviderId, Direct>> = {
  anthropic_api: {
    vendorId: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    call: (request, key) => ({
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: { model: request.expectedModel.modelId, max_tokens: MAX_OUTPUT_TOKENS, temperature: 0, system: request.systemPrompt, messages: [{ role: 'user', content: request.userPayload }] },
    }),
    heard: parsedWith(FromAnthropic, value => ({ model: value.model, text: value.content[0].text })),
  },
  openai_api: {
    vendorId: 'openai',
    url: 'https://api.openai.com/v1/chat/completions',
    call: (request, key) => ({
      headers: { authorization: `Bearer ${key}` },
      body: { model: request.expectedModel.modelId, max_completion_tokens: MAX_OUTPUT_TOKENS, temperature: 0, messages: [{ role: 'system', content: request.systemPrompt }, { role: 'user', content: request.userPayload }] },
    }),
    heard: parsedWith(FromOpenAi, value => ({ model: value.model, text: value.choices[0].message.content })),
  },
};

const secretOf = (ctx: Ctx, sub: { secretEnc: string | null }): string | null => (sub.secretEnc ? decryptSecret(sub.secretEnc, ctx.config.secret) : null);

/* The oldest key of the provider, so the same one answers every time. */
async function keyOf(ctx: Ctx, provider: ProviderId): Promise<string | null> {
  const [sub] = await ctx.db.select({ secretEnc: subscriptions.secretEnc }).from(subscriptions).where(and(eq(subscriptions.provider, provider), eq(subscriptions.kind, 'api_key'), isNull(subscriptions.removedAt))).orderBy(subscriptions.createdAt).limit(1);
  return sub ? secretOf(ctx, sub) : null;
}

async function callVendor(url: string, call: ReturnType<Direct['call']>, timeoutMs: number): Promise<unknown> {
  const answer = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...call.headers }, body: JSON.stringify(call.body) });
  return answer.ok ? answer.json() : null;
}

const directFor = (expected: ModelIdentity): Direct | null => {
  const direct = DIRECT[expected.providerId];
  return direct && direct.vendorId === expected.vendorId && expected.inferenceConfigHash === FRESH_INFERENCE_HASH ? direct : null;
};

async function askDirect(ctx: Ctx, direct: Direct, request: FreshModelRequest, options: FreshOptions): Promise<Spoken | null> {
  const key = await keyOf(ctx, request.expectedModel.providerId);
  if (!key) return null;
  const url = options.endpoints?.[request.expectedModel.providerId] ?? direct.url;
  return direct.heard(await callVendor(url, direct.call(request, key), options.timeoutMs ?? FRESH_TIMEOUT_MS));
}

/* The one model call that is not a turn: a job would run in its program, with that program's own tools, so this goes straight to the
   vendor. It is sure of who answered, or it says it is unavailable and whatever waits for it keeps waiting. It says nothing of why, as
   what a vendor answers may hold anything. */
export const freshModelCheck = (ctx: Ctx, options: FreshOptions = {}) => async (request: FreshModelRequest): Promise<FreshModelResponse> => {
  const direct = directFor(request.expectedModel);
  if (!direct) return unavailable;
  const spoken = await askDirect(ctx, direct, request, options).catch(() => null);
  return spoken?.model === request.expectedModel.revisionId ? { status: 'ok', reviewer: request.expectedModel, rawOutput: spoken.text, isolated: true } : unavailable;
};
