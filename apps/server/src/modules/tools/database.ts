import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { HIDDEN, SECRET, type SqlMode } from '../../db/agent-sql.js';
import { answersCeoOrDelegate, withInputLock } from '../conversation/decision-context.js';

type ToolJob = { id: string; companyId: string; agentId: string };

/* Answers longer than this are cut, as view's are. */
const MAX_ANSWER = 30_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const SECRETS = Object.values(SECRET).flat().join(', ');
const CLOSED = 'Sign-ins, invites, install codes, sealed plan sign-ins and the public link are closed to this tool.';
export const READ_ONLY = 'Operations reads the database; a change goes to the orchestrator as one message with the SQL and why.';
/* The orchestrator's in a turn that answers nobody who takes the CEO's decisions. */
export const READS_IN_THIS_TURN = 'In this turn the tool only reads: it answers neither the CEO nor the CEO delegate. A change waits for a turn of theirs.';
const DECISIONS = 'Requests, cards and the logs of tasks and conversations change only through the other tools: a request closes only with answer_request.';
const PEOPLE = 'People and what they reach change only through invite_person, change_person and invite_again, which only the CEO may ask for.';
const PLANS = 'Subscriptions and machines change only through their tools, which only the CEO may ask for.';
const TESTS = 'Whole-suite runs on free machines and work runs start and stop only through run_tests, run_work, stop_tests and stop_work, so they reach only the machines lent to them.';
const HARNESS = 'Hornhoof keeps where a test harness stands itself and builds it by itself: test_harness shows it, and the tool only reads it.';
const ASSISTANTS = "An assistant, its key and the addresses Hornhoof reaches it at change only on the People screen, by a person who may set it up.";
const ASSISTANT_READS = 'Hornhoof keeps what an assistant reads and the answers it waits for itself: the tool only reads it.';
/* What the orchestrator may not do with a table, in the words he acts on. */
const RULES: Record<string, string> = {
  people: PEOPLE,
  person_access: PEOPLE,
  subscriptions: PLANS,
  machines: PLANS,
  nodes: PLANS,
  node_connections: 'Hornhoof writes the history of node connections itself: the tool only reads it.',
  test_runs: TESTS,
  test_parts: TESTS,
  turn_snapshots: 'Hornhoof works out the pipeline report itself: the tool only reads it.',
  test_part_timings: 'Hornhoof works out the pipeline report itself: the tool only reads it.',
  test_file_results: 'Hornhoof keeps which test files passed itself, as a forged row would let a test go unrun: the tool only reads it.',
  test_suite_memory: 'Hornhoof keeps what test runs leave for their next run itself: the tool only reads it.',
  harness_builds: HARNESS,
  harness_products: HARNESS,
  departments: "A department's repository changes only with set_repository, which only the CEO may ask for.",
  agents:
    "Employees come by hire and go by fire_employee, and their skills and subscription change by change_employee, which make the CEO's checks; kind and role_key never change, a head stays in its department, and an assistant's own agent belongs to its owner.",
  jobs: 'Hornhoof starts the turns: the tool changes only their status, error and finished_at.',
  requests: DECISIONS,
  proposals: DECISIONS,
  agent_events: DECISIONS,
  task_events: DECISIONS,
  assistants: ASSISTANTS,
  assistant_events: ASSISTANT_READS,
  assistant_replies: ASSISTANT_READS,
  assistant_requests: ASSISTANT_READS,
};
const secretsOf = (table: string) => {
  const columns = SECRET[table];
  if (!columns) return undefined;
  return `${columns.join(' and ')} ${columns.length > 1 ? 'are' : 'is'} closed to this tool: name the other columns of ${table} instead of *.`;
};

/* The database's words, and after them why, when it refused. A read-only role refused only a write, unless the table is
   hidden or has secrets. */
