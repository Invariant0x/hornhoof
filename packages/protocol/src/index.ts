import { z } from 'zod';

/* Messages between the Hornhoof server and its nodes, one JSON object per WebSocket frame. */

export const PROVIDER_IDS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const JOB_ERRORS = ['timeout', 'agent_failed', 'not_logged_in'] as const;
export type JobError = (typeof JOB_ERRORS)[number];

/* The last bytes of a job's output kept for people to read when something fails. */
export const TAIL_BYTES = 4096;

const LimitWindow = z.object({
  name: z.string().min(1).max(40),
  utilization: z.number().min(0).max(1).nullable(),
  resetsAt: z.string().max(40).nullable(),
});

/* Usage windows as the provider reports them, for example five hours and seven days. */
const Limits = z.object({
  status: z.enum(['allowed', 'warning', 'rejected']),
  windows: z.array(LimitWindow).max(8),
});
export type Limits = z.infer<typeof Limits>;

/* Job and subscription ids end up in folder names on the node, so they hold no slashes or dots. */
const Id = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

const NodeMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.string().max(40), loggedIn: z.boolean(), running: z.array(z.string()).max(100) }),
  z.object({ type: z.literal('status'), loggedIn: z.boolean(), limits: Limits.nullable() }),
  z.object({ type: z.literal('job.started'), jobId: z.string() }),
  z.object({
    type: z.literal('job.done'),
    jobId: z.string(),
    ok: z.boolean(),
    sessionId: z.string().nullable(),
    result: z.string(),
    tail: z.string(),
    error: z.enum(JOB_ERRORS).nullable(),
  }),
  z.object({ type: z.literal('removed') }),
]);
export type NodeMessage = z.infer<typeof NodeMessage>;

const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job.run'),
    jobId: Id,
    subscriptionId: Id,
    provider: z.enum(PROVIDER_IDS),
    prompt: z.string(),
    sessionId: z.string().nullable(),
    model: z.string().nullable(),
    timeoutMs: z.number().int().positive(),
    secret: z.string().nullable(),
  }),
  z.object({ type: z.literal('remove') }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

function parse<T>(schema: z.ZodType<T>, raw: string): T | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

export const parseNodeMessage = (raw: string): NodeMessage | null => parse(NodeMessage, raw);
export const parseServerMessage = (raw: string): ServerMessage | null => parse(ServerMessage, raw);
