import { z } from 'zod';
import { effortsOf, topEffort } from './efforts.js';

/* Messages between the Hornhoof server and its nodes, one JSON object per WebSocket frame. */

export const PROVIDER_IDS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api', 'antigravity'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const JOB_ERRORS = ['timeout', 'agent_failed', 'not_logged_in', 'cancelled'] as const;
export type JobError = (typeof JOB_ERRORS)[number];

/* Why a part of a run ended other than with its command passing: it failed, ran out of time, was stopped, the branch
   could not be cloned, or the task's files could not be fetched. */
export const TEST_ERRORS = ['failed', 'timeout', 'cancelled', 'clone_failed', 'files_failed'] as const;
export type TestError = (typeof TEST_ERRORS)[number];
/* The most parts a run splits into, and the most of each part's log a node sends: its start and its end. */
export const MAX_TEST_PARTS = 10;
export const TEST_LOG_BYTES = 1024 * 1024;
/* What the company's machines run for its agents: a branch's test suite, or any other work, on a branch or in an empty
   folder. */
export const RUN_KINDS = ['tests', 'work'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
/* What a machine of the company is. A computer runs parts of runs in a shell; a phone or a browser will take work of its
   own kind once a node for it exists. */
export const MACHINE_KINDS = ['computer', 'phone', 'browser'] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];
/* The most task files a part of work takes in, and the most files one part puts on the task. */
export const MAX_RUN_FILES = 20;
/* The biggest file a part puts on the task, as big as any task file may be. */
export const RUN_FILE_BYTES = 50 * 1024 * 1024;
/* A file's plain name, never a folder or a way out of one. */
export const RunFile = z
  .string()
  .min(1)
  .max(200)
  .refine(n => !/[\/\\\u0000-\u001f\u007f]/.test(n) && n !== '.' && n !== '..', 'Not a plain file name.');

/* The last bytes of a job's output kept for people to read when something fails. */
export const TAIL_BYTES = 4096;

/* The end of a text in at most this many UTF-8 bytes, as a job's tail is kept on the node and in Hornhoof. */
export function lastBytes(text: string, bytes = TAIL_BYTES): string {
  const buf = new TextEncoder().encode(text);
  return buf.length <= bytes ? text : new TextDecoder().decode(buf.subarray(buf.length - bytes));
}
/* The longest standing instructions a job may carry, now that skills go as files; Hornhoof refuses edits that would go
   past it. */
export const MAX_INSTRUCTIONS = 200_000;
/* What a node from before skill files takes: it drops a job with longer instructions. */
export const OLD_NODE_INSTRUCTIONS = 20_000;

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
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', efforts: EFFORTS, defaultEffort: 'high' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: EFFORTS, defaultEffort: 'medium' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: EFFORTS, defaultEffort: 'medium' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: EFFORTS, defaultEffort: 'medium' },
  ],
  openai_api: [
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: EFFORTS },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: EFFORTS },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', efforts: EFFORTS },
    { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: EFFORTS },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: EFFORTS },
  ],
};

/* Claude Code takes these and moves each to the newest model of its family. Each runs at high unless picked, but the
   5.5 models at medium, and the Default model is Opus 5.5 (code.claude.com/docs/en/model-config). */
export const CLAUDE_DEFAULT_EFFORT = 'medium';
export const CLAUDE_ALIASES: ModelOption[] = [
  { id: 'fable', name: 'Fable', efforts: EFFORTS, defaultEffort: 'high' },
  { id: 'opus', name: 'Opus', efforts: EFFORTS, defaultEffort: 'medium' },
  { id: 'sonnet', name: 'Sonnet', efforts: EFFORTS, defaultEffort: 'medium' },
  { id: 'haiku', name: 'Haiku', efforts: EFFORTS, defaultEffort: 'medium' },
];

/* The effort an agent runs at: what a person picked while its model takes it, else Kimi and Codex at the most their model
   takes and the others at their program's default. No efforts known takes what was picked, and Kimi's max. */
export function effortFor(provider: ProviderId, chosen: string | null, efforts: string[] = []): string | null {
  const kept = chosen && (!efforts.length || efforts.includes(chosen)) ? chosen : null;
  return kept ?? topEffort(provider, efforts);
}

