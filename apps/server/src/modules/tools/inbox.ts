import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { inboxChanged, inboxView, markMail, type InboxRow } from '../conversation/inbox.js';
import type { ToolJob } from './job.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const letterOf = (row: InboxRow) => ({
  id: row.id,
  from: row.senderName,
  sender: row.senderAgentId,
  task: row.taskNumber,
  kind: row.kind,
  at: row.createdAt.toISOString(),
  text: row.text,
  status: row.status,
});

/* The employee's own inbox: what other employees, the orchestrator and Hornhoof wrote to it, read in any turn, and marked
   once read or dealt with. Nobody reads or marks another's. */
export function registerInboxTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'inbox',
    {
      description:
        'Your inbox: the letters other employees, the orchestrator and Hornhoof wrote to you, oldest first, with who sent each, its task and whether you read it. ' +
        'By default only the unread ones; status all gives the history. Filter by task number or by the employee who sent it; before takes the id of a letter to page back from it.',
      inputSchema: {
        status: z.enum(['unread', 'read', 'done', 'all']).optional(),
        task: z.number().int().positive().optional(),
        sender: z.uuid().optional().describe("The sending employee's id."),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.uuid().optional(),
      },
    },
    async filter => {
      const view = await inboxView(ctx.db, job.agentId, filter);
      return say(JSON.stringify({ unread: view.unread, letters: view.letters.map(letterOf) }));
    },
  );
  server.registerTool(
    'inbox_mark',
    {
      description: 'Marks letters of your inbox: read once you read them, done once you dealt with them. A letter marked before the turn that takes your inbox goes out needs no turn of its own.',
      inputSchema: { ids: z.array(z.uuid()).min(1).max(200), status: z.enum(['read', 'done']) },
    },
    async ({ ids, status }) => {
      const marked = await markMail(ctx.db, job.agentId, ids, status);
      if (marked === null) return say('Some of these letters are not in your inbox. Nothing was marked. Call inbox for the ids of yours.', true);
      await inboxChanged(ctx, job.agentId);
      return say(`Marked ${marked} ${marked === 1 ? 'letter' : 'letters'} ${status}.`);
    },
  );
}
