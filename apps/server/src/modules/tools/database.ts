import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { HIDDEN, SECRET, type SqlAnswer, type SqlCall, type SqlMode } from '../../db/agent-sql.js';
import { notConfirmed } from '../../db/confirm.js';
import { checkAgentSql, SqlRefused } from '../../db/sql-check.js';
import { sources } from '../../db/sources.js';
import { answersCeoOrDelegate, standingPrincipal, withInputLock } from '../conversation/decision-context.js';
import { currentInvocation, keptAnswer } from './calls.js';

type ToolJob = { id: string; companyId: string; agentId: string };

/* Answers longer than this are cut, as view's are. */
const MAX_ANSWER = 30_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const SECRETS = Object.values(SECRET).flat().join(', ');
/* The closed tables but the first, which each text below starts in its own way. */
const CLOSED_AFTER_SIGN_INS =
  "invites, install codes, sealed plan sign-ins, the public link, Hornhoof's records of where changes came from, the company's certificate authority, its machines' certificates and the peer secrets, the machines' join tickets and online time, people's keys, the machines' computer access and the commands run there, and the recovery keys";
const CLOSED = `Sign-ins, ${CLOSED_AFTER_SIGN_INS} are closed to this tool.`;
export const READ_ONLY = 'Operations reads the database; a change goes to the orchestrator as one message with the SQL and why.';
/* The orchestrator's while the last person who wrote to it takes none of the CEO's decisions. */
export const READS_IN_THIS_TURN = 'The tool only reads now: the last person who wrote to you is neither the CEO nor the CEO delegate. A change goes once one of them asks for it.';
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
  turn_tokens: 'Hornhoof counts what each turn used itself, from what its program told: the tool only reads it.',
  test_part_timings: 'Hornhoof works out the pipeline report itself: the tool only reads it.',
  test_file_results: 'Hornhoof keeps which test files passed itself, as a forged row would let a test go unrun: the tool only reads it.',
  test_suite_memory: 'Hornhoof keeps what test runs leave for their next run itself: the tool only reads it.',
  harness_builds: HARNESS,
  harness_products: HARNESS,
  departments: "A department's repository changes only on its screen or with set_repository, on the word of the CEO or a person who runs it; its owner and autonomous release change only on the screen.",
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
  agent_inbox: "Hornhoof keeps employees' inboxes itself, as each letter names who wrote it: the tool only reads them. An employee marks its own letters with inbox_mark, and the orchestrator any employee's, with inbox_mark and its id in employee.",
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

/* A text the check refused never reached the database, so it hears that and not the database's words. What is no row change
   in a call that only reads is a change it may not make, so it hears why too. */
function refusedText(err: SqlRefused, mode: SqlMode, readOnly: string): string {
  return `Hornhoof did not run this SQL: ${err.message}${mode === 'read' && err.kind === 'statement' ? ` ${readOnly}` : ''}`;
}

function failureText(err: Error, mode: SqlMode, readOnly: string): string {
  if (err instanceof SqlRefused) return refusedText(err, mode, readOnly);
  if (notConfirmed(err)) return `The database answered: ${err.message} The call may have run; check before repeating it.`;
  return refusal(err, mode, readOnly);
}

const DESCRIPTIONS: Record<SqlMode, string> = {
  write:
    "Runs SQL on Hornhoof's own Postgres database, for what no other tool does: fixing a stuck row, changing a field, removing what the screens cannot. " +
    'Only SELECT, INSERT, UPDATE, DELETE and WITH statements run, several in one transaction that Hornhoof begins and commits, undone together when one fails; a call may take 5 seconds. It reads and changes the rows of every table ' +
    `but sign-ins, ${CLOSED_AFTER_SIGN_INS}, and never the columns with secrets (${SECRETS}), so name columns instead of * on those tables. ` +
    "People and their access, subscriptions, machines, repositories, an employee's kind, role, skills and subscription, a head's department and a turn but its status change only through the other tools. " +
    'It cannot change the tables themselves. A change skips the checks and notices the other tools make, so prefer them, read before you write and change only ' +
    'the rows you mean. Each statement comes back as { rows, changed }.',
  read:
    "Reads Hornhoof's own Postgres database, to find what went wrong: stuck rows, failed turns, who changed what and when. Only SELECT and WITH statements run, several in one " +
    `transaction; a call may take 15 seconds. It reads the rows of every table but sign-ins, ${CLOSED_AFTER_SIGN_INS}, and never the columns ` +
    `with secrets (${SECRETS}), so name columns instead of * on those tables. ${READ_ONLY} Each statement comes back as { rows, changed }.`,
};

