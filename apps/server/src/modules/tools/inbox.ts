import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, LETTER_KINDS } from '../../db/schema.js';
import { agentParty } from '../events/parties.js';
import { inboxChanged, inboxView, logMarked, markMail, picksLetters, type InboxRow } from '../conversation/inbox.js';
import type { ToolJob } from './job.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const letterOf = (row: InboxRow) => ({
  id: row.id,
  from: row.senderName,
  sender: row.senderAgentId,
  task: row.taskNumber,
  kind: row.kind,
  source: row.source,
  at: row.createdAt.toISOString(),
  text: row.text,
  status: row.status,
});

const FORBIDDEN = "Forbidden: only the orchestrator reads and marks another employee's inbox. Leave out employee for your own.";
const noSuch = (id: string) => `There is no employee with id ${id} in the company. Call company for their ids.`;
const NO_PICK = 'Name the letters: ids, or a kind, a source, a task or receivedBefore. To take every letter, give receivedBefore as now.';
const NO_REASON = "Say why in reason: it goes in that employee's log with your name and how many letters you marked.";

const EMPLOYEE = z.uuid().optional().describe("Another employee's id, for its inbox; the orchestrator's alone. Left out: your own.");

type Inbox = { agentId: string; name: string; own: boolean };

/* Whose inbox the call is about: the caller's own, or, for the orchestrator alone, any employee's of the company. A
   person's own assistant is its owner's alone, and a removed employee is gone. */
async function inboxOf(ctx: Ctx, job: ToolJob, employee: string | undefined): Promise<Inbox | string> {
  if (employee === undefined || employee === job.agentId) return { agentId: job.agentId, name: 'your', own: true };
  if (job.agentKind !== 'orchestrator') return FORBIDDEN;
  const [found] = await ctx.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.id, employee), eq(agents.companyId, job.companyId), ne(agents.kind, 'assistant'), isNull(agents.removedAt)));
  return found ? { agentId: found.id, name: `${found.name}'s`, own: false } : noSuch(employee);
}

const marked = (count: number, status: string, inbox: Inbox) => `Marked ${count} ${count === 1 ? 'letter' : 'letters'} ${status}${inbox.own ? '' : ` in ${inbox.name} inbox`}.`;

/* The employee's own inbox: what other employees, the orchestrator and Hornhoof wrote to it, read in any turn, and marked
   once read or dealt with. The orchestrator answers for nothing standing still anywhere, so it reads any employee's
   letters whole and marks them too, in any turn of its own; each such mark goes in that employee's log with its reason. */
export function registerInboxTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'inbox',
    {
      description:
        'Your inbox: the letters other employees, the orchestrator and Hornhoof wrote to you, oldest first, with who sent each, its task and whether you read it. ' +
        'By default only the unread ones; status all gives the history. Filter by task number or by the employee who sent it; before takes the id of a letter to page back from it. ' +
        "The orchestrator reads any employee's inbox, letters whole, by its id in employee.",
      inputSchema: {
        employee: EMPLOYEE,
        status: z.enum(['unread', 'read', 'done', 'all']).optional(),
        task: z.number().int().positive().optional(),
        sender: z.uuid().optional().describe("The sending employee's id."),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.uuid().optional(),
      },
    },
    async ({ employee, ...filter }) => {
      const inbox = await inboxOf(ctx, job, employee);
      if (typeof inbox === 'string') return say(inbox, true);
      const view = await inboxView(ctx.db, inbox.agentId, filter);
      return say(JSON.stringify({ unread: view.unread, letters: view.letters.map(letterOf) }));
    },
  );
  server.registerTool(
    'inbox_mark',
    {
      description:
        'Marks letters of your inbox: read once you read them, done once you dealt with them. A letter marked before the turn that takes your inbox goes out needs no turn of its own. ' +
        'Name them by ids, or by kind, source, task and receivedBefore, which all apply together; read never takes back a letter marked done. ' +
        "The orchestrator marks any employee's letters by its id in employee, with a reason that goes in that employee's log with its name and how many it marked.",
      inputSchema: {
        employee: EMPLOYEE,
        ids: z.array(z.uuid()).min(1).max(200).optional(),
        kind: z.enum(LETTER_KINDS).optional().describe('message, report, comment, assignment or notification.'),
        source: z.string().trim().min(1).max(64).optional().describe("Which of Hornhoof's notices, as inbox shows it, such as program_alarm."),
        task: z.number().int().positive().optional(),
        receivedBefore: z.iso.datetime({ offset: true }).optional().describe('Only letters that came before this moment, in ISO time.'),
        status: z.enum(['read', 'done']),
        reason: z.string().trim().min(1).max(500).optional().describe("Why, for another employee's letters."),
      },
    },
    async ({ employee, status, reason, receivedBefore, ...rest }) => {
      const inbox = await inboxOf(ctx, job, employee);
      if (typeof inbox === 'string') return say(inbox, true);
      const pick = { ...rest, ...(receivedBefore ? { receivedBefore: new Date(receivedBefore) } : {}) };
      if (!picksLetters(pick)) return say(NO_PICK, true);
      if (!inbox.own && !reason) return say(NO_REASON, true);
      const count = await markMail(ctx.db, inbox.agentId, pick, status);
      if (count === null) return say(`Some of these letters are not in ${inbox.name} inbox. Nothing was marked. Call inbox for the ids.`, true);
      if (!inbox.own) await logMarked(ctx, { id: inbox.agentId, companyId: job.companyId }, { party: await orchestratorParty(ctx, job), reason: reason! }, status, count);
      await inboxChanged(ctx, inbox.agentId);
      return say(marked(count, status, inbox));
    },
  );
}

async function orchestratorParty(ctx: Ctx, job: ToolJob) {
  const party = await agentParty(ctx, job.companyId, job.agentId);
  return { ...party, kind: 'agent' as const, id: job.agentId };
}
