export * from './department-mode.js';
export * from './tool-privacy.js';
export * from './external-operations.js';
export * from './request-materials.js';
export * from './questions.js';
export { APPROVAL_CHANNELS, APPROVAL_MODES, ApprovalAmount, ApprovalChannel, ApprovalRule, approvalNeeded, defaultRule, kindKey, GOING_OUT_CHANNELS, ruleOf, type ApprovalMode, type ApprovalWork, type StoredApprovalRule } from './approval-policy.js';
export { NOTIFICATION_NAMES, NotificationSchema, NotificationSourceSchema, type Notification, type NotificationSource } from './notifications.js';
export { MachineDrain, NodeWait } from './machine-drain.js';
export { inLane } from './lane.js';
export * from './pipeline-report.js';
export * from './test-terminals.js';
export { COMMIT_SHA, CommitSha, ownBranch } from './test-commit.js';
export { mutationResultMatches, MutationResult, mutationSelectionMatches, CandidateMutation, MutationDelta, MutationFunction, MutationSelection, runtimeVersionMatches, requiredTestRuntimes, runsInClass, runtimeClass, supportsTestProfile, EnvironmentProblem, FileNote, FileOutcome, KEPT_BYTES, KeptFiles, PREPARATION_UNIT, UnitFingerprint, UnitFingerprints, TestsDescribed, EnvironmentDescription, EnvironmentSnapshot, InputDigest, ProductCommitSha, RuntimeCapability, RuntimePlatform, TestExecution, TestUnit, TestEnvironmentReceipt, TEST_DESCRIPTION_BYTES, validateEnvironmentDescription, Command, EnvironmentDigest, RepositoryPath, RepositoryScope, TestArtifact, TestEnvironmentV1, TestMutation, TestPrepare, TestReset, TestService, TestSplit, TestSuite, TEST_ENVIRONMENT_BYTES, hashTestEnvironment, parseTestEnvironment } from './test-environment.js';
import { z } from 'zod';
import { NodeExit, NodeLog } from './node-exit.js';
import { CommitSha } from './test-commit.js';
import { FileOutcome, KeptFiles, RepositoryScope, RuntimeCapability, ProductCommitSha, TestExecution, TestEnvironmentReceipt, TestsDescribed } from './test-environment.js';
import { HarnessSynced } from './harness.js';
export { HarnessClaim, HarnessDone, HarnessFailed, HarnessSynced, HarnessUnit } from './harness.js';
export * from './phones.js';
import { PhoneProbe, PhoneOpen, PhoneAction, PhoneRenew, PhoneRevoke, PhoneReply, PhoneFrame } from './phones.js';
import { CheckAcquire, CheckRelease, CheckQueueReply } from './check-queue.js';
import { API_PROTOCOLS, PROVIDER_IDS, type ProviderId } from './providers.js';
export { CHECK_LEASE_MS, checkCapacity, CheckSlotQueue, CheckQueueRequest, CheckQueueReply, type CheckOptions } from './check-queue.js';

export { NODE_LOG_BYTES, NODE_LOG_LINES, NodeExit, NodeLog, NodeStopReason } from './node-exit.js';

/* Messages between the Hornhoof server and its nodes, one JSON object per WebSocket frame. */

export { PROVIDER_IDS, type ProviderId };
export { API_PROTOCOLS, API_PROVIDERS, apiEndpoint, isApiProvider, type ApiEndpoint, type ApiProtocol, type ApiProvider } from './providers.js';

export const JOB_ERRORS = ['timeout', 'agent_failed', 'not_logged_in', 'cancelled'] as const;
export type JobError = (typeof JOB_ERRORS)[number];

/* Why a turn's program failed, in one list for every program: the model is busy, too many requests now, the plan's
   window is used up, the sign-in no longer works, the program waits for a first setup only the plan's owner may pass,
   such as accepting its terms, it did not get Hornhoof's tools, the service could not be reached, the answer broke off,
   the provider will not do this work, the context or output is too big, the program itself is gone, or anything else. */
export const FAILURE_KINDS = ['overloaded', 'model_access_denied', 'rate_limited', 'usage_limit', 'auth', 'setup', 'tools', 'network', 'cut', 'refused', 'too_big', 'crash', 'unknown'] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];
/* A failed turn's kind, the program's own words for it, cut to size, and whether the program called it worth trying again. */
export const Failure = z.object({ kind: z.enum(FAILURE_KINDS), text: z.string().max(2000), retryable: z.boolean() });
export type Failure = z.infer<typeof Failure>;

/* What a turn's program does now, from its own hooks and log, never from its screen: it thinks, runs a tool, asks a person
   a question or for leave, tries the model again after an error as its log says, waits for what to type with nothing
   typed, or is gone, its session over. */
export const PROGRAM_STATES = ['thinking', 'tool', 'asking', 'retrying', 'idle', 'gone'] as const;
export type ProgramState = (typeof PROGRAM_STATES)[number];
/* The most of a gone program's last screen a node tells: its last 40 lines, cut to this many characters. */
export const PROGRAM_SCREEN_MAX = 4000;

/* How long after a turn ends the program may still start its own turn with words it kept. */
export const UNHEARD_MS = 15_000;

/* A program's own words to itself, like the news of its background work: no person's, and nothing of anyone's goes lost. */
export const isProgramOwnPrompt = (text: string): boolean => /^\s*<(?:task-notification|system-reminder)\b/.test(text);

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