/* The efforts a model takes, from a module of its own that the web takes too. */
export { effortsOf };
export { lineState, yellowUntil, RETURN_MS, type LineFacts, type LineState, type WorkLine } from './map.js';

const pick = (defaultEffort: string | undefined) => (defaultEffort ? { defaultEffort } : {});

/* The level an agent runs at when nobody picked one, when Hornhoof knows it: Kimi and Codex at the most their model takes,
   Claude Code as its docs give it, even for a node's older list, and the others as their node reported. */
export function defaultEffortOf(provider: ProviderId, models: ModelOption[], model: string | null): string | null {
  const top = topEffort(provider, effortsOf(models, model));
  if (top) return top;
  const claude = provider === 'claude' || provider === 'anthropic_api';
  if (!model) return claude ? CLAUDE_DEFAULT_EFFORT : null;
  const known = claude ? [...CLAUDE_ALIASES, ...API_MODELS.anthropic_api] : [];
  return models.find(m => m.id === model)?.defaultEffort ?? known.find(m => m.id === model)?.defaultEffort ?? null;
}

/* What a subscription can run: what its node reported, else what Hornhoof knows for the provider. The web adds "Default" on top. */
export function modelsFor(provider: ProviderId, reported: ModelOption[] | null): ModelOption[] {
  /* A node from before Hornhoof knew Claude Code's levels reports its models without them. */
  if (reported && provider === 'claude') return reported.map(m => (m.defaultEffort ? m : { ...m, ...pick(CLAUDE_ALIASES.find(a => a.id === m.id)?.defaultEffort) }));
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

export const TEMPLATE_KEYS = ['operations', 'development', 'marketing', 'sales', 'business_development', 'design', 'support', 'finance', 'home_devices', 'household'] as const;
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
  { key: 'home_devices', roleCode: 'HOM', ticked: false, always: false },
  { key: 'household', roleCode: 'HHD', ticked: false, always: false },
];

/* A ready-made company the CEO can pick on the first screen. Each one lists departments to create, with their products
   and the people to staff them with (role code and how many). The names and descriptions live in the web dictionaries;
   the mini scheme on the card is drawn from these departments. "Start empty" is not here: it is the default on the card,
   and creates nothing. Staffing is only offered afterwards, so a template brings no subscriptions. */
export const COMPANY_TEMPLATE_KEYS = ['project', 'startup', 'studio', 'corporation', 'security', 'opensource', 'agency', 'lab', 'home'] as const;
export type CompanyTemplateKey = (typeof COMPANY_TEMPLATE_KEYS)[number];
export type CompanyTemplateStaff = { role: string; count: number };
export type CompanyTemplateDept = { template: TemplateKey; name?: string; products?: string[]; staff: CompanyTemplateStaff[] };
export type CompanyTemplate = { key: CompanyTemplateKey; departments: readonly CompanyTemplateDept[] };

export const COMPANY_TEMPLATES: readonly CompanyTemplate[] = [
  {
    key: 'project',
    departments: [{ template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }] }, { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }] }],
  },
  {
    key: 'startup',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-SEC', count: 1 }] },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }] },
    ],
  },
  {
    key: 'studio',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-INTEG', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2', 'Product 3'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }],
      },
    ],
  },
  {
    key: 'corporation',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }],
      },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }, { role: 'DSN-SYS', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }, { role: 'MKT-SEO', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }] },
      { template: 'finance', staff: [{ role: 'FIN-HEAD', count: 1 }, { role: 'FIN-BOOK', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-PARTNER', count: 1 }] },
    ],
  },
  {
    key: 'security',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-INTEG', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-RED', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }] },
    ],
  },
  {
    key: 'opensource',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-DOCS', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-KB', count: 1 }] },
    ],
  },
  {
    key: 'agency',
    departments: [
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }] },
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }] },
    ],
  },
  {
    key: 'lab',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-DOCS', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }] },
    ],
  },
  {
    key: 'home',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }] },
      { template: 'home_devices', staff: [{ role: 'HOM-HEAD', count: 1 }, { role: 'HOM-NET', count: 1 }, { role: 'HOM-SMART', count: 1 }] },
      { template: 'household', staff: [{ role: 'HHD-HEAD', count: 1 }, { role: 'HHD-SUPPLY', count: 1 }, { role: 'HHD-BILLS', count: 1 }, { role: 'HHD-CAL', count: 1 }] },
    ],
  },
];

