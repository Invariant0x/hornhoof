import { COMPANY_TEMPLATE_KEYS, CRED_KINDS, MACHINE_KINDS, RUN_KINDS, TEMPLATE_KEYS, type Account, type Boot, type Limits, type ModelOption } from '@hornhoof/protocol';
import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const companyId = () => uuid('company_id').notNull().references(() => companies.id);
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });

/* One deployment serves one company: the unique singleton column makes a second row impossible. */
export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  /* What the orchestrator learned about the company, saved when the CEO creates the structure. */
  brief: text('brief').notNull().default(''),
  /* The ready-made template the CEO started from, so the orchestrator's greeting can offer to staff it. Null when the CEO started empty. */
  template: text('template', { enum: COMPANY_TEMPLATE_KEYS }),
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
  /* Who the agents' commits are by; without one each agent's program sets its own. */
  repoAuthorName: text('repo_author_name'),
  repoAuthorEmail: text('repo_author_email'),
  /* The free memory, in GB, a machine needs to take one of the repository's test runs; none takes the default. */
  repoTestMemoryGb: integer('repo_test_memory_gb'),
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

export const PROVIDERS = ['claude', 'codex', 'kimi', 'glm', 'anthropic_api', 'openai_api', 'antigravity'] as const;
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
    /* Only a computer takes parts of runs, which are shell commands. */
    kind: text('kind', { enum: MACHINE_KINDS }).notNull().default('computer'),
    /* Lends itself to the company's test runs; its owner, or someone who sees the whole company, can take it back. */
    lendsTests: boolean('lends_tests').notNull().default(true),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  t => [unique('machines_person_key').on(t.personId, t.machineKey)],
);

/* A one-time code inside an install command. Only its hash is stored. No subscriptions: the machine joins alone. A code
   made for one machine works only there. */
export const nodeCodes = pgTable('node_codes', {
  codeHash: text('code_hash').primaryKey(),
  companyId: companyId(),
  personId: uuid('person_id').notNull().references(() => people.id),
  subscriptionIds: uuid('subscription_ids').array().notNull(),
  machineId: uuid('machine_id').references(() => machines.id),
  /* The command, sealed, when the orchestrator asked for it: only the CEO's screen shows it, until the CEO closes it. */
  commandEnc: text('command_enc'),
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
    /* A plan's, over its nodes: waiting for a machine while it has none, ready while one is signed in, needs a sign-in
       otherwise. */
    status: text('status', { enum: SUBSCRIPTION_STATUSES }).notNull(),
    /* Only API keys have a target. A personal subscription serves wherever its owner works. */
    targetKind: text('target_kind', { enum: TARGET_KINDS }),
    targetId: uuid('target_id'),
    /* The same on every machine the plan runs on. */
    limits: jsonb('limits').$type<Limits>(),
    /* The share of each limit window, in percent, that task turns may use; past it they wait for the window to start
       over while people's own messages still go. Null: the whole limit. */
    budget: integer('budget'),
    /* The models its node says it can run; null until a node reports them. */
    models: jsonb('models').$type<ModelOption[]>(),
    /* Counts the plan's sign-ins: each new one is sealed to its nodes under a higher number, and older ones are dropped. */
    credVersion: integer('cred_version').notNull().default(0),
    /* Codex runs on one machine at a time, as its sign-in renews itself: the node that holds it now. */
    leaseNodeId: uuid('lease_node_id').references((): AnyPgColumn => nodes.id),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  t => [index('subscriptions_owner_person_id').on(t.ownerPersonId)],
);

export const NODE_STATUSES = ['needs_login', 'ready'] as const;

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
    boot: jsonb('boot').$type<Boot>(),
    createdAt: createdAt(),
  },
  t => [unique('nodes_machine_plan').on(t.machineId, t.subscriptionId).nullsNotDistinct(), index('nodes_subscription_id').on(t.subscriptionId)],
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
    kind: text('kind', { enum: ['orchestrator', 'head', 'worker'] }).notNull(),
    name: text('name').notNull(),
    model: text('model').notNull(),
    departmentId: uuid('department_id').references(() => departments.id),
    teamId: uuid('team_id').references(() => teams.id),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
    /* The node of its plan its program lives on, with its folder, session and terminal; it stays there while that node is
       ready. None on a company key, which runs on the built-in node, and before its first turn. */
    nodeId: uuid('node_id').references((): AnyPgColumn => nodes.id),
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
  ],
);

export type AgentOverrides = { base?: string; skills?: Record<string, string> };