/* Nodes read plan limits every five minutes. Three missed readings make a snapshot stale. */
const LIMITS_STALE_MS = 15 * 60_000;
const blockingWindow = (w: Limits['windows'][number]) => w.utilization === null || w.utilization >= 1;
const staleSnapshot = (updatedAt: string | Date | null, now: number) => {
  const measuredAt = updatedAt instanceof Date ? updatedAt.getTime() : updatedAt ? Date.parse(updatedAt) : NaN;
  return !Number.isFinite(measuredAt) || now - measuredAt > LIMITS_STALE_MS;
};
const rejectionOver = (limits: Limits, windows: Limits['windows']) => limits.status === 'rejected' && limits.windows.some(blockingWindow) && !windows.some(blockingWindow);

/* The last snapshot as it applies now: expired windows are over, and a stale one says nothing current. */
export function currentLimits(limits: Limits | null, updatedAt: string | Date | null, now = Date.now()): Limits | null {
  if (!limits) return null;
  if (staleSnapshot(updatedAt, now)) return { status: 'allowed', windows: [], complete: false };
  const windows = limits.windows.filter(w => w.resetsAt === null || Number.isNaN(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) > now);
  return { ...limits, status: rejectionOver(limits, windows) ? 'allowed' : limits.status, windows, ...(windows.length !== limits.windows.length ? { complete: false } : {}) };
}

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

/* Effort rules live apart from the message schemas so the web uses the same ones. */
export { effortFor, effortsOf, ORCHESTRATOR_EFFORT, ROLE_EFFORTS, type RoleEffort } from './efforts.js';
export { lineState, yellowUntil, NEXT_TURN_WORDS, QUIET_ALARM_MS, RETURN_MS, type LineFacts, type LineState, type WorkLine } from './map.js';

const pick = (defaultEffort: string | undefined) => (defaultEffort ? { defaultEffort } : {});

/* The model's own default for display: Claude Code as its docs give it, even for a node's older list, and the others as
   their node reported. This does not choose a level for a run. */
export function defaultEffortOf(provider: ProviderId, models: ModelOption[], model: string | null): string | null {
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
  /* OpenRouter and a compatible API run only the models their connection was given. */
  if (provider === 'claude') return CLAUDE_ALIASES;
  return [];
}

/* Job and subscription ids end up in folder names on the node, so they hold no slashes or dots. */
const Id = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/* How many tokens a turn used, as its program counted them: what went in fresh, what came out, what was read from and
   written to the prompt cache, and all of them together. A part the program does not tell is null; a turn whose program
   tells none has no counts at all. */
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
/* model: the one the turn ran on, as its program told, else the one the turn asked for; none when neither is known. */
export const TurnTokens = z
  .object({ input: Count, output: Count, cacheRead: Count, cacheWrite: Count, total: Count, model: z.string().min(1).max(200).optional() })
  .refine(t => [t.input, t.output, t.cacheRead, t.cacheWrite, t.total].some(v => v !== null), 'A turn without any count has no tokens.');
export type TurnTokens = z.infer<typeof TurnTokens>;

/* An API's address, as the company named it: http or https, with no sign-in in it, nothing after a #. */
export const ApiBaseUrl = z
  .string()
  .max(500)
  .refine(value => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.hash && url.hostname.length > 0;
    } catch {
      return false;
    }
  }, 'An API address is an http or https address with no sign-in in it.');
export const ApiConnection = z.object({ baseUrl: ApiBaseUrl, protocol: z.enum(API_PROTOCOLS) });

/* What an agent is doing while a job runs, already shortened by the node for people to watch. */
export const AgentEvent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(8000) }),
  z.object({ kind: z.literal('tool'), name: z.string().max(100), input: z.string().max(300), sensitive: z.literal(true).optional(), issued: z.literal(true).optional() }),
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

/* The departments the orchestrator starts from. Names and descriptions live in the web dictionaries and the server's prompt.
   teamMembers: how many people the turnkey teams of its template bring, for the headcount on a company template's card;
   a test keeps it equal to the team templates. */
export const DEPARTMENT_TEMPLATES: readonly { key: TemplateKey; roleCode: string; ticked: boolean; always: boolean; teamMembers: number }[] = [
  { key: 'operations', roleCode: 'OPS', ticked: true, always: true, teamMembers: 1 },
  { key: 'development', roleCode: 'DEV', ticked: true, always: false, teamMembers: 2 },
  { key: 'marketing', roleCode: 'MKT', ticked: true, always: false, teamMembers: 1 },
  { key: 'sales', roleCode: 'SAL', ticked: true, always: false, teamMembers: 1 },
  { key: 'business_development', roleCode: 'BIZ', ticked: true, always: false, teamMembers: 1 },
  { key: 'design', roleCode: 'DSN', ticked: false, always: false, teamMembers: 1 },
  { key: 'support', roleCode: 'SUP', ticked: false, always: false, teamMembers: 1 },
  { key: 'finance', roleCode: 'FIN', ticked: false, always: false, teamMembers: 1 },
  { key: 'home_devices', roleCode: 'HOM', ticked: false, always: false, teamMembers: 1 },
  { key: 'household', roleCode: 'HHD', ticked: false, always: false, teamMembers: 1 },
];

/* A ready-made company the CEO can pick on the first screen. Each one lists departments to create, with their products
   and the people setup hires into them (role code and how many). The names and descriptions live in the web dictionaries;
   the mini scheme on the card is drawn from these departments. "Start empty" is not here: it is the default on the card,
   and creates nothing. The people take a subscription the company has that may serve them, or wait for one. */
