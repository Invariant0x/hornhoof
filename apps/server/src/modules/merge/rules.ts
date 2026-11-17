import { HIDDEN, SECRET } from '../../db/agent-sql.js';

/* Whose a conflict is. The first five are the CEO's: people, what they reach, the plans and the machines the company
   runs on, and protected, the records only a person's guarded route or one of Hornhoof's own gateways writes (what
   waits for people's decisions, the waits and their policies, the checks made by a model, the outbound gateway). Work
   is the orchestrator's. */
export type Topic = 'people' | 'access' | 'plans' | 'machines' | 'protected' | 'work';
export const CEO_TOPICS: readonly Topic[] = ['people', 'access', 'plans', 'machines', 'protected'];

export type TableRule = {
  /* rows: compared row by row, or by what the journal proves. add: added and never compared. log: matched by a column
     and added with a new sequence value. skip: never merged. */
  kind: 'rows' | 'add' | 'log' | 'skip';
  topic: Topic;
  /* log: the column rows are matched by. */
  match?: string;
  /* log: the column that takes the next value of its sequence on an added row. */
  sequence?: string;
  /* The scope columns of a per-scope number. */
  number?: readonly string[];
  /* The column naming the task a row belongs to. */
  task?: string;
  /* Tables planned before it besides its parents. */
  after?: readonly string[];
  afterRestore?: 'skip';
  /* Columns never taken from the source. */
  hereOnly?: readonly string[];
};

const rows = (topic: Topic, more: Omit<TableRule, 'kind' | 'topic'> = {}): TableRule => ({ kind: 'rows', topic, ...more });
const add = (topic: Topic): TableRule => ({ kind: 'add', topic });
const skip = (topic: Topic): TableRule => ({ kind: 'skip', topic });
const each = (names: readonly string[], rule: TableRule): Record<string, TableRule> => Object.fromEntries(names.map(name => [name, rule]));

/* The gateway that sends for the company, and the support desk it answers: its payloads and contacts are private, and a
   row of it stands for an approval, a receipt, a consent or a day's count. */
const OUTBOUND = [
  'outbound_channels', 'outbound_policies', 'outbound_accounts', 'outbound_bindings', 'outbound_catalog_revisions', 'outbound_contacts', 'outbound_permissions',
  'outbound_messages', 'outbound_message_revisions', 'outbound_approvals', 'outbound_review_receipts', 'outbound_daily_usage', 'outbound_attempts', 'outbound_sampling_counters',
  'support_tickets', 'support_classifications',
];

/* The rule of every table of public. A table this does not name stops a merge, so a new table is given its rule when it
   is made. */
