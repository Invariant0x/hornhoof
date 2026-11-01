import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';

type ToolJob = { companyId: string };

/* Answers longer than this are cut, as view's are. */
const MAX_ANSWER = 30_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* SQL on Hornhoof's own database, for what the other tools do not reach. The map is told to look again after a change. */
export function registerDatabaseTool(server: McpServer, ctx: Ctx, job: ToolJob): void {
  server.registerTool(
    'database',
    {
      description:
        "Runs SQL on Hornhoof's own Postgres database, for what no other tool does: fixing a stuck row, changing a field, removing what the screens cannot. " +
        'Several statements run in one transaction and are undone together when one fails; a call may take 15 seconds. It reads and changes the rows of every table ' +
        'but sign-ins, invites, install codes and passwords, and cannot change the tables themselves. A change skips the checks and notices the other tools make, ' +
        'so prefer them, read before you write and change only the rows you mean. Each statement comes back as { rows, changed }.',
      inputSchema: { sql: z.string().trim().min(1).max(20_000) },
    },
    async ({ sql }) => {
      if (!ctx.agentSql) return say("This Hornhoof's database does not let Hornhoof make the role this tool runs as.", true);
      try {
        const answers = await ctx.agentSql.run(sql);
        if (answers.some(a => a.changed > 0)) ctx.bus.publish(job.companyId, { type: 'org' });
        const body = JSON.stringify(answers);
        return say(body.length > MAX_ANSWER ? `${body.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : body);
      } catch (err) {
        return say(`The database answered: ${(err as Error).message}`, true);
      }
    },
  );
}
