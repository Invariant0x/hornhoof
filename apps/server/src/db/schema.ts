import { TEMPLATE_KEYS, type Limits } from '@hornhoof/protocol';
import { bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const companyId = () => uuid('company_id').notNull().references(() => companies.id);

/* One deployment serves one company: the unique singleton column makes a second row impossible. */
export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  /* What the orchestrator learned about the company, saved when the CEO creates the structure. */
  brief: text('brief').notNull().default(''),
  singleton: boolean('singleton').notNull().default(true).unique(),
  createdAt: createdAt(),
});

export const SCOPE_KINDS = ['company', 'department', 'team'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const people = pgTable(
  'people',
  {
    id: id(),
    companyId: companyId(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    title: text('title').notNull().default(''),
    passwordHash: text('password_hash'),
    status: text('status', { enum: ['active', 'invited', 'disabled'] }).notNull(),
    scopeKind: text('scope_kind', { enum: SCOPE_KINDS }).notNull(),
    scopeId: uuid('scope_id'),
    isOwner: boolean('is_owner').notNull().default(false),
    createdAt: createdAt(),
  },
  t => [index('people_company_id').on(t.companyId)],
);

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    personId: uuid('person_id').notNull().references(() => people.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  t => [index('sessions_person_id').on(t.personId)],
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
  parentId: uuid('parent_id').references((): AnyPgColumn => departments.id),
  about: text('about').notNull().default(''),
  roleCode: text('role_code').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
});

export const teams = pgTable('teams', {
  id: id(),
  companyId: companyId(),
  departmentId: uuid('department_id').notNull().references(() => departments.id),
  name: text('name').notNull(),
  about: text('about').notNull().default(''),
  stage: integer('stage').notNull().default(0),
  gate: boolean('gate').notNull().default(false),
  createdAt: createdAt(),
});

export const PROVIDERS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const TARGET_KINDS = ['orchestrator', 'department', 'team', 'any'] as const;

/* A computer a person ran the installer on. One per person and machine key, so running it again reuses the row. */
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
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  t => [unique('machines_person_key').on(t.personId, t.machineKey)],
);

/* A one-time code inside an install command. Only its hash is stored. */
export const nodeCodes = pgTable('node_codes', {
  codeHash: text('code_hash').primaryKey(),
  companyId: companyId(),
  personId: uuid('person_id').notNull().references(() => people.id),
  subscriptionIds: uuid('subscription_ids').array().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const SUBSCRIPTION_STATUSES = ['waiting_machine', 'needs_login', 'ready'] as const;

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
    status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull(),
    /* Only API keys have a target. A personal subscription serves wherever its owner works. */
    targetKind: text('target_kind', { enum: TARGET_KINDS }),
    targetId: uuid('target_id'),
    machineId: uuid('machine_id').references(() => machines.id),
    nodeKeyHash: text('node_key_hash').unique(),
    nodeVersion: text('node_version'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    limits: jsonb('limits').$type<Limits>(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  t => [index('subscriptions_owner_person_id').on(t.ownerPersonId)],
);

export const agents = pgTable('agents', {
  id: id(),
  companyId: companyId(),
  kind: text('kind', { enum: ['orchestrator', 'head', 'worker'] }).notNull(),
  name: text('name').notNull(),
  model: text('model').notNull(),
  departmentId: uuid('department_id').references(() => departments.id),
  teamId: uuid('team_id').references(() => teams.id),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
  createdAt: createdAt(),
});

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export const JOB_KINDS = ['test', 'conversation'] as const;

/* One prompt sent to one subscription's node. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
    agentId: uuid('agent_id').references(() => agents.id),
    prompt: text('prompt').notNull(),
    sessionId: text('session_id'),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('queued'),
    result: text('result'),
    tail: text('tail').notNull().default(''),
    error: text('error'),
    timeoutMs: integer('timeout_ms').notNull(),
    kind: text('kind', { enum: JOB_KINDS }).notNull().default('test'),
    /* The job's Hornhoof tools present this token; it works only while the job runs. */
    toolTokenHash: text('tool_token_hash').unique(),
    createdBy: uuid('created_by').references(() => people.id),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  t => [index('jobs_subscription_id').on(t.subscriptionId)],
);

export const AGENT_EVENT_KINDS = ['message', 'text', 'tool', 'tool_result', 'todo', 'proposal', 'applied', 'stopped', 'failed'] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/* An agent's conversation as people see it: their messages, what the agent did, and what came of it. */
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
  t => [index('agent_events_agent_id_seq').on(t.agentId, t.seq)],
);

export const proposals = pgTable('proposals', {
  id: id(),
  companyId: companyId(),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  jobId: uuid('job_id').references(() => jobs.id),
  brief: text('brief').notNull().default(''),
  items: jsonb('items').notNull(),
  status: text('status', { enum: ['pending', 'applied', 'dismissed'] }).notNull().default('pending'),
  appliedBy: uuid('applied_by').references(() => people.id),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: createdAt(),
});