export const COMPANY_TEMPLATE_KEYS = ['project', 'startup', 'studio', 'corporation', 'security', 'opensource', 'agency', 'lab', 'home'] as const;
export type CompanyTemplateKey = (typeof COMPANY_TEMPLATE_KEYS)[number];
export type CompanyTemplateStaff = { role: string; count: number };
export type CompanyTemplateDept = { template: TemplateKey; name?: string; products?: string[]; staff: CompanyTemplateStaff[] };
export type CompanyTemplate = { key: CompanyTemplateKey; departments: readonly CompanyTemplateDept[] };

export const COMPANY_TEMPLATES: readonly CompanyTemplate[] = [
  {
    key: 'project',
    departments: [{ template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] }, { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-PM', count: 1 }] }],
  },
  {
    key: 'startup',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }, { role: 'DSN-PM', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }, { role: 'MKT-PM', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }, { role: 'BIZ-PM', count: 1 }] },
    ],
  },
  {
    key: 'studio',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2', 'Product 3'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }],
      },
    ],
  },
  {
    key: 'corporation',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      {
        template: 'development',
        products: ['Product 1', 'Product 2'],
        staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 3 }, { role: 'DEV-REV', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-PM', count: 1 }],
      },
      { template: 'design', staff: [{ role: 'DSN-HEAD', count: 1 }, { role: 'DSN-UI', count: 1 }, { role: 'DSN-SYS', count: 1 }, { role: 'DSN-PM', count: 1 }] },
      { template: 'marketing', staff: [{ role: 'MKT-HEAD', count: 1 }, { role: 'MKT-WRITE', count: 1 }, { role: 'MKT-SEO', count: 1 }, { role: 'MKT-PM', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }, { role: 'SAL-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-PM', count: 1 }] },
      { template: 'finance', staff: [{ role: 'FIN-HEAD', count: 1 }, { role: 'FIN-BOOK', count: 1 }, { role: 'FIN-PM', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-PARTNER', count: 1 }, { role: 'BIZ-PM', count: 1 }] },
    ],
  },
  {
    key: 'security',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-SEC', count: 1 }, { role: 'DEV-RED', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-PM', count: 1 }] },
    ],
  },
  {
    key: 'opensource',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-REV', count: 1 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-KB', count: 1 }, { role: 'SUP-PM', count: 1 }] },
    ],
  },
  {
    key: 'agency',
    departments: [
      { template: 'sales', staff: [{ role: 'SAL-HEAD', count: 1 }, { role: 'SAL-AE', count: 1 }, { role: 'SAL-SDR', count: 1 }, { role: 'SAL-PM', count: 1 }] },
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-INTEG', count: 1 }, { role: 'OPS-FIX', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'support', staff: [{ role: 'SUP-HEAD', count: 1 }, { role: 'SUP-T1', count: 1 }, { role: 'SUP-T2', count: 1 }, { role: 'SUP-PM', count: 1 }] },
    ],
  },
  {
    key: 'lab',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'development', staff: [{ role: 'DEV-HEAD', count: 1 }, { role: 'DEV-ARCH', count: 1 }, { role: 'DEV-ENG', count: 2 }, { role: 'DEV-DOCS', count: 1 }, { role: 'DEV-PM', count: 1 }] },
      { template: 'business_development', staff: [{ role: 'BIZ-HEAD', count: 1 }, { role: 'BIZ-ANALYST', count: 1 }, { role: 'BIZ-PM', count: 1 }] },
    ],
  },
  {
    key: 'home',
    departments: [
      { template: 'operations', staff: [{ role: 'OPS-HEAD', count: 1 }, { role: 'OPS-WATCH', count: 1 }, { role: 'OPS-BUGS', count: 1 }, { role: 'OPS-PROGRAM', count: 1 }, { role: 'OPS-PM', count: 1 }] },
      { template: 'home_devices', staff: [{ role: 'HOM-HEAD', count: 1 }, { role: 'HOM-NET', count: 1 }, { role: 'HOM-SMART', count: 1 }, { role: 'HOM-PM', count: 1 }] },
      { template: 'household', staff: [{ role: 'HHD-HEAD', count: 1 }, { role: 'HHD-SUPPLY', count: 1 }, { role: 'HHD-BILLS', count: 1 }, { role: 'HHD-CAL', count: 1 }, { role: 'HHD-PM', count: 1 }] },
    ],
  },
];

/* A live terminal between a person's browser and an agent's session on a node: its id, and the screen size in cells. */
const TermId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const Cols = z.number().int().min(10).max(500);
const Rows = z.number().int().min(4).max(200);
/* What one frame carries of a terminal's screen or of a person's keys and pastes. */
export const TERM_CHUNK = 64 * 1024;
/* Keys that may leave words in a program's input. Scrolling, clicks, arrows and a lone Enter leave none. */
export const typesWords = (data: string): boolean => /[^\x00-\x20\x7f]/.test(data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/g, ''));
/* Focus, the answers to a program's queries and the mouse: what a terminal sends by itself, as tmux attaches or its window
   takes focus, and no person typed. */
