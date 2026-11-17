import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ASSISTANT_TABLES, HIDDEN, SECRET, type SqlAnswer, type SqlCall, type SqlMode } from '../../db/agent-sql.js';
import { notConfirmed } from '../../db/confirm.js';
import { checkAgentSql, SqlRefused } from '../../db/sql-check.js';
import { sources } from '../../db/sources.js';
import { currentInvocation, keptAnswer } from './calls.js';

type ToolJob = { id: string; companyId: string; agentId: string };

/* Answers longer than this are cut, as api's are. */
const MAX_ANSWER = 30_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const SECRETS = Object.values(SECRET).flat().join(', ');
/* The closed tables but the first, which each text below starts in its own way. */
const CLOSED_AFTER_SIGN_INS =
  "invites, install codes, sealed plan sign-ins, the public link, Hornhoof's records of where changes came from, the company's certificate authority, its machines' certificates and the peer secrets, the machines' join tickets and online time, people's keys, the machines' computer access and the commands run there, and the recovery keys";
const CLOSED = `Sign-ins, ${CLOSED_AFTER_SIGN_INS} are closed to this tool.`;
const READ_ONLY = 'Operations reads the database; a change goes to the orchestrator as one message with the SQL and why.';
const ASSISTANTS_CLOSED = 'Personal assistants are closed to this tool.';
const closedColumns = (table: string, columns: string[]) =>
  `${columns.join(' and ')} ${columns.length > 1 ? 'are' : 'is'} closed to this tool: name the other columns of ${table} instead of *.`;
const secretsOf = (table: string) => (SECRET[table] ? closedColumns(table, SECRET[table]) : undefined);
const closedToRead = (table: string): string | undefined =>
  ASSISTANT_TABLES.includes(table) ? ASSISTANTS_CLOSED : secretsOf(table);
const isReadOnlyError = (denied: boolean, err: Error & { code?: string }): boolean =>
  denied || err.code === '25006' || /read-only transaction/.test(err.message);
function readWhy(denied: boolean, err: Error & { code?: string }, table: string | undefined, readOnly: string): string | undefined {
  const closed = denied && table ? closedToRead(table) : undefined;
  return closed ?? (isReadOnlyError(denied, err) ? readOnly : undefined);
}

/* The database's words, and after them why, when it refused Operations. A read-only role refused only a write, unless the
   table is hidden, an assistant table or has secrets. */
function refusal(err: Error & { code?: string }, mode: SqlMode): string {
  const table = /permission denied for table "?(\w+)"?/.exec(err.message)?.[1];
  const denied = err.code === '42501' || /permission denied/.test(err.message);
  let why: string | undefined;
  if (mode === 'read' && table && HIDDEN.includes(table)) why = CLOSED;
  else if (mode === 'read') why = readWhy(denied, err, table, READ_ONLY);
  return `The database answered: ${err.message}${why ? `. ${why}` : ''}`;
}

/* A text the check refused never reached the database, so it hears that and not the database's words. What is no row change
   in a call that only reads is a change it may not make, so it hears why too. */
function refusedText(err: SqlRefused): string {
  return `Hornhoof did not run this SQL: ${err.message}${err.kind === 'statement' ? ` ${READ_ONLY}` : ''}`;
}

function failureText(err: Error, mode: SqlMode): string {
  if (err instanceof SqlRefused) return refusedText(err);
  if (notConfirmed(err)) return `The database answered: ${err.message} The call may have run; check before repeating it.`;
  return refusal(err, mode);
}

/* What the tool says of itself in each mode. */
const DESCRIPTIONS: Record<SqlMode, string> = {
  write:
    "Runs any SQL on Hornhoof's own Postgres database with Hornhoof's own rights: it reads and changes every table and every column, keys, tokens and secrets included, " +
    "the network's records in net and net_local too, and the schema itself. Use it to see how Hornhoof runs right now with source and logs, and for what no other tool does. " +
    'Several statements run in one transaction that Hornhoof begins and commits, undone together when one fails; a call may take 5 seconds. ' +
    'A change skips the checks and notices the other tools make, so prefer them where they fit, read before you write and change only the rows you mean. ' +
    'Each statement comes back as { rows, changed }.',
  read:
    "Reads Hornhoof's own Postgres database, to find what went wrong: stuck rows, failed turns, who changed what and when. Only SELECT and WITH statements run, several in one " +
    `transaction; a call may take 15 seconds. It reads the rows of every table but sign-ins, ${CLOSED_AFTER_SIGN_INS}, and never the columns ` +
    `with secrets (${SECRETS}), so name columns instead of * on those tables. ${READ_ONLY} Each statement comes back as { rows, changed }.`,
};

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

/* Operations' text passes the check first; the orchestrator's goes as Hornhoof's own would. */
async function runSql(ctx: Ctx, agentSql: NonNullable<Ctx['agentSql']>, job: ToolJob, sql: string, mode: SqlMode) {
  try {
    if (mode === 'read') await checkAgentSql(sql);
    const answers = await agentSql.run(sql, mode, mode === 'write' ? recorded(job) : undefined);
    if (answers.some(a => a.changed > 0)) ctx.bus.publish(job.companyId, { type: 'org' });
    return answerOf(answers);
  } catch (err) {
    return say(failureText(err as Error, mode), true);
  }
}

/* SQL on Hornhoof's own database: the orchestrator's does anything Hornhoof itself may (Ivan's word of 17 November 2026),
   in any turn; the head of Operations' only reads. The map is told to look again after a change. */
export function registerDatabaseTool(server: McpServer, ctx: Ctx, job: ToolJob, mode: SqlMode): void {
  server.registerTool('database', { description: DESCRIPTIONS[mode], inputSchema: { sql: z.string().trim().min(1).max(20_000) } }, async ({ sql }) => {
    const agentSql = ctx.agentSql;
    if (!agentSql) return say(ctx.agentSqlPending ? 'Hornhoof is starting.' : "This Hornhoof's database does not let Hornhoof make the role this tool runs as.", true);
    return runSql(ctx, agentSql, job, sql, mode);
  });
}
