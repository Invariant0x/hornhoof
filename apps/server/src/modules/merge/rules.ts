import { SECRET } from '../../db/agent-sql.js';

/* Says whose a conflict is: the orchestrator settles work, and the CEO alone settles the rest. */
export type Topic = 'people' | 'access' | 'plans' | 'machines' | 'work';
export const CEO_TOPICS: readonly Topic[] = ['people', 'access', 'plans', 'machines'];

/* rows: compared and merged column by column. add: added when the leader lacks it, never compared. log: matched by a
   column and added with a new sequence value, never compared or deleted. skip: never merged. */
export type TableRule = {
  kind: 'rows' | 'add' | 'log' | 'skip';
  topic: Topic;
  match?: string;
  sequence?: string;
  number?: readonly string[];
  task?: string;
  after?: readonly string[];
  afterRestore?: 'skip';
  hereOnly?: readonly string[];
};

const WORK_ROW: TableRule = { kind: 'rows', topic: 'work' };
const TASK_ROW: TableRule = { kind: 'rows', topic: 'work', task: 'task_id' };

export const TABLE_RULES: Readonly<Record<string, TableRule>> = {
  /* Join codes and waiting wakes go, tickets are join codes too, and a sign-in count and the link's certificate belong
     to the machine that leads. */
  node_codes: { kind: 'skip', topic: 'machines' },
  machine_tickets: { kind: 'skip', topic: 'machines' },
  pending_wakes: { kind: 'skip', topic: 'work' },
  sign_in_attempts: { kind: 'skip', topic: 'people' },
  link_tls: { kind: 'skip', topic: 'access' },

  applied: { kind: 'add', topic: 'work' },
  tool_calls: { kind: 'add', topic: 'work' },
  machine_online: { kind: 'add', topic: 'machines' },

  agent_events: { kind: 'log', topic: 'work', match: 'id', sequence: 'seq' },
  task_events: { kind: 'log', topic: 'work', match: 'uuid', sequence: 'id', task: 'task_id' },
  agent_changes: { kind: 'log', topic: 'work', match: 'id' },

  people: { kind: 'rows', topic: 'people' },
  /* A restore's carry ended every session on purpose, so none comes back after one. */
  sessions: { kind: 'rows', topic: 'people', afterRestore: 'skip' },
  invites: { kind: 'rows', topic: 'people' },
  person_keys: { kind: 'rows', topic: 'people' },

  person_access: { kind: 'rows', topic: 'access' },
  /* Only a machine's owner opens computer access, so a merge never takes these from the source. */
  machine_access: { kind: 'rows', topic: 'access', hereOnly: ['until', 'opened_by', 'opened_at', 'grant'] },
  recovery_keys: { kind: 'rows', topic: 'access' },
  certificates: { kind: 'rows', topic: 'access' },
  authority: { kind: 'rows', topic: 'access' },
  peer_secrets: { kind: 'rows', topic: 'access' },
  public_links: { kind: 'rows', topic: 'access' },

  subscriptions: { kind: 'rows', topic: 'plans' },
  nodes: { kind: 'rows', topic: 'plans' },
  plan_credentials: { kind: 'rows', topic: 'plans' },

  machines: { kind: 'rows', topic: 'machines' },
  computer_runs: { kind: 'rows', topic: 'machines' },

  companies: WORK_ROW,
  departments: WORK_ROW,
  teams: WORK_ROW,
  agents: WORK_ROW,
  proposals: WORK_ROW,
  improvements: WORK_ROW,
  test_parts: WORK_ROW,
  tasks: { kind: 'rows', topic: 'work', number: ['company_id'], task: 'id' },
  turns: { kind: 'rows', topic: 'work', number: ['company_id'], task: 'task_id' },
  test_runs: { kind: 'rows', topic: 'work', number: ['company_id'], task: 'task_id' },
  notebook_notes: { kind: 'rows', topic: 'work', number: ['company_id', 'department_id'] },
  jobs: TASK_ROW,
  requests: TASK_ROW,
  attachments: TASK_ROW,
  /* Its source_key names a log's row by that row's number on each side, so the logs go first. */
  map_returns: { kind: 'rows', topic: 'work', task: 'source_task_id', after: ['task_events', 'agent_events'] },
};

/* Columns that are never compared: reports both sides write all the time, which would make every row a conflict. A name
   a table does not have is ignored, since plans add the machines' columns one by one. */
export const BOOKKEEPING: Readonly<Record<string, readonly string[]>> = {
  tasks: ['updated_at', 'version'],
  notebook_notes: ['updated_at'],
  improvements: ['updated_at'],
  nodes: ['last_seen_at', 'status', 'version'],
  subscriptions: ['status', 'limits', 'models'],
  machines: [
    'server_order', 'server_why', 'web_port', 'peer_port', 'commit', 'uptime_s', 'fsync_p99_ms', 'disk_free', 'report_at', 'addresses',
    'path', 'direct_fails', 'renew_at', 'update_commit', 'update_state', 'go_commit', 'go_at', 'failed_commit', 'failed_at', 'owner_pin',
    'held_backups',
  ],
};

/* An end both sides recorded is one end, whatever time each side gave it. */
export const ENDS: readonly string[] = ['revoked_at', 'removed_at', 'closed_at', 'used_at', 'retired_at'];

/* What the source left running must not run again, so a row written in an open state is written closed. */
export type Closing = { column: string; open: readonly string[]; to: string; at: string; error?: string };
export const CLOSING: Readonly<Record<string, Closing>> = {
  jobs: { column: 'status', open: ['queued', 'running'], to: 'failed', at: 'finished_at', error: 'error' },
  computer_runs: { column: 'state', open: ['waiting', 'sent'], to: 'lost', at: 'done_at' },
  test_runs: { column: 'status', open: ['running'], to: 'stopped', at: 'finished_at' },
  test_parts: { column: 'status', open: ['queued', 'running'], to: 'stopped', at: 'finished_at', error: 'error' },
};

/* Ids in a column no foreign key checks, which the merge checks as if one did. */
export type SoftRef = { table: string; column: string; parent: string; list: boolean; when?: { column: string; value: string } };
export const SOFT_REFS: readonly SoftRef[] = [
  { table: 'tasks', column: 'gates', parent: 'agents', list: true },
  { table: 'tasks', column: 'panel', parent: 'agents', list: true },
  { table: 'tasks', column: 'after', parent: 'tasks', list: true },
  { table: 'subscriptions', column: 'target_id', parent: 'departments', list: false, when: { column: 'target_kind', value: 'department' } },
  { table: 'subscriptions', column: 'target_id', parent: 'teams', list: false, when: { column: 'target_kind', value: 'team' } },
];

export function ruleOf(table: string): TableRule {
  const rule = TABLE_RULES[table];
  if (!rule) throw new Error(`No merge rule for public.${table}.`);
  return rule;
}

const SECRET_NAMES: readonly string[] = ['sealed', 'wrapped', 'salt', 'iv', 'grant'];

/* A secret column's value is kept for a pick but never shown, so a new secret column should fall under a name here. */
export function isSecret(table: string, column: string): boolean {
  const listed = SECRET[table]?.includes(column) ?? false;
  return listed || column.endsWith('_hash') || column.endsWith('_enc') || SECRET_NAMES.includes(column);
}

export function ceosConflict(table: string): boolean {
  return CEO_TOPICS.includes(ruleOf(table).topic);
}
