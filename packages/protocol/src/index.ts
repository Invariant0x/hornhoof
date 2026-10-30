import { z } from 'zod';

/* Messages between the Hornhoof server and its nodes, one JSON object per WebSocket frame. */

export const PROVIDER_IDS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const JOB_ERRORS = ['timeout', 'agent_failed', 'not_logged_in', 'cancelled'] as const;
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

/* What an agent is doing while a job runs, already shortened by the node for people to watch. */
export const AgentEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(8000) }),
  z.object({ kind: z.literal('tool'), name: z.string().max(100), input: z.string().max(300) }),
  z.object({ kind: z.literal('tool_result'), ok: z.boolean(), summary: z.string().max(500) }),
  z.object({
    kind: z.literal('todo'),
    items: z.array(z.object({ text: z.string().max(200), state: z.enum(['todo', 'doing', 'done']) })).max(20),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/* Keeps the first max characters, ending with an ellipsis when something was cut. */
export function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const TEMPLATE_KEYS = ['operations', 'development', 'marketing', 'sales', 'business_development', 'design', 'support', 'finance'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/* The departments the orchestrator starts from. Names and descriptions live in the web dictionaries and the server's prompt. */
export const DEPARTMENT_TEMPLATES: readonly { key: TemplateKey; roleCode: string; ticked: boolean; always: boolean }[] = [
  { key: 'operations', roleCode: 'OPS', ticked: true, always: true },
  { key: 'development', roleCode: 'DEV', ticked: true, always: false },
  { key: 'marketing', roleCode: 'MKT', ticked: true, always: false },
  { key: 'sales', roleCode: 'SAL', ticked: true, always: false },
  { key: 'business_development', roleCode: 'BIZ', ticked: true, always: false },
  { key: 'design', roleCode: 'DSN', ticked: false, always: false },
  { key: 'support', roleCode: 'SUP', ticked: false, always: false },
  { key: 'finance', roleCode: 'FIN', ticked: false, always: false },
];

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
  z.object({ type: z.literal('job.event'), jobId: z.string(), seq: z.number().int().min(0), event: AgentEvent }),
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
    /* The agent's standing instructions for this job, and the token its Hornhoof tools present. */
    instructions: z.string().max(20000).nullable(),
    toolToken: z.string().max(200).nullable(),
  }),
  z.object({ type: z.literal('job.cancel'), jobId: Id }),
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