/* What the tool says of itself, and why a read-only call refused a write, in each mode. */
const DESCRIBED: Record<SqlMode, string> = {
  write: `${DESCRIPTIONS.write} When the last person who wrote to you is neither the CEO nor the CEO delegate, it only reads.`,
  read: DESCRIPTIONS.read,
};
const WHY_READ_ONLY: Record<SqlMode, string> = { write: READS_IN_THIS_TURN, read: READ_ONLY };

/* The mode a call runs in: the orchestrator's changes rows only for the CEO or the delegate, the last person who wrote to
   it, in this turn or an earlier one. */
async function modeNow(ctx: Ctx, job: ToolJob, mode: SqlMode): Promise<SqlMode> {
  if (mode === 'read') return 'read';
  return (await answersCeoOrDelegate(ctx.db, job.id, standingPrincipal)) ? 'write' : 'read';
}

/* What the agent reads of a call that ran. */
function answerOf(answers: SqlAnswer[]) {
  const body = JSON.stringify(answers);
  return say(body.length > MAX_ANSWER ? `${body.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : body);
}

/* A change made by a call that front gave an id is recorded by the lease check itself, with the answer the agent will
   read, in the change's own commit: so the call's first step is taken there, and the source goes on from the next. */
function recorded(job: ToolJob): SqlCall | undefined {
  const invocation = currentInvocation();
  if (!invocation) return undefined;
  return {
    invocation,
    jobId: job.id,
    answer: results => {
      const source = sources.getStore()!;
      source.next = Math.max(source.next, 1);
      source.wrote = true;
      return keptAnswer(answerOf(results));
    },
  };
}

async function runSql(ctx: Ctx, agentSql: NonNullable<Ctx['agentSql']>, job: ToolJob, sql: string, mode: SqlMode) {
  const now = await modeNow(ctx, job, mode);
  try {
    await checkAgentSql(sql);
    const answers = await agentSql.run(sql, now, now === 'write' ? recorded(job) : undefined);
    if (answers.some(a => a.changed > 0)) ctx.bus.publish(job.companyId, { type: 'org' });
    return answerOf(answers);
  } catch (err) {
    return say(failureText(err as Error, now, WHY_READ_ONLY[mode]), true);
  }
}

/* SQL on Hornhoof's own database, for what the other tools do not reach: the orchestrator's changes rows, the head of
   Operations' only reads. The orchestrator's only reads too when the last person who wrote to it is neither the CEO nor
   the delegate, as found when the call runs, under the input lock words for the turn take. The map is told to look again
   after a change. */
export function registerDatabaseTool(server: McpServer, ctx: Ctx, job: ToolJob, mode: SqlMode): void {
  server.registerTool('database', { description: DESCRIBED[mode], inputSchema: { sql: z.string().trim().min(1).max(20_000) } }, async ({ sql }) => {
    const agentSql = ctx.agentSql;
    if (!agentSql) return say(ctx.agentSqlPending ? 'Hornhoof is starting.' : "This Hornhoof's database does not let Hornhoof make the role this tool runs as.", true);
    const run = () => runSql(ctx, agentSql, job, sql, mode);
    return mode === 'write' ? withInputLock(ctx, job.agentId, run) : run();
  });
}
