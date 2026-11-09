import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents } from '../../db/schema.js';
import { agentBriefing } from './briefing.js';

type ToolJob = { companyId: string; agentId: string };

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* What an agent's department and product keep for it. It reads it when it decides to: at its start, or when it needs the
   repositories or the rules of work again. Nothing of it goes into its messages. */
export function registerBriefingTool(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'briefing',
    {
      description:
        'What your department and your product keep for their agents: their own way of working and the repositories they work in, each with its branch, rules and commit author; ' +
        'the one cloned in your folder comes first, with where it is. Read it when you start on their work or need it again; people change it on the department screen.',
    },
    async () => {
      const [me] = await ctx.db.select({ companyId: agents.companyId, departmentId: agents.departmentId, productId: agents.productId }).from(agents).where(eq(agents.id, job.agentId));
      const briefing = me && me.companyId === job.companyId ? await agentBriefing(ctx.db, me) : null;
      return briefing ? say(JSON.stringify(briefing)) : say('You belong to no department, so nothing is kept for you here.');
    },
  );
}
