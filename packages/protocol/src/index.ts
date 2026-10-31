import { z } from 'zod';

/* Messages between the Hornhoof server and its nodes, one JSON object per WebSocket frame. */

export const PROVIDER_IDS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const JOB_ERRORS = ['timeout', 'agent_failed', 'not_logged_in', 'cancelled'] as const;
export type JobError = (typeof JOB_ERRORS)[number];

/* The last bytes of a job's output kept for people to read when something fails. */
export const TAIL_BYTES = 4096;
/* The longest standing instructions a job may carry; Hornhoof refuses edits that would go past it. */
export const MAX_INSTRUCTIONS = 20_000;

const LimitWindow = z.object({
  name: z.string().min(1).max(40),
  utilization: z.number().min(0).max(1).nullable(),
  resetsAt: z.string().max(40).nullable(),
});

/* Usage windows as the provider reports them, for example five hours and seven days. A complete list names every window
   the plan has, so one it leaves out is not on the plan; otherwise it tells only what the program said this time. */
const Limits = z.object({
  status: z.enum(['allowed', 'warning', 'rejected']),
  windows: z.array(LimitWindow).max(8),
  complete: z.boolean().optional(),
});
export type Limits = z.infer<typeof Limits>;

/* How hard a model thinks, as its program names the level: low, high, max and the like. */
const Effort = z.string().regex(/^[a-z]{1,16}$/);

/* A model a subscription can run, as its program names it, with the efforts it takes and the one it thinks at by default. */
const ModelOption = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(80), efforts: z.array(Effort).max(8).optional(), defaultEffort: Effort.optional() });
export type ModelOption = z.infer<typeof ModelOption>;
const Models = z.array(ModelOption).max(60);

/* The levels Claude Code's --effort and Codex's reasoning effort take for the models Hornhoof knows itself. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/* API keys run these; a node never needs to report them. */
export const API_MODELS: { anthropic_api: ModelOption[]; openai_api: ModelOption[] } = {
  anthropic_api: [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: EFFORTS },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: EFFORTS },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: EFFORTS },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: EFFORTS },
  ],
  openai_api: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: EFFORTS },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: EFFORTS },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: EFFORTS },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: EFFORTS },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: EFFORTS },
  ],
};

/* Claude Code takes these and moves each to the newest model of its family. */
export const CLAUDE_ALIASES: ModelOption[] = [
  { id: 'fable', name: 'Fable', efforts: EFFORTS },
  { id: 'opus', name: 'Opus', efforts: EFFORTS },
  { id: 'sonnet', name: 'Sonnet', efforts: EFFORTS },
  { id: 'haiku', name: 'Haiku', efforts: EFFORTS },
];

/* The effort an agent runs at: what a person picked while its model takes it, else Kimi at the most its model takes and
   the others at their program's default. No efforts known takes what was picked, and Kimi's max. */
export function effortFor(provider: ProviderId, chosen: string | null, efforts: string[] = []): string | null {
  const kept = chosen && (!efforts.length || efforts.includes(chosen)) ? chosen : null;
  if (kept || provider !== 'kimi') return kept;
  return efforts.length && !efforts.includes('max') ? efforts[efforts.length - 1]! : 'max';
}

/* The efforts a model takes. The program picks the Default model itself, and a model the subscription does not run runs
   on it, so they take only the levels every model that names some takes. */
export function effortsOf(models: ModelOption[], model: string | null): string[] {
  const found = model ? models.find(m => m.id === model) : undefined;
  if (found) return found.efforts ?? [];
  const named = models.flatMap(m => (m.efforts?.length ? [m.efforts] : []));
  return named.length ? named[0]!.filter(level => named.every(list => list.includes(level))) : [];
}

/* What a subscription can run: what its node reported, else what Hornhoof knows for the provider. The web adds "Default" on top. */
export function modelsFor(provider: ProviderId, reported: ModelOption[] | null): ModelOption[] {
  if (reported) return reported;
  if (provider === 'anthropic_api' || provider === 'openai_api') return API_MODELS[provider];
  if (provider === 'claude') return CLAUDE_ALIASES;
  return [];
}

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

/* A live terminal between a person's browser and an agent's session on a node: its id, and the screen size in cells. */
const TermId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const Cols = z.number().int().min(10).max(500);
const Rows = z.number().int().min(4).max(200);
/* What one frame carries of a terminal's screen or of a person's keys and pastes. */
export const TERM_CHUNK = 64 * 1024;