const TERMINAL_REPORT = /^\x1b\[(?:[IO]|[>?][0-9;]*c|[0-9;]*R|<[0-9]+;[0-9]+;[0-9]+[Mm])$/;
export const isTerminalReport = (data: string): boolean => TERMINAL_REPORT.test(data);

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
/* The agents whose programs run on a node now, which a node that runs them in terminals names with its hello and each load:
   Hornhoof starts no new program on a machine short of free memory. A list that is not one counts as none said. */
const Live = z.array(z.string().regex(/^[A-Za-z0-9-]{1,64}$/)).max(200).optional().catch(undefined);

/* Installed agent programs and an update in progress on the connected node. */
export const ProgramInfo = z.object({
  id: z.enum(['claude', 'codex', 'kimi']),
  version: z.string().min(1).max(64).nullable(),
  updating: z.boolean(),
  failed: z.boolean(),
});
export type ProgramInfo = z.infer<typeof ProgramInfo>;
const Programs = z.array(ProgramInfo).max(3);

/* What a plan's sign-in is on a node: Claude's long token, Codex's auth file (on one machine at a time), Kimi's and GLM's
   keys. Hornhoof keeps each only sealed to one node's public key, so it can never read them. */
export const CRED_KINDS = ['claude_token', 'codex_auth', 'kimi_key', 'glm_key'] as const;
export type CredKind = (typeof CRED_KINDS)[number];
const CredKind = z.enum(CRED_KINDS);
/* The account a node's program is signed in to, as far as the program tells: unknown parts are null. */
export const Account = z.object({ email: z.string().max(200).nullable(), tier: z.string().max(40).nullable() });
export type Account = z.infer<typeof Account>;
/* An age public key, and an armored age message sealed to one. */
export const AgeRecipient = z.string().regex(/^age1[0-9a-z]{58}$/);
export const Sealed = z.string().min(1).max(64 * 1024);
const MAX_ENVELOPES = 20;
/* How a node came up: when its program started, when the machine under it did, and the container it runs in. Hornhoof
   compares it with what the node said before to tell why turns it ran are gone. */
export const Boot = z.object({ startedAt: z.iso.datetime(), machineUpAt: z.iso.datetime(), container: z.string().min(1).max(200) });
export type Boot = z.infer<typeof Boot>;
/* A node build: the commit, in full, of the last change to the files of the node's image. */
export const NodeBuild = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/* How an agent's program ended: its exit code, or the signal that ended it, by name, such as SIGTERM. */
export const ProgramExit = z.object({ code: z.number().int().nullable(), signal: z.string().max(40).nullable() });
export type ProgramExit = z.infer<typeof ProgramExit>;
const BrowserError = z.string().min(1).max(300);

/* How the server saw a node's connection end: the node stopped answering its pings, the node closed it, it was cut with no
   word from either side, the socket failed, a newer connection of the same node took its place, the server stopped, or the
   node was taken off its machine in Hornhoof. */
export const CONNECTION_ENDS = ['missed_pongs', 'node_closed', 'network', 'socket_error', 'replaced', 'server_stopped', 'disconnected', 'not_taken'] as const;
export type ConnectionEnd = (typeof CONNECTION_ENDS)[number];

export const NODE_DISCONNECT_CAUSES = [
  'watchdog_timeout',
  'server_close',
  'socket_error',
  'dns_error',
  'handshake_timeout',
  'http_rejected',
  'abnormal_close',
] as const;
export type NodeDisconnectCause = (typeof NODE_DISCONNECT_CAUSES)[number];

/* What a node observed across a connection drop, sent right after hello once it reconnects. */
export const NodeReconnect = z.object({
  disconnectedAt: z.iso.datetime(),
  reconnectedAt: z.iso.datetime(),
  offlineMs: z.number().int().nonnegative(),
  attempts: z.number().int().min(1),
  cause: z.enum(NODE_DISCONNECT_CAUSES),
  closeCode: z.number().int().min(0).max(65_535).nullable(),
  closeReason: z.string().max(200).regex(/^[^\p{Cc}]*$/u).nullable(),
  errorCode: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/).nullable(),
  error: z.string().max(300).regex(/^[^\p{Cc}]*$/u).nullable(),
  dnsFailed: z.boolean(),
  watchdogTimedOut: z.boolean(),
  clockJumpMs: z.number().int().positive().nullable(),
  networkChanged: z.boolean(),
});
export type NodeReconnect = z.infer<typeof NodeReconnect>;

/* The node messages that change the company's data. A node numbers them from 1 within a stream and keeps each until the
   server confirms it, so a restart on either side loses none and applies none twice. The rest are snapshots or live
   answers that are worth nothing late: hello, load, status, the terminal's screens, turn.open, agent.start, agent.said,
   agent.restarted and node.stopping. */
export const NUMBERED = ['job.started', 'job.event', 'job.done', 'tests.started', 'tests.done', 'cred.sealed', 'login.done', 'agent.context', 'removed', 'job.program', 'agent.hook_rejected', 'agent.unheard'] as const;
/* Optional, so a build that does not number still talks to one that does. */
const MessageNumber = z.number().int().min(1).optional();
/* The header of the upgrade answer of a server that sends ack. */
export const ACKS_HEADER = 'hornhoof-acks';
/* The header of the upgrade answer of a server that answers an agent's calls to its tools with no turn running, by
   tools.call. */
export const TOOLS_HEADER = 'hornhoof-tools';
/* The most a call to the tools with no turn running, or Hornhoof's answer to it, carries: a frame holds 4 MB. */
export const TOOLS_BODY_MAX = 3 * 1024 * 1024;
/* What an MCP client sends while it connects and looks at what the server has. A newer client, agy 1.4.12 among them,
   first asks with server/discover and falls back to initialize when the server does not know it. */
