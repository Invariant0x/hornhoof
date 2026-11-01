import { Task43Invoke } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../../app.js';
import { authorizeTask43 } from './auth.js';
import { Task43Error, task43Error, task43ErrorBody } from './errors.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

export function registerTask43TransferTool(server: McpServer, ctx: Ctx, job: { id: string }, signal: AbortSignal): void {
  server.registerTool(
    'transfer_task_artifact',
    {
      description: 'Copy the one delegated task43 artifact for the currently running Operations task56. Arguments: task must be 56; requestId is a UUID.',
      inputSchema: Task43Invoke,
    },
    async ({ task, requestId }) => {
      try {
        const auth = await authorizeTask43(ctx, job.id, ctx.task43.policy);
        const receipt = await ctx.task43.transfer(auth, requestId, signal);
        return say(JSON.stringify(receipt), receipt.status === 'failed');
      } catch (error) {
        if (error instanceof Task43Error) return say(JSON.stringify(task43ErrorBody(error)), true);
        const safe = task43Error('unavailable', 'io_failed', 'The transfer could not be completed.');
        return say(JSON.stringify(task43ErrorBody(safe)), true);
      }
    },
  );
}