function refusal(err: Error & { code?: string }, mode: SqlMode, readOnly = READ_ONLY): string {
  const table = /permission denied for table "?(\w+)"?/.exec(err.message)?.[1];
  const denied = err.code === '42501' || /permission denied/.test(err.message);
  let why: string | undefined;
  if (table && HIDDEN.includes(table)) why = CLOSED;
  else if (mode === 'read') {
    if (denied && table && SECRET[table]) why = secretsOf(table);
    else if (denied || err.code === '25006' || /read-only transaction/.test(err.message)) why = readOnly;
  } else if (table) why = [RULES[table], secretsOf(table)].filter(Boolean).join(' ') || undefined;
  return `The database answered: ${err.message}${why ? `. ${why}` : ''}`;
}

const DESCRIPTIONS: Record<SqlMode, string> = {
  write:
    "Runs SQL on Hornhoof's own Postgres database, for what no other tool does: fixing a stuck row, changing a field, removing what the screens cannot. " +
    'Several statements run in one transaction and are undone together when one fails; a call may take 15 seconds. It reads and changes the rows of every table ' +
    `but sign-ins, invites, install codes, sealed plan sign-ins and the public link, and never the columns with secrets (${SECRETS}), so name columns instead of * on those tables. ` +
    "People and their access, subscriptions, machines, repositories, an employee's kind, role, skills and subscription, a head's department and a turn but its status change only through the other tools. " +
    'It cannot change the tables themselves. A change skips the checks and notices the other tools make, so prefer them, read before you write and change only ' +
    'the rows you mean. Each statement comes back as { rows, changed }.',
  read:
    "Reads Hornhoof's own Postgres database, to find what went wrong: stuck rows, failed turns, who changed what and when. Several statements run in one " +
    'transaction; a call may take 15 seconds. It reads the rows of every table but sign-ins, invites, install codes, sealed plan sign-ins and the public link, and never the columns ' +
    `with secrets (${SECRETS}), so name columns instead of * on those tables. ${READ_ONLY} Each statement comes back as { rows, changed }.`,
};

/* What the tool says of itself, and why a read-only call refused a write, in each mode. */
const DESCRIBED: Record<SqlMode, string> = {
  write: `${DESCRIPTIONS.write} In a turn that answers neither the CEO nor the CEO delegate it only reads.`,
  read: DESCRIPTIONS.read,
};
const WHY_READ_ONLY: Record<SqlMode, string> = { write: READS_IN_THIS_TURN, read: READ_ONLY };

/* The mode a call runs in: the orchestrator's changes rows only in a turn that answers the CEO or the delegate. */
async function modeNow(ctx: Ctx, job: ToolJob, mode: SqlMode): Promise<SqlMode> {
  if (mode === 'read') return 'read';
  return (await answersCeoOrDelegate(ctx.db, job.id)) ? 'write' : 'read';
}

async function runSql(ctx: Ctx, agentSql: NonNullable<Ctx['agentSql']>, job: ToolJob, sql: string, mode: SqlMode) {
  const now = await modeNow(ctx, job, mode);
  try {
    const answers = await agentSql.run(sql, now);
    if (answers.some(a => a.changed > 0)) ctx.bus.publish(job.companyId, { type: 'org' });
    const body = JSON.stringify(answers);
    return say(body.length > MAX_ANSWER ? `${body.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : body);
  } catch (err) {
    return say(refusal(err as Error, now, WHY_READ_ONLY[mode]), true);
  }
}

/* SQL on Hornhoof's own database, for what the other tools do not reach: the orchestrator's changes rows, the head of
   Operations' only reads. The orchestrator's only reads too in a turn that answers neither the CEO nor the delegate, as
   the turn answers when the call runs, under the input lock words for the turn take. The map is told to look again after
   a change. */
export function registerDatabaseTool(server: McpServer, ctx: Ctx, job: ToolJob, mode: SqlMode): void {
  server.registerTool('database', { description: DESCRIBED[mode], inputSchema: { sql: z.string().trim().min(1).max(20_000) } }, async ({ sql }) => {
    const agentSql = ctx.agentSql;
    if (!agentSql) return say("This Hornhoof's database does not let Hornhoof make the role this tool runs as.", true);
    const run = () => runSql(ctx, agentSql, job, sql, mode);
    return mode === 'write' ? withInputLock(ctx, job.agentId, run) : run();
  });
}