export const MCP_CONNECTING: readonly string[] = ['server/discover', 'initialize', 'notifications/initialized', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list'];
/* How many runs or parts a hello may list. A node lists the ends it has not had confirmed too, and never drops those, so
   the bound is the outbox's own; at a uuid's 39 bytes both lists leave half of the socket's 4 MiB for the rest. */
export const HELLO_IDS_MAX = 20_000;
/* A server that sends no ack drops a hello that lists more than this. */
export const HELLO_IDS_BEFORE_ACKS = 100;

const NodeMessage = z.discriminatedUnion('type', [
  CheckAcquire, CheckRelease, TestsDescribed, HarnessSynced, PhoneReply, PhoneFrame,
  /* terminals: the node runs agents in sessions people can watch and type into. */
  /* tests: the parts of test runs it runs, or ran and Hornhoof has not confirmed. */
  /* skillFiles: it writes a turn's skills as files where the agent's program finds them; a node without it gets them in
     the instructions. */
  z.object({
    type: z.literal('hello'),
    version: z.string().max(40),
    loggedIn: z.boolean(),
    /* Signed in, but the program waits for a first setup only the plan's owner may pass, such as accepting its terms. */
    setupNeeded: z.boolean().optional(),
    running: z.array(z.string()).max(HELLO_IDS_MAX),
    models: Models.optional(),
    terminals: z.boolean().optional(),
    phones: z.boolean().optional(),
    /* The node runs parts of other work too, not only of test runs. */
    work: z.boolean().optional(),
    /* Why the node takes no part of any run: a part runs only as a user of the node's own, which this one lacks. */
    noRuns: z.string().max(300).optional(),
    testEnvironmentVersion: z.literal(1).optional(),
    testRuntimes: z.array(RuntimeCapability).max(64).optional(),
    /* It takes the harness of a product ahead of any run, and shares what it builds through Hornhoof. */
    testHarness: z.literal(1).optional(),
    /* Why the Playwright browsers could not launch on this node before handing out tasks or runs; null when ready. */
    browserError: BrowserError.nullable().optional(),
    load: Load.optional(),
    live: Live,
    tests: z.array(z.string()).max(HELLO_IDS_MAX).optional(),
    skillFiles: z.boolean().optional(),
    /* The key Hornhoof seals this node's sign-ins to; the private half never leaves the node. */
    publicKey: AgeRecipient.optional(),
    account: Account.nullable().optional(),
    boot: Boot.optional(),
    programs: Programs.optional(),
    /* The node build CI wrote into the node's image, the last commit that changed its files; none from a node built by
       hand or from before. One that is not a commit is left out rather than the hello refused. */
    build: NodeBuild.optional().catch(undefined),
    restart: NodeExit.optional(),
    nodeLog: NodeLog.optional(),
    /* The outbox the node numbers its messages in: a uuid made with its file, so a wiped volume never reuses a number. */
    stream: z.uuid().optional(),
  }),
  z.object({ type: z.literal('node.stopping'), startedAt: z.iso.datetime(), exit: NodeExit }),
  z.object({ type: z.literal('node.reconnect'), ...NodeReconnect.shape }),
  z.object({ type: z.literal('load'), ...Load.shape, live: Live }),
  z.object({ type: z.literal('tests.waiting'), partId: z.string(), position: z.number().int().positive() }),
  z.object({ type: z.literal('tests.started'), partId: z.string(), n: MessageNumber }),
  /* exitCode: the command's, none when it never ran or was killed. commit: what its clone was at when the command ran. */
  z.object({
    type: z.literal('tests.done'),
    partId: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int().nullable(),
    error: z.enum(TEST_ERRORS).nullable(),
    commit: CommitSha.nullable(),
    log: z.string().max(TEST_LOG_BYTES + 1024),
    environmentReceipt: TestEnvironmentReceipt.optional(),
    /* How each test file went, where its runner says; none means its suite's outcome is all that is known. */
    files: z.array(FileOutcome).max(10_000).optional(),
    kept: KeptFiles.optional(),
    n: MessageNumber,
  }),
  z.object({
    type: z.literal('status'),
    loggedIn: z.boolean(),
    setupNeeded: z.boolean().optional(),
    limits: Limits.nullable(),
    models: Models.optional(),
    account: Account.nullable().optional(),
    programs: Programs.optional(),
    browserError: BrowserError.nullable().optional(),
    noRuns: z.string().max(300).nullable().optional(),
    testEnvironmentVersion: z.literal(1).optional(),
    testRuntimes: z.array(RuntimeCapability).max(64).optional(),
    /* It takes the harness of a product ahead of any run, and shares what it builds through Hornhoof. */
    testHarness: z.literal(1).optional(),
  }),
  /* The sign-in this node holds, sealed for each of the plan's other nodes; version counts sign-ins of the plan. */
  z.object({
    type: z.literal('cred.sealed'),
    kind: CredKind,
    version: z.number().int().min(1),
    envelopes: z.array(z.object({ nodeId: Id, sealed: Sealed })).max(MAX_ENVELOPES),
    n: MessageNumber,
  }),
  /* How the sign-in Hornhoof started on this node ended. */
  z.object({ type: z.literal('login.done'), ok: z.boolean(), error: z.string().max(300).nullable(), n: MessageNumber }),
  z.object({ type: z.literal('job.started'), jobId: z.string(), n: MessageNumber }),
  /* Which of the turns Hornhoof asked about the node still runs, as its hello would list them. */
  z.object({ type: z.literal('jobs.held'), asked: z.array(z.string()).max(100), held: z.array(z.string()).max(100) }),
  /* The node's last lines of log, as Hornhoof asked for them. */
  z.object({ type: z.literal('node.log'), requestId: z.uuid(), log: NodeLog }),
  z.object({
    type: z.literal('job.done'),
    jobId: z.string(),
    ok: z.boolean(),
    sessionId: z.string().nullable(),
    result: z.string(),
    tail: z.string(),
    error: z.enum(JOB_ERRORS).nullable(),
    /* The ended turn's words are still queued or held by the program; older nodes send none. */
    wordsWaiting: z.boolean().optional(),
    /* Set on a failed turn whose program said why; older nodes send none. */
    failure: Failure.optional(),
    /* The tokens the turn used; null when its program told none, left out by older nodes. */
    tokens: TurnTokens.nullable().optional(),
    /* How the agent's program ended, when the node saw it end: its exit code, or the name of the signal that ended it. */
    exit: ProgramExit.optional(),
    n: MessageNumber,
  }),
  z.object({ type: z.literal('job.event'), jobId: z.string(), seq: z.number().int().min(0), event: AgentEvent, n: MessageNumber }),
  /* What the turn's program does now: sent at each change of its state or tool, and while the turn runs at least once a
     minute, so Hornhoof knows the node is there. since: when the state began; tool: the tool it runs; signAt: when the
     program last gave any sign of life, a hook call or a line in its log; retry: its own retry while retrying. Older
     nodes send neither signAt nor retry. screenAt: when its screen last changed, now only for people to see. Times are
     the node's, in milliseconds since 1970. A program that is gone says how it ended, its exit code or the signal that
     ended it, null both when its session went whole, and its last screen. */
  z.object({
    type: z.literal('job.program'),
    jobId: z.string(),
    /* The session the program named by now: a node that restarts mid-turn can no longer say so when the turn ends. */
    session: z.string().min(1).max(200).optional(),
    state: z.enum(PROGRAM_STATES),
    since: z.number().int().nonnegative(),
    tool: z.string().max(100).optional(),
    screenAt: z.number().int().nonnegative(),
    signAt: z.number().int().nonnegative().optional(),
    retry: z.object({ attempt: z.number().int().min(1), max: z.number().int().min(1).nullable(), nextAt: z.number().int().nonnegative().nullable() }).optional(),
    exitCode: ProgramExit.shape.code.optional(),
    signal: ProgramExit.shape.signal.optional(),
    screen: z.string().max(PROGRAM_SCREEN_MAX).optional(),
    n: MessageNumber,
  }),
  z.object({ type: z.literal('removed'), n: MessageNumber }),
  z.object({ type: z.literal('term.data'), termId: TermId, data: z.string().max(4 * TERM_CHUNK) }),
  z.object({ type: z.literal('term.exit'), termId: TermId }),
  /* Whether the agent's program runs in the view's session yet: while it starts, the window shows a loader. asleep: it sleeps
     until its next turn, and the window shows what it printed and says so. */
  z.object({ type: z.literal('term.program'), termId: TermId, running: z.boolean(), asleep: z.boolean().optional() }),
  /* A person typed to an agent that had no turn running: Hornhoof opens one so the agent has its tools. ref names the
     typed turn, and Hornhoof's answer carries it back. */
  z.object({ type: z.literal('turn.open'), queuedFrom: Id.optional(), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), text: z.string().max(100_000), ref: z.string().max(64).optional() }),
  /* Someone who may type opened the window of an agent whose program does not run: Hornhoof starts it with a turn that
     types nothing. */
  z.object({ type: z.literal('agent.start'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }),
  /* What the agent's program sent to its tools while no turn of it ran: as it connected, or a call. Hornhoof answers it in
     a step of its own, as tools.answer under the same ref. version: the MCP protocol version the program asked with. */
  z.object({ type: z.literal('tools.call'), agentKey: Id, ref: z.string().min(1).max(64), body: z.string().max(TOOLS_BODY_MAX), version: z.string().max(40).optional() }),
  /* The agent's program runs a check command while no turn of it runs: Hornhoof opens a step of its tools for it, and says
     which as tools.checking under the same ref. */
  z.object({ type: z.literal('tools.check'), agentKey: Id, ref: z.string().min(1).max(64) }),
  /* The check command of that step ended; ok: with code 0. */
  z.object({ type: z.literal('tools.checked'), agentKey: Id, jobId: Id, ok: z.boolean() }),
  /* A hook refusal is diagnostic, not an answer or a change to the turn's state. */
  z.object({
    type: z.literal('agent.hook_rejected'),
    agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    event: z.string().regex(/^[a-z]{1,20}$/),
    reason: z.string().min(1).max(300),
    n: MessageNumber,
  }),
  /* How full the agent's context is now, as its program counts it: a share from 0 to 1. */
  z.object({ type: z.literal('agent.context'), agentKey: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), used: z.number().min(0).max(1), n: MessageNumber }),
  /* Whether Hornhoof's words named by ref went into the agent's running turn; if not, they wait for its next one. */
  /* Said ok means the program recorded the words, or Codex holds them. Unheard follows if they never entered a turn. */
  z.object({ type: z.literal('agent.said'), ref: z.string().max(64), ok: z.boolean() }),
  z.object({ type: z.literal('agent.unheard'), agentKey: Id, jobId: Id.nullable(), text: z.string().max(100_000), n: MessageNumber }),
  z.object({ type: z.literal('agent.words_settled'), agentKey: Id, jobId: Id }),
  /* Words a program's input held, that nobody sent, before a new turn: Hornhoof keeps them and answers, and only then does
     the node clear the input. typed: someone typed at the terminal since Hornhoof last typed there. The same ref means the
     same words for the same turn, so words sent again are kept once. */
  z.object({ type: z.literal('agent.input_left'), agentKey: Id, jobId: Id.nullable(), text: z.string().max(100_000), typed: z.boolean(), ref: z.string().min(1).max(64) }),
  /* How a restart Hornhoof asked for went: done, or why the node did not do it. */
  z.object({ type: z.literal('agent.restarted'), agentKey: Id, jobId: Id, ok: z.boolean(), reason: z.string().max(300).nullable() }),
]);
export type NodeMessage = z.infer<typeof NodeMessage>;