const NodeMessage = z.discriminatedUnion('type', [
  /* terminals: the node runs agents in sessions people can watch and type into. */
  z.object({ type: z.literal('hello'), version: z.string().max(40), loggedIn: z.boolean(), running: z.array(z.string()).max(100), models: Models.optional(), terminals: z.boolean().optional() }),
  z.object({ type: z.literal('status'), loggedIn: z.boolean(), limits: Limits.nullable(), models: Models.optional() }),
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
  z.object({ type: z.literal('term.data'), termId: TermId, data: z.string().max(4 * TERM_CHUNK) }),
  z.object({ type: z.literal('term.exit'), termId: TermId }),
  /* A person typed to an agent that had no turn running: Hornhoof opens one so the agent has its tools. ref names the
     typed turn, and Hornhoof's answer carries it back. */
  z.object({ type: z.literal('turn.open'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), text: z.string().max(100_000), ref: z.string().max(64).optional() }),
  /* Someone who may type opened the window of an agent whose program does not run: Hornhoof starts it with a turn that
     types nothing. */
  z.object({ type: z.literal('agent.start'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }),
  /* How full the agent's context is now, as its program counts it: a share from 0 to 1. */
  z.object({ type: z.literal('agent.context'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), used: z.number().min(0).max(1) }),
]);
export type NodeMessage = z.infer<typeof NodeMessage>;

/* A git repository over https and a branch name git takes as a plain name, never as an option. The token has its own
   field: an address with a name or password in it would put them on command lines and into the clone's settings. */
export const Repo = z.object({
  url: z
    .string()
    .max(500)
    .regex(/^https:\/\/[^\s]+$/)
    .refine(u => !/^https:\/\/[^/]*@/.test(u), 'Put the token in its own field, not in the address.'),
  branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/-]+$/).refine(b => !b.startsWith('-') && !b.includes('..'), 'Not a branch name.'),
  token: z.string().max(500),
  /* Who the agents' commits are by: set in the clone, so a node from before it leaves the field out. */
  author: z
    .object({ name: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}<>]+$/u), email: z.email().max(200) })
    .nullable()
    .optional(),
});
export type RepoAuthor = NonNullable<z.infer<typeof Repo>['author']>;
const Workspace = z.object({ key: Id, repo: Repo.nullable() });
export type Workspace = z.infer<typeof Workspace>;

/* The folder inside an agent's folder that holds a repository's clone: the last part of its address without .git. */
export function repoFolder(url: string): string {
  const last = url.replace(/\/+$/, '').split('/').pop() ?? '';
  return last.replace(/\.git$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'repo';
}

const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job.run'),
    jobId: Id,
    subscriptionId: Id,
    provider: z.enum(PROVIDER_IDS),
    prompt: z.string(),
    sessionId: z.string().nullable(),
    model: z.string().nullable(),
    /* How hard the program thinks; null leaves it at its own default. */
    effort: Effort.nullable().optional(),
    timeoutMs: z.number().int().positive(),
    secret: z.string().nullable(),
    /* The agent's standing instructions for this job, and the token its Hornhoof tools present. */
    instructions: z.string().max(MAX_INSTRUCTIONS).nullable(),
    toolToken: z.string().max(200).nullable(),
    /* The conversation from before, for a program that starts a new session on a turn that types nothing: it goes with
       the instructions when the program starts and is no change of them. */
    context: z.string().max(64 * 1024).nullable().optional(),
    /* Where the agent works, for such a turn too; it comes again with each start, as it can change. */
    guidance: z.string().max(16 * 1024).nullable().optional(),
    /* The agent's own folder on the node and the repository it works in; a test job has none. */
    workspace: Workspace.nullable().optional(),
  }),
  z.object({ type: z.literal('job.cancel'), jobId: Id }),
  z.object({ type: z.literal('remove') }),
  /* write: the person may type; anyone else watches. agentKey: the agent's folder and session on the node. */
  z.object({ type: z.literal('term.open'), termId: TermId, agentKey: Id, cols: Cols, rows: Rows, write: z.boolean() }),
  z.object({ type: z.literal('term.input'), termId: TermId, data: z.string().max(TERM_CHUNK) }),
  z.object({ type: z.literal('term.resize'), termId: TermId, cols: Cols, rows: Rows }),
  z.object({ type: z.literal('term.close'), termId: TermId }),
  /* The turn Hornhoof opened for what a person typed, or none when it could not. */
  z.object({ type: z.literal('turn.opened'), agentKey: Id, jobId: Id.nullable(), toolToken: z.string().max(200).nullable(), ref: z.string().max(64).optional() }),
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