export const TABLE_RULES: Readonly<Record<string, TableRule>> = {
  /* Join codes, tickets and waiting wakes go; a sign-in count and the link's certificate belong to the machine that
     leads. So do a notice that waits to be handed over, which its wait raises again, what a machine built of a
     harness, which lies on the leader's own disk, and the physical programs a server watched on its nodes, with what
     it handed them and its looks at the ones that hung. */
  node_codes: skip('machines'),
  machine_tickets: skip('machines'),
  pending_wakes: skip('work'),
  sign_in_attempts: skip('people'),
  link_tls: skip('access'),
  wait_notices: skip('work'),
  harness_builds: skip('machines'),
  harness_products: skip('machines'),
  ...each(['program_instances', 'program_deliveries', 'program_operator_cases', 'program_operator_signals'], skip('work')),
  /* An answer a bot still owed when its database was set aside is not sent later, out of its time. */
  telegram_replies: skip('work'),
  /* What an assistant was told, and what is still being collected for it, is the feed of the database that leads: its
     numbers are that database's own, and an answer collected in one that was set aside is not told later. */
  ...each(['assistant_events', 'assistant_seqs', 'assistant_replies', 'assistant_requests'], skip('work')),

  /* Records that are written once: one the leader lacks is added, and none is compared. */
  applied: add('work'),
  tool_calls: add('work'),
  machine_online: add('machines'),
  person_changes: add('people'),
  node_connections: add('plans'),
  turn_snapshots: add('work'),
  /* What a turn used, kept once when it ends. */
  turn_tokens: add('work'),
  test_part_timings: add('work'),
  test_file_results: add('work'),
  test_suite_memory: add('work'),
  outbound_contact_events: add('protected'),
  outbound_events: add('protected'),
  /* Who set up a department's messages, on a person's word: written once, and never changed. */
  outbound_setup_events: add('protected'),
  autonomous_releases: { kind: 'add', topic: 'protected', task: 'task_id', hereOnly: ['verdict_event_id'] },
  /* The record of a turn's release stands for the approval of its commit, by a person or by the autonomous release log. */
  turn_releases: { kind: 'add', topic: 'protected', task: 'task_id' },

  agent_events: { kind: 'log', topic: 'work', match: 'id', sequence: 'seq' },
  task_events: { kind: 'log', topic: 'work', match: 'uuid', sequence: 'id', task: 'task_id' },
  agent_changes: { kind: 'log', topic: 'work', match: 'id' },
  /* A letter the leader lacks joins an employee's inbox after its own letters; one both hold keeps how the leader read it. */
  agent_inbox: { kind: 'log', topic: 'work', match: 'id', sequence: 'seq', task: 'task_id' },

  people: rows('people'),
  /* A restore's carry ended every session on purpose. */
  sessions: rows('people', { afterRestore: 'skip' }),
  invites: rows('people'),
  person_keys: rows('people'),

  person_access: rows('access'),
  /* Only a machine's owner opens computer access to it, so no merge does. */
  machine_access: rows('access', { hereOnly: ['until', 'opened_by', 'opened_at', 'grant'] }),
  ...each(['recovery_keys', 'certificates', 'authority', 'peer_secrets', 'public_links'], rows('access')),
  /* A bot's token is a way from outside to an agent of the company. */
  telegram_bots: rows('access'),
  /* An assistant's key is a way in from outside, under its owner's rights. */
  assistants: rows('access'),
  /* The key of a git host is a way out to an account of the company's, and so is the Google key that makes its sheets. */
  repo_hosts: rows('access'),
  google_sheets: rows('access'),
  company_phones: rows('protected'),
  // Historical records follow their task. A row alone never reissues a runtime grant on the node.
  phone_sessions: rows('protected'),
  phone_frames: add('protected'),

  ...each(['subscriptions', 'nodes', 'plan_credentials', 'agent_fallbacks'], rows('plans')),

  machines: rows('machines'),
  computer_runs: rows('machines'),

  ...each(['requests', 'task_waits', 'outbound_messages'], rows('protected', { task: 'task_id' })),
  ...each(['request_internal', 'proposals', 'approval_policies', 'wait_policies'], rows('protected')),
  ...each(['model_checks', 'model_check_revisions', 'model_check_datasets', 'model_check_evaluations', 'model_check_certificates'], rows('protected')),
  ...each(OUTBOUND.filter(name => name !== 'outbound_messages'), rows('protected')),

  ...each(['companies', 'departments', 'teams', 'agents', 'improvements', 'test_parts', 'backlog_items', 'briefings', 'map_layouts'], rows('work')),
  /* The cards of Hornhoof's own feedback inbox and who sent each: a card only the source holds whose number or finding the
     leader gave another card stays out. */
  ...each(['feedback_inbox', 'feedback_signals'], rows('work')),
  tasks: rows('work', { number: ['company_id'], task: 'id' }),
  turns: rows('work', { number: ['company_id'], task: 'task_id' }),
  test_runs: rows('work', { number: ['company_id'], task: 'task_id' }),
  notebook_notes: rows('work', { number: ['company_id', 'department_id'] }),
  ...each(['jobs', 'attachments', 'task_routes'], rows('work', { task: 'task_id' })),
  /* Its source_key names an event by a number of each side, so the logs go first. */
  map_returns: rows('work', { task: 'source_task_id', after: ['task_events', 'agent_events'] }),
};

/* Columns that are never compared: what a report, a counter of the app or a clock writes on both sides all the time.
   A name a table does not have is ignored. */
export const BOOKKEEPING: Readonly<Record<string, readonly string[]>> = {
  tasks: ['updated_at', 'version'],
  notebook_notes: ['updated_at'],
  improvements: ['updated_at'],
  briefings: ['updated_at'],
  approval_policies: ['updated_at'],
  task_waits: ['updated_at'],
  outbound_accounts: ['updated_at'],
  outbound_messages: ['updated_at'],
  map_layouts: ['updated_at'],
  feedback_inbox: ['updated_at'],
  feedback_signals: ['signals', 'updated_at'],
  telegram_bots: ['update_offset'],
  agents: ['context_used', 'timer_at'],
  nodes: ['last_seen_at', 'status', 'version', 'boot'],
  subscriptions: ['status', 'limits', 'models', 'limits_updated_at', 'lease_node_id'],
  machines: [
    'server_order', 'server_why', 'web_port', 'peer_port', 'commit', 'uptime_s', 'fsync_p99_ms', 'disk_free', 'report_at', 'addresses', 'path', 'direct_fails', 'renew_at',
    'update_commit', 'update_state', 'go_commit', 'go_at', 'failed_commit', 'failed_at', 'owner_pin', 'held_backups',
    'memory', 'cores', 'copy_state', 'copy_progress', 'copy_error', 'copy_at', 'copy_name', 'copy_old', 'copy_old_led', 'data_left_at', 'upload_state', 'link_rtt_ms', 'link_mbps', 'internet_rtt_ms', 'internet_mbps',
  ],
};

