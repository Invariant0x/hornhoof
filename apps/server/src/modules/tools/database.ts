import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { HIDDEN, SECRET, type SqlMode } from '../../db/agent-sql.js';

type ToolJob = { companyId: string };

/* Answers longer than this are cut, as view's are. */
const MAX_ANSWER = 30_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const SECRETS = Object.values(SECRET).flat().join(', ');
const CLOSED = 'Sign-ins, invites, install codes and the public link are closed to this tool.';
export const READ_ONLY = 'Operations reads the database; a change goes to the orchestrator as one message with the SQL and why.';
const PEOPLE = "People and what they reach change only through the people tools, which make the CEO's checks.";
/* What the orchestrator may not do with a table, in the words he acts on. */
const RULES: Record<string, string> = {
  people: PEOPLE,
  person_access: PEOPLE,
  agents:
    "Employees come by hire and go by fire_employee, and their skills change by change_employee, which make the CEO's checks; kind and role_key never change, and a head stays in its department.",
  jobs: 'Hornhoof starts the turns: the tool changes only their status, error and finished_at.',
};
const secretsOf = (table: string) => {
  const columns = SECRET[table];
  if (!columns) return undefined;
  return `${columns.join(' and ')} ${columns.length > 1 ? 'are' : 'is'} closed to this tool: name the other columns of ${table} instead of *.`;
};

/* The database's words, and after them why, when it refused. A read-only role refused only a write, unless the table is
   hidden or has secrets. */
function refusal(err: Error & { code?: string }, mode: SqlMode): string {
  const table = /permission denied for table "?(\w+)"?/.exec(err.message)?.[1];
  const denied = err.code === '42501' || /permission denied/.test(err.message);
  let why: string | undefined;
  if (table && HIDDEN.includes(table)) why = CLOSED;
  else if (mode === 'read') {
    if (denied && table && SECRET[table]) why = secretsOf(table);
    else if (denied || err.code === '25006' || /read-only transaction/.test(err.message)) why = READ_ONLY;
  } else if (table) why = [RULES[table], secretsOf(table)].filter(Boolean).join(' ') || undefined;
  return `The database answered: ${err.message}${why ? `. ${why}` : ''}`;
}

const DESCRIPTIONS: Record<SqlMode, string> = {
  write:
    "Runs SQL on Hornhoof's own Postgres database, for what no other tool does: fixing a stuck row, changing a field, removing what the screens cannot. " +
    'Several statements run in one transaction and are undone together when one fails; a call may take 15 seconds. It reads and changes the rows of every table ' +
    `but sign-ins, invites, install codes and the public link, and never the columns with secrets (${SECRETS}), so name columns instead of * on those tables. ` +
    "People and their access, an employee's kind, role and skills, a head's department and a turn but its status change only through the other tools. " +
    'It cannot change the tables themselves. A change skips the checks and notices the other tools make, so prefer them, read before you write and change only ' +
    'the rows you mean. Each statement comes back as { rows, changed }.',
  read:
    "Reads Hornhoof's own Postgres database, to find what went wrong: stuck rows, failed turns, who changed what and when. Several statements run in one " +
    'transaction; a call may take 15 seconds. It reads the rows of every table but sign-ins, invites, install codes and the public link, and never the columns ' +
    `with secrets (${SECRETS}), so name columns instead of * on those tables. ${READ_ONLY} Each statement comes back as { rows, changed }.`,
};

/* SQL on Hornhoof's own database, for what the other tools do not reach: the orchestrator's changes rows, the head of
   Operations' only reads. The map is told to look again after a change. */
export function registerDatabaseTool(server: McpServer, ctx: Ctx, job: ToolJob, mode: SqlMode): void {
  server.registerTool('database', { description: DESCRIPTIONS[mode], inputSchema: { sql: z.string().trim().min(1).max(20_000) } }, async ({ sql }) => {
    if (!ctx.agentSql) return say("This Hornhoof's database does not let Hornhoof make the role this tool runs as.", true);
    try {
      const answers = await ctx.agentSql.run(sql, mode);
      if (answers.some(a => a.changed > 0)) ctx.bus.publish(job.companyId, { type: 'org' });
      const body = JSON.stringify(answers);
      return say(body.length > MAX_ANSWER ? `${body.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : body);
    } catch (err) {
      return say(refusal(err as Error, mode), true);
    }
  });
}
