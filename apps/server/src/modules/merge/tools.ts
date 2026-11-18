import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import type { ToolJob } from '../tools/job.js';
import { conflictsOf, pick, type Picker } from './picks.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const FILTER = {
  merge: z.uuid().optional().describe('Only the conflicts of this merge.'),
  table: z.string().trim().min(1).max(63).optional().describe('Only the conflicts of rows of this table.'),
  from: z.iso.datetime().optional().describe('Only those the other side changed at or after this time.'),
  to: z.iso.datetime().optional().describe('Only those the other side changed at or before this time.'),
};
const whenOf = (said: { from?: string; to?: string }) => ({ ...(said.from ? { from: new Date(said.from) } : {}), ...(said.to ? { to: new Date(said.to) } : {}) });

/* The orchestrator sees every conflict. A pick that permanently deletes a row needs the CEO. */
export function registerMergeTools(server: McpServer, ctx: Ctx, job: ToolJob): void {
  const who: Picker = { kind: 'orchestrator', agentId: job.agentId };

  server.registerTool(
    'merge_conflicts',
    {
      description: 'What a merge could not prove: each conflict with both values, the task it belongs to and whose it is. Open ones by default.',
      inputSchema: {
        ...FILTER,
        settled: z.boolean().optional().describe('True lists the settled ones in place of the open ones.'),
        after: z.uuid().optional().describe('The id of the last conflict of the page before.'),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ merge, table, from, to, settled, after, limit }) => say(JSON.stringify(await conflictsOf(ctx.db, { merge, table, ...whenOf({ from, to }), settled, after, limit }))),
  );

  server.registerTool(
    'merge_pick',
    {
      description: "Settles conflicts: here keeps this company's value, there takes the other side's, value writes yours for one conflict. In bulk by merge, table or time range.",
      inputSchema: {
        ids: z.array(z.uuid()).min(1).max(500).optional().describe('The conflicts to settle, by their ids.'),
        ...FILTER,
        take: z.enum(['here', 'there', 'value']),
        value: z.record(z.string(), z.unknown()).optional().describe('With take value: the columns of the one conflict and what to write into each.'),
      },
    },
    async ({ ids, merge, table, from, to, take, value }) => {
      try {
        const done = await pick(ctx, who, { ids, merge, table, ...whenOf({ from, to }) }, take, value);
        const lines = [`Settled ${done.settled}: kept here ${done.here}, took there ${done.there}.`];
        if (done.refused.length > 0) lines.push(`Refused ${done.refused.length}: ${done.refused.map(refused => `${refused.id}: ${refused.why}`).join('; ')}`);
        if (done.tasks.length > 0) lines.push(`Tasks changed: ${done.tasks.map(task => `#${task.number}`).join(', ')}. Tell their holders.`);
        return say(lines.join('\n'));
      } catch (err) {
        if (err instanceof ApiError) return say(err.message, true);
        throw err;
      }
    },
  );
}