/* A live terminal between a person's browser and an agent's session on a node: its id, and the screen size in cells. */
const TermId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const Cols = z.number().int().min(10).max(500);
const Rows = z.number().int().min(4).max(200);
/* What one frame carries of a terminal's screen or of a person's keys and pastes. */
export const TERM_CHUNK = 64 * 1024;

/* How busy a node's machine is: its processors, the load average over the last minute, its free and total memory in
   bytes, and how many test runs and agent jobs the node runs now. A node sends it with its hello and every LOAD_MS.
   Newer nodes also name the machine's processor and the free and total space of the disk their folders are on, and
   identify the physical host together with its own processors, load and memory. */
const Load = z.object({
  cpus: z.number().int().min(1).max(4096),
  load: z.number().min(0).max(100_000),
  memFree: z.number().int().min(0),
  memTotal: z.number().int().min(0),
  tests: z.number().int().min(0).max(1000),
  jobs: z.number().int().min(0).max(1000),
  cpuModel: z.string().max(200).optional(),
  diskFree: z.number().int().min(0).optional(),
  diskTotal: z.number().int().min(0).optional(),
  host: z.string().min(1).max(200).optional(),
  hostCpus: z.number().int().min(1).max(4096).optional(),
  hostLoad: z.number().min(0).max(100_000).optional(),
  hostMemFree: z.number().int().min(0).optional(),
  hostMemory: z.number().int().min(0).optional(),
});
export type NodeLoad = z.infer<typeof Load>;
export const LOAD_MS = 20_000;