export const AGENT_CHANGE_FIELDS = ['name', 'model', 'effort', 'timer', 'subscription', 'skills', 'prompt', 'reset', 'hired', 'removed', 'switch'] as const;

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
/* Why a node started again, as far as Hornhoof can tell from what it said before and now: Hornhoof updated it, the machine
   started again, its container was made anew, its program started again in the same container, or the connection broke
   and the turn never reached it. */
export const RESTART_CAUSES = ['update', 'machine', 'container', 'program', 'connection', 'unknown'] as const;
export type RestartCause = (typeof RESTART_CAUSES)[number];
/* A turn a node restart cut off: why, when Hornhoof learned it, on which node, and the number of the task it was on. */
export type Interruption = { cause: RestartCause; at: string; node: { id: string | null; name: string }; task: number | null; versions?: { from: string; to: string } };

/* One prompt sent to one subscription's node. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    companyId: companyId(),
    subscriptionId: uuid('subscription_id').notNull().references(() => subscriptions.id),
    /* The node it went out to; none for the built-in node's jobs, and while it waits. */
    nodeId: uuid('node_id').references(() => nodes.id),
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
    /* The turn carries a message of the company's owner, so the tools for people, access, money and the company's reach
       work in it. A turn an employee, a timer or a task woke does not. */
    answersCeo: boolean('answers_ceo').notNull().default(false),
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
  t => [index('jobs_subscription_id').on(t.subscriptionId), index('jobs_task_id').on(t.taskId), index('jobs_agent_id_status').on(t.agentId, t.status)],
);

/* computer: the orchestrator asked for the computer the server runs on, or the CEO opened, closed or declined it. */
export const AGENT_EVENT_KINDS = ['message', 'text', 'tool', 'tool_result', 'todo', 'proposal', 'applied', 'stopped', 'failed', 'computer'] as const;
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
  t => [index('agent_events_agent_id_seq').on(t.agentId, t.seq), index('agent_events_job_id').on(t.jobId)],
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
export const TURN_STATUSES = ['planned', 'open', 'closed'] as const;
/* id is the message's agent event; words kept before it was recorded have none. */
export type TurnMessage = { id?: string; by: string; text: string; at: string };