const NUMBERED_TYPES: ReadonlySet<string> = new Set(NUMBERED);
/* Whether a node numbers this message, whether or not this one carries a number. */
export const isNumbered = (m: NodeMessage): boolean => NUMBERED_TYPES.has(m.type);

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
/* repositoryScope: the repository as the company's registry of what is built knows it, so the agent's worktree can take the
   dependencies a machine built for its commit. */
const Workspace = z.object({ key: Id, repo: Repo.nullable(), repositoryScope: RepositoryScope.optional() });
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

function validTestMode(message: { command: string; commitSha?: string | null; environment?: TestExecution; repositoryScope?: RepositoryScope }): boolean {
  if (!message.environment) return message.command.trim().length > 0;
  const description = message.environment.snapshot.description;
  return !message.command && message.commitSha === description.commitSha && JSON.stringify(message.repositoryScope) === JSON.stringify(description.repositoryScope);
}

const ServerMessage = z.discriminatedUnion('type', [
  CheckQueueReply, PhoneProbe, PhoneOpen, PhoneAction, PhoneRenew, PhoneRevoke,
  z.object({
    type: z.literal('job.run'),
    jobId: Id,
    subscriptionId: Id,
    provider: z.enum(PROVIDER_IDS),
    prompt: z.string(),
    /* An assistant's whole conversation with its owner, which the node types in place of the prompt when the session the
       turn goes on in starts anew. A node from before drops it and types the prompt. */
    freshPrompt: z.string().optional(),
    sessionId: z.string().nullable(),
    model: z.string().nullable(),
    /* How hard the program thinks; null leaves it at its own default. */
    effort: Effort.nullable().optional(),
    /* How full Claude Code's context gets before it compacts the conversation, in tokens; left out, its own window. */
    compactWindow: z.number().int().min(100_000).max(1_000_000).optional(),
    /* Node's timers wait at most this long; a longer one fires at once. */
    timeoutMs: z.number().int().positive().max(2 ** 31 - 1),
    secret: z.string().nullable(),
    /* For an API key: where its program sends its calls and in which protocol. A node from before runs the Claude and
       OpenAI APIs at their own addresses without it. */
    api: ApiConnection.optional(),
    /* The agent's standing instructions for this job, and the token its Hornhoof tools present. */
    instructions: z.string().max(MAX_INSTRUCTIONS).nullable(),
    toolToken: z.string().max(200).nullable(),
    /* The conversation from before, for a program that starts a new session on a turn that types nothing: it goes with
       the instructions when the program starts and is no change of them. */
    context: z.string().max(64 * 1024).nullable().optional(),
    /* The agent's own folder on the node and the repository it works in; a test job has none. */
    workspace: Workspace.nullable().optional(),
    /* The agent's skills, which the node writes as files where its program finds them; each name becomes a folder. */
    skills: z.array(SkillFile).max(MAX_SKILLS).optional(),
    /* A one-shot call: the program runs once in its mode that answers and exits, in a fresh folder of the call's own with
       the workspace's repository cloned in it, which the node removes after. It keeps no session, has no inbox and takes
       its turn in the machine's check queue. */
    call: z.literal(true).optional(),
  }),
  z.object({ type: z.literal('programs.update') }),
  z.object({ type: z.literal('job.cancel'), jobId: Id }),
  /* Hornhoof has every numbered message of the node's stream up to this number, applied or failed for good; the node
     drops them. */
  z.object({ type: z.literal('ack'), upto: z.number().int().min(0) }),
  /* Hornhoof asks which of these turns the node still runs: one it does not is over. */
  z.object({ type: z.literal('jobs.check'), jobIds: z.array(Id).min(1).max(100) }),
  /* Hornhoof asks for the node's last lines of log. */
  z.object({ type: z.literal('node.log.read'), requestId: z.uuid() }),
  /* Hornhoof has the job's end: the node stops sending it again after each reconnect. */
  z.object({ type: z.literal('job.ack'), jobId: Id }),
  z.object({ type: z.literal('remove') }),
  /* A sign-in sealed to this node's key, which it opens and keeps where its program reads it; drop removes it. */
  z.object({ type: z.literal('cred.put'), kind: CredKind, version: z.number().int().min(1), sealed: Sealed }),
  /* Seal the sign-in this node holds for these nodes of the same plan and send it back as cred.sealed under version. */
  z.object({ type: z.literal('cred.seal'), kind: CredKind, version: z.number().int().min(1), recipients: z.array(z.object({ nodeId: Id, publicKey: AgeRecipient })).max(MAX_ENVELOPES) }),
  /* Open the plan's sign-in in the login terminal; fresh signs the program out first, for another account. */
  z.object({ type: z.literal('login.start'), fresh: z.boolean() }),
  z.object({ type: z.literal('login.stop') }),
  /* Codex runs on one machine at a time: hold says whether this node is it. */
  z.object({ type: z.literal('cred.lease'), hold: z.boolean() }),
  /* write: the person may type; anyone else watches. agentKey: the agent's folder and session on the node. */
  z.object({ type: z.literal('term.open'), termId: TermId, agentKey: Id, cols: Cols, rows: Rows, write: z.boolean() }),
  /* pressedIn: these keys hold an Enter of a person, pressed in this running turn: what it sends may come out of the
     program's own queue after that turn. */
  z.object({ type: z.literal('term.input'), termId: TermId, data: z.string().max(TERM_CHUNK), pressedIn: Id.optional() }),
  z.object({ type: z.literal('term.resize'), termId: TermId, cols: Cols, rows: Rows }),
  z.object({ type: z.literal('term.close'), termId: TermId }),
  /* The turn Hornhoof opened for what a person typed, or none when it could not. */
  z.object({ type: z.literal('turn.opened'), agentKey: Id, jobId: Id.nullable(), toolToken: z.string().max(200).nullable(), ref: z.string().max(64).optional() }),
  /* A part of a run: the node clones the branch into a fresh folder, runs the command there as a user that reaches
     none of the node's keys, within the time, and removes the folder. No agent program takes part. branch null: for
     tests the task's own, task-<task> or the only one that starts with task-<task>-. kind work: any command, in an
     empty folder when there is no repository, with the task's files named in files fetched first; what it leaves in its
     output folder goes on the task. commitSha: the one commit every part of the run checks, whatever its branch points
     at by now; none on a part of work, or on one of a run from before commits were pinned. */
  z.strictObject({ type: z.literal('tests.describe'), requestId: Id, repositoryScope: RepositoryScope, repo: Repo.pick({ url: true, token: true }), commitSha: ProductCommitSha, baseCommit: ProductCommitSha.optional() }),
  z.strictObject({ type: z.literal('tests.describe.cancel'), requestId: Id }),
  /* Get the harness of this commit ready before any run asks for it. */
  z.strictObject({ type: z.literal('tests.harness'), requestId: Id, repositoryScope: RepositoryScope, repo: Repo.pick({ url: true, token: true }), commitSha: ProductCommitSha }),
  z.object({
    type: z.literal('tests.run'),
    partId: Id,
    kind: z.enum(RUN_KINDS).optional(),
    repo: Repo.pick({ url: true, token: true }).nullable(),
    branch: Branch.nullable(),
    commitSha: CommitSha.nullable().optional(),
    files: z.array(RunFile).max(MAX_RUN_FILES).optional(),
    task: z.number().int().positive(),
    command: z.string().max(4000).default(''),
    repositoryScope: RepositoryScope.optional(),
    environment: TestExecution.optional(),
    /* What the suites of this part left in their last run. */
    kept: KeptFiles.optional(),
    part: z.number().int().min(1).max(MAX_TEST_PARTS),
    parts: z.number().int().min(1).max(MAX_TEST_PARTS),
    timeoutMs: z.number().int().positive().max(2 ** 31 - 1),
  }).refine(validTestMode, 'A product selection and a manual command are mutually exclusive.'),
  z.object({ type: z.literal('tests.cancel'), partId: Id }),
  /* Hornhoof has the part's end: the node stops sending it again after each reconnect. */
  z.object({ type: z.literal('tests.ack'), partId: Id }),
  /* Words for an agent whose turn runs, from its head, another agent, the orchestrator or a person's window: typed into
     the program as a person types, so the turn takes them in. The optional within budget, in milliseconds from receipt,
     limits how long the node can wait to type them without depending on the server's clock. */
  z.object({ type: z.literal('agent.say'), agentKey: Id, text: z.string().max(100_000), ref: z.string().max(64), within: z.number().int().nonnegative().optional() }),
  /* Hornhoof keeps the words named by ref, so the node may clear them from the program's input. */
  z.object({ type: z.literal('agent.input_kept'), agentKey: Id, ref: z.string().min(1).max(64) }),
  /* Restart the agent's program in the same session, when it cannot come back by itself. The node checks the same
     conditions against its own events first, then types the note and the turn's words the program had not taken in. */
  z.object({ type: z.literal('agent.restart'), agentKey: Id, jobId: Id, note: z.string().max(4000) }),
  /* The agent left this node's plan: its program goes once it is idle. jobId is the last turn it was sent here, so a word that
     comes late does not close a program that ran a later one. */
  z.object({ type: z.literal('agent.release'), agentKey: Id, jobId: Id }),
  /* Hornhoof's answer to a tools.call, as its /mcp gave it: the HTTP status and the body, empty for a notification. */
  z.object({ type: z.literal('tools.answer'), agentKey: Id, ref: z.string().min(1).max(64), status: z.number().int().min(100).max(599), body: z.string().max(TOOLS_BODY_MAX) }),
  /* The step a check command of a tools.check runs in, open until the node says it ended or Hornhoof stops it with
     job.cancel; or, with none, the words its program gets for why it may not run now. */
  z.object({ type: z.literal('tools.checking'), agentKey: Id, ref: z.string().min(1).max(64), jobId: Id.nullable(), refused: z.string().max(500).optional() }),
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
