import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { WAIT_OUTCOMES, WAIT_SOURCE_KINDS, WAIT_STATES, type ExternalWait, type WaitPlan, type WaitSourceState } from '@hornhoof/protocol/waits';
import type { QuestionAudience, QuestionClassificationSnapshot } from '@hornhoof/protocol';
import { API_PROTOCOLS, APPROVAL_CHANNELS, APPROVAL_MODES, CATALOG_KINDS, COMPANY_TEMPLATE_KEYS, CONNECTION_ENDS, CRED_KINDS, INVALIDATION_CODES, MACHINE_KINDS, MESSAGE_STATUSES, MODEL_CHECK_KINDS, PROVIDER_IDS, RISK_CLASSES, RUN_KINDS, TEMPLATE_KEYS, WORK_KINDS, type MaterialSnapshotHistory, type CatalogValue, type CheckBinding, type CheckResult, type EvaluationCounts, type GateCode, type MessageDocument, type OutboundPolicyValue, type ReasonCode, type ModelIdentity, type EnvironmentSnapshot, type EnvironmentProblem, type RepositoryScope, type TestExecution, type TestEnvironmentReceipt, type Account, type Boot, type Failure, type Limits, type ModelOption, type NodeExit, type NodeReconnect, type TestFileTiming, type TestPackageTiming, type TurnFacts } from '@hornhoof/protocol';
import type { OperatorInputLine, OperatorQuestion, OperatorReason } from '@hornhoof/protocol/program-operator';
import type { MessageParty } from '../modules/events/parties.js';
import type { BindingPart } from '../modules/model-checks/lifecycle.js';
import type { UnitFingerprint } from '@hornhoof/protocol';
import type { RunProblem, Thresholds } from '../modules/model-checks/score.js';
import { sql } from 'drizzle-orm';
import { bigint, bigserial, boolean, check, customType, date, doublePrecision, foreignKey, index, integer, jsonb, pgTable, primaryKey, real, serial, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const companyId = () => uuid('company_id').notNull().references(() => companies.id);
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });

/* Legacy rows keep null metadata. A versioned public stamp is always complete. */
const materialStamp = (revision: AnyPgColumn, digest: AnyPgColumn) => sql`
  (${revision} IS NULL AND ${digest} IS NULL) OR
  (${revision} IS NOT NULL AND ${digest} IS NOT NULL AND ${revision} > 0
   AND ${revision} <= 9007199254740991 AND ${digest} ~ '^[0-9a-f]{64}$')`;
/* JSON bytes remain private/bounded; the sealing service validates the history
   structure and append-only semantics before persisting it. */
const materialHistoryBound = (history: AnyPgColumn) => sql`
  ${history} IS NULL OR (jsonb_typeof(${history}) = 'object' AND octet_length(${history}::text) <= 1048576)`;

/* Source metadata is private server state, not classification or route authority. Unknown legacy provenance stays null. */
const questionColumns = () => ({
  audience: text('audience').$type<QuestionAudience>().notNull().default('internal'),
  questionRevision: bigint('question_revision', { mode: 'number' }).notNull().default(1),
  sourceKey: text('source_key'),
  sourceJobId: uuid('source_job_id').references(() => jobs.id),
  sourceSequence: bigint('source_sequence', { mode: 'number' }),
  triageAgentId: uuid('triage_agent_id').references(() => agents.id),
  routeRevision: bigint('route_revision', { mode: 'number' }).notNull().default(1),
  classification: jsonb('classification').$type<QuestionClassificationSnapshot>(),
});
type QuestionColumns = { [K in keyof ReturnType<typeof questionColumns>]: AnyPgColumn } & { companyId: AnyPgColumn };
const safeRevision = (column: AnyPgColumn) => sql`${column} BETWEEN 1 AND 9007199254740991`;
const safeSequence = (column: AnyPgColumn) => sql`${column} BETWEEN 0 AND 9007199254740991`;
const questionObjectBound = (column: AnyPgColumn) => sql`jsonb_typeof(${column}) = 'object' AND octet_length(${column}::text) <= 32768`;
const questionChecks = (name: string, t: QuestionColumns) => [
  check(`${name}_question_audience`, sql`${t.audience} IN ('internal', 'human', 'legacy')`),
  check(`${name}_question_revision`, safeRevision(t.questionRevision)),
  check(`${name}_route_revision`, safeRevision(t.routeRevision)),
  check(`${name}_source_sequence`, safeSequence(t.sourceSequence)),
  check(`${name}_source_key`, sql`length(btrim(${t.sourceKey})) BETWEEN 1 AND 512 AND ${t.sourceKey} !~ '[[:cntrl:]]'`),
  check(`${name}_classification_bound`, questionObjectBound(t.classification)),
  unique(`${name}_source_episode`).on(t.companyId, t.sourceKey),
];
export type QuestionRecoveryIntent = {
  sourceKey: string;
  reason: 'internal_route_unavailable' | 'plan_unavailable';
  recordedAt: string;
};
const internalResolutionColumns = () => ({
  executorInstruction: text('executor_instruction'),
  resolvedByAgentId: uuid('resolved_by_agent_id').references(() => agents.id),
  resolvedByJobId: uuid('resolved_by_job_id').references(() => jobs.id),
  resolvedSourceSequence: bigint('resolved_source_sequence', { mode: 'number' }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  recoveryIntent: jsonb('recovery_intent').$type<QuestionRecoveryIntent>(),
});
type ResolutionColumns = { [K in keyof ReturnType<typeof internalResolutionColumns>]: AnyPgColumn };
const resolutionChecks = (name: string, t: ResolutionColumns) => [
  check(`${name}_resolver_whole`, sql`num_nonnulls(${t.resolvedByAgentId}, ${t.resolvedByJobId}, ${t.resolvedAt}) IN (0, 3)
    AND (${t.resolvedSourceSequence} IS NULL OR ${t.resolvedAt} IS NOT NULL)`),
  check(`${name}_resolver_sequence`, safeSequence(t.resolvedSourceSequence)),
  check(`${name}_recovery_bound`, questionObjectBound(t.recoveryIntent)),
];

/* One deployment serves one company: the unique singleton column makes a second row impossible. */
/* How mail from employees and Hornhoof reaches an employee: kept in its inbox and taken in one turn for the lot, or each
   as a turn of its own and into the turn that runs. */
export const INBOX_MODES = ['inbox', 'direct'] as const;
export type InboxMode = (typeof INBOX_MODES)[number];

export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  /* The delivery of every employee whose department and own card say none. */
  inboxMode: text('inbox_mode', { enum: INBOX_MODES }).notNull().default('inbox'),
  /* What the orchestrator learned about the company, saved when the CEO creates the structure. */
  brief: text('brief').notNull().default(''),
  /* The ready-made template the CEO started from, so the orchestrator's greeting knows it. Null when the CEO started empty. */
  template: text('template', { enum: COMPANY_TEMPLATE_KEYS }),
  singleton: boolean('singleton').notNull().default(true).unique(),
  /* Task and turn numbers the company gave before their rows were removed by hand: new ones go on after them, so a branch
     task-N or a version 0.N.0 never names two pieces of work. */
  taskNumbersUsed: integer('task_numbers_used').notNull().default(0),
  turnNumbersUsed: integer('turn_numbers_used').notNull().default(0),
  createdAt: createdAt(),
});

/* company: the person reaches the whole company. listed: the departments and teams in person_access. */
export const SCOPE_KINDS = ['company', 'listed'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const people = pgTable(
  'people',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    /* Every person signs in by it; an assistant never signs in, so it may have none. */
    email: text('email').unique(),
    title: text('title').notNull().default(''),
    passwordHash: text('password_hash'),
    status: text('status', { enum: ['active', 'invited', 'disabled'] }).notNull(),
    scopeKind: text('scope_kind', { enum: SCOPE_KINDS }).notNull(),
    isOwner: boolean('is_owner').notNull().default(false),
    /* The CEO's delegate takes the CEO's decisions, while active with the whole company. Only the CEO sets it. */
    isCeoDelegate: boolean('is_ceo_delegate').notNull().default(false),
    /* Who they are in Telegram, so a head's bot knows them: a username, kept in small letters, and the number Telegram gives
       the account, which a bot learns the first time they write under that username and goes by from then on. */
    telegramUsername: text('telegram_username'),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }),
    /* A personal assistant: an outside agent that acts for the person it belongs to, with that person's rights as they are at
       each call, through its key only. It never signs in with a password. */
    isAgent: boolean('is_agent').notNull().default(false),
    assistantOf: uuid('assistant_of').references((): AnyPgColumn => people.id),
    createdAt: createdAt(),
  },
  t => [
    index('people_company_id').on(t.companyId), uniqueIndex('people_telegram_username').on(t.telegramUsername), uniqueIndex('people_telegram_user_id').on(t.telegramUserId),
    index('people_assistant_of').on(t.assistantOf),
    check('people_assistant', sql`(${t.isAgent} AND ${t.assistantOf} IS NOT NULL AND ${t.passwordHash} IS NULL) OR (NOT ${t.isAgent} AND ${t.assistantOf} IS NULL AND ${t.email} IS NOT NULL)`),
  ],
);

export const ASSISTANT_PROGRAMS = ['avaclone', 'openclaw', 'hermes', 'other'] as const;
export type AssistantProgram = (typeof ASSISTANT_PROGRAMS)[number];

/* What an assistant runs as and how it is reached: its program, the address Hornhoof wakes it at, and its key, kept only as
   a hash, with the secret its wakes are signed with, encrypted with the server's secret. Both are shown once, and come and
   go together. Its own agent, once its owner picked a plan for it, thinks for it in a terminal of its own, and asks the
   program for the program's skills at the skills address. */
export const assistants = pgTable(
  'assistants',
  {
    personId: uuid('person_id').primaryKey().references(() => people.id),
    companyId: companyId(),
    program: text('program', { enum: ASSISTANT_PROGRAMS }).notNull(),
    eventsUrl: text('events_url'),
    skillsUrl: text('skills_url'),
    agentId: uuid('agent_id').references((): AnyPgColumn => agents.id),
    keyHash: text('key_hash').unique(),
    keyCreatedAt: timestamp('key_created_at', { withTimezone: true }),
    wakeSecretEnc: text('wake_secret_enc'),
    createdAt: createdAt(),
  },
  t => [
    check('assistants_program', sql`${t.program} IN ('avaclone', 'openclaw', 'hermes', 'other')`),
    check('assistants_key_whole', sql`num_nonnulls(${t.keyHash}, ${t.keyCreatedAt}, ${t.wakeSecretEnc}) IN (0, 3)`),
  ],
);

export const ASSISTANT_EVENT_KINDS = ['reply', 'reply_end', 'request', 'request_closed'] as const;
export type AssistantEventKind = (typeof ASSISTANT_EVENT_KINDS)[number];

/* What an assistant reads: what an agent said to it, and the requests that wait for its owner. Numbered by one counter per
   company, which a new event takes under the counter's row lock, so the numbers commit in the order they grow and a reader
   that asks for what comes after a number misses none. Kept for 30 days. */