export const turns = pgTable(
  'turns',
  {
    id: id(),
    companyId: companyId(),
    number: integer('number').notNull(),
    /* A short name and the main point in a line or two. */
    title: text('title').notNull().default(''),
    goal: text('goal').notNull(),
    /* Planned turns wait in number order; the lowest opens when the open one closes. */
    status: text('status', { enum: TURN_STATUSES }).notNull().default('open'),
    /* The people's own words the turn was laid out from, as they wrote them. */
    messages: jsonb('messages').$type<TurnMessage[]>().notNull().default([]),
    /* The orchestrator's task for a turn started by a person, from before he laid turns out himself. */
    taskId: uuid('task_id').references((): AnyPgColumn => tasks.id),
    startedBy: uuid('started_by').references(() => people.id),
    createdByAgentId: uuid('created_by_agent_id').references((): AnyPgColumn => agents.id),
    closedBy: uuid('closed_by').references(() => people.id),
    createdAt: createdAt(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  t => [unique('turns_company_number').on(t.companyId, t.number), uniqueIndex('turns_one_open').on(t.companyId).where(sql`status = 'open'`)],
);

export const TASK_STATUSES = ['planned', 'open', 'working', 'review', 'waiting', 'blocked', 'done', 'cancelled'] as const;
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
    /* Everyone who checks the work at the current gate: each employee of its reviewer's role that is on. */
    panel: jsonb('panel').$type<string[]>().notNull().default([]),
    /* Tasks of the same turn that must be done first: until they are, the task waits and its holder is not woken. */
    after: jsonb('after').$type<string[]>().notNull().default([]),
    stage: integer('stage').notNull().default(0),
    /* It passed its last gate and its executor merges it into the turn's branch, at stage 0 again; handing that in closes it. */
    merging: boolean('merging').notNull().default(false),
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
  t => [
    unique('tasks_company_number').on(t.companyId, t.number),
    index('tasks_department_id').on(t.departmentId),
    index('tasks_assignee').on(t.assigneeAgentId),
    index('tasks_parent_id').on(t.parentId),
    /* What no move makes: a gate with no executor behind it, counts below zero, a closed task without its time, a task
       under itself, gates that are not lists. */
    check('tasks_review_has_executor', sql`${t.status} <> 'review' OR ${t.executorAgentId} IS NOT NULL`),
    check('tasks_counts', sql`${t.stage} >= 0 AND ${t.bounces} >= 0 AND ${t.silent} >= 0`),
    check('tasks_closed_at', sql`${t.status} NOT IN ('done', 'cancelled') OR ${t.closedAt} IS NOT NULL`),
    check('tasks_not_own_parent', sql`${t.parentId} IS NULL OR ${t.parentId} <> ${t.id}`),
    check('tasks_gates_lists', sql`jsonb_typeof(${t.gates}) = 'array' AND jsonb_typeof(${t.panel}) = 'array'`),
  ],
);

export const TASK_EVENT_KINDS = ['created', 'assigned', 'updated', 'comment', 'submitted', 'verdict', 'report', 'blocked', 'asked', 'answered', 'reminded', 'continued', 'stuck', 'cancelled', 'done', 'started', 'interrupted'] as const;
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
    /* The turn that gave it back and the task it gave back, kept off the line while that turn still runs. */
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
    why: text('why').notNull(),
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
export const REQUEST_STATUSES = ['open', 'answered', 'approved', 'declined', 'withdrawn'] as const;

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
    text: text('text').notNull(),
    commit: text('commit'),
    options: jsonb('options').$type<RequestOption[]>().notNull().default([]),
    link: text('link'),
    picked: integer('picked'),
    status: text('status', { enum: REQUEST_STATUSES }).notNull().default('open'),
    answer: text('answer'),
    answeredBy: uuid('answered_by').references(() => people.id),
    /* The orchestrator's words for people: what is needed from them, why, and the ways to go, in plain words. */
    explained: text('explained'),
    /* What it is about; none on requests from before topics, which go to the CEO. */
    decisionTopic: text('decision_topic', { enum: DECISION_TOPICS }),
    createdAt: createdAt(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  t => [index('requests_task_id').on(t.taskId), check('requests_approval_commit', sql`${t.kind} <> 'approval' OR ${t.commit} IS NOT NULL`)],
);

/* A picture an agent sent from its turn to show its work. People see it once a request of that agent shows it. Or a file
   an agent on a task put on it, of any kind, which every agent of the company downloads by its name. */
export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    companyId: companyId(),
    jobId: uuid('job_id').notNull().references(() => jobs.id),
    agentId: uuid('agent_id').notNull().references(() => agents.id),
    requestId: uuid('request_id').references(() => requests.id),
    /* The task a file was put on, and the file's name there; a picture has neither. */
    taskId: uuid('task_id').references(() => tasks.id),
    name: text('name'),
    mediaType: text('media_type').notNull(),
    bytes: bytea('bytes').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  t => [index('attachments_request_id').on(t.requestId), index('attachments_job_id').on(t.jobId), index('attachments_task_id').on(t.taskId)],
);

export const TEST_RUN_STATUSES = ['running', 'passed', 'failed', 'stopped'] as const;

/* A command an agent runs for a task on whichever machines of the company are free, in parts when it splits: the full
   test suite of a task's branch, or any other work, on a branch or in an empty folder with the task's files. The agent
   hears the result on its task, and each part's log, and what a part of work made, go on the task as files. */
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
    /* None: for tests the task's own branch, task-<number> or the one that starts with task-<number>-; for work no
       repository, an empty folder. */
    branch: text('branch'),
    command: text('command').notNull(),
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
  t => [unique('test_runs_company_number').on(t.companyId, t.number), index('test_runs_task_id').on(t.taskId)],
);

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
    status: text('status', { enum: TEST_PART_STATUSES }).notNull().default('queued'),
    nodeId: uuid('node_id').references(() => nodes.id),
    builtin: boolean('builtin').notNull().default(false),
    machineId: uuid('machine_id').references(() => machines.id),
    /* The machine's name as it ran, for the result. */
    machineName: text('machine_name'),
    /* Its assigned physical computer, kept through disconnects and server restarts. Null on older parts. */
    computer: text('computer'),
    /* The commit it tested, the command's exit code, and why it ended when that was not the tests themselves. */
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
  t => [unique('test_parts_run_part').on(t.runId, t.part), index('test_parts_status').on(t.status)],
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

/* open: waits for the CEO. taken: the CEO gave it to the orchestrator. done: the orchestrator did it. dismissed: the CEO
   set it aside. */
export const IMPROVEMENT_STATUSES = ['open', 'taken', 'done', 'dismissed'] as const;

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
    /* The person who took it into work or set it aside. */
    decidedBy: uuid('decided_by').references(() => people.id),
    /* The orchestrator's word on what came of it, or why it could not be done. */
    result: text('result'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('improvements_company_id_status').on(t.companyId, t.status)],
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
  createdAt: createdAt(),
});