/* An end both sides recorded is one end: two times in one of these count as equal, and the leader's stays. */
export const ENDS: readonly string[] = ['revoked_at', 'removed_at', 'closed_at', 'used_at', 'retired_at'];

/* How a row that a merge writes in an open state is written closed, so nothing the source left open runs again. open:
   the values of column that are open, null for a column that is empty while open. at: the column that takes the time.
   error: the column that takes the reason. also: other columns the closed state needs. */
export type Closing = { column: string; open: readonly (string | null)[]; to: string; at: string; error?: string; also?: Readonly<Record<string, unknown>> };
export const CLOSING: Readonly<Record<string, readonly Closing[]>> = {
  jobs: [{ column: 'status', open: ['queued', 'running'], to: 'failed', at: 'finished_at', error: 'error' }],
  computer_runs: [{ column: 'state', open: ['waiting', 'sent'], to: 'lost', at: 'done_at' }],
  test_runs: [{ column: 'status', open: ['running'], to: 'stopped', at: 'finished_at' }],
  test_parts: [{ column: 'status', open: ['queued', 'running'], to: 'stopped', at: 'finished_at', error: 'error' }],
  /* A message that never went out is called off. Of one that was going out nobody knows whether it was taken, and a
     person says so before its account sends again. */
  outbound_messages: [
    { column: 'status', open: ['scheduled', 'waiting_checks', 'waiting_approval', 'reserved'], to: 'cancelled', at: 'updated_at' },
    { column: 'status', open: ['sending'], to: 'unknown', at: 'updated_at' },
  ],
  outbound_attempts: [
    { column: 'status', open: ['reserved'], to: 'definitely_not_accepted', at: 'ended_at', also: { safe_code: 'not_sent' } },
    { column: 'status', open: ['sending'], to: 'unknown', at: 'ended_at', also: { safe_code: 'connection_lost' } },
  ],
  model_check_evaluations: [{ column: 'status', open: ['queued', 'running'], to: 'incomplete', at: 'finished_at' }],
  support_classifications: [{ column: 'status', open: ['pending'], to: 'unavailable', at: 'decided_at' }],
  /* A connection the source held open ended with the server that held it. */
  node_connections: [{ column: 'cause', open: [null], to: 'server_stopped', at: 'disconnected_at', also: { close_code: 1001 } }],
};

/* Ids in a column no foreign key checks. list: the column holds a list of them. when: the reference counts only for
   rows with this value there. */
export type SoftRef = { table: string; column: string; parent: string; list: boolean; when?: { column: string; value: string } };
export const SOFT_REFS: readonly SoftRef[] = [
  { table: 'tasks', column: 'after', parent: 'tasks', list: true },
  { table: 'subscriptions', column: 'target_id', parent: 'departments', list: false, when: { column: 'target_kind', value: 'department' } },
  { table: 'subscriptions', column: 'target_id', parent: 'teams', list: false, when: { column: 'target_kind', value: 'team' } },
];

export function ruleOf(table: string): TableRule {
  const rule = TABLE_RULES[table];
  if (!rule) throw new Error(`No merge rule for public.${table}.`);
  return rule;
}

const SECRET_NAMES = new Set(['sealed', 'wrapped', 'salt', 'iv', 'grant']);

/* A column whose values are kept for a pick and shown to nobody. */
export function isSecret(table: string, column: string): boolean {
  return Boolean(SECRET[table]?.includes(column)) || column.endsWith('_hash') || column.endsWith('_enc') || SECRET_NAMES.has(column);
}

export function ceosConflict(table: string): boolean {
  return CEO_TOPICS.includes(ruleOf(table).topic);
}

/* Whose a conflict is, wherever that is asked: the CEO's by its topic, whatever the orchestrator's own SQL may not
   see, and a table this build has no rule for, as a conflict carried from another build may name. */
export function ceos(table: string): boolean {
  const rule = TABLE_RULES[table];
  return !rule || CEO_TOPICS.includes(rule.topic) || HIDDEN.includes(table);
}
/* The tables whose conflicts the orchestrator settles. */
export const ORCHESTRATORS_TABLES = (): string[] => Object.keys(TABLE_RULES).filter(table => !ceos(table));