export const assistantEvents = pgTable(
  'assistant_events',
  {
    id: id(),
    companyId: companyId(),
    assistantId: uuid('assistant_id').notNull().references(() => people.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    kind: text('kind', { enum: ASSISTANT_EVENT_KINDS }).notNull(),
    data: jsonb('data').notNull(),
    createdAt: createdAt(),
  },
  t => [
    unique('assistant_events_company_seq').on(t.companyId, t.seq),
    index('assistant_events_assistant_seq').on(t.assistantId, t.seq),
    index('assistant_events_created_at').on(t.createdAt),
    check('assistant_events_kind', sql`${t.kind} IN ('reply', 'reply_end', 'request', 'request_closed')`),
  ],
);

/* The last number a company's assistant events took. */
export const assistantSeqs = pgTable('assistant_seqs', {
  companyId: uuid('company_id').primaryKey().references(() => companies.id),
  seq: bigint('seq', { mode: 'number' }).notNull().default(0),
});

/* An assistant's message whose answer is still being collected: the agent, the turn that answers it now, the last event of
   that turn already passed on, whether anything was, and when the turn was seen over with nothing going on from it. */
export const assistantReplies = pgTable(
  'assistant_replies',
  {
    id: id(),
    companyId: companyId(),
    assistantId: uuid('assistant_id').notNull().references(() => people.id),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    messageId: uuid('message_id').notNull(),
    byOwnAgent: boolean('by_own_agent').notNull().default(false),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    afterSeq: bigint('after_seq', { mode: 'number' }).notNull(),
    answered: boolean('answered').notNull().default(false),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  t => [unique('assistant_replies_message').on(t.messageId), index('assistant_replies_company').on(t.companyId)],
);

/* The open requests an assistant was told wait for its owner, so it hears once when each opens and once when it closes. */
export const assistantRequests = pgTable(
  'assistant_requests',
  {
    assistantId: uuid('assistant_id').notNull().references(() => people.id),
    requestId: uuid('request_id').notNull().references(() => requests.id),
    createdAt: createdAt(),
  },
  t => [primaryKey({ columns: [t.assistantId, t.requestId] })],
);

/* Where a person put the blocks of the company map: the hub, a department or a person, each by its top left in the map's
   world. Each person keeps their own arrangement, which follows them to another device; a block not in it stands where the
   map places it. */
export type MapBlocks = Record<string, { x: number; y: number }>;
/* The bends a person put on the lines of the map, each line's in order from where it starts, as [x, y] in the same world.
   A line runs through its bends at right angles wherever its blocks stand. */
export type MapAnchors = Record<string, [number, number][]>;
export const mapLayouts = pgTable('map_layouts', {
  personId: uuid('person_id').primaryKey().references(() => people.id),
  companyId: companyId(),
  blocks: jsonb('blocks').$type<MapBlocks>().notNull().default({}),
  anchors: jsonb('anchors').$type<MapAnchors>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    personId: uuid('person_id').notNull().references(() => people.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    /* True only on rows made before the __Host- cookie existed: the migration's default marks them, startSession never does. */
    beforeHostCookie: boolean('before_host_cookie').notNull().default(true),
  },
  t => [index('sessions_person_id').on(t.personId)],
);

/* One row per sign-in try that was let through, kept an hour. Only SHA-256 hashes of the email and the address are stored. */
export const signInAttempts = pgTable(
  'sign_in_attempts',
  {
    id: id(),
    emailHash: text('email_hash').notNull(),
    addressHash: text('address_hash').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('sign_in_attempts_email').on(t.emailHash, t.at), index('sign_in_attempts_address').on(t.addressHash, t.at), index('sign_in_attempts_at').on(t.at)],
);

export const invites = pgTable(
  'invites',
  {
    tokenHash: text('token_hash').primaryKey(),
    companyId: companyId(),
    personId: uuid('person_id').notNull().references(() => people.id),
    createdBy: uuid('created_by').notNull().references(() => people.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  t => [index('invites_person_id').on(t.personId)],
);

/* A template department without a typed name shows its template's name in the reader's language. A product sits under its parent. */
export const departments = pgTable('departments', {
  id: id(),
  companyId: companyId(),
  name: text('name'),
  templateKey: text('template_key', { enum: TEMPLATE_KEYS }),
  /* The delivery of its employees whose own card says none; none takes the company's. */
  inboxMode: text('inbox_mode', { enum: INBOX_MODES }),
  parentId: uuid('parent_id').references((): AnyPgColumn => departments.id),
  about: text('about').notNull().default(''),
  roleCode: text('role_code').notNull(),
  position: integer('position').notNull().default(0),
  /* The git repository its agents work in: https only; the token is stored encrypted and shown by its last 4 characters. */
  repoUrl: text('repo_url'),
  repoBranch: text('repo_branch'),
  repoTokenEnc: text('repo_token_enc'),
  /* Server-only credential scope; every token write or clear advances it. */
  repoTokenRevision: integer('repo_token_revision').notNull().default(1),
  repoTokenLast4: text('repo_token_last4'),
  /* Who the agents' commits are by; without one each agent's program sets its own. */
  repoAuthorName: text('repo_author_name'),
  repoAuthorEmail: text('repo_author_email'),
  /* The free memory, in GB, a machine needs to take one of the repository's test runs; none takes the default. */
  repoTestMemoryGb: integer('repo_test_memory_gb'),
  /* The command that runs the repository's whole test suite. Only a passed run of exactly this one lets GitHub skip its own tests. */
  repoFullTestCommand: text('repo_full_test_command'),
  /* The person the CEO named to take the department's approvals and set its policy; none means the CEO. Only the CEO sets it,
     and it is never worked out from who has access. It counts only while that person is active and still has access. */
  ownerPersonId: uuid('owner_person_id').references((): AnyPgColumn => people.id),
  /* A top-level department's autonomous release, set only by a signed-in person who runs it, never an agent: when on, exact
     commits for its main line with a green full run, an independent PASS verdict and a fast-forward path from main pass
     without a human approval card. Its products and parts go by it. */
  autonomousRelease: boolean('autonomous_release').notNull().default(false),
  createdAt: createdAt(),
}, t => [unique('departments_company_id').on(t.companyId, t.id), index('departments_owner_person_id').on(t.ownerPersonId), check('departments_repo_token_revision', sql`${t.repoTokenRevision} > 0`)]);

/* A key of a git host Hornhoof creates repositories with, for now GitHub's: its token, encrypted with the server's secret and
   shown by its last 4 characters, and the user or organization the repositories go to. The company keeps one, and a
   department may keep one of its own, which goes first for it and its products. */
export const repoHosts = pgTable(
  'repo_hosts',
  {
    id: id(),
    companyId: companyId(),
    /* None: the whole company's. */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['github'] }).notNull().default('github'),
    owner: text('owner').notNull(),
    tokenEnc: text('token_enc').notNull(),
    tokenLast4: text('token_last4').notNull(),
    updatedBy: uuid('updated_by').references(() => people.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex('repo_hosts_company').on(t.companyId).where(sql`${t.departmentId} IS NULL`),
    uniqueIndex('repo_hosts_department').on(t.departmentId),
    check('repo_hosts_provider', sql`${t.provider} IN ('github')`),
  ],
);

/* The company's Google Sheets credentials, encrypted at rest, so agents of any department can create populated spreadsheets
   and share their links when Google is connected. */
export const GOOGLE_CREDENTIAL_KINDS = ['service_account', 'oauth'] as const;
export type GoogleCredentialKind = (typeof GOOGLE_CREDENTIAL_KINDS)[number];

export const googleSheets = pgTable(
  'google_sheets',
  {
    id: id(),
    companyId: companyId(),
    kind: text('kind', { enum: GOOGLE_CREDENTIAL_KINDS }).notNull(),
    account: text('account').notNull(),
    shareEmail: text('share_email'),
    credentialsEnc: text('credentials_enc').notNull(),
    keyLast4: text('key_last4').notNull(),
    updatedBy: uuid('updated_by').references(() => people.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex('google_sheets_company').on(t.companyId),
    check('google_sheets_kind', sql`${t.kind} IN ('service_account', 'oauth')`),
  ],
);

/* How a department's approvals go, one rule per channel; a channel with no rule asks every time. The rules belong to the
   department, not to its owner, so they stay when the owner changes or goes. */
export const approvalPolicies = pgTable(
  'approval_policies',
  {
    id: id(),
    companyId: companyId(),
    departmentId: uuid('department_id').notNull().references(() => departments.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: APPROVAL_CHANNELS }).notNull(),
    mode: text('mode', { enum: APPROVAL_MODES }).notNull(),
    limitAmount: doublePrecision('limit_amount'),
    limitUnit: text('limit_unit'),
    /* The person whose rule it is; when the orchestrator set it, the person its turn answered. */
    updatedBy: uuid('updated_by').references(() => people.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [unique('approval_policies_channel').on(t.departmentId, t.channel), check('approval_policies_limit', sql`(${t.mode} = 'within_limits') = (${t.limitAmount} IS NOT NULL)`)],
);

export const teams = pgTable('teams', {
  id: id(),
  companyId: companyId(),
  departmentId: uuid('department_id').notNull().references(() => departments.id),
  name: text('name').notNull(),
  about: text('about').notNull().default(''),
  stage: integer('stage').notNull().default(0),
  gate: boolean('gate').notNull().default(false),
  /* Its members take urgent work only. */
  urgentOnly: boolean('urgent_only').notNull().default(false),
  /* Each member does a task end to end alone, with no echelons and no other member of the department. */
  turnkey: boolean('turnkey').notNull().default(false),
  createdAt: createdAt(),
});

export const PROVIDERS = PROVIDER_IDS;
export type Provider = (typeof PROVIDERS)[number];
export const TARGET_KINDS = ['orchestrator', 'department', 'team', 'any'] as const;

/* A computer a person ran the installer on. One per person and machine key, so running it again reuses the row. */
/* A data machine keeps the company's database and may lead; a worker runs agents and keeps none of it. */
export const MACHINE_ROLES = ['data', 'worker'] as const;
export type MachineRole = (typeof MACHINE_ROLES)[number];

/* How a worker reaches the company's server: on the local network, or through hornhoof.org. */
export const LINK_PATHS = ['direct', 'relay'] as const;
export type LinkPath = (typeof LINK_PATHS)[number];
/* Where a worker stands with the server's build: it has it downloaded, it installs it, or its install failed. */
export const UPDATE_STATES = ['ready', 'installing', 'failed'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
/* A copy of the company's database on a machine: being made, being made again beside the old one, following, or stopped
   with a reason: its disk is full, a change did not fit, its database once led the company, or the company's settings
   could not be written there. */
export const COPY_STATES = ['making', 'remaking', 'ready', 'stopped', 'saving'] as const;
export type CopyState = (typeof COPY_STATES)[number];
export const COPY_ERRORS = ['disk_full', 'apply', 'led', 'setup'] as const;
export type CopyError = (typeof COPY_ERRORS)[number];
/* What a machine that stopped holding the company's data still owes: its upload, then its wipe. */
export const UPLOAD_STATES = ['waiting', 'received', 'kept'] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];

export const machines = pgTable(
  'machines',
  {
    id: id(),
    companyId: companyId(),
    personId: uuid('person_id').notNull().references(() => people.id),
    machineKey: text('machine_key').notNull(),
    hostname: text('hostname').notNull().default(''),
    os: text('os').notNull().default(''),
    arch: text('arch').notNull().default(''),
    /* Only a computer takes parts of runs, which are shell commands. */
    kind: text('kind', { enum: MACHINE_KINDS }).notNull().default('computer'),
    /* Lends itself to the company's test runs; its owner, or someone who sees the whole company, can take it back. */
    lendsTests: boolean('lends_tests').notNull().default(true),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /* What the machine is in the company's network. networkId: the id its keeper runs under; none without a keeper.
       role: none while no keeper of the company runs there. signKey: the Ed25519 public key its certificates name. */
    networkId: text('network_id').unique(),
    role: text('role', { enum: MACHINE_ROLES }),
    signKey: text('sign_key'),
    /* What its keeper last reported: the ports it publishes, its build, and how the machine does. */
    webPort: integer('web_port'),
    peerPort: integer('peer_port'),
    commit: text('commit'),
    uptimeS: integer('uptime_s'),
    fsyncP99Ms: real('fsync_p99_ms'),
    diskFree: bigint('disk_free', { mode: 'number' }),
    reportAt: timestamp('report_at', { withTimezone: true }),
    /* The private addresses its keeper reported, and how the machine reaches the server now: none when it does not.
       directFails: an address on a network it shares with the server did not take its connection. */
    addresses: text('addresses').array().notNull().default(sql`'{}'::text[]`),
    path: text('path', { enum: LINK_PATHS }),
    directFails: boolean('direct_fails').notNull().default(false),
    /* When its last signed request for a new certificate was made, so the same one is taken once. */
    renewAt: timestamp('renew_at', { withTimezone: true }),
    /* Following the server's build: the commit it downloaded or installs, the commit the server last let it install and
       when, and the last commit whose install failed or ran out there. */
    updateCommit: text('update_commit'),
    updateState: text('update_state', { enum: UPDATE_STATES }),
    goCommit: text('go_commit'),
    goAt: timestamp('go_at', { withTimezone: true }),
    failedCommit: text('failed_commit'),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    /* The print of its owner's key as its keeper pinned it from the command the owner ran there. */
    ownerPin: text('owner_pin'),
    /* Backups: the public half of the age key its keeper made, whether its owner lets it keep the company's bundles,
       and the bundles its keeper last said it holds. */
    ageKey: text('age_key'),
    keepsBackups: boolean('keeps_backups').notNull().default(true),
    heldBackups: uuid('held_backups').array().notNull().default(sql`'{}'::uuid[]`),
    /* Its place in taking the company server: 1 leads, none for a machine that may not hold the company's data.
       serverPin: the place the CEO pinned, from 2, or 'none' for a machine that never takes the server. serverWhy: a
       key the card turns into words. */
    serverOrder: integer('server_order'),
    serverPin: text('server_pin'),
    serverWhy: text('server_why'),
    /* What Docker gives the machine, from its keeper's report. */
    memory: bigint('memory', { mode: 'number' }),
    cores: integer('cores'),
    /* Its copy of the company's database, as its keeper last reported it. copyAt: the server's pulse the copy holds.
       copyName: the name of its subscription, its slot and its connection. copyOld: the attempt whose old database
       waits for the server to merge it. */
    copyState: text('copy_state', { enum: COPY_STATES }),
    copyProgress: integer('copy_progress'),
    copyError: text('copy_error', { enum: COPY_ERRORS }),
    copyAt: timestamp('copy_at', { withTimezone: true }),
    copyName: text('copy_name'),
    copyOld: integer('copy_old'),
    /* The term under which the old database that waits for its merge led the company; null for one that never led. */
    copyOldLed: bigint('copy_old_led', { mode: 'number' }),
    /* When it stopped holding the company's data, and how far the upload of what it held has come. */
    dataLeftAt: timestamp('data_left_at', { withTimezone: true }),
    uploadState: text('upload_state', { enum: UPLOAD_STATES }),
    /* What the server order is scored on besides: the median round trip of its hellos to the leader over a day, the
       best rate of the leader's sending to it over a day, which stays when a day brings none, the median round trip
       to github.com over a day, and the rate of its last daily download from there. */
    linkRttMs: integer('link_rtt_ms'),
    linkMbps: integer('link_mbps'),
    internetRttMs: integer('internet_rtt_ms'),
    internetMbps: integer('internet_mbps'),
  },
  t => [
    unique('machines_person_key').on(t.personId, t.machineKey),
    check('machines_role', sql`role IS NULL OR role IN ('data', 'worker')`),
    check('machines_path', sql`path IS NULL OR path IN ('direct', 'relay')`),
    check('machines_update_state', sql`update_state IS NULL OR update_state IN ('ready', 'installing', 'failed')`),
    uniqueIndex('machines_server_order').on(t.serverOrder),
    uniqueIndex('machines_server_pin').on(t.serverPin).where(sql`server_pin <> 'none'`),
    check('machines_server_order_range', sql`server_order >= 1`),
    /* The CASE, so a pin that is no number fails the check and not the cast. */
    check('machines_server_pin_value', sql`server_pin = 'none' OR CASE WHEN server_pin ~ '^[1-9][0-9]{0,2}$' THEN server_pin::int >= 2 ELSE false END`),
    check('machines_copy_progress_range', sql`copy_progress BETWEEN 0 AND 99`),
    check('machines_copy_state', sql`copy_state IS NULL OR copy_state IN ('making', 'remaking', 'ready', 'stopped', 'saving')`),
    check('machines_copy_error', sql`copy_error IS NULL OR copy_error IN ('disk_full', 'apply', 'led', 'setup')`),
    check('machines_upload_state', sql`upload_state IS NULL OR upload_state IN ('waiting', 'received', 'kept')`),
    check('machines_measures_range', sql`link_rtt_ms >= 0 AND link_mbps >= 0 AND internet_rtt_ms >= 0 AND internet_mbps >= 0`),
  ],
);

/* A one-time code inside an install command. Only its hash is stored. No subscriptions: the machine joins alone. A code
   made for one machine works only there. */
export const nodeCodes = pgTable('node_codes', {
  codeHash: text('code_hash').primaryKey(),
  companyId: companyId(),
  personId: uuid('person_id').notNull().references(() => people.id),
  subscriptionIds: uuid('subscription_ids').array().notNull(),
  machineId: uuid('machine_id').references(() => machines.id),
  /* The install command, sealed for its author, or for the CEO when the orchestrator asked for it. */
  commandEnc: text('command_enc'),
  /* Closing a plan's top block leaves its install command active in the plan's card. */
  dismissedSubscriptionIds: uuid('dismissed_subscription_ids').array().notNull().default(sql`'{}'::uuid[]`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
  /* A command that brings the company's core to its machine. */
  core: boolean('core').notNull().default(false),
}, t => [index('node_codes_active_owner').on(t.personId).where(sql`${t.usedAt} is null`)]);

/* needs_setup: signed in, but its program waits for a first setup only the plan's owner may pass on the machine. */
export const SUBSCRIPTION_STATUSES = ['waiting_machine', 'needs_login', 'needs_setup', 'ready'] as const;

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    companyId: companyId(),
    provider: text('provider', { enum: PROVIDERS }).notNull(),
    kind: text('kind', { enum: ['personal', 'api_key'] }).notNull(),
    label: text('label').notNull(),
    ownerPersonId: uuid('owner_person_id').notNull().references(() => people.id),
    secretEnc: text('secret_enc'),
    last4: text('last4'),
    /* A plan's, over its nodes: waiting for a machine while it has none, ready while one is signed in, needs a sign-in
       otherwise. */
    status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull(),
    /* Only API keys have a target. A personal subscription serves wherever its owner works. */
    targetKind: text('target_kind', { enum: TARGET_KINDS }),
    targetId: uuid('target_id'),
    /* The same on every machine the plan runs on. */
    limits: jsonb('limits').$type<Limits>(),
    /* When the last limits snapshot arrived. Null on rows written before snapshots were timestamped. */
    limitsUpdatedAt: timestamp('limits_updated_at', { withTimezone: true }),
    /* The share of each limit window, in percent, that task turns may use; past it they wait for the window to start
       over while people's own messages still go. Null: the whole limit. */
    budget: integer('budget'),
    /* The models its node says it can run; null until a node reports them. An API connection's are the ones it was given. */
    models: jsonb('models').$type<ModelOption[]>(),
    /* The plans its employees go on to, in this order, when it reaches its limit or the share set for tasks, each with the
       model to run there or none for the one their role asks for. Empty: any plan of the company that may serve them. */
    fallbacks: jsonb('fallbacks').$type<PlanFallback[]>().notNull().default([]),
    /* Where a compatible API answers, which a person named; null for every other subscription, whose address is known. */
    baseUrl: text('base_url'),
    /* The protocol an API connection's program talks to it in: OpenRouter's choice, a compatible API's own. */
    apiProtocol: text('api_protocol', { enum: API_PROTOCOLS }),
    /* Counts the plan's sign-ins: each new one is sealed to its nodes under a higher number, and older ones are dropped. */
    credVersion: integer('cred_version').notNull().default(0),
    /* Codex runs on one machine at a time, as its sign-in renews itself: the node that holds it now. */
    leaseNodeId: uuid('lease_node_id').references((): AnyPgColumn => nodes.id),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  t => [index('subscriptions_owner_person_id').on(t.ownerPersonId)],
);

/* One plan a plan's employees go on to at its limit: model null runs the one their role asks for there. */
export type PlanFallback = { subscription: string; model: string | null };

export const NODE_STATUSES = ['needs_login', 'needs_setup', 'ready'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/* One node on one machine: a personal plan's, signed in on that machine by itself, or the machine's own, which has no
   plan and takes only test runs. One plan runs on as many of its owner's machines as they add it to. The key is the
   node's only credential; none once the machine is disconnected or the node removed. */
export const nodes = pgTable(
  'nodes',
  {
    id: id(),
    companyId: companyId(),
    machineId: uuid('machine_id').notNull().references(() => machines.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    keyHash: text('key_hash').unique(),
    status: text('status', { enum: NODE_STATUSES }).notNull().default('needs_login'),
    version: text('version'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /* The age key Hornhoof seals the plan's sign-in to for this node; the node keeps the private half. */
    publicKey: text('public_key'),
    /* The account its program is signed in to, as the program tells. */
    account: jsonb('account').$type<Account>(),
    /* How it came up, as it said last: what tells why the turns it ran are gone when it says it again. */
    boot: jsonb('boot').$type<Boot & { stopped?: NodeExit }>(),
    /* Since when it waits for an update: it takes no new turn until it is back from it. Empty when it does not wait. */
    updateWaitSince: timestamp('update_wait_since', { withTimezone: true }),
    createdAt: createdAt(),
  },
  t => [unique('nodes_machine_plan').on(t.machineId, t.subscriptionId).nullsNotDistinct(), index('nodes_subscription_id').on(t.subscriptionId)],
);

/* Each connection of a node, from when it came to how it ended; a node that stays connected has an open one. How long the
   node was away is the time to its next one. A connection's end and cause come together. report: what the node itself said
   of this drop once it was back; a node from before says nothing. nodeId: none for the machine's built-in node, which has
   no node of its own (#1060). */
export const nodeConnections = pgTable(
  'node_connections',
  {
    id: id(),
    companyId: companyId(),
    machineId: uuid('machine_id').notNull().references(() => machines.id),
    nodeId: uuid('node_id').references(() => nodes.id, { onDelete: 'cascade' }),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull(),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    cause: text('cause', { enum: CONNECTION_ENDS }),
    closeCode: integer('close_code'),
    closeReason: text('close_reason'),
    error: text('error'),
    report: jsonb('report').$type<NodeReconnect>(),
  },
  t => [
    index('node_connections_machine').on(t.machineId, t.connectedAt),
    index('node_connections_node').on(t.nodeId, t.connectedAt),
    check('node_connections_end_has_cause', sql`(${t.disconnectedAt} IS NULL) = (${t.cause} IS NULL)`),
  ],
);

/* A plan's sign-in sealed to one of its nodes. Hornhoof cannot open it: only that node's private key does. */
export const planCredentials = pgTable(
  'plan_credentials',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
    nodeId: uuid('node_id').notNull().references(() => nodes.id),
    kind: text('kind', { enum: CRED_KINDS }).notNull(),
    version: integer('version').notNull(),
    sealed: text('sealed').notNull(),
    createdAt: createdAt(),
  },
  t => [unique('plan_credentials_node_kind').on(t.nodeId, t.kind), index('plan_credentials_subscription_id').on(t.subscriptionId)],
);

export const agents = pgTable(
  'agents',
  {
    id: id(),
    companyId: companyId(),
    /* An assistant's own agent belongs to the assistant's owner alone, outside every department. */
    kind: text('kind', { enum: ['orchestrator', 'head', 'worker', 'assistant'] }).notNull(),
    name: text('name').notNull(),
    model: text('model').notNull(),
    departmentId: uuid('department_id').references(() => departments.id),
    teamId: uuid('team_id').references(() => teams.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    /* Its own delivery; none takes its department's, then the company's. */
    inboxMode: text('inbox_mode', { enum: INBOX_MODES }),
    /* The node of its plan its program lives on, with its folder, session and terminal; it stays there while that node is
       ready. None on a company key, which runs on the built-in node, and before its first turn. */
    nodeId: uuid('node_id').references((): AnyPgColumn => nodes.id),
    /* The machine whose built-in node its program lives on, by its network id, for one on a company key; none on a
       plan's node, and before its first turn. */
    builtinMachine: text('builtin_machine'),
    /* The role template it was hired from, its enabled skills, its own text over the template's, and the template
       hashes it was hired with, so the card can say a template moved on. */
    roleKey: text('role_key'),
    skills: jsonb('skills').$type<string[]>().notNull().default([]),
    overrides: jsonb('overrides').$type<AgentOverrides>().notNull().default({}),
    templateHashes: jsonb('template_hashes').$type<Record<string, string>>().notNull().default({}),
    /* A product department the employee works for, inside its department. */
    productId: uuid('product_id').references((): AnyPgColumn => departments.id),
    createdBy: uuid('created_by').references(() => people.id),
    /* Switched off for now: it ends the turn it runs and takes no task turns until it is on again. */
    switchedOffAt: timestamp('switched_off_at', { withTimezone: true }),
    /* How full its context was when its node last said, as a share from 0 to 1. */
    contextUsed: real('context_used'),
    /* The level a person picked; none follows the role's level, fitted to its model. */
    effort: text('effort'),
    /* Wakes on its own every so many minutes, outside any task, to do what its order says; none means it does not. The
       last round started, or was skipped, at timer_at. A timer for work skips its round while nothing is open or failed. */
    timerMinutes: integer('timer_minutes'),
    timerOrder: text('timer_order'),
    timerAt: timestamp('timer_at', { withTimezone: true }),
    timerForWork: boolean('timer_for_work').notNull().default(false),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  /* One head per department and one orchestrator per company, among those still employed. */
  t => [
    uniqueIndex('agents_one_head').on(t.departmentId).where(sql`kind = 'head' AND removed_at IS NULL`),
    uniqueIndex('agents_one_orchestrator').on(t.companyId).where(sql`kind = 'orchestrator' AND removed_at IS NULL`),
    check('agents_builtin_machine', sql`builtin_machine ~ '^[0-9a-f]{32}([0-9a-f]{32})?$'`),
  ],
);

export type AgentKind = (typeof agents.$inferSelect)['kind'];

/* An employee Hornhoof put on a fallback plan while its own was at its limit: the plan, model and effort it goes back to
   between turns once that limit starts over, and the fallback it went to. A person who moves it by hand ends it. */
export const agentFallbacks = pgTable('agent_fallbacks', {
  agentId: uuid('agent_id').primaryKey().references(() => agents.id),
  companyId: companyId(),
  homeSubscriptionId: uuid('home_subscription_id').notNull().references(() => subscriptions.id),
  homeModel: text('home_model').notNull(),
  homeEffort: text('home_effort'),
  subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
  createdAt: createdAt(),
});

/* base keeps its stored key for compatibility; it is the assignment, separate from role identity. */
export type AgentOverrides = { base?: string; skills?: Record<string, string> };

export const AGENT_CHANGE_FIELDS = ['name', 'model', 'effort', 'timer', 'subscription', 'skills', 'prompt', 'reset', 'hired', 'removed', 'switch', 'team', 'telegram'] as const;

/* Every change to an employee's card: who, when, what, before and after. */
export const agentChanges = pgTable(
  'agent_changes',
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    personId: uuid('person_id').references(() => people.id),
    /* Made by the orchestrator, which runs the company as the CEO can; no person then. */
    byOrchestrator: boolean('by_orchestrator').notNull().default(false),
    field: text('field', { enum: AGENT_CHANGE_FIELDS }).notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  t => [index('agent_changes_agent_id').on(t.agentId)],
);

/* A person's own rename: who changed it, when, and the name before and after. */
export const personChanges = pgTable(
  'person_changes',
  {
    id: id(),
    companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => people.id, { onDelete: 'set null' }),
    field: text('field', { enum: ['name'] }).notNull(),
    before: text('before').notNull(),
    after: text('after').notNull(),
    createdAt: createdAt(),
  },
  t => [index('person_changes_person_id').on(t.personId), index('person_changes_company_id').on(t.companyId)],
);

/* The departments and teams a listed person reaches. */
export const personAccess = pgTable(
  'person_access',
  {
    id: id(),
    companyId: companyId(),
    personId: uuid('person_id').notNull().references(() => people.id),
    departmentId: uuid('department_id').references(() => departments.id),
    teamId: uuid('team_id').references(() => teams.id),
  },
  t => [unique('person_access_place').on(t.personId, t.departmentId, t.teamId).nullsNotDistinct(), index('person_access_person_id').on(t.personId)],
);

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'obsolete'] as const;
/* tools: a step that answers an agent's program, which called its tools with no turn running, and ends with that request. */
export const JOB_KINDS = ['test', 'conversation', 'tools'] as const;
/* Why a node started again, as far as Hornhoof can tell: its built-in server started again, Hornhoof updated it, the machine
   started again, its container was made anew, its program started again in the same container, or the connection broke
   and the turn never reached it. */
export const RESTART_CAUSES = ['server', 'update', 'machine', 'container', 'program', 'connection', 'unknown'] as const;
export type RestartCause = (typeof RESTART_CAUSES)[number];
/* A turn a node restart cut off: why, when Hornhoof learned it, on which node, and the number of the task it was on. */
export type Interruption = { cause: RestartCause; at: string; node: { id: string | null; name: string }; task: number | null; versions?: { from: string; to: string }; machine?: { id: string | null; name: string | null }; diagnosis?: NodeExit };

/* One prompt sent to one subscription's node. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
    /* The node it went out to; none for the built-in node's jobs, and while it waits. */
    nodeId: uuid('node_id').references(() => nodes.id),
    /* The machine whose built-in node it went out to, by its network id; none for a job of a plan's node. */
    builtinMachine: text('builtin_machine'),
    agentId: uuid('agent_id').references(() => agents.id),
    prompt: text('prompt').notNull(),
    /* The one turn that takes the agent's unread inbox: its prompt is written from the inbox when it goes out. */
    inboxWake: boolean('inbox_wake').notNull().default(false),
    /* What the turn was asked before the queue composed its sent prompt. Null for turns from before this was kept. */
    requestedPrompt: text('requested_prompt'),
    sessionId: text('session_id'),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    result: text('result'),
    tail: text('tail').notNull().default(''),
    error: text('error'),
    failure: jsonb('failure').$type<Failure>(),
    notBefore: timestamp('not_before', { withTimezone: true }),
    restartedAt: timestamp('restarted_at', { withTimezone: true }),
    timeoutMs: integer('timeout_ms').notNull(),
    kind: text('kind', { enum: JOB_KINDS }).notNull().default('test'),
    /* The job's Hornhoof tools present this token; it works only while the job runs. */
    toolTokenHash: text('tool_token_hash').unique(),
    /* The turn carries a message of the company's owner, so the tools for people, access, money and the company's reach
       work in it. A turn an employee, a timer or a task woke does not. */
    answersCeo: boolean('answers_ceo').notNull().default(false),
    /* Words for the running turn are on their way, or went in without being kept: no decision is taken in it by anyone's word. */
    decisionInputPending: boolean('decision_input_pending').notNull().default(false),
    /* The hash of the instructions it ran with; a change starts a fresh session. */
    instructionsHash: text('instructions_hash'),
    createdBy: uuid('created_by').references(() => people.id),
    /* The task a turn works on, when a task woke the agent. */
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    /* The turn this one runs once more, after a node restart cut it off. */
    retryOf: uuid('retry_of').references((): AnyPgColumn => jobs.id),
    interruption: jsonb('interruption').$type<Interruption>(),
    /* How the agent's program ended, as its node saw it: the exit code, or the name of the signal that ended it. */
    exitCode: integer('exit_code'),
    exitSignal: text('exit_signal'),
    /* The turn whose session this one goes on with once, after that turn ended without recording what it was woken for. */
    continueOf: uuid('continue_of').references((): AnyPgColumn => jobs.id),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  t => [index('jobs_subscription_id').on(t.subscriptionId), index('jobs_task_id').on(t.taskId), index('jobs_agent_id_status').on(t.agentId, t.status),
    check('jobs_builtin_machine', sql`builtin_machine ~ '^[0-9a-f]{32}([0-9a-f]{32})?$'`),
  ],
);

/* What one turn used of its subscription, as its program told it when the turn ended: null where it told a count not,
   and all null for a program that tells no tokens. Input is what the model read anew, the cache what it read from its
   cache and wrote to it, the total all of them and the output. */
export const turnTokens = pgTable(
  'turn_tokens',
  {
    jobId: uuid('job_id').primaryKey().references(() => jobs.id),
    companyId: companyId(),
    agentId: uuid('agent_id').references(() => agents.id),
    subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }),
    cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }),
    totalTokens: bigint('total_tokens', { mode: 'number' }),
    /* The model the turn ran on, as its node told: its program's word, else the one the turn asked for; null when neither. */
    model: text('model'),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  t => [
    index('turn_tokens_subscription_at').on(t.subscriptionId, t.at),
    index('turn_tokens_company_at').on(t.companyId, t.at),
    check('turn_tokens_counts', sql`coalesce(${t.inputTokens}, 0) >= 0 and coalesce(${t.outputTokens}, 0) >= 0 and coalesce(${t.cacheReadTokens}, 0) >= 0 and coalesce(${t.cacheWriteTokens}, 0) >= 0 and coalesce(${t.totalTokens}, 0) >= 0`),
  ],
);

/* computer: the orchestrator asked for the computer the server runs on, or the CEO opened, closed or declined it. typed: a
   person pressed Enter in the terminal of the running turn, so what they typed is their word in it; the window shows
   what the program shows instead. Repeated words keep their author and envelope as typed, without showing or sending
   another message. */
export const AGENT_EVENT_KINDS = ['message', 'text', 'tool', 'tool_result', 'todo', 'proposal', 'applied', 'stopped', 'failed', 'computer', 'typed', 'hook_rejected', 'program', 'turn_refused', 'input_left'] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/* An agent's conversation as people see it: their messages, what the agent did, and what came of it. */
/* Every message an employee gets from another employee, the orchestrator or Hornhoof: who sent it, on which task, what it
   says, and whether the employee has read it or dealt with it. job: the turn it went in or waits for. */
/* What a letter is, as the inbox tab names it. */
export const LETTER_KINDS = ['message', 'report', 'comment', 'assignment', 'notification'] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];

export const agentInbox = pgTable(
  'agent_inbox',
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    senderKind: text('sender_kind', { enum: ['agent', 'person', 'hornhoof'] }).notNull(),
    senderAgentId: uuid('sender_agent_id').references(() => agents.id),
    senderPersonId: uuid('sender_person_id').references(() => people.id),
    senderName: text('sender_name').notNull(),
    taskId: uuid('task_id').references(() => tasks.id),
    taskNumber: integer('task_number'),
    kind: text('kind', { enum: LETTER_KINDS }).notNull(),
    /* Which of Hornhoof's notices it is, when it is one (NOTIFICATION_NAMES). */
    source: text('source'),
    text: text('text').notNull(),
    jobId: uuid('job_id').references(() => jobs.id),
    status: text('status', { enum: ['unread', 'read', 'done'] }).notNull().default('unread'),
    readAt: timestamp('read_at', { withTimezone: true }),
    /* The order letters came in, of one moment too. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  t => [index('agent_inbox_agent_status').on(t.agentId, t.status, t.seq), index('agent_inbox_job').on(t.jobId)],
);

export const agentEvents = pgTable(
  'agent_events',
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    jobId: uuid('job_id').references(() => jobs.id),
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    kind: text('kind', { enum: AGENT_EVENT_KINDS }).notNull(),
    data: jsonb('data').notNull(),
    /* The author of a message, or the person who confirmed a proposal. */
    personId: uuid('person_id').references(() => people.id),
    createdAt: createdAt(),
  },
  t => [
    index('agent_events_agent_id_seq').on(t.agentId, t.seq), index('agent_events_job_id').on(t.jobId),
    index('agent_events_program_history').on(t.jobId, t.createdAt).where(sql`${t.kind} in ('program', 'failed')`),
    index('agent_events_silent_job').on(sql`(${t.data}->>'silentJob')`).where(sql`${t.kind} = 'message' and ${t.data} ? 'silentJob'`),
    index('agent_events_failure_case').on(sql`(data->>'failureCase')`).where(sql`data->>'failureCase' is not null`),
    index('agent_events_report_window').on(t.agentId, t.createdAt).where(sql`data->>'report' is not null or data->>'from' = 'agent'`),
    index('agent_events_operations_pending').on(sql`(data->>'operationsPending')`).where(sql`data->>'operationsPending' is not null`),
    uniqueIndex('agent_events_operator_evidence').on(t.companyId, sql`(data->>'operatorEvidenceId')`).where(sql`data->>'operatorEvidenceId' is not null`),
    uniqueIndex('agent_events_operator_ordinal').on(t.companyId, sql`(data->'operatorEvidence'->>'instance')`, sql`(data->'operatorEvidence'->>'ordinal')`).where(sql`data->>'operatorEvidenceId' is not null`),
    index('agent_events_operator_instance').on(t.agentId, sql`(data->'operatorEvidence'->>'instance')`).where(sql`data->>'operatorEvidenceId' is not null`),
  ],
);

/* A head's or the orchestrator's Telegram bot: its token, encrypted with the server's secret and never shown again, the
   bot's own number and name from Telegram, and the update it reads from next, so a restart neither loses nor repeats one.
   A bot belongs to one agent, and an agent has one bot. */
export const telegramBots = pgTable('telegram_bots', {
  id: id(),
  companyId: companyId(),
  agentId: uuid('agent_id').notNull().unique().references(() => agents.id),
  tokenEnc: text('token_enc').notNull(),
  botUserId: bigint('bot_user_id', { mode: 'number' }).notNull().unique(),
  username: text('username').notNull(),
  updateOffset: bigint('update_offset', { mode: 'number' }).notNull().default(0),
  createdBy: uuid('created_by').references(() => people.id),
  createdAt: createdAt(),
});

/* A person's message that came through a bot, whose answer goes back to their chat: the turn it went into, the last event
   of that turn already sent there, whether anything was, and the language the bot speaks to them in. */
export const telegramReplies = pgTable(
  'telegram_replies',
  {
    id: id(),
    botId: uuid('bot_id').notNull().references(() => telegramBots.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    afterSeq: bigint('after_seq', { mode: 'number' }).notNull(),
    answered: boolean('answered').notNull().default(false),
    lang: text('lang', { enum: ['en', 'ru'] }).notNull(),
    createdAt: createdAt(),
  },
  t => [unique('telegram_replies_job_chat').on(t.botId, t.jobId, t.chatId)],
);

export const proposals = pgTable('proposals', {
  id: id(),
  companyId: companyId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  jobId: uuid('job_id').references(() => jobs.id),
  ...questionColumns(),
  brief: text('brief').notNull().default(''),
  materialRevision: bigint('material_revision', { mode: 'number' }),
  materialDigest: text('material_digest'),
  /* Private sealed versions, never serialized as a public proposal. */
  materialSnapshot: jsonb('material_snapshot').$type<MaterialSnapshotHistory>(),
  items: jsonb('items').notNull(),
  /* structure: departments for the company; staff: employees for one department. */
  kind: text('kind', { enum: ['structure', 'staff'] }).notNull().default('structure'),
  departmentId: uuid('department_id').references(() => departments.id),
  status: text('status', { enum: ['pending', 'applied', 'dismissed'] }).notNull().default('pending'),
  appliedBy: uuid('applied_by').references(() => people.id),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [
  ...questionChecks('proposals', t),
  check('proposals_material_stamp', materialStamp(t.materialRevision, t.materialDigest)),
  check('proposals_material_snapshot_bound', materialHistoryBound(t.materialSnapshot)),
]);

/* A release of one top-level department: its open turn gathers the results accepted into its branch turn-<number>, and the
   tag of its recorded release closes it. Each department has one open at a time, numbered across the company. */
export const TURN_STATUSES = ['open', 'closed'] as const;
/* id is the message's agent event; words kept before it was recorded have none. */
export type TurnMessage = { id?: string; by: string; text: string; at: string };

export const turns = pgTable(
  'turns',
  {
    id: id(),
    companyId: companyId(),
    /* The top-level department whose work the turn holds, with its products' and sub-departments'. Only a closed turn of a
       department that was removed has none. */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    number: integer('number').notNull(),
    /* A short name and the main point in a line or two. */
    title: text('title').notNull().default(''),
    goal: text('goal').notNull(),
    status: text('status', { enum: TURN_STATUSES }).notNull().default('open'),
    /* The tag vX.Y.Z and the commit it closed on; none while it is open, or on a turn closed before turns were releases. */
    version: text('version'),
    commit: text('commit'),
    /* The release it goes on from: the tag before it and its commit. None until the server first looked at the tags. */
    baseVersion: text('base_version'),
    baseCommit: text('base_commit'),
    /* The head of the turn before it as that one closed: its branch starts there, so no result of that turn is lost. */
    startCommit: text('start_commit'),
    /* The people's own words the turn was laid out from, as they wrote them. */
    messages: jsonb('messages').$type<TurnMessage[]>().notNull().default([]),
    /* The orchestrator's task for a turn started by a person, from before he laid turns out himself. */
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    startedBy: uuid('started_by').references(() => people.id),
    createdByAgentId: uuid('created_by_agent_id').references((): AnyPgColumn => agents.id),
    createdAt: createdAt(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  t => [
    unique('turns_company_number').on(t.companyId, t.number),
    unique('turns_company_id').on(t.companyId, t.id),
    uniqueIndex('turns_one_open').on(t.companyId, t.departmentId).where(sql`status = 'open'`),
    check('turns_department', sql`${t.status} = 'closed' OR ${t.departmentId} IS NOT NULL`),
    check('turns_status', sql`${t.status} IN ('open', 'closed')`),
    uniqueIndex('turns_department_version').on(t.companyId, t.departmentId, t.version).where(sql`version IS NOT NULL`),
  ],
);

/* A release of a turn as its holder asked for it before main moved: the exact commit and main under it, the full run on it,
   the results it brings with the verdicts on them, and who approved it. Only the tag of a release kept here closes a turn. */
export type ReleasedTask = { taskId: string; number: number; commit: string; verdicts: string[] };
export const turnReleases = pgTable(
  'turn_releases',
  {
    id: id(),
    companyId: companyId(),
    turnId: uuid('turn_id').notNull().references(() => turns.id),
    commit: text('commit').notNull(),
    baseCommitSha: text('base_commit_sha').notNull(),
    runId: uuid('run_id').references((): AnyPgColumn => testRuns.id),
    tasks: jsonb('tasks').$type<ReleasedTask[]>().notNull().default([]),
    /* The release task it was asked on, and what approved its commit: a person there, or, with autonomous release on and
       every commit of it checked, the entry of the autonomous release log. One of the two, never both. */
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    approvalRequestId: uuid('approval_request_id').references((): AnyPgColumn => requests.id),
    autonomousReleaseId: uuid('autonomous_release_id').references((): AnyPgColumn => autonomousReleases.id),
    requestedByAgentId: uuid('requested_by_agent_id').references((): AnyPgColumn => agents.id),
    /* Whether every commit it brings is of a candidate whose checkers passed it, and what is not. */
    covered: boolean('covered').notNull(),
    uncovered: jsonb('uncovered').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  t => [
    index('turn_releases_turn_id').on(t.turnId),
    check('turn_releases_commit', sql`${t.commit} ~ '^[0-9a-f]{40}$' AND ${t.baseCommitSha} ~ '^[0-9a-f]{40}$'`),
    check('turn_releases_approved_once', sql`(${t.approvalRequestId} IS NULL) <> (${t.autonomousReleaseId} IS NULL)`),
  ],
);

/* A turn's pipeline facts: kept as it closed, or rebuilt from its events for a turn that closed before this was kept. */
export const TURN_SNAPSHOT_SOURCES = ['closed', 'rebuilt'] as const;
export const turnSnapshots = pgTable(
  'turn_snapshots',
  {
    turnId: uuid('turn_id').primaryKey().references(() => turns.id),
    companyId: companyId(),
    source: text('source', { enum: TURN_SNAPSHOT_SOURCES }).notNull(),
    facts: jsonb('facts').$type<TurnFacts>().notNull(),
    createdAt: createdAt(),
  },
  t => [index('turn_snapshots_company_id').on(t.companyId)],
);

export const TASK_STATUSES = ['open', 'working', 'review', 'waiting', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type { ExternalWait } from '@hornhoof/protocol/waits';
/* Who stopped the work and why; root is the task the pause was placed on, which the work under it shares. */
export type TaskPause = { at: string; reason: string; by: { agentId: string } | { personId: string }; root: string };

/* A piece of work: the title and brief for people, the body every agent reads as the current truth, and its required route. */
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    companyId: companyId(),
    number: integer('number').notNull(),
    turnId: uuid('turn_id').references((): AnyPgColumn => turns.id),
    parentId: uuid('parent_id').references((): AnyPgColumn => tasks.id),
    departmentId: uuid('department_id').references(() => departments.id),
    productId: uuid('product_id').references(() => departments.id),
    title: text('title').notNull(),
    brief: text('brief').notNull().default(''),
    body: text('body').notNull().default(''),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('open'),
    /* The sole current owner of this task or its checking candidate. */
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id),
    /* The employee originally assigned the executable result; candidate events retain later producers. */
    executorAgentId: uuid('executor_agent_id').references(() => agents.id),
    /* Tasks of the company that must be done first, of any turn or none: until they are, the task waits and its holder is
       not woken. */
    after: jsonb('after').$type<string[]>().notNull().default([]),
    /* Task turns in a row that ended without moving the task. */
    silent: integer('silent').notNull().default(0),
    /* Waiting for an external event, without changing who holds the task or its workflow stage. */
    externalWait: jsonb('external_wait').$type<ExternalWait>(),
    /* Paused work wakes nobody until whoever may pause it resumes it. Closing a task ends its pause. */
    paused: jsonb('paused').$type<TaskPause>(),
    /* What kind of work it is and what a mistake in it would cost, as whoever gave it out named them. */
    workKind: text('work_kind', { enum: WORK_KINDS }),
    riskClass: text('risk_class', { enum: RISK_CLASSES }),
    /* Said by the CEO, never read from its words; work under a task is as urgent as it is. */
    urgent: boolean('urgent').notNull().default(false),
    /* Marked by whoever gives the work out for the short path. */
    small: boolean('small').notNull().default(false),
    /* Grows with every move, so two moves that read the same task cannot both land. */
    version: integer('version').notNull().default(0),
    createdByPersonId: uuid('created_by_person_id').references(() => people.id),
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  t => [
    unique('tasks_company_number').on(t.companyId, t.number),
    index('tasks_department_id').on(t.departmentId),
    index('tasks_assignee').on(t.assigneeAgentId),
    index('tasks_parent_id').on(t.parentId),
    index('tasks_turn_id').on(t.turnId),
    /* What waits for a task is found by what it comes after, whatever turn it is in. */
    index('tasks_after').using('gin', t.after),
    index('tasks_product_id').on(t.productId),
    index('tasks_external_wait_until').on(sql`(${t.externalWait}->>'until')`).where(sql`${t.externalWait} IS NOT NULL`),
    check('tasks_counts', sql`${t.silent} >= 0`),
    check('tasks_closed_at', sql`${t.status} NOT IN ('done', 'cancelled') OR ${t.closedAt} IS NOT NULL`),
    check('tasks_status', sql`${t.status} IN ('open', 'working', 'review', 'waiting', 'blocked', 'done', 'cancelled')`),
    check('tasks_not_own_parent', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    check('tasks_work_kind', sql`${t.workKind} IS NULL OR ${t.workKind} IN ('bug', 'known_behavior', 'unknown_path', 'legacy_code')`),
    check('tasks_risk_class', sql`${t.riskClass} IS NULL OR ${t.riskClass} IN ('money', 'access', 'security', 'data', 'none')`),
  ],
);

/* What people of a department put aside for a later turn: a proposal nobody holds, no agent reads as work and no turn
   holds, until a person or the orchestrator puts it into a turn, where it becomes a task and leaves the list. */
export const backlogItems = pgTable(
  'backlog_items',
  {
    id: id(),
    companyId: companyId(),
    departmentId: uuid('department_id').notNull().references(() => departments.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    text: text('text').notNull().default(''),
    /* Its place in the department's list: the lower, the sooner it is meant to go. */
    position: integer('position').notNull(),
    createdByPersonId: uuid('created_by_person_id').notNull().references(() => people.id),
    createdAt: createdAt(),
  },
  t => [index('backlog_items_department_position').on(t.departmentId, t.position)],
);

/* Required route state. Existing records need explicit release preparation, never a fallback route. */
export const taskRoutes = pgTable('task_routes', {
  taskId: uuid('task_id').primaryKey().references(() => tasks.id),
  companyId: companyId(),
  revision: integer('revision').notNull().default(1),
  state: jsonb('state').$type<Omit<EchelonsSnapshot, 'ownerAgentId' | 'revision'>>().notNull(),
  paths: jsonb('paths').$type<string[]>().notNull().default([]),
}, t => [
  check('task_routes_revision', sql`${t.revision} > 0`),
  check('task_routes_state', sql`jsonb_typeof(${t.state}) = 'object'`),
  check('task_routes_paths', sql`jsonb_typeof(${t.paths}) = 'array'`),
]);

export const TASK_EVENT_KINDS = ['created', 'assigned', 'updated', 'comment', 'submitted', 'verdict', 'report', 'blocked', 'asked', 'answered', 'reminded', 'continued', 'stuck', 'cancelled', 'done', 'started', 'interrupted', 'wake_skipped', 'wake_obsolete', 'wait_due', 'wait_card', 'away'] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/* Everything that happened to a task, with the person or agent who did it. */
export const taskEvents = pgTable(
  'task_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /* What names this event across machines, where the serial id of each differs. */
    uuid: uuid('uuid').notNull().defaultRandom().unique(),
    companyId: companyId(),
    taskId: uuid('task_id').notNull().references(() => tasks.id),
    kind: text('kind', { enum: TASK_EVENT_KINDS }).notNull(),
    personId: uuid('person_id').references(() => people.id),
    agentId: uuid('agent_id').references(() => agents.id),
    text: text('text').notNull().default(''),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  t => [index('task_events_task_id').on(t.taskId)],
);

/* A line of the map from an agent to the one above it: the orchestrator to a department's head, a head to an employee of
   its department. Each start of new work on it begins a new cycle, and the latest result given back along it keeps the
   cycle it came in, so a result from an earlier cycle never lights the line again. */
export const mapReturns = pgTable(
  'map_returns',
  {
    companyId: companyId(),
    upstreamAgentId: uuid('upstream_agent_id')
      .notNull()
      .references(() => agents.id),
    downstreamAgentId: uuid('downstream_agent_id')
      .notNull()
      .references(() => agents.id),
    workEpoch: integer('work_epoch').notNull().default(0),
    /* The turn whose start began the cycle, so its start told again begins no other. */
    workJobId: uuid('work_job_id').references(() => jobs.id),
    returnedEpoch: integer('returned_epoch'),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    /* What gave it back: task:<task event id> or message:<agent event seq>. */
    sourceKey: text('source_key'),
    /* The turn that last handed a task in along the line and that task, kept off the line while that turn still runs. A
       message hands no task in and leaves them as they are. */
    sourceJobId: uuid('source_job_id').references(() => jobs.id),
    sourceTaskId: uuid('source_task_id').references(() => tasks.id),
  },
  t => [
    primaryKey({ columns: [t.companyId, t.upstreamAgentId, t.downstreamAgentId] }),
    check('map_returns_epochs', sql`${t.workEpoch} >= 0 AND (${t.returnedEpoch} IS NULL OR (${t.returnedEpoch} >= 0 AND ${t.returnedEpoch} <= ${t.workEpoch}))`),
    check('map_returns_given_back', sql`(${t.returnedAt} IS NULL) = (${t.returnedEpoch} IS NULL) AND (${t.returnedAt} IS NULL) = (${t.sourceKey} IS NULL)`),
  ],
);

/* The turns a task move needs, written with the move and gone once they are queued: a server that stopped in between
   queues them when it is back. why, text and note as in a wake. */
export const pendingWakes = pgTable(
  'pending_wakes',
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    taskId: uuid('task_id').notNull().references(() => tasks.id),
    /* A timed wake is obsolete once another task move replaced the action it names. */
    taskVersion: integer('task_version'),
    why: text('why').notNull(),
    cause: jsonb('cause').$type<import('../modules/tasks/notification-cause.js').WakeCause>(),
    text: text('text'),
    note: text('note'),
    createdAt: createdAt(),
  },
  t => [index('pending_wakes_created_at').on(t.createdAt)],
);

export const REQUEST_KINDS = ['question', 'approval', 'choice', 'stuck'] as const;
/* What a decision is about, which says whose it is: a task or an employee of a department goes to that department's own
   person, the rest only to the CEO. */
export const DECISION_TOPICS = ['task', 'employee', 'people', 'access', 'subscriptions', 'machines', 'repositories', 'public_link', 'updates', 'release'] as const;
export type DecisionTopic = (typeof DECISION_TOPICS)[number];
export const REQUEST_STATUSES = ['open', 'answered', 'approved', 'declined', 'withdrawn', 'resolved_internal'] as const;

/* One of the ways a person can pick from, with the picture that shows it. */
export type RequestOption = { label: string; image: string | null };

/* What an agent waits for from a person: an answer, an approval of an exact commit, a pick of one way out of a few, or
   help with a stuck task. link: where to see the work, picked: the option the person took. */
export const requests = pgTable(
  'requests',
  {
    id: id(),
    companyId: companyId(),
    taskId: uuid('task_id').notNull().references(() => tasks.id),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    kind: text('kind', { enum: REQUEST_KINDS }).notNull(),
    ...questionColumns(),
    text: text('text').notNull(),
    commit: text('commit'),
    /* Null together on legacy sources; no private file/disclosure metadata here. */
    materialRevision: bigint('material_revision', { mode: 'number' }),
    materialDigest: text('material_digest'),
    options: jsonb('options').$type<RequestOption[]>().notNull().default([]),
    link: text('link'),
    picked: integer('picked'),
    status: text('status', { enum: REQUEST_STATUSES }).notNull().default('open'),
    answer: text('answer'),
    answeredBy: uuid('answered_by').references(() => people.id),
    /* When the orchestrator answered for that person: itself, its turn and the message of the person it acted on. */
    answeredByAgentId: uuid('answered_by_agent_id').references(() => agents.id),
    answerJobId: uuid('answer_job_id').references(() => jobs.id),
    answerSourceSeq: bigint('answer_source_seq', { mode: 'number' }),
    /* When the person's assistant gave the answer for them. */
    answeredByAssistantId: uuid('answered_by_assistant_id').references((): AnyPgColumn => people.id),
    /* The orchestrator's words for people: what is needed from them, why, and the ways to go, in plain words. */
    explained: text('explained'),
    /* What it is about; none on requests from before topics, which go to the CEO. */
    decisionTopic: text('decision_topic', { enum: DECISION_TOPICS }),
    /* What an approval a department's policy asked for is about: its channel, the kind of work and how much, as the agent said.
       An approval either names a commit or says this. */
    approvalChannel: text('approval_channel', { enum: APPROVAL_CHANNELS }),
    approvalKind: text('approval_kind'),
    approvalAmount: doublePrecision('approval_amount'),
    /* A goal in danger, as whoever may say so said it: which goal, which episode of it, how bad and whether it is over. An
       answer to the question does not end the episode, and neither a text nor a date ever opens one. */
    goalRefKind: text('goal_ref_kind', { enum: ['task', 'turn'] }),
    goalRefId: uuid('goal_ref_id'),
    goalEpisodeId: uuid('goal_episode_id'),
    goalImpact: text('goal_impact', { enum: ['at_risk', 'missed'] }),
    goalRevision: integer('goal_revision'),
    goalState: text('goal_state', { enum: ['open', 'resolved'] }),
    createdAt: createdAt(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  t => [
    ...questionChecks('requests', t),
    check('requests_internal_not_person_answer', sql`${t.status} <> 'resolved_internal' OR
      num_nonnulls(${t.answeredBy}, ${t.answeredByAgentId}, ${t.answerJobId}, ${t.answerSourceSeq}, ${t.answeredAt}) = 0`),
    check('requests_material_stamp', materialStamp(t.materialRevision, t.materialDigest)),
    check('requests_goal_whole', sql`num_nonnulls(${t.goalRefKind}, ${t.goalRefId}, ${t.goalEpisodeId}, ${t.goalImpact}, ${t.goalRevision}, ${t.goalState}) IN (0, 6)`),
    uniqueIndex('requests_one_open_goal').on(t.companyId, t.goalRefKind, t.goalRefId).where(sql`${t.goalState} = 'open'`),
    unique('requests_company_id').on(t.companyId, t.id),
    index('requests_task_id').on(t.taskId),
    index('requests_approved_kinds').on(t.companyId, t.approvalChannel, t.approvalKind).where(sql`${t.status} = 'approved' AND ${t.approvalChannel} IS NOT NULL`),
    check('requests_approval_commit', sql`${t.kind} <> 'approval' OR ${t.commit} IS NOT NULL OR ${t.approvalChannel} IS NOT NULL`),
  ],
);

/* Private content and actual internal resolver provenance, without a second lifecycle. */
export const requestInternal = pgTable('request_internal', {
  requestId: uuid('request_id').primaryKey().references(() => requests.id),
  companyId: companyId(),
  materialSnapshot: jsonb('material_snapshot').$type<MaterialSnapshotHistory>(),
  technicalText: text('technical_text'),
  ...internalResolutionColumns(),
}, t => [
  ...resolutionChecks('request_internal', t),
  foreignKey({ columns: [t.companyId, t.requestId], foreignColumns: [requests.companyId, requests.id], name: 'request_internal_company_request' }),
  index('request_internal_company_id').on(t.companyId),
  check('request_internal_material_snapshot_bound', materialHistoryBound(t.materialSnapshot)),
]);

/* A picture an agent sent from its turn to show its work. People see it once a request of that agent shows it. Or a file
   an agent on a task put on it, of any kind, which every agent of the company downloads by its name. */
export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    companyId: companyId(),
    /* The agent's turn that put it here; a person's picture has none. */
    jobId: uuid('job_id').references(() => jobs.id),
    /* The agent that put it here, or the one a person sends it to. */
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    /* The person who sends it to that agent with a message. */
    personId: uuid('person_id').references(() => people.id),
    requestId: uuid('request_id').references(() => requests.id),
    operatorCaseId: uuid('operator_case_id').references((): AnyPgColumn => programOperatorCases.id),
    /* The task a file was put on, and the file's name there; a picture has neither. */
    taskId: uuid('task_id').references(() => tasks.id),
    name: text('name'),
    mediaType: text('media_type').notNull(),
    bytes: bytea('bytes').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  t => [index('attachments_request_id').on(t.requestId), index('attachments_job_id').on(t.jobId), index('attachments_task_id').on(t.taskId), index('attachments_person_id').on(t.personId), index('attachments_operator_case_id').on(t.operatorCaseId)],
);

/* A phone is lent independently of its host computer's root access and compute pool. */
export const companyPhones = pgTable('company_phones', {
  id: id(), companyId: companyId(), personId: uuid('person_id').notNull().references(() => people.id),
  machineId: uuid('machine_id').notNull().references(() => machines.id), nodeId: uuid('node_id').notNull().references(() => nodes.id),
  /* The phone's address on the network, as adb names it. */
  serial: text('serial').notNull(), hardwareKey: text('hardware_key').notNull(),
  name: text('name').notNull(), lending: boolean('lending').notNull().default(true), generation: integer('generation').notNull().default(0),
  createdAt: createdAt(), removedAt: timestamp('removed_at', { withTimezone: true }),
}, t => [uniqueIndex('company_phones_machine_serial').on(t.machineId, t.serial).where(sql`${t.removedAt} is null`), uniqueIndex('company_phones_hardware').on(t.hardwareKey).where(sql`${t.removedAt} is null`), index('company_phones_company').on(t.companyId), check('company_phones_generation', sql`${t.generation} >= 0`)]);

export const phoneSessions = pgTable('phone_sessions', {
  id: id(), companyId: companyId(), phoneId: uuid('phone_id').notNull().references(() => companyPhones.id),
  order: bigserial('queue_order', { mode: 'number' }).notNull(),
  agentId: uuid('agent_id').notNull().references(() => agents.id), jobId: uuid('job_id').notNull().references(() => jobs.id),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  status: text('status', { enum: ['queued', 'starting', 'active', 'revoking', 'ended', 'cancelled'] }).notNull().default('queued'),
  generation: integer('generation'), leaseUntil: timestamp('lease_until', { withTimezone: true }),
  createdAt: createdAt(), startedAt: timestamp('started_at', { withTimezone: true }), endedAt: timestamp('ended_at', { withTimezone: true }),
  reason: text('reason', { enum: ['completed', 'cancelled', 'lost', 'stopped', 'offline', 'recording_limit', 'failed'] }),
}, t => [
  index('phone_sessions_task').on(t.taskId), index('phone_sessions_job').on(t.jobId), index('phone_sessions_queue').on(t.phoneId, t.order),
  uniqueIndex('phone_sessions_active').on(t.phoneId).where(sql`${t.status} in ('starting', 'active', 'revoking')`),
  uniqueIndex('phone_sessions_borrower').on(t.phoneId, t.jobId).where(sql`${t.status} in ('queued', 'starting', 'active', 'revoking')`),
]);

/* A session's screens, in order, each picture an attachment of its task. */
export const phoneFrames = pgTable('phone_frames', {
  id: id(), companyId: companyId(), sessionId: uuid('session_id').notNull().references(() => phoneSessions.id), sequence: integer('sequence').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(), attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'cascade' }),
}, t => [unique('phone_frames_sequence').on(t.sessionId, t.sequence), index('phone_frames_session').on(t.sessionId)]);

/* A physical agent program, distinct from the provider session it resumes. */
export const programInstances = pgTable('program_instances', {
  id: uuid('id').primaryKey(),
  companyId: companyId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  nodeId: uuid('node_id').notNull().references(() => nodes.id),
  launched: boolean('launched').notNull().default(false),
  active: boolean('active').notNull().default(false),
  exited: boolean('exited').notNull().default(false),
  createdAt: createdAt(),
}, t => [index('program_instances_agent_id').on(t.agentId)]);

/* Words stay in conversation records. This identity and digest survive dispatch, fallback and reconnect. */
export const programDeliveries = pgTable('program_deliveries', {
  id: id(),
  companyId: companyId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  nodeId: uuid('node_id').notNull().references(() => nodes.id),
  instance: uuid('program_instance_id').references(() => programInstances.id),
  ordinal: integer('ordinal').notNull(),
  reference: text('reference').notNull(),
  kind: text('kind', { enum: ['assignment', 'live'] }).notNull(),
  digest: text('digest').notNull(),
  sourceDeliveryId: uuid('source_delivery_id').references((): AnyPgColumn => programDeliveries.id),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }),
  receiptAt: timestamp('receipt_at', { withTimezone: true }),
  firstActivityAt: timestamp('first_activity_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  outcome: text('outcome', { enum: ['pending', 'taken', 'not_taken', 'cancelled'] }).notNull().default('pending'),
  createdAt: createdAt(),
}, t => [unique('program_deliveries_ordinal').on(t.agentId, t.ordinal), unique('program_deliveries_reference').on(t.agentId, t.reference), index('program_deliveries_job_id').on(t.jobId)]);

export type OperatorCaseEvidence = { reason: OperatorReason; evidenceKey: string; deliveryId: string | null; input?: OperatorInputLine };

/* One investigation per physical program; its original deadline never moves after a read or key. */
export const programOperatorCases = pgTable('program_operator_cases', {
  id: id(),
  companyId: companyId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  jobId: uuid('job_id').notNull().references(() => jobs.id),
  nodeId: uuid('node_id').notNull().references(() => nodes.id),
  instance: uuid('program_instance_id').notNull().references(() => programInstances.id),
  reason: text('reason').$type<OperatorReason>().notNull(),
  evidenceKey: text('evidence_key').notNull(),
  deliveryId: uuid('delivery_id').references(() => programDeliveries.id),
  evidence: jsonb('evidence').$type<OperatorCaseEvidence[]>().notNull().default([]),
  status: text('status', { enum: ['open', 'resolved', 'escalated'] }).notNull().default('open'),
  capability: text('capability').notNull(),
  revision: integer('revision').notNull().default(1),
  readOnly: boolean('read_only').notNull().default(false),
  operatorAgentId: uuid('operator_agent_id').references(() => agents.id),
  operatorJobId: uuid('operator_job_id').references(() => jobs.id),
  escalationJobId: uuid('escalation_job_id').references(() => jobs.id),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  resolution: jsonb('resolution').$type<{ outcome: string; text: string; image: string | null; actor?: MessageParty; question?: OperatorQuestion; holdCall?: { job: string; to: string; at: string; operations: boolean } }>(),
  recoveryHold: boolean('recovery_hold').notNull().default(false),
  continuationJobId: uuid('continuation_job_id').references(() => jobs.id),
  pictureId: uuid('picture_id').references((): AnyPgColumn => attachments.id),
}, t => [unique('program_operator_case_evidence').on(t.companyId, t.agentId, t.instance, t.reason, t.evidenceKey), uniqueIndex('program_operator_case_open').on(t.agentId, t.instance).where(sql`${t.status} = 'open'`), index('program_operator_case_deadline').on(t.deadlineAt).where(sql`${t.status} = 'open'`), index('program_operator_case_hold').on(t.agentId).where(sql`${t.recoveryHold}`)]);

/* Supplementary reasons are consumed too; replay cannot reopen a resolved investigation through another cause. */
export const programOperatorSignals = pgTable('program_operator_signals', {
  companyId: companyId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  instance: uuid('program_instance_id').notNull().references(() => programInstances.id),
  reason: text('reason').$type<OperatorReason>().notNull(),
  evidenceKey: text('evidence_key').notNull(),
  caseId: uuid('case_id').notNull().references(() => programOperatorCases.id),
}, t => [primaryKey({ columns: [t.agentId, t.instance, t.reason, t.evidenceKey] })]);

export const TEST_RUN_STATUSES = ['running', 'passed', 'failed', 'stopped'] as const;

/* A command an agent runs for a task on whichever machines of the company are free, in parts when it splits: the full
   test suite of a task's branch, or any other work, on a branch or in an empty folder with the task's files. The agent
   hears the result on its task, and each part's log, and what a part of work made, go on the task as files. */
export type TestEnvironmentRequest = {
  version: 1; repositoryScope: RepositoryScope; suite?: string;
  /* The time limit of a part the run asked for, when it asked for one. */
  minutes?: number;
  requestId: string | null; nodeId: string | null; builtin: boolean;
  /* The machine whose built-in node was asked, when one was; a request from before machines had theirs names none,
     and was this server's own. */
  builtinMachine?: string | null;
  sentAt: string | null; attempts: number; problem: EnvironmentProblem | null;
};
/* computer: the machine a part was laid out for by its pace; it goes there while that machine is online and may take it. */
export type TestEnvironmentSelection = { selection: TestExecution['selection']; after: number[]; computer?: string };
export type TestFileKey = { suiteId: string; file: string };
/* How a run reused green results. mode: cached reuses what kept its fingerprint, full runs everything, off had no fingerprints
   to go by. fingerprints and wouldSkip serve the run's parts and go when it ends. */
export type TestRunFileCache = {
  /* release: the release the run checks, whose results it may take; none on a run from before releases were kept. */
  mode: 'cached' | 'full' | 'off'; release?: string; fingerprints: UnitFingerprint[]; reused: number; preparationReused: boolean;
  verifiedFingerprints?: UnitFingerprint[];
  /* How many green results the run kept for later, once it ended. */
  kept?: number;
  wouldSkip: TestFileKey[]; compared: number; mismatches: TestFileKey[]; notes: { file: string; note: string }[];
};

export const testRuns = pgTable(
  'test_runs',
  {
    id: id(),
    companyId: companyId(),
    number: integer('number').notNull(),
    taskId: uuid('task_id').notNull().references(() => tasks.id),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    /* The turn that asked for it: the logs go on the task as that turn's files. */
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    /* The department or product whose repository it clones; a removed one takes its repository along. */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: RUN_KINDS }).notNull().default('tests'),
    /* A test run's branch, its own or the one named. None: on a test run from before commits were pinned the task's own,
       task-<number> or the one that starts with task-<number>-; for work no repository, an empty folder. */
    branch: text('branch'),
    /* The one commit every part of a test run checks, read from its branch before any part goes out. None on a run of
       work, or on a run from before commits were pinned. */
    commitSha: text('commit_sha'),
    command: text('command').notNull(),
    /* Original manifest evidence and the chosen profile; old manual runs retain null evidence. */
    environmentSnapshot: jsonb('environment_snapshot').$type<EnvironmentSnapshot>(),
    environmentHash: text('environment_hash'),
    /* The assigned authenticated metadata request, persisted without a repository credential. */
    environmentRequest: jsonb('environment_request').$type<TestEnvironmentRequest>(),
    fileCache: jsonb('file_cache').$type<TestRunFileCache>(),
    /* The task's files a part of work takes in, by name. */
    files: jsonb('files').$type<string[]>().notNull().default([]),
    /* The free memory a part of work needs; tests need what their repository says. */
    memoryGb: integer('memory_gb'),
    /* The agent said a part of work may run twice, so one whose machine went offline, and may still run there, runs
       again elsewhere. A part of a test run always may. */
    repeatable: boolean('repeatable').notNull().default(false),
    parts: integer('parts').notNull().default(1),
    timeoutMs: integer('timeout_ms').notNull(),
    status: text('status', { enum: TEST_RUN_STATUSES }).notNull().default('running'),
    /* An agent other than the one that asked for it stopped it. */
    stoppedByAgentId: uuid('stopped_by_agent_id').references(() => agents.id),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  t => [unique('test_runs_company_number').on(t.companyId, t.number), index('test_runs_task_id').on(t.taskId), index('test_runs_environment_request').on(sql`(${t.environmentRequest}->>'requestId')`).where(sql`${t.environmentRequest} is not null and ${t.environmentSnapshot} is null and ${t.status} = 'running'`)],
);

export const HARNESS_BUILD_STATUSES = ['building', 'ready', 'failed'] as const;
/* One built piece of a product's test harness. key: what it was built from, the program and the architecture, so a machine
   of another architecture has a row of its own for the same version. One machine holds the lease and builds; the others
   wait for it and take its bundle, which lies in HARNESS_DIR. */
export const harnessBuilds = pgTable(
  'harness_builds',
  {
    id: id(),
    companyId: companyId(),
    departmentId: uuid('department_id').notNull().references(() => departments.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    version: text('version').notNull(),
    unit: text('unit').notNull(),
    platform: text('platform').notNull(),
    commitSha: text('commit_sha').notNull(),
    status: text('status', { enum: HARNESS_BUILD_STATUSES }).notNull().default('building'),
    builder: text('builder'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    digest: text('digest'),
    size: bigint('size', { mode: 'number' }),
    error: text('error'),
    failures: integer('failures').notNull().default(0),
    nextTryAt: timestamp('next_try_at', { withTimezone: true }),
    /* The machines that said they hold it. */
    copies: jsonb('copies').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [unique('harness_builds_company_key').on(t.companyId, t.key), index('harness_builds_department').on(t.departmentId, t.createdAt)],
);

/* Where a machine stands with a product's harness: the last commit it answered for, and what stopped it. */
export type HarnessMachine = { name: string; commitSha: string; version: string | null; problem: string | null; at: string };
/* A problem of a product's harness: the commit it was seen on, and what the head last heard of, so it hears once. */
export type HarnessProblem = { code: string; detail: string; commitSha: string };
/* A product's harness as a whole. goodCommit: the last one a machine had all of, which stays usable when a later one breaks. */
export const harnessProducts = pgTable('harness_products', {
  departmentId: uuid('department_id').primaryKey().references(() => departments.id, { onDelete: 'cascade' }),
  companyId: companyId(),
  headCommit: text('head_commit'),
  goodCommit: text('good_commit'),
  version: text('version'),
  problem: jsonb('problem').$type<HarnessProblem>(),
  told: text('told'),
  machines: jsonb('machines').$type<Record<string, HarnessMachine>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const TEST_PART_STATUSES = ['queued', 'running', 'passed', 'failed', 'stopped'] as const;
/* A machine that lost a part of a run as it ran: the place (a machine's id, or builtin), its name then, and why. */
export type LostRun = { key: string; machine: string; why: string; computer?: string };

/* One part of a test run: it waits for a free machine, then runs on one node, a node on a machine or the built-in node. */
export const testParts = pgTable(
  'test_parts',
  {
    id: id(),
    companyId: companyId(),
    runId: uuid('run_id').notNull().references(() => testRuns.id),
    part: integer('part').notNull(),
    environmentSelection: jsonb('environment_selection').$type<TestEnvironmentSelection>(),
    environmentReceipt: jsonb('environment_receipt').$type<TestEnvironmentReceipt>(),
    /* The files its runner named as failed. */
    failedFiles: jsonb('failed_files').$type<TestFileKey[]>(),
    status: text('status', { enum: TEST_PART_STATUSES }).notNull().default('queued'),
    nodeId: uuid('node_id').references(() => nodes.id),
    builtin: boolean('builtin').notNull().default(false),
    /* The machine whose built-in node runs it, by its network id; none for a part on a plan's node. */
    builtinMachine: text('builtin_machine'),
    machineId: uuid('machine_id').references(() => machines.id),
    /* The machine's name as it ran, for the result. */
    machineName: text('machine_name'),
    /* Its assigned physical computer, kept through disconnects and server restarts. Null on older parts. */
    computer: text('computer'),
    /* The commit its node says it tested, the command's exit code, and why it ended when that was not the tests themselves. */
    commit: text('commit'),
    exitCode: integer('exit_code'),
    error: text('error'),
    /* The last lines of what it printed. */
    tail: text('tail').notNull().default(''),
    /* The machines that lost it before, oldest first: it ran again after each. */
    lost: jsonb('lost').$type<LostRun[]>().notNull().default([]),
    createdAt: createdAt(),
    /* Since when it waits for a machine: since it was made, or since it was lost. */
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  t => [unique('test_parts_run_part').on(t.runId, t.part), index('test_parts_status').on(t.status), check('test_parts_builtin_machine', sql`builtin_machine ~ '^[0-9a-f]{32}([0-9a-f]{32})?$'`)],
);

/* What a part's log said of its test files, read once from the log on the task: empty when it said nothing. */
export const testPartTimings = pgTable(
  'test_part_timings',
  {
    partId: uuid('part_id').primaryKey().references(() => testParts.id, { onDelete: 'cascade' }),
    companyId: companyId(),
    runId: uuid('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
    files: jsonb('files').$type<TestFileTiming[]>().notNull().default([]),
    packages: jsonb('packages').$type<TestPackageTiming[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  t => [index('test_part_timings_run_id').on(t.runId)],
);

/* A test file that passed, by what its result depended on: at the same fingerprint in the same repository it need not run again. */
export const testFileResults = pgTable(
  'test_file_results',
  {
    companyId: companyId(),
    repositoryOwnerId: uuid('repository_owner_id').notNull().references(() => departments.id, { onDelete: 'cascade' }),
    repoUrlHash: text('repo_url_hash').notNull(),
    fingerprint: text('fingerprint').notNull(),
    suiteId: text('suite_id').notNull(),
    file: text('file').notNull(),
    runId: uuid('run_id').notNull().references(() => testRuns.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    ms: integer('ms'),
    /* What the result came to, as its runner put it. */
    note: text('note'),
    /* No longer read: every shared run checks a release now. It stays until a migration drops it. */
    mainLine: boolean('main_line').notNull().default(false),
    createdAt: createdAt(),
  },
  t => [primaryKey({ name: 'test_file_results_pk', columns: [t.companyId, t.repositoryOwnerId, t.repoUrlHash, t.fingerprint, t.suiteId, t.file] }), index('test_file_results_age').on(t.companyId, t.createdAt)],
);

/* What a suite's last run left for its next, as its manifest's keep names it. */
export const testSuiteMemory = pgTable(
  'test_suite_memory',
  {
    companyId: companyId(),
    repositoryOwnerId: uuid('repository_owner_id').notNull().references(() => departments.id, { onDelete: 'cascade' }),
    repoUrlHash: text('repo_url_hash').notNull(),
    suiteId: text('suite_id').notNull(),
    files: jsonb('files').$type<{ path: string; text: string }[]>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [primaryKey({ name: 'test_suite_memory_pk', columns: [t.companyId, t.repositoryOwnerId, t.repoUrlHash, t.suiteId] })],
);

/* The company's notebook: short notes the orchestrator keeps across conversations, such as the CEO's decisions, rules
   and agreements. People who see the whole company read and change it too. */
export const notebookNotes = pgTable(
  'notebook_notes',
  {
    id: id(),
    companyId: companyId(),
    number: integer('number').notNull(),
    text: text('text').notNull(),
    /* The department whose head carries the note; none for the company notebook the orchestrator carries. */
    departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').references(() => people.id),
    byOrchestrator: boolean('by_orchestrator').notNull().default(false),
    /* The head that wrote it last, when it was one. */
    agentId: uuid('agent_id').references(() => agents.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /* A removed note keeps its number, so a number never names two notes. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  t => [unique('notebook_notes_book_number').on(t.companyId, t.departmentId, t.number).nullsNotDistinct()],
);

/* A repository a product or a department works in, as its people describe it: where it is, its branch, its own rules of
   work and who commits to it. Only the one connected with set_repository is cloned for the agents. */
export type BriefingRepository = { url: string; branch: string; rules: string; author: { name: string; email: string } | null };

/* What a department or a product keeps for its agents, one record each: its own way of working and, for a product, its
   repositories. People write it on the department's screen; an agent reads its own department's and product's when it
   decides to, and nothing of it goes into the agents' messages. */
export const briefings = pgTable(
  'briefings',
  {
    departmentId: uuid('department_id').primaryKey(),
    companyId: companyId(),
    text: text('text').notNull().default(''),
    repositories: jsonb('repositories').$type<BriefingRepository[]>().notNull().default([]),
    /* Who wrote it last: a person, or the orchestrator for the person its turn answered. */
    personId: uuid('person_id').references(() => people.id),
    byOrchestrator: boolean('by_orchestrator').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [foreignKey({ name: 'briefings_department', columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }).onDelete('cascade')],
);

/* open: waits for the CEO. taken: the CEO gave it to the orchestrator. done: the orchestrator did it. dismissed: the CEO
   set it aside. sent: a person sent it to Hornhoof's developers, as a finding about Hornhoof itself. */
export const IMPROVEMENT_STATUSES = ['open', 'taken', 'done', 'dismissed', 'sent'] as const;
/* company: how this company works, its setup, its instructions, its own work. platform: Hornhoof itself, such as a system
   package its node image lacks or a failure of its terminal or queue. */
export const IMPROVEMENT_SCOPES = ['company', 'platform'] as const;

/* An improvement as a short case: what is wrong, the facts with where each comes from, kept apart from what its finder only
   guesses, why it matters, the change and what it gives. */
export type ImprovementParts = {
  problem: string | null;
  facts: { text: string; source: string }[];
  guesses: string[];
  why: string | null;
  change: string;
  gain: string | null;
};

/* Something an employee found to improve in how the company works, such as a program to install ahead or a harmless
   action to allow, for the CEO to take into work. Its department is its finder's. */
export const improvements = pgTable(
  'improvements',
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    title: text('title').notNull(),
    /* The whole case as one text. One filed before the parts has only this. */
    text: text('text').notNull(),
    parts: jsonb('parts').$type<ImprovementParts>(),
    /* How many rounds found it: one that finds it again rewrites it and adds one. */
    seen: integer('seen').notNull().default(1),
    status: text('status', { enum: IMPROVEMENT_STATUSES }).notNull().default('open'),
    scope: text('scope', { enum: IMPROVEMENT_SCOPES }).notNull().default('company'),
    /* The error code Hornhoof gave, for a finding about Hornhoof itself that has one. */
    code: text('code'),
    /* The person who took it into work, set it aside or sent it. */
    decidedBy: uuid('decided_by').references(() => people.id),
    /* The orchestrator's word on what came of it, or why it could not be done. */
    result: text('result'),
    /* For one sent to Hornhoof's developers: when it went, the report exactly as it went, what tells its repeats, its number
       in their inbox and the issue it became there, as their inbox answered, and how many rounds had found it when they
       last heard of it. */
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sentReport: jsonb('sent_report').$type<SentReport>(),
    sentFingerprint: text('sent_fingerprint'),
    reportNumber: integer('report_number'),
    issueNumber: integer('issue_number'),
    issueUrl: text('issue_url'),
    reportedSeen: integer('reported_seen'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('improvements_company_id_status').on(t.companyId, t.status), index('improvements_sent_fingerprint').on(t.companyId, t.sentFingerprint)],
);

/* What a report to Hornhoof's developers is. */
export const FEEDBACK_KINDS = ['bug', 'improvement', 'idea'] as const;
/* A report as an installation sent it: its kind, cleaned words and technical data. */
export type SentReport = {
  kind: (typeof FEEDBACK_KINDS)[number];
  title: string;
  text: string;
  facts: { version: string; platform: string[]; errorCode: string | null };
};

/* On Hornhoof's own installation, one card of the inbox: a report every installation may send, its repeats counted on it.
   fingerprint: what tells repeats apart, its kind, error code and title written plainly. The text is the first report's,
   as text. versions and platforms: every one the signals came with. The issue it became on GitHub, once a person made it. */
export const feedbackInbox = pgTable(
  'feedback_inbox',
  {
    id: id(),
    companyId: companyId(),
    /* What an installation calls the report by: its place in the order cards were opened. */
    number: serial('number').notNull(),
    fingerprint: text('fingerprint').notNull(),
    kind: text('kind', { enum: FEEDBACK_KINDS }).notNull(),
    title: text('title').notNull(),
    text: text('text').notNull(),
    errorCode: text('error_code'),
    versions: text('versions').array().notNull().default(sql`'{}'::text[]`),
    platforms: text('platforms').array().notNull().default(sql`'{}'::text[]`),
    issueNumber: integer('issue_number'),
    issueUrl: text('issue_url'),
    issuedBy: uuid('issued_by').references(() => people.id),
    createdAt: createdAt(),
    /* When its last signal came. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [unique('feedback_inbox_fingerprint').on(t.companyId, t.fingerprint), unique('feedback_inbox_number').on(t.number)],
);

/* How many times one installation sent a card's report, by the id it signs its reports with. */
export const feedbackSignals = pgTable(
  'feedback_signals',
  {
    cardId: uuid('card_id')
      .notNull()
      .references(() => feedbackInbox.id, { onDelete: 'cascade' }),
    installation: text('installation').notNull(),
    signals: integer('signals').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [primaryKey({ columns: [t.cardId, t.installation] })],
);

/* The company's public link at the relay, like acme.hornhoof.org: its name and address, the key that changes or removes
   it there and the tunnel's settings, the last two encrypted. One deployment has one company, so at most one link. */
export const publicLinks = pgTable('public_links', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id),
  name: text('name').notNull(),
  url: text('url').notNull(),
  keyEnc: text('key_enc').notNull(),
  tunnelEnc: text('tunnel_enc').notNull(),
  /* The key a change is under way to, sealed as keyEnc is. */
  nextKeyEnc: text('next_key_enc'),
  /* A name the company never asked for: Hornhoof took it so that the company's machines can hold copies, and nobody is
     shown it or served through it. */
  hidden: boolean('hidden').notNull().default(false),
  createdAt: createdAt(),
});

/* Wait requests and observations survive a restart until accepted into the recipient's work queue. */
export const waitNotices = pgTable('wait_notices', {
  id: id(),
  companyId: companyId(),
  /* Who it is for: an employee, who gets it as a turn, or a person, who keeps it as a card until they say they saw it. */
  agentId: uuid('agent_id').references(() => agents.id),
  personId: uuid('person_id').references(() => people.id),
  dedupKey: text('dedup_key').notNull(),
  message: jsonb('message').$type<import('../modules/tasks/wait-notice-types.js').WaitNoticeMessage>().notNull(),
  guard: jsonb('guard').$type<import('../modules/tasks/wait-notice-types.js').WaitNoticeGuard>().notNull(),
  createdAt: createdAt(),
  leaseId: uuid('lease_id'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  /* The accountable wait a notice speaks for, at the generation and route it was written for: a later one makes it stale. */
  waitId: uuid('wait_id').references(() => taskWaits.id),
  generation: integer('generation'),
  level: integer('level'),
  purpose: text('purpose'),
  routeRevision: integer('route_revision'),
  /* A person saw the card. It decides nothing: the question it speaks of stays as it is. */
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedByPersonId: uuid('acknowledged_by_person_id').references(() => people.id),
}, t => [
  unique('wait_notices_dedup').on(t.companyId, t.dedupKey),
  check('wait_notices_one_recipient', sql`(${t.agentId} IS NULL) <> (${t.personId} IS NULL)`),
  index('wait_notices_cards').on(t.personId, t.createdAt).where(sql`${t.personId} IS NOT NULL AND ${t.acknowledgedAt} IS NULL`),
  index('wait_notices_pending').on(t.createdAt).where(sql`${t.deliveredAt} IS NULL AND ${t.cancelledAt} IS NULL`),
  uniqueIndex('wait_notices_one_per_level').on(t.waitId, t.generation, t.level, t.purpose, t.routeRevision).where(sql`${t.waitId} IS NOT NULL`),
  check('wait_notices_wait_whole', sql`${t.waitId} IS NULL OR (${t.generation} IS NOT NULL AND ${t.level} IS NOT NULL AND ${t.purpose} IS NOT NULL AND ${t.routeRevision} IS NOT NULL)`),
]);

/* One record for each source a task waits on, with who answers for it and until when. Its source is what ends it: a date
   passing proves nothing. Both SQL roles stay out (HIDDEN): the record names private work, and one written by hand could
   move a promise or quiet an alarm. */
export const taskWaits = pgTable('task_waits', {
  id: id(),
  companyId: companyId(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  kind: text('kind', { enum: WAIT_SOURCE_KINDS }).notNull(),
  /* Stable across restarts, never made up by a sweep; for an external wait, the id of its operation. */
  sourceKey: text('source_key').notNull(),
  /* The source's own count of its changes. A task's version moves with any comment and has no part in it. */
  sourceRevision: integer('source_revision').notNull(),
  /* Grows when the owner or the plan changes, which makes what was written for the one before stale. */
  generation: integer('generation').notNull().default(1),
  state: text('state', { enum: WAIT_STATES }).notNull(),
  ownerAgentId: uuid('owner_agent_id').references(() => agents.id),
  ownerPersonId: uuid('owner_person_id').references(() => people.id),
  plan: jsonb('plan').$type<WaitPlan>(),
  ownerDueAt: timestamp('owner_due_at', { withTimezone: true }),
  headDueAt: timestamp('head_due_at', { withTimezone: true }),
  decisionDueAt: timestamp('decision_due_at', { withTimezone: true }),
  level: integer('level').notNull().default(0),
  nextActionAt: timestamp('next_action_at', { withTimezone: true }),
  reviewOrdinal: integer('review_ordinal').notNull().default(0),
  nextReviewAt: timestamp('next_review_at', { withTimezone: true }),
  attentionAgentId: uuid('attention_agent_id').references(() => agents.id),
  attentionPersonId: uuid('attention_person_id').references(() => people.id),
  /* Who decides in the end: the department's named owner, and the CEO without one. Kept as authority; no alarm follows from it. */
  finalDecisionPersonId: uuid('final_decision_person_id').references(() => people.id),
  fallbackToCeo: boolean('fallback_to_ceo').notNull().default(false),
  routeRevision: integer('route_revision').notNull().default(0),
  sourceState: jsonb('source_state').$type<WaitSourceState>().notNull().default({}),
  outcome: text('outcome', { enum: WAIT_OUTCOMES }),
  proofRef: text('proof_ref'),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('task_waits_open_source').on(t.companyId, t.taskId, t.kind, t.sourceKey).where(sql`${t.state} IN ('active', 'legacy_needs_plan')`),
  index('task_waits_task').on(t.taskId),
  index('task_waits_next_action').on(t.nextActionAt).where(sql`${t.state} = 'active'`),
  check('task_waits_kind', sql`${t.kind} IN ('after', 'review', 'person', 'run', 'external')`),
  check('task_waits_state', sql`${t.state} IN ('active', 'resolved', 'cancelled', 'superseded', 'legacy_needs_plan')`),
  check('task_waits_counts', sql`${t.sourceRevision} >= 0 AND ${t.generation} >= 1 AND ${t.reviewOrdinal} >= 0 AND ${t.routeRevision} >= 0 AND ${t.level} BETWEEN 0 AND 3`),
  check('task_waits_one_owner', sql`${t.ownerAgentId} IS NULL OR ${t.ownerPersonId} IS NULL`),
  check('task_waits_one_attention', sql`${t.attentionAgentId} IS NULL OR ${t.attentionPersonId} IS NULL`),
  check('task_waits_active_is_whole', sql`${t.state} <> 'active' OR (
    (${t.ownerAgentId} IS NULL) <> (${t.ownerPersonId} IS NULL) AND ${t.plan} IS NOT NULL AND ${t.ownerDueAt} IS NOT NULL AND ${t.headDueAt} IS NOT NULL
    AND ${t.decisionDueAt} IS NOT NULL AND ${t.nextActionAt} IS NOT NULL)`),
  /* A review goes on until its source ends. Only an external operation, whose one signal has gone, has none left. */
  check('task_waits_reviews_go_on', sql`${t.state} <> 'active' OR ${t.nextReviewAt} IS NOT NULL OR (${t.reviewOrdinal} >= 1 AND ${t.kind} = 'external' AND ${t.sourceKey} LIKE 'operation:%')`),
  check('task_waits_legacy_has_no_dates', sql`${t.state} <> 'legacy_needs_plan' OR (${t.plan} IS NULL AND ${t.ownerDueAt} IS NULL AND ${t.headDueAt} IS NULL AND ${t.decisionDueAt} IS NULL AND ${t.nextActionAt} IS NULL AND ${t.nextReviewAt} IS NULL)`),
  check('task_waits_ended', sql`(${t.state} IN ('active', 'legacy_needs_plan')) = (${t.endedAt} IS NULL AND ${t.outcome} IS NULL AND ${t.proofRef} IS NULL)`),
]);

/* A version of how long a department gives a kind of wait, at a stage or at all. No company starts with one, and a plan made
   from one keeps its dates when a later version comes. */
export const waitPolicies = pgTable('wait_policies', {
  id: id(),
  companyId: companyId(),
  departmentId: uuid('department_id').notNull().references(() => departments.id),
  kind: text('kind', { enum: WAIT_SOURCE_KINDS }).notNull(),
  stage: text('stage').notNull().default(''),
  version: integer('version').notNull(),
  ownerMs: bigint('owner_ms', { mode: 'number' }).notNull(),
  headMs: bigint('head_ms', { mode: 'number' }).notNull(),
  decisionMs: bigint('decision_ms', { mode: 'number' }).notNull(),
  reviewIntervalMs: bigint('review_interval_ms', { mode: 'number' }).notNull(),
  createdByPersonId: uuid('created_by_person_id').references(() => people.id),
  createdByAgentId: uuid('created_by_agent_id').references(() => agents.id),
  createdAt: createdAt(),
}, t => [
  unique('wait_policies_version').on(t.companyId, t.departmentId, t.kind, t.stage, t.version),
  check('wait_policies_order', sql`${t.ownerMs} > 0 AND ${t.ownerMs} <= ${t.headMs} AND ${t.headMs} <= ${t.decisionMs} AND ${t.reviewIntervalMs} > 0 AND ${t.version} >= 1`),
  check('wait_policies_kind', sql`${t.kind} IN ('after', 'review', 'person', 'run', 'external')`),
  check('wait_policies_one_author', sql`(${t.createdByPersonId} IS NULL) <> (${t.createdByAgentId} IS NULL)`),
]);

/* Checks made by a model. Both SQL roles stay out (HIDDEN): the examples hold private words, the held-out part must not
   reach whoever tunes a prompt, and a status written by hand could turn a check on. */
const MODEL_CHECK_PARTIES = ['person', 'agent'] as const;

export const modelChecks = pgTable('model_checks', {
  id: id(),
  companyId: companyId(),
  departmentId: uuid('department_id').notNull().references(() => departments.id, { onDelete: 'cascade' }),
  productId: uuid('product_id').references(() => departments.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: MODEL_CHECK_KINDS }).notNull(),
  /* Off until a run of this very binding passes, and off again when its week ends or a part of it changes. */
  status: text('status', { enum: ['off', 'on'] }).notNull().default('off'),
  offReason: text('off_reason', { enum: INVALIDATION_CODES }),
  bindingDigest: text('binding_digest'),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  /* Set by the owner of the department, not by whoever wrote the check. */
  thresholds: jsonb('thresholds').$type<Thresholds>(),
  thresholdsBy: uuid('thresholds_by').references(() => people.id),
  createdAt: createdAt(),
}, t => [
  unique('model_checks_place').on(t.departmentId, t.productId, t.kind).nullsNotDistinct(),
  index('model_checks_company_id').on(t.companyId),
  check('model_checks_status', sql`${t.status} IN ('off', 'on')`),
  check('model_checks_on_is_bound', sql`${t.status} = 'off' OR (${t.bindingDigest} IS NOT NULL AND ${t.validUntil} IS NOT NULL AND ${t.thresholds} IS NOT NULL AND ${t.offReason} IS NULL)`),
]);

/* A definition of a check, never changed: the next change is the next version. */
export const modelCheckRevisions = pgTable('model_check_revisions', {
  id: id(),
  checkId: uuid('check_id').notNull().references(() => modelChecks.id, { onDelete: 'cascade' }),
  definitionVersion: integer('definition_version').notNull(),
  checkerCodeHash: text('checker_code_hash').notNull(),
  promptHash: text('prompt_hash').notNull(),
  outputSchemaHash: text('output_schema_hash').notNull(),
  sourceListHash: text('source_list_hash').notNull(),
  taxonomyHash: text('taxonomy_hash'),
  model: jsonb('model').$type<ModelIdentity>().notNull(),
  authorKind: text('author_kind', { enum: MODEL_CHECK_PARTIES }).notNull(),
  authorId: uuid('author_id').notNull(),
  createdAt: createdAt(),
}, t => [
  unique('model_check_revisions_version').on(t.checkId, t.definitionVersion),
  check('model_check_revisions_author', sql`${t.authorKind} IN ('person', 'agent')`),
]);

/* A set of examples, never changed: its id is the datasetVersion of a binding. Its lines stay sealed, with the counts beside them. */
export const modelCheckDatasets = pgTable('model_check_datasets', {
  id: id(),
  checkId: uuid('check_id').notNull().references(() => modelChecks.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  hash: text('hash').notNull(),
  jsonlEnc: text('jsonl_enc').notNull(),
  cases: integer('cases').notNull(),
  holdoutCases: integer('holdout_cases').notNull(),
  mustBlockCases: integer('must_block_cases').notNull(),
  addedByKind: text('added_by_kind', { enum: MODEL_CHECK_PARTIES }).notNull(),
  addedById: uuid('added_by_id').notNull(),
  createdAt: createdAt(),
}, t => [
  unique('model_check_datasets_version').on(t.checkId, t.version),
  check('model_check_datasets_added_by', sql`${t.addedByKind} IN ('person', 'agent')`),
  check('model_check_datasets_counts', sql`${t.cases} > 0 AND ${t.holdoutCases} >= 0 AND ${t.mustBlockCases} >= 0 AND ${t.holdoutCases} <= ${t.cases} AND ${t.mustBlockCases} <= ${t.cases}`),
]);

/* One run over one binding: its id is the reportId. The dedup key makes one change or one week a single run, however many
   rounds see it. A pass cannot be written for a run that was cut short, had an error or missed what it must block. */
export const modelCheckEvaluations = pgTable('model_check_evaluations', {
  id: id(),
  checkId: uuid('check_id').notNull().references(() => modelChecks.id, { onDelete: 'cascade' }),
  revisionId: uuid('revision_id').notNull().references(() => modelCheckRevisions.id, { onDelete: 'cascade' }),
  datasetId: uuid('dataset_id').notNull().references(() => modelCheckDatasets.id, { onDelete: 'cascade' }),
  /* The binding it ran, whole: the next change compares against it, and a report says what it was about. */
  binding: jsonb('binding').$type<CheckBinding>().notNull(),
  bindingDigest: text('binding_digest').notNull(),
  trigger: text('trigger', { enum: ['change', 'weekly'] }).notNull(),
  parts: jsonb('parts').$type<BindingPart[]>().notNull().default([]),
  dedupKey: text('dedup_key').notNull(),
  status: text('status', { enum: ['queued', 'running', 'passed', 'failed', 'incomplete'] }).notNull().default('queued'),
  complete: boolean('complete').notNull().default(false),
  infraErrors: integer('infra_errors').notNull().default(0),
  mustBlockMisses: integer('must_block_misses').notNull().default(0),
  metrics: jsonb('metrics').$type<EvaluationCounts>(),
  holdoutMetrics: jsonb('holdout_metrics').$type<EvaluationCounts>(),
  problems: jsonb('problems').$type<RunProblem[]>().notNull().default([]),
  /* Ids of missed examples of the part authors may see. Held-out ones are never named. */
  missedDevCases: jsonb('missed_dev_cases').$type<string[]>().notNull().default([]),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [
  unique('model_check_evaluations_dedup').on(t.checkId, t.dedupKey),
  index('model_check_evaluations_pending').on(t.createdAt).where(sql`${t.status} IN ('queued', 'running')`),
  index('model_check_evaluations_finished').on(t.checkId, t.finishedAt),
  check('model_check_evaluations_trigger', sql`${t.trigger} IN ('change', 'weekly')`),
  check('model_check_evaluations_status', sql`${t.status} IN ('queued', 'running', 'passed', 'failed', 'incomplete')`),
  check('model_check_evaluations_ended', sql`(${t.status} IN ('queued', 'running')) = (${t.finishedAt} IS NULL)`),
  check('model_check_evaluations_clean_pass', sql`${t.status} <> 'passed' OR (${t.complete} AND ${t.infraErrors} = 0 AND ${t.mustBlockMisses} = 0 AND ${t.metrics} IS NOT NULL AND ${t.holdoutMetrics} IS NOT NULL)`),
]);

/* A row of the outbound gateway points only at rows of its own company, whatever a bug or a forged id asks. */
type Owned = { companyId: AnyPgColumn; id: AnyPgColumn };
const sameCompany = (name: string, company: AnyPgColumn, column: AnyPgColumn, parent: Owned) => foreignKey({ name, columns: [company, column], foreignColumns: [parent.companyId, parent.id] });
const inPlace = (table: string, t: { companyId: AnyPgColumn; departmentId: AnyPgColumn; productId: AnyPgColumn }) => [
  sameCompany(`${table}_department`, t.companyId, t.departmentId, departments),
  sameCompany(`${table}_product`, t.companyId, t.productId, departments),
];
const isDigest = (name: string, column: AnyPgColumn) => check(name, sql`${column} ~ '^[0-9a-f]{64}$'`);
const placeColumns = () => ({ companyId: companyId(), departmentId: uuid('department_id').notNull(), productId: uuid('product_id') });
const at = (name: string) => timestamp(name, { withTimezone: true });

/* A way out of the company: one adapter, one purpose, direct to contacts or public. A stop holds a reason and only a
   person's decision ends it; each stop or reopening is a new generation, so what was admitted under an older one is stale. */
export type StopReason = GateCode | 'complaint_threshold' | 'refusal_threshold' | 'bounce_threshold';
export const outboundChannels = pgTable('outbound_channels', {
  id: id(),
  ...placeColumns(),
  name: text('name').notNull(),
  adapter: text('adapter', { enum: ['smtp', 'webhook'] }).notNull(),
  purpose: text('purpose').notNull(),
  audience: text('audience', { enum: ['direct', 'public'] }).notNull(),
  status: text('status', { enum: ['new', 'active', 'stopped'] }).notNull().default('new'),
  generation: integer('generation').notNull().default(1),
  stoppedReason: text('stopped_reason').$type<StopReason>(),
  stoppedAt: at('stopped_at'),
  createdBy: uuid('created_by').notNull().references(() => people.id),
  createdAt: createdAt(),
}, t => [
  unique('outbound_channels_company_id').on(t.companyId, t.id),
  unique('outbound_channels_place').on(t.departmentId, t.productId, t.name).nullsNotDistinct(),
  ...inPlace('outbound_channels', t),
  check('outbound_channels_adapter', sql`${t.adapter} IN ('smtp', 'webhook')`),
  check('outbound_channels_audience', sql`${t.audience} IN ('direct', 'public')`),
  check('outbound_channels_status', sql`${t.status} IN ('new', 'active', 'stopped')`),
  check('outbound_channels_generation', sql`${t.generation} > 0`),
  check('outbound_channels_stop', sql`(${t.status} = 'stopped') = (${t.stoppedAt} IS NOT NULL) AND (${t.status} = 'stopped') = (${t.stoppedReason} IS NOT NULL)`),
]);

/* An owner's limits of a channel. Never changed: the next change is the next revision, with its own digest. */
export const outboundPolicies = pgTable('outbound_policies', {
  id: id(),
  companyId: companyId(),
  channelId: uuid('channel_id').notNull(),
  revision: integer('revision').notNull(),
  digest: text('digest').notNull(),
  value: jsonb('value').$type<OutboundPolicyValue>().notNull(),
  createdBy: uuid('created_by').notNull().references(() => people.id),
  createdAt: createdAt(),
}, t => [
  unique('outbound_policies_company_id').on(t.companyId, t.id),
  unique('outbound_policies_revision').on(t.channelId, t.revision),
  sameCompany('outbound_policies_channel', t.companyId, t.channelId, outboundChannels),
  check('outbound_policies_positive', sql`${t.revision} > 0`),
  isDigest('outbound_policies_digest', t.digest),
]);

/* The sender's account. Its settings stay sealed and only the trusted sender opens them; a new secret is a new generation,
   so what was queued under the old one is stale. Its domain has one spelling, so that a limit counts it once. */
export const outboundAccounts = pgTable('outbound_accounts', {
  id: id(),
  ...placeColumns(),
  channelId: uuid('channel_id').notNull(),
  senderDomain: text('sender_domain').notNull(),
  label: text('label').notNull(),
  configEnc: text('config_enc').notNull(),
  configGeneration: integer('config_generation').notNull().default(1),
  status: text('status', { enum: ['active', 'invalid', 'revoked'] }).notNull().default('active'),
  createdBy: uuid('created_by').notNull().references(() => people.id),
  createdAt: createdAt(),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, t => [
  unique('outbound_accounts_company_id').on(t.companyId, t.id),
  unique('outbound_accounts_label').on(t.channelId, t.label),
  ...inPlace('outbound_accounts', t),
  sameCompany('outbound_accounts_channel', t.companyId, t.channelId, outboundChannels),
  check('outbound_accounts_domain', sql`${t.senderDomain} = lower(${t.senderDomain}) AND ${t.senderDomain} <> ''`),
  check('outbound_accounts_status', sql`${t.status} IN ('active', 'invalid', 'revoked')`),
  check('outbound_accounts_generation', sql`${t.configGeneration} > 0`),
]);

/* Who writes from an account. Persistent, not a lease: one account to one author and one author to one account at a time.
   A transfer is a new row with the next generation, and what was queued under the old one never moves to the new author. */
export const outboundBindings = pgTable('outbound_bindings', {
  id: id(),
  companyId: companyId(),
  accountId: uuid('account_id').notNull(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  generation: integer('generation').notNull(),
  status: text('status', { enum: ['active', 'released'] }).notNull().default('active'),
  createdBy: uuid('created_by').notNull().references(() => people.id),
  createdAt: createdAt(),
  releasedAt: at('released_at'),
}, t => [
  unique('outbound_bindings_generation').on(t.accountId, t.generation),
  uniqueIndex('outbound_bindings_one_author').on(t.companyId, t.accountId).where(sql`${t.status} = 'active'`),
  uniqueIndex('outbound_bindings_one_account').on(t.companyId, t.agentId).where(sql`${t.status} = 'active'`),
  sameCompany('outbound_bindings_account', t.companyId, t.accountId, outboundAccounts),
  check('outbound_bindings_status', sql`${t.status} IN ('active', 'released')`),
  check('outbound_bindings_positive', sql`${t.generation} > 0`),
  check('outbound_bindings_release', sql`(${t.status} = 'released') = (${t.releasedAt} IS NOT NULL)`),
]);

/* Everything a message may say: prices, links, claims, templates, lists. A revision is never changed, only published by a
   person and later revoked. A model can propose one, and the publisher's column holds people only. */
export const outboundCatalogRevisions = pgTable('outbound_catalog_revisions', {
  id: id(),
  ...placeColumns(),
  channelId: uuid('channel_id'),
  entryId: uuid('entry_id').notNull(),
  revision: integer('revision').notNull(),
  kind: text('kind', { enum: CATALOG_KINDS }).notNull(),
  locale: text('locale'),
  value: jsonb('value').$type<CatalogValue>().notNull(),
  digest: text('digest').notNull(),
  status: text('status', { enum: ['proposed', 'published', 'revoked'] }).notNull().default('proposed'),
  validFrom: at('valid_from').notNull().defaultNow(),
  validUntil: at('valid_until'),
  createdByKind: text('created_by_kind', { enum: ['person', 'agent'] }).notNull(),
  createdById: uuid('created_by_id').notNull(),
  publishedBy: uuid('published_by').references(() => people.id),
  publishedAt: at('published_at'),
  revokedAt: at('revoked_at'),
  createdAt: createdAt(),
}, t => [
  unique('outbound_catalog_company_id').on(t.companyId, t.id),
  unique('outbound_catalog_revision').on(t.companyId, t.entryId, t.revision),
  ...inPlace('outbound_catalog', t),
  sameCompany('outbound_catalog_channel', t.companyId, t.channelId, outboundChannels),
  check('outbound_catalog_positive', sql`${t.revision} > 0`),
  check('outbound_catalog_kind', sql`${t.value} ->> 'kind' = ${t.kind}`),
  check('outbound_catalog_status', sql`${t.status} IN ('proposed', 'published', 'revoked')`),
  check('outbound_catalog_author', sql`${t.createdByKind} IN ('person', 'agent')`),
  check('outbound_catalog_published', sql`(${t.status} = 'proposed') = (${t.publishedBy} IS NULL) AND (${t.publishedBy} IS NULL) = (${t.publishedAt} IS NULL)`),
  check('outbound_catalog_revoked', sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`),
  check('outbound_catalog_validity', sql`${t.validUntil} IS NULL OR ${t.validUntil} > ${t.validFrom}`),
  isDigest('outbound_catalog_digest', t.digest),
]);

/* One row for one address in one company, whichever department met it, so that no copy escapes a refusal. Departments reach
   it through permissions of their channels. Its address stays sealed. A refusal is for good. */
export const outboundContacts = pgTable('outbound_contacts', {
  id: id(),
  companyId: companyId(),
  kind: text('kind', { enum: ['email', 'direct'] }).notNull(),
  addressEnc: text('address_enc').notNull(),
  addressHash: text('address_hash').notNull(),
  doNotContact: boolean('do_not_contact').notNull().default(false),
  suppressedAt: at('suppressed_at'),
  createdAt: createdAt(),
}, t => [
  unique('outbound_contacts_company_id').on(t.companyId, t.id),
  unique('outbound_contacts_address').on(t.companyId, t.kind, t.addressHash),
  check('outbound_contacts_kind', sql`${t.kind} IN ('email', 'direct')`),
  check('outbound_contacts_suppressed', sql`${t.doNotContact} = (${t.suppressedAt} IS NOT NULL)`),
  isDigest('outbound_contacts_hash', t.addressHash),
]);

/* A contact's permission for one purpose on one channel. Once taken away it does not come back: a new grant is a new row. */
export const outboundPermissions = pgTable('outbound_permissions', {
  id: id(),
  companyId: companyId(),
  contactId: uuid('contact_id').notNull(),
  channelId: uuid('channel_id').notNull(),
  purpose: text('purpose').notNull(),
  status: text('status', { enum: ['granted', 'revoked'] }).notNull().default('granted'),
  source: text('source').notNull(),
  evidenceDigest: text('evidence_digest').notNull(),
  grantedAt: at('granted_at').notNull().defaultNow(),
  revokedAt: at('revoked_at'),
}, t => [
  unique('outbound_permissions_company_id').on(t.companyId, t.id),
  uniqueIndex('outbound_permissions_active').on(t.contactId, t.channelId, t.purpose).where(sql`${t.status} = 'granted'`),
  sameCompany('outbound_permissions_contact', t.companyId, t.contactId, outboundContacts),
  sameCompany('outbound_permissions_channel', t.companyId, t.channelId, outboundChannels),
  check('outbound_permissions_status', sql`${t.status} IN ('granted', 'revoked')`),
  check('outbound_permissions_revoked', sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`),
  isDigest('outbound_permissions_evidence', t.evidenceDigest),
]);

/* What happened to a contact's permissions, in order and never rewritten. One event counts once. */
export const outboundContactEvents = pgTable('outbound_contact_events', {
  id: id(),
  companyId: companyId(),
  contactId: uuid('contact_id').notNull(),
  kind: text('kind', { enum: ['consent_granted', 'consent_revoked', 'unsubscribed', 'suppressed'] }).notNull(),
  dedupKey: text('dedup_key').notNull(),
  evidenceDigest: text('evidence_digest').notNull(),
  occurredAt: at('occurred_at').notNull(),
  createdAt: createdAt(),
}, t => [
  unique('outbound_contact_events_dedup').on(t.companyId, t.dedupKey),
  sameCompany('outbound_contact_events_contact', t.companyId, t.contactId, outboundContacts),
  check('outbound_contact_events_kind', sql`${t.kind} IN ('consent_granted', 'consent_revoked', 'unsubscribed', 'suppressed')`),
  isDigest('outbound_contact_events_evidence', t.evidenceDigest),
]);

/* A support question as it came in. Each change is the next revision, so a receipt names exactly what it was about. */
export const supportTickets = pgTable('support_tickets', {
  id: id(),
  ...placeColumns(),
  ticketId: uuid('ticket_id').notNull(),
  revision: integer('revision').notNull(),
  contactId: uuid('contact_id').notNull(),
  textEnc: text('text_enc').notNull(),
  digest: text('digest').notNull(),
  status: text('status', { enum: ['open', 'escalated', 'closed'] }).notNull().default('open'),
  externalRef: text('external_ref'),
  createdAt: createdAt(),
}, t => [
  unique('support_tickets_revision').on(t.companyId, t.ticketId, t.revision),
  ...inPlace('support_tickets', t),
  sameCompany('support_tickets_contact', t.companyId, t.contactId, outboundContacts),
  check('support_tickets_positive', sql`${t.revision} > 0`),
  check('support_tickets_status', sql`${t.status} IN ('open', 'escalated', 'closed')`),
  isDigest('support_tickets_digest', t.digest),
]);

/* A receipt of the server's classifier: its id is the classificationReceiptId. Only the server decides it, once. */
export const supportClassifications = pgTable('support_classifications', {
  id: id(),
  companyId: companyId(),
  ticketId: uuid('ticket_id').notNull(),
  ticketRevision: integer('ticket_revision').notNull(),
  ticketDigest: text('ticket_digest').notNull(),
  bindingDigest: text('binding_digest').notNull(),
  idempotencyKey: uuid('idempotency_key').notNull(),
  status: text('status', { enum: ['pending', 'ready', 'unavailable'] }).notNull().default('pending'),
  classId: text('class_id'),
  requiresHuman: boolean('requires_human'),
  reasonCodes: jsonb('reason_codes').$type<ReasonCode[]>().notNull().default([]),
  reviewer: jsonb('reviewer').$type<ModelIdentity>(),
  decidedAt: at('decided_at'),
  createdAt: createdAt(),
}, t => [
  unique('support_classifications_company_id').on(t.companyId, t.id),
  unique('support_classifications_once').on(t.companyId, t.ticketId, t.ticketRevision, t.bindingDigest),
  unique('support_classifications_idempotency').on(t.companyId, t.idempotencyKey),
  foreignKey({ name: 'support_classifications_ticket', columns: [t.companyId, t.ticketId, t.ticketRevision], foreignColumns: [supportTickets.companyId, supportTickets.ticketId, supportTickets.revision] }),
  check('support_classifications_status', sql`${t.status} IN ('pending', 'ready', 'unavailable')`),
  check('support_classifications_decision', sql`CASE ${t.status}
    WHEN 'pending' THEN ${t.classId} IS NULL AND ${t.requiresHuman} IS NULL AND ${t.reviewer} IS NULL AND ${t.decidedAt} IS NULL
    WHEN 'ready' THEN ${t.classId} IS NOT NULL AND ${t.requiresHuman} IS NOT NULL AND ${t.reviewer} IS NOT NULL AND ${t.decidedAt} IS NOT NULL
    ELSE ${t.classId} IS NULL AND ${t.requiresHuman} IS NULL AND ${t.decidedAt} IS NOT NULL END`),
  isDigest('support_classifications_ticket_digest', t.ticketDigest),
  isDigest('support_classifications_binding_digest', t.bindingDigest),
]);

/* One message of one author: to whom, from which account, and how far it got. Its bytes are in its revisions. What decided
   its admission never changes; a retry with the same key finds this row. Its sampling numbers stay with it when it is
   cancelled, so that nobody fishes for a number that is not reviewed. */
export const outboundMessages = pgTable('outbound_messages', {
  id: id(),
  ...placeColumns(),
  taskId: uuid('task_id').notNull().references(() => tasks.id),
  authorAgentId: uuid('author_agent_id').notNull().references(() => agents.id),
  authorJobId: uuid('author_job_id').references(() => jobs.id),
  idempotencyKey: uuid('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  channelId: uuid('channel_id').notNull(),
  accountId: uuid('account_id').notNull(),
  bindingGeneration: integer('binding_generation').notNull(),
  targetKind: text('target_kind', { enum: ['contact', 'audience', 'ticket'] }).notNull(),
  contactId: uuid('contact_id'),
  audienceEntryId: uuid('audience_entry_id'),
  ticketId: uuid('ticket_id'),
  ticketRevision: integer('ticket_revision'),
  classificationId: uuid('classification_id'),
  segmentId: uuid('segment_id'),
  samplingOrdinals: jsonb('sampling_ordinals').$type<Record<string, number>>().notNull().default({}),
  revision: integer('revision').notNull().default(1),
  status: text('status', { enum: MESSAGE_STATUSES }).notNull(),
  reasonCodes: jsonb('reason_codes').$type<GateCode[]>().notNull().default([]),
  scheduledAt: at('scheduled_at').notNull(),
  createdAt: createdAt(),
  updatedAt: at('updated_at').notNull().defaultNow(),
}, t => [
  unique('outbound_messages_company_id').on(t.companyId, t.id),
  unique('outbound_messages_idempotency').on(t.companyId, t.authorAgentId, t.idempotencyKey),
  index('outbound_messages_due').on(t.scheduledAt).where(sql`${t.status} = 'scheduled'`),
  index('outbound_messages_task').on(t.taskId),
  ...inPlace('outbound_messages', t),
  sameCompany('outbound_messages_channel', t.companyId, t.channelId, outboundChannels),
  sameCompany('outbound_messages_account', t.companyId, t.accountId, outboundAccounts),
  sameCompany('outbound_messages_contact', t.companyId, t.contactId, outboundContacts),
  sameCompany('outbound_messages_classification', t.companyId, t.classificationId, supportClassifications),
  foreignKey({ name: 'outbound_messages_binding', columns: [t.accountId, t.bindingGeneration], foreignColumns: [outboundBindings.accountId, outboundBindings.generation] }),
  foreignKey({ name: 'outbound_messages_ticket', columns: [t.companyId, t.ticketId, t.ticketRevision], foreignColumns: [supportTickets.companyId, supportTickets.ticketId, supportTickets.revision] }),
  check('outbound_messages_positive', sql`${t.revision} > 0`),
  check('outbound_messages_status', sql`${t.status} IN ('scheduled', 'waiting_checks', 'waiting_approval', 'rejected', 'reserved', 'sending', 'sent', 'definitely_failed', 'unknown', 'cancelled')`),
  check('outbound_messages_target', sql`CASE ${t.targetKind}
    WHEN 'contact' THEN ${t.contactId} IS NOT NULL AND ${t.segmentId} IS NOT NULL AND ${t.audienceEntryId} IS NULL AND ${t.ticketId} IS NULL AND ${t.ticketRevision} IS NULL AND ${t.classificationId} IS NULL
    WHEN 'audience' THEN ${t.audienceEntryId} IS NOT NULL AND ${t.segmentId} IS NOT NULL AND ${t.contactId} IS NULL AND ${t.ticketId} IS NULL AND ${t.ticketRevision} IS NULL AND ${t.classificationId} IS NULL
    WHEN 'ticket' THEN ${t.contactId} IS NOT NULL AND ${t.ticketId} IS NOT NULL AND ${t.ticketRevision} IS NOT NULL AND ${t.classificationId} IS NOT NULL AND ${t.segmentId} IS NULL AND ${t.audienceEntryId} IS NULL
    ELSE false END`),
  check('outbound_messages_rejected', sql`${t.status} <> 'rejected' OR jsonb_array_length(${t.reasonCodes}) > 0`),
  isDigest('outbound_messages_request', t.requestDigest),
]);

/* The exact bytes of one revision of a message, sealed, and what they were built from. Never changed: new bytes are the
   next revision, and an approval or an attempt of the old one stays about the old one. */
export const outboundMessageRevisions = pgTable('outbound_message_revisions', {
  id: id(),
  companyId: companyId(),
  messageId: uuid('message_id').notNull(),
  revision: integer('revision').notNull(),
  document: jsonb('document').$type<MessageDocument>().notNull(),
  contentDigest: text('content_digest').notNull(),
  sealedEnc: text('sealed_enc').notNull(),
  sourceRevisionsDigest: text('source_revisions_digest').notNull(),
  policyId: uuid('policy_id').notNull(),
  policyDigest: text('policy_digest').notNull(),
  createdAt: createdAt(),
}, t => [
  unique('outbound_message_revisions_number').on(t.messageId, t.revision),
  sameCompany('outbound_message_revisions_message', t.companyId, t.messageId, outboundMessages),
  sameCompany('outbound_message_revisions_policy', t.companyId, t.policyId, outboundPolicies),
  check('outbound_message_revisions_positive', sql`${t.revision} > 0`),
  isDigest('outbound_message_revisions_content', t.contentDigest),
  isDigest('outbound_message_revisions_sources', t.sourceRevisionsDigest),
  isDigest('outbound_message_revisions_policy_digest', t.policyDigest),
]);

/* What a person's answer is an answer to: exact bytes, or an exact approach. A plain request with a matching kind in its
   words is never enough, and a request that has no row here approves nothing. */
export const outboundApprovals = pgTable('outbound_approvals', {
  id: id(),
  companyId: companyId(),
  requestId: uuid('request_id').notNull(),
  kind: text('kind', { enum: ['message', 'approach'] }).notNull(),
  messageId: uuid('message_id'),
  messageRevision: integer('message_revision'),
  contentDigest: text('content_digest'),
  accountId: uuid('account_id'),
  bindingGeneration: integer('binding_generation'),
  channelId: uuid('channel_id'),
  templateId: uuid('template_id'),
  templateRevision: integer('template_revision'),
  segmentId: uuid('segment_id'),
  locale: text('locale'),
  policyDigest: text('policy_digest').notNull(),
  sourceRevisionsDigest: text('source_revisions_digest').notNull(),
  authorityFingerprint: text('authority_fingerprint').notNull(),
  createdAt: createdAt(),
}, t => [
  unique('outbound_approvals_request').on(t.requestId),
  sameCompany('outbound_approvals_of_request', t.companyId, t.requestId, requests),
  sameCompany('outbound_approvals_message', t.companyId, t.messageId, outboundMessages),
  sameCompany('outbound_approvals_account', t.companyId, t.accountId, outboundAccounts),
  sameCompany('outbound_approvals_channel', t.companyId, t.channelId, outboundChannels),
  foreignKey({ name: 'outbound_approvals_revision', columns: [t.messageId, t.messageRevision], foreignColumns: [outboundMessageRevisions.messageId, outboundMessageRevisions.revision] }),
  check('outbound_approvals_kind', sql`CASE ${t.kind}
    WHEN 'message' THEN ${t.messageId} IS NOT NULL AND ${t.messageRevision} IS NOT NULL AND ${t.contentDigest} IS NOT NULL AND ${t.accountId} IS NOT NULL AND ${t.bindingGeneration} IS NOT NULL AND ${t.channelId} IS NULL AND ${t.templateId} IS NULL AND ${t.templateRevision} IS NULL AND ${t.segmentId} IS NULL AND ${t.locale} IS NULL
    WHEN 'approach' THEN ${t.channelId} IS NOT NULL AND ${t.templateId} IS NOT NULL AND ${t.templateRevision} IS NOT NULL AND ${t.segmentId} IS NOT NULL AND ${t.locale} IS NOT NULL AND ${t.messageId} IS NULL AND ${t.messageRevision} IS NULL AND ${t.contentDigest} IS NULL AND ${t.accountId} IS NULL AND ${t.bindingGeneration} IS NULL
    ELSE false END`),
  isDigest('outbound_approvals_content', t.contentDigest),
  isDigest('outbound_approvals_policy', t.policyDigest),
  isDigest('outbound_approvals_sources', t.sourceRevisionsDigest),
  isDigest('outbound_approvals_authority', t.authorityFingerprint),
]);

/* What a fresh model said of one revision, built by the server from the call it really made. */
export const outboundReviewReceipts = pgTable('outbound_review_receipts', {
  id: id(),
  companyId: companyId(),
  messageId: uuid('message_id').notNull(),
  messageRevision: integer('message_revision').notNull(),
  checkId: uuid('check_id').notNull().references(() => modelChecks.id),
  bindingDigest: text('binding_digest').notNull(),
  subjectDigest: text('subject_digest').notNull(),
  reviewer: jsonb('reviewer').$type<ModelIdentity>().notNull(),
  result: jsonb('result').$type<CheckResult>().notNull(),
  createdAt: createdAt(),
}, t => [
  unique('outbound_review_receipts_once').on(t.messageId, t.messageRevision, t.bindingDigest),
  sameCompany('outbound_review_receipts_message', t.companyId, t.messageId, outboundMessages),
  foreignKey({ name: 'outbound_review_receipts_revision', columns: [t.messageId, t.messageRevision], foreignColumns: [outboundMessageRevisions.messageId, outboundMessageRevisions.revision] }),
  isDigest('outbound_review_receipts_binding', t.bindingDigest),
  isDigest('outbound_review_receipts_subject', t.subjectDigest),
]);

/* A day's count of one account or sender domain. Removing it would reset a limit, so it stays. */
export const outboundDailyUsage = pgTable('outbound_daily_usage', {
  id: id(),
  companyId: companyId(),
  scope: text('scope', { enum: ['account', 'domain'] }).notNull(),
  scopeKey: text('scope_key').notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  timezone: text('timezone').notNull(),
  limitVersion: integer('limit_version').notNull(),
  reserved: integer('reserved').notNull().default(0),
  accepted: integer('accepted').notNull().default(0),
  unknown: integer('unknown').notNull().default(0),
  definitelyFailed: integer('definitely_failed').notNull().default(0),
  createdAt: createdAt(),
}, t => [
  unique('outbound_daily_usage_company_id').on(t.companyId, t.id),
  unique('outbound_daily_usage_bucket').on(t.companyId, t.scope, t.scopeKey, t.day, t.timezone, t.limitVersion),
  check('outbound_daily_usage_scope', sql`${t.scope} IN ('account', 'domain')`),
  check('outbound_daily_usage_counts', sql`${t.reserved} >= 0 AND ${t.accepted} >= 0 AND ${t.unknown} >= 0 AND ${t.definitelyFailed} >= 0`),
]);

/* One try at sending one revision, tied to all the generations it was admitted under. While it may have had an effect there
   is no other of its message, and nothing else leaves its account: an unknown outcome keeps both closed until it is settled. */
export const outboundAttempts = pgTable('outbound_attempts', {
  id: id(),
  companyId: companyId(),
  messageId: uuid('message_id').notNull(),
  messageRevision: integer('message_revision').notNull(),
  accountId: uuid('account_id').notNull(),
  bindingGeneration: integer('binding_generation').notNull(),
  configGeneration: integer('config_generation').notNull(),
  channelGeneration: integer('channel_generation').notNull(),
  accountBucketId: uuid('account_bucket_id').notNull(),
  domainBucketId: uuid('domain_bucket_id').notNull(),
  status: text('status', { enum: ['reserved', 'sending', 'accepted', 'definitely_not_accepted', 'unknown'] }).notNull(),
  providerReceipt: text('provider_receipt'),
  safeCode: text('safe_code'),
  leaseId: uuid('lease_id'),
  leaseUntil: at('lease_until'),
  startedAt: at('started_at'),
  endedAt: at('ended_at'),
  createdAt: createdAt(),
}, t => [
  unique('outbound_attempts_company_id').on(t.companyId, t.id),
  uniqueIndex('outbound_attempts_one_of_message').on(t.messageId).where(sql`${t.status} <> 'definitely_not_accepted'`),
  uniqueIndex('outbound_attempts_one_of_account').on(t.companyId, t.accountId).where(sql`${t.status} IN ('sending', 'unknown')`),
  sameCompany('outbound_attempts_message', t.companyId, t.messageId, outboundMessages),
  sameCompany('outbound_attempts_account', t.companyId, t.accountId, outboundAccounts),
  sameCompany('outbound_attempts_account_bucket', t.companyId, t.accountBucketId, outboundDailyUsage),
  sameCompany('outbound_attempts_domain_bucket', t.companyId, t.domainBucketId, outboundDailyUsage),
  foreignKey({ name: 'outbound_attempts_revision', columns: [t.messageId, t.messageRevision], foreignColumns: [outboundMessageRevisions.messageId, outboundMessageRevisions.revision] }),
  foreignKey({ name: 'outbound_attempts_binding', columns: [t.accountId, t.bindingGeneration], foreignColumns: [outboundBindings.accountId, outboundBindings.generation] }),
  check('outbound_attempts_status', sql`${t.status} IN ('reserved', 'sending', 'accepted', 'definitely_not_accepted', 'unknown')`),
  check('outbound_attempts_outcome', sql`CASE ${t.status}
    WHEN 'accepted' THEN ${t.providerReceipt} IS NOT NULL AND ${t.safeCode} IS NULL AND ${t.endedAt} IS NOT NULL
    WHEN 'definitely_not_accepted' THEN ${t.safeCode} IS NOT NULL AND ${t.providerReceipt} IS NULL AND ${t.endedAt} IS NOT NULL
    WHEN 'unknown' THEN ${t.safeCode} IS NOT NULL AND ${t.providerReceipt} IS NULL AND ${t.endedAt} IS NOT NULL
    ELSE ${t.safeCode} IS NULL AND ${t.providerReceipt} IS NULL AND ${t.endedAt} IS NULL END`),
]);

/* What a provider said later: delivered, bounced, refused, complained. One event of one source counts once. */
export const outboundEvents = pgTable('outbound_events', {
  id: id(),
  companyId: companyId(),
  attemptId: uuid('attempt_id'),
  kind: text('kind', { enum: ['delivered', 'bounce', 'refusal', 'complaint'] }).notNull(),
  source: text('source').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  occurredAt: at('occurred_at').notNull(),
  createdAt: createdAt(),
}, t => [
  unique('outbound_events_once').on(t.companyId, t.source, t.providerEventId),
  sameCompany('outbound_events_attempt', t.companyId, t.attemptId, outboundAttempts),
  check('outbound_events_kind', sql`${t.kind} IN ('delivered', 'bounce', 'refusal', 'complaint')`),
]);

/* What was set up for a department's messages, and by whom: a person, or the department's head carrying out that person's
   word. The owner reads it; it holds no setting, address or secret, only what changed and the ids it changed. */
export const OUTBOUND_SETUP_KINDS = ['channel_created', 'policy_set', 'auto_send_on', 'auto_send_off', 'channel_stopped', 'channel_reopened', 'catalog_published', 'catalog_revoked', 'account_set_up', 'account_rotated', 'account_revoked', 'account_bound', 'account_released'] as const;
export type OutboundSetupKind = (typeof OUTBOUND_SETUP_KINDS)[number];
export const outboundSetupEvents = pgTable('outbound_setup_events', {
  id: id(),
  companyId: companyId(),
  departmentId: uuid('department_id').notNull(),
  channelId: uuid('channel_id'),
  kind: text('kind', { enum: OUTBOUND_SETUP_KINDS }).notNull(),
  subjectId: uuid('subject_id'),
  detail: jsonb('detail').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  personId: uuid('person_id').notNull().references(() => people.id),
  agentId: uuid('agent_id').references(() => agents.id),
  createdAt: createdAt(),
}, t => [
  index('outbound_setup_events_department').on(t.companyId, t.departmentId, t.createdAt),
  sameCompany('outbound_setup_events_place', t.companyId, t.departmentId, departments),
  sameCompany('outbound_setup_events_channel', t.companyId, t.channelId, outboundChannels),
  check('outbound_setup_events_kind', sql`${t.kind} IN (${sql.raw(OUTBOUND_SETUP_KINDS.map(k => `'${k}'`).join(', '))})`),
]);

/* The numbers sampling goes by: one counter of a channel, of a segment or of an author. It only goes on, whatever is
   retried or cancelled, so that a number nobody reviews cannot be fished for. */
export const outboundSamplingCounters = pgTable('outbound_sampling_counters', {
  id: id(),
  companyId: companyId(),
  channelId: uuid('channel_id').notNull(),
  scope: text('scope', { enum: ['channel', 'segment', 'author'] }).notNull(),
  scopeKey: text('scope_key').notNull(),
  next: integer('next').notNull().default(1),
  cleanOutcomes: integer('clean_outcomes').notNull().default(0),
  createdAt: createdAt(),
}, t => [
  unique('outbound_sampling_counters_scope').on(t.companyId, t.channelId, t.scope, t.scopeKey),
  sameCompany('outbound_sampling_counters_channel', t.companyId, t.channelId, outboundChannels),
  check('outbound_sampling_counters_kind', sql`${t.scope} IN ('channel', 'segment', 'author')`),
  check('outbound_sampling_counters_values', sql`${t.next} > 0 AND ${t.cleanOutcomes} >= 0`),
]);

/* A binding proved by a finished run. At most one is active for a check, and once it ended it stays ended. */
export const modelCheckCertificates = pgTable('model_check_certificates', {
  id: id(),
  checkId: uuid('check_id').notNull().references(() => modelChecks.id, { onDelete: 'cascade' }),
  bindingDigest: text('binding_digest').notNull(),
  reportId: uuid('report_id').notNull(),
  evaluatedAt: at('evaluated_at').notNull(),
  validUntil: at('valid_until').notNull(),
  status: text('status', { enum: ['active', 'invalidated'] }).notNull().default('active'),
  invalidatedReason: text('invalidated_reason', { enum: INVALIDATION_CODES }),
  invalidatedAt: at('invalidated_at'),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('model_check_certificates_one_active').on(t.checkId).where(sql`${t.status} = 'active'`),
  foreignKey({ name: 'model_check_certificates_report', columns: [t.reportId], foreignColumns: [modelCheckEvaluations.id] }).onDelete('cascade'),
  check('model_check_certificates_status', sql`${t.status} IN ('active', 'invalidated')`),
  check('model_check_certificates_validity', sql`${t.validUntil} > ${t.evaluatedAt}`),
  check('model_check_certificates_end', sql`(${t.status} = 'invalidated') = (${t.invalidatedReason} IS NOT NULL) AND (${t.status} = 'invalidated') = (${t.invalidatedAt} IS NOT NULL)`),
  isDigest('model_check_certificates_binding', t.bindingDigest),
]);

/* The certificate of the company's public link, which ends TLS on this machine, and the ACME account it comes from. The
   private keys are kept only as encryptSecret gives them, like the link's own key. The mode is kept here so a restart
   writes the same tunnel settings and the link does not blink. */
export const linkTls = pgTable('link_tls', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companies.id),
  /* The CA the account is at. */
  directory: text('directory').notNull(),
  accountKeyEnc: text('account_key_enc').notNull(),
  accountUrl: text('account_url'),
  /* The link name the certificate is for. */
  name: text('name'),
  /* The chain. */
  certPem: text('cert_pem'),
  /* The CA the certificate came from. */
  certDirectory: text('cert_directory'),
  certKeyEnc: text('cert_key_enc'),
  notAfter: timestamp('not_after', { withTimezone: true }),
  renewAt: timestamp('renew_at', { withTimezone: true }),
  /* When to ask the CA's renewal information again. */
  askAt: timestamp('ask_at', { withTimezone: true }),
  /* No order before this, after a failure. */
  nextTryAt: timestamp('next_try_at', { withTimezone: true }),
  /* The last failure's AcmeError type, else its kind; null after a success. */
  failure: text('failure'),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  mode: text('mode', { enum: ['http', 'https'] }).notNull().default('http'),
  /* No switch to https before this. */
  httpsBlockedUntil: timestamp('https_blocked_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* Where a change came from: a step of a node message, of a page's request or of a tool call, written in the change's own
   transaction, so a retry finds its source listed. The base is the source without its step. */
export const applied = pgTable(
  'applied',
  {
    source: text('source').primaryKey(),
    base: text('base'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('applied_base').on(t.base), index('applied_at').on(t.at)],
);

/* A tool call by its invocation id, with the answer it gave, so a call sent again after a lost answer gets that answer
   and never a second run. */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    answer: jsonb('answer'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('tool_calls_at').on(t.at)],
);

/* The company's own certificate authority, made once by the app that leads. Its key is kept sealed with the server's
   secret, as the link's key is, and only the leading app signs with it. The three tables below keep their rows to their
   owner, whatever a role is granted. */
export const authority = pgTable('authority', {
  singleton: boolean('singleton').primaryKey().default(true),
  certPem: text('cert_pem').notNull(),
  keyEnc: text('key_enc').notNull(),
  createdAt: createdAt(),
}).enableRLS();

/* Every certificate the authority issued, until it expires, so that all of a machine's can be revoked. */
export const certificates = pgTable('certificates', {
  /* Lowercase hex. */
  serial: text('serial').primaryKey(),
  machineId: uuid('machine_id')
    .notNull()
    .references(() => machines.id),
  until: timestamp('until', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}).enableRLS();

/* visit: the relay's key for a visitor of the link, with the link's name, as JSON. */
export const PEER_SECRET_KINDS = ['data', 'app', 'visit'] as const;

/* The secrets of the two services a machine offers its peers through the relay, sealed with the server's secret. */
export const peerSecrets = pgTable(
  'peer_secrets',
  {
    kind: text('kind', { enum: PEER_SECRET_KINDS }).primaryKey(),
    secretEnc: text('secret_enc').notNull(),
    createdAt: createdAt(),
  },
  () => [check('peer_secrets_kind', sql`kind IN ('data', 'app', 'visit')`)],
).enableRLS();

/* A ticket a joining machine's keeper redeems once for its first certificate. Only its hash is kept. */
export const machineTickets = pgTable('machine_tickets', {
  ticketHash: text('ticket_hash').primaryKey(),
  machineId: uuid('machine_id')
    .notNull()
    .references(() => machines.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
}).enableRLS();

/* How long a machine was online on each day, in UTC, by its keeper's reports. */
export const machineOnline = pgTable(
  'machine_online',
  {
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    day: date('day', { mode: 'string' }).notNull(),
    seconds: integer('seconds').notNull().default(0),
  },
  t => [primaryKey({ columns: [t.machineId, t.day] }), check('machine_online_seconds', sql`seconds BETWEEN 0 AND 86400`)],
).enableRLS();

/* Each person's own key, made in their browser. The server keeps the public half, and the private half only wrapped by a
   key made from the person's password, which the server never keeps. */
export const personKeys = pgTable(
  'person_keys',
  {
    personId: uuid('person_id')
      .primaryKey()
      .references(() => people.id),
    companyId: companyId(),
    /* SPKI DER, base64url. */
    publicKey: text('public_key').notNull(),
    wrapped: text('wrapped').notNull(),
    salt: text('salt').notNull(),
    iv: text('iv').notNull(),
    iterations: integer('iterations').notNull(),
    createdAt: createdAt(),
  },
  () => [check('person_keys_iterations', sql`iterations >= 600000`)],
).enableRLS();

/* Computer access to one machine of the company: open while `until` is ahead, what the orchestrator asked it for, who
   opened it, and the grant its owner signed, which the machine's keeper checks against the key it holds. */
export const machineAccess = pgTable(
  'machine_access',
  {
    machineId: uuid('machine_id')
      .primaryKey()
      .references(() => machines.id),
    companyId: companyId(),
    until: timestamp('until', { withTimezone: true }),
    askedReason: text('asked_reason'),
    askedAt: timestamp('asked_at', { withTimezone: true }),
    openedBy: uuid('opened_by').references(() => people.id),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    grant: jsonb('grant').$type<{ payload: string; signature: string }>(),
  },
  () => [check('machine_access_asked', sql`(asked_reason IS NULL) = (asked_at IS NULL)`)],
).enableRLS();

/* The public halves of the recovery keys the CEO saved, newest last. The private half exists only in the file the CEO
   keeps. linkPrint, linkName, linkUrl: the public link it was saved with, which a bundle names so a machine that
   survived a total loss finds the new server by it; none when saved without a link. */
export const recoveryKeys = pgTable('recovery_keys', {
  id: id(),
  companyId: companyId(),
  recipient: text('recipient').notNull().unique(),
  linkPrint: text('link_print'),
  linkName: text('link_name'),
  linkUrl: text('link_url'),
  madeBy: uuid('made_by')
    .notNull()
    .references(() => people.id),
  madeAt: createdAt(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}).enableRLS();

/* waiting: its machine's keeper has not taken it; sent: the keeper took it; lost: the keeper no longer holds it and gave
   no answer, so what it did is not known. */
export const RUN_STATES = ['waiting', 'sent', 'done', 'lost'] as const;
export type RunState = (typeof RUN_STATES)[number];

/* The commands the orchestrator runs on a machine while its access is open, and their answers. */
export const computerRuns = pgTable(
  'computer_runs',
  {
    id: id(),
    companyId: companyId(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id),
    jobId: uuid('job_id').references(() => jobs.id),
    agentId: uuid('agent_id').references(() => agents.id),
    command: text('command').notNull(),
    timeoutS: integer('timeout_s').notNull(),
    state: text('state', { enum: RUN_STATES }).notNull().default('waiting'),
    exit: integer('exit'),
    /* The end of what it printed. */
    output: text('output'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  t => [
    index('computer_runs_machine_state').on(t.machineId, t.state),
    check('computer_runs_state', sql`state IN ('waiting', 'sent', 'done', 'lost')`),
    check('computer_runs_timeout', sql`timeout_s BETWEEN 1 AND 1800`),
  ],
).enableRLS();

/* Each exact commit Hornhoof let go to main without a card while the CEO had autonomous release on: who asked for it,
   the full commit SHA, the main SHA it was fast-forward from, the full test run and the independent PASS verdict. */
export const autonomousReleases = pgTable('autonomous_releases', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  departmentId: uuid('department_id').references(() => departments.id, { onDelete: 'set null' }),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  taskNumber: integer('task_number').notNull(),
  agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  agentName: text('agent_name').notNull(),
  commitSha: text('commit_sha').notNull(),
  baseCommitSha: text('base_commit_sha').notNull(),
  testRunId: uuid('test_run_id').references(() => testRuns.id, { onDelete: 'set null' }),
  testRunNumber: integer('test_run_number').notNull(),
  reviewerAgentId: uuid('reviewer_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  reviewerName: text('reviewer_name').notNull(),
  verdictEventId: bigint('verdict_event_id', { mode: 'number' }).references(() => taskEvents.id, { onDelete: 'set null' }),
  verdictStage: text('verdict_stage').notNull(),
  createdAt: createdAt(),
}, t => [
  index('autonomous_releases_company_created').on(t.companyId, t.createdAt),
  index('autonomous_releases_company_commit').on(t.companyId, t.commitSha),
  check('autonomous_releases_commit_sha', sql`${t.commitSha} ~ '^[0-9a-f]{40}$'`),
  check('autonomous_releases_base_commit_sha', sql`${t.baseCommitSha} ~ '^[0-9a-f]{40}$'`),
]);

/* The company's vault of site sign-ins. A person types them into Hornhoof's form, or gives them to an agent that saves
   them; the password and the code secret are kept encrypted with the server's key, and every agent of the company takes
   them as text to sign in. Who added an entry is a person or an agent. */
export const vaultEntries = pgTable('vault_entries', {
  id: id(),
  companyId: companyId(),
  name: text('name').notNull(),
  site: text('site').notNull(),
  login: text('login').notNull(),
  passwordEnc: text('password_enc').notNull(),
  /* The one-time code's secret, digits, period and algorithm, as JSON; none when the site asks for no code. */
  totpEnc: text('totp_enc'),
  createdBy: uuid('created_by').references(() => people.id),
  createdByAgent: uuid('created_by_agent').references(() => agents.id),
  createdAt: createdAt(),
}, t => [uniqueIndex('vault_entries_company_name').on(t.companyId, sql`lower(${t.name})`)]);

/* Who added, changed, removed or took which entry, when, and for which task; never a value. The name and site stay as they
   were, so the log still reads after the entry is gone. */
const VAULT_LOG_KINDS = ['created', 'changed', 'removed', 'taken'] as const;
export const vaultLog = pgTable('vault_log', {
  id: id(),
  companyId: companyId(),
  entryId: uuid('entry_id').references(() => vaultEntries.id, { onDelete: 'set null' }),
  entryName: text('entry_name').notNull(),
  site: text('site').notNull(),
  kind: text('kind', { enum: VAULT_LOG_KINDS }).notNull(),
  personId: uuid('person_id').references(() => people.id),
  agentId: uuid('agent_id').references(() => agents.id),
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  at: createdAt(),
}, t => [index('vault_log_entry_at').on(t.entryId, t.at), index('vault_log_company_at').on(t.companyId, t.at)]);
