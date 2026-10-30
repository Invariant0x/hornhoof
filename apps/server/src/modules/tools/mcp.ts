import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { agents, jobs, proposals } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { appendEvent } from '../events/store.js';
import { companyView } from './company.js';
import { checkItems, Proposal } from './structure.js';

type ToolJob = { id: string; companyId: string; agentId: string; agentKind: (typeof agents.$inferSelect)['kind'] };

/* The token works only while its job runs, and only for a job that belongs to an agent. */
async function jobOf(ctx: Ctx, req: FastifyRequest): Promise<ToolJob> {
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
  const [job] = token
    ? await ctx.db
        .select({ id: jobs.id, companyId: jobs.companyId, agentId: agents.id, agentKind: agents.kind })
        .from(jobs)
        .innerJoin(agents, eq(agents.id, jobs.agentId))
        .where(and(eq(jobs.toolTokenHash, hashToken(token)), eq(jobs.status, 'running')))
    : [];
  if (!job) throw new ApiError(401, 'unauthorized', 'This tool token is not valid.', 'tool_token_invalid');
  return job;
}

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* Hornhoof's tools as one agent's job sees them: every agent reads the company, only the orchestrator proposes.
   Departments and employees are never created here: the CEO's click does that. */
function toolsFor(ctx: Ctx, job: ToolJob): McpServer {
  const server = new McpServer({ name: 'hornhoof', version: '0.4.0' });
  server.registerTool(
    'company',
    { description: 'The company as it is now: its brief, the people who run it, departments with their products, subscriptions, and the department templates.' },
    async () => say(JSON.stringify(await companyView(ctx.db, job.companyId))),
  );
  if (job.agentKind !== 'orchestrator') return server;
  server.registerTool(
    'propose_structure',
    {
      description:
        'Shows the CEO a card with departments to create or change and returns at once. The CEO decides with one click; wait for their answer. ' +
        'brief: two to five sentences about the company. Each item is a new department { template, name?, checked, note, products? } ' +
        '(name only when a template is used a second time) or a change { department, checked, note, products?, remove? }. A newer card replaces the older one.',
      inputSchema: Proposal.shape,
    },
    async ({ brief, items }) => {
      const problem = await checkItems(ctx.db, job.companyId, items);
      if (problem) return say(problem, true);
      const proposal = await ctx.db.transaction(async tx => {
        await tx.update(proposals).set({ status: 'dismissed' }).where(and(eq(proposals.companyId, job.companyId), eq(proposals.status, 'pending')));
        const [row] = await tx.insert(proposals).values({ companyId: job.companyId, agentId: job.agentId, jobId: job.id, brief, items }).returning({ id: proposals.id });
        return row!;
      });
      await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'proposal', data: { proposalId: proposal.id, brief, items } });
      return say('Shown to the CEO. Wait for their answer.');
    },
  );
  return server;
}

/* Streamable HTTP without sessions: every POST gets its own server and transport. */
export function mcpRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/mcp', async (req, reply) => {
    const job = await jobOf(ctx, req);
    const server = toolsFor(ctx, job);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: '/mcp', handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send({ error: { code: 'method_not_allowed', message: 'Use POST.' } }) });
  }
}
