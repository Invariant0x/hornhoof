import { TEMPLATE_KEYS, type Limits, type ModelOption } from '@hornhoof/protocol';
import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

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

/* company: the person reaches the whole company. listed: the departments and teams in person_access. */
export const SCOPE_KINDS = ['company', 'listed'] as const;
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
  /* The git repository its agents work in: https only; the token is stored encrypted and shown by its last 4 characters. */
  repoUrl: text('repo_url'),
  repoBranch: text('repo_branch'),
  repoTokenEnc: text('repo_token_enc'),
  repoTokenLast4: text('repo_token_last4'),
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
    /* The models its node says it can run; null until a node reports them. */
    models: jsonb('models').$type<ModelOption[]>(),
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
  /* The role template it was hired from, its enabled skills, its own text over the template's, and the template
     hashes it was hired with, so the card can say a template moved on. */
  roleKey: text('role_key'),
  skills: jsonb('skills').$type<string[]>().notNull().default([]),
  overrides: jsonb('overrides').$type<AgentOverrides>().notNull().default({}),
  templateHashes: jsonb('template_hashes').$type<Record<string, string>>().notNull().default({}),
  /* A product department the employee works for, inside its department. */
  productId: uuid('product_id').references((): AnyPgColumn => departments.id),
  createdBy: uuid('created_by').references(() => people.id),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type AgentOverrides = { base?: string; skills?: Record<string, string> };

export const AGENT_CHANGE_FIELDS = ['name', 'model', 'subscription', 'skills', 'prompt', 'reset', 'hired', 'removed'] as const;

/* Every change to an employee's card: who, when, what, before and after. */
export const agentChanges = pgTable(
  'agent_changes',
  {
    id: id(),
    companyId: companyId(),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    personId: uuid('person_id').references(() => people.id),
    field: text('field', { enum: AGENT_CHANGE_FIELDS }).notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  t => [index('agent_changes_agent_id').on(t.agentId)],
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
    /* The hash of the instructions it ran with; a change starts a fresh session. */
    instructionsHash: text('instructions_hash'),
    createdBy: uuid('created_by').references(() => people.id),
    /* The task a turn works on, when a task woke the agent. */
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  t => [index('jobs_subscription_id').on(t.subscriptionId), index('jobs_task_id').on(t.taskId)],
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
  /* structure: departments for the company; staff: employees for one department. */
  kind: text('kind', { enum: ['structure', 'staff'] }).notNull().default('structure'),
  departmentId: uuid('department_id').references(() => departments.id),
  status: text('status', { enum: ['pending', 'applied', 'dismissed'] }).notNull().default('pending'),
  appliedBy: uuid('applied_by').references(() => people.id),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/* A company-wide cycle the CEO starts with a goal; one is open at a time. */
export const turns = pgTable(
  'turns',
  {
    id: id(),
    companyId: companyId(),
    number: integer('number').notNull(),
    goal: text('goal').notNull(),
    status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
    /* The orchestrator's task for the turn. */
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    startedBy: uuid('started_by').notNull().references(() => people.id),
    closedBy: uuid('closed_by').references(() => people.id),
    createdAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  t => [unique('turns_company_number').on(t.companyId, t.number), uniqueIndex('turns_one_open').on(t.companyId).where(sql`status = 'open'`)],
);

export const TASK_STATUSES = ['open', 'working', 'review', 'waiting', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/* A piece of work: the title and brief for people, the body every agent reads as the current truth, and its gates. */
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
    /* Who holds the task now: the executor, the gate at its stage, or the head or orchestrator that owns it. */
    assigneeAgentId: uuid('assignee_agent_id').references(() => agents.id),
    /* A member task's executor; its gates are employees in order and stage 0 is the executor's turn. */
    executorAgentId: uuid('executor_agent_id').references(() => agents.id),
    gates: jsonb('gates').$type<string[]>().notNull().default([]),
    stage: integer('stage').notNull().default(0),
    bounces: integer('bounces').notNull().default(0),
    /* Task turns in a row that ended without moving the task. */
    silent: integer('silent').notNull().default(0),
    /* Grows with every move, so two moves that read the same task cannot both land. */
    version: integer('version').notNull().default(0),
    createdByPersonId: uuid('created_by_person_id').references(() => people.id),
    createdByAgentId: uuid('created_by_agent_id').references(() => agents.id),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  t => [unique('tasks_company_number').on(t.companyId, t.number), index('tasks_department_id').on(t.departmentId), index('tasks_assignee').on(t.assigneeAgentId), index('tasks_parent_id').on(t.parentId)],
);

export const TASK_EVENT_KINDS = ['created', 'assigned', 'updated', 'comment', 'submitted', 'verdict', 'report', 'blocked', 'asked', 'answered', 'reminded', 'stuck', 'cancelled', 'done'] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/* Everything that happened to a task, with the person or agent who did it. */
export const taskEvents = pgTable(
  'task_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
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

export const REQUEST_KINDS = ['question', 'approval', 'stuck'] as const;
export const REQUEST_STATUSES = ['open', 'answered', 'approved', 'declined', 'withdrawn'] as const;

/* What an agent waits for from a person: an answer, an approval of an exact commit, or help with a stuck task. */
export const requests = pgTable(
  'requests',
  {
    id: id(),
    companyId: companyId(),
    taskId: uuid('task_id').notNull().references(() => tasks.id),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    kind: text('kind', { enum: REQUEST_KINDS }).notNull(),
    text: text('text').notNull(),
    commit: text('commit'),
    status: text('status', { enum: REQUEST_STATUSES }).notNull().default('open'),
    answer: text('answer'),
    answeredBy: uuid('answered_by').references(() => people.id),
    createdAt: createdAt(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  t => [index('requests_task_id').on(t.taskId)],
);