const NodeMessage = z.discriminatedUnion('type', [
  /* terminals: the node runs agents in sessions people can watch and type into. */
  /* tests: the parts of test runs it runs, or ran and Hornhoof has not confirmed. */
  /* skillFiles: it writes a turn's skills as files where the agent's program finds them; a node without it gets them in
     the instructions. */
  z.object({
    type: z.literal('hello'),
    version: z.string().max(40),
    loggedIn: z.boolean(),
    running: z.array(z.string()).max(100),
    models: Models.optional(),
    terminals: z.boolean().optional(),
    /* The node runs parts of other work too, not only of test runs. */
    work: z.boolean().optional(),
    /* Why the node takes no part of any run: a part runs only as a user of the node's own, which this one lacks. */
    noRuns: z.string().max(300).optional(),
    load: Load.optional(),
    tests: z.array(z.string()).max(100).optional(),
    skillFiles: z.boolean().optional(),
  }),
  z.object({ type: z.literal('load'), ...Load.shape }),
  z.object({ type: z.literal('tests.started'), partId: z.string() }),
  /* exitCode: the command's, none when it never ran or was killed. commit: what the clone tested. */
  z.object({
    type: z.literal('tests.done'),
    partId: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    error: z.enum(TEST_ERRORS).nullable(),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
    log: z.string().max(TEST_LOG_BYTES + 1024),
  }),
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
  /* Whether the agent's program runs in the view's session yet: while it starts, the window shows a loader. */
  z.object({ type: z.literal('term.program'), termId: TermId, running: z.boolean() }),
  /* A person typed to an agent that had no turn running: Hornhoof opens one so the agent has its tools. ref names the
     typed turn, and Hornhoof's answer carries it back. */
  z.object({ type: z.literal('turn.open'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), text: z.string().max(100_000), ref: z.string().max(64).optional() }),
  /* Someone who may type opened the window of an agent whose program does not run: Hornhoof starts it with a turn that
     types nothing. */
  z.object({ type: z.literal('agent.start'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }),
  /* How full the agent's context is now, as its program counts it: a share from 0 to 1. */
  z.object({ type: z.literal('agent.context'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), used: z.number().min(0).max(1) }),
  /* Whether Hornhoof's words named by ref went into the agent's running turn; if not, they wait for its next one. */
  z.object({ type: z.literal('agent.said'), ref: z.string().max(64), ok: z.boolean() }),
]);
export type NodeMessage = z.infer<typeof NodeMessage>;

/* A git repository over https and a branch name git takes as a plain name, never as an option. The token has its own
   field: an address with a name or password in it would put them on command lines and into the clone's settings. The
   address is read as a URL at the door, so what is saved is what the server and the node can read later. */
const isHttps = (u: string) => URL.canParse(u) && new URL(u).protocol === 'https:' && new URL(u).hostname !== '';
export const Branch = z.string().min(1).max(200).regex(/^[A-Za-z0-9._\/-]+$/).refine(b => !b.startsWith('-') && !b.includes('..'), 'Not a branch name.');
export const Repo = z.object({
  url: z
    .string()
    .max(500)
    .regex(/^https:\/\/[^\s]+$/)
    .refine(isHttps, 'Not an https address.')
    .refine(u => !/^https:\/\/[^/]*@/.test(u), 'Put the token in its own field, not in the address.'),
  branch: Branch,
  token: z.string().max(500),
  /* Who the agents' commits are by: set in the clone, so a node from before it leaves the field out. */
  author: z
    .object({ name: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}<>]+$/u), email: z.email().max(200) })
    .nullable()
    .optional(),
});
export type RepoAuthor = NonNullable<z.infer<typeof Repo>['author']>;
const Workspace = z.object({ key: Id, repo: Repo.nullable() });
/* As many skills as an agent can have on, each a folder named after it with its SKILL.md. */
export const MAX_SKILLS = 200;
const SkillFile = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), description: z.string().min(1).max(1000), body: z.string().max(200_000) });
export type SkillFile = z.infer<typeof SkillFile>;
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
    /* How full Claude Code's context gets before it compacts the conversation, in tokens; left out, its own window. */
    compactWindow: z.number().int().min(100_000).max(1_000_000).optional(),
    /* Node's timers wait at most this long; a longer one fires at once. */
    timeoutMs: z.number().int().positive().max(2 ** 31 - 1),
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
    /* The agent's skills, which the node writes as files where its program finds them; each name becomes a folder. */
    skills: z.array(SkillFile).max(MAX_SKILLS).optional(),
  }),
  z.object({ type: z.literal('job.cancel'), jobId: Id }),
  /* Hornhoof has the job's end: the node stops sending it again after each reconnect. */
  z.object({ type: z.literal('job.ack'), jobId: Id }),
  z.object({ type: z.literal('remove') }),
  /* write: the person may type; anyone else watches. agentKey: the agent's folder and session on the node. */
  z.object({ type: z.literal('term.open'), termId: TermId, agentKey: Id, cols: Cols, rows: Rows, write: z.boolean() }),
  z.object({ type: z.literal('term.input'), termId: TermId, data: z.string().max(TERM_CHUNK) }),
  z.object({ type: z.literal('term.resize'), termId: TermId, cols: Cols, rows: Rows }),
  z.object({ type: z.literal('term.close'), termId: TermId }),
  /* The turn Hornhoof opened for what a person typed, or none when it could not. */
  z.object({ type: z.literal('turn.opened'), agentKey: Id, jobId: Id.nullable(), toolToken: z.string().max(200).nullable(), ref: z.string().max(64).optional() }),
  /* A part of a run: the node clones the branch into a fresh folder, runs the command there as a user that reaches
     none of the node's keys, within the time, and removes the folder. No agent program takes part. branch null: for
     tests the task's own, task-<task> or the only one that starts with task-<task>-. kind work: any command, in an
     empty folder when there is no repository, with the task's files named in files fetched first; what it leaves in its
     output folder goes on the task. */
  z.object({
    type: z.literal('tests.run'),
    partId: Id,
    kind: z.enum(RUN_KINDS).optional(),
    repo: Repo.pick({ url: true, token: true }).nullable(),
    branch: Branch.nullable(),
    files: z.array(RunFile).max(MAX_RUN_FILES).optional(),
    task: z.number().int().positive(),
    command: z.string().min(1).max(4000),
    part: z.number().int().min(1).max(MAX_TEST_PARTS),
    parts: z.number().int().min(1).max(MAX_TEST_PARTS),
    timeoutMs: z.number().int().positive().max(2 ** 31 - 1),
  }),
  z.object({ type: z.literal('tests.cancel'), partId: Id }),
  /* Hornhoof has the part's end: the node stops sending it again after each reconnect. */
  z.object({ type: z.literal('tests.ack'), partId: Id }),
  /* Words for an agent whose turn runs, from its head, another agent, the orchestrator or a person's window: typed into
     the program as a person types, so the turn takes them in. */
  z.object({ type: z.literal('agent.say'), agentKey: Id, text: z.string().max(100_000), ref: z.string().max(64) }),
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
