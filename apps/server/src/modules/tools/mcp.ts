import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { proposals } from '../../db/schema.js';
import { appendEvent } from '../events/store.js';
import { companyView } from './company.js';
import { jobOf, type ToolJob } from './job.js';
import { registerControlTools } from './control.js';
import { registerDatabaseTool } from './database.js';
import { checkStaff, departmentOf, StaffProposal, staffingOptions } from './staff.js';
import { checkItems, Proposal } from './structure.js';
import { registerTaskTools } from '../tasks/tools.js';
import { registerWatchTools } from './watch.js';
import { registerHeadNotebookTools } from '../notebook/tools.js';
import { registerImprovementTools, registerOrchestratorImprovementTools } from '../improvements/tools.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* Hornhoof's tools as one agent's job sees them: every agent reads the company, an employee gets the tools its skills
   grant, a head keeps its department notebook, tells the orchestrator and puts what to improve under Improvements, and the
   orchestrator also proposes cards and does whatever the CEO can do in the screens. */
function toolsFor(ctx: Ctx, app: FastifyInstance, job: ToolJob): McpServer {
  const server = new McpServer({ name: 'hornhoof', version: '0.5.0' });
  server.registerTool(
    'company',
    { description: 'The company as it is now: its brief, the people who run it, departments with their products and employees, subscriptions, and the department templates.' },
    async () => say(JSON.stringify(await companyView(ctx.db, ctx.templates, job.companyId))),
  );
  registerTaskTools(server, ctx, job);
  if (job.agentKind !== 'orchestrator') {
    const grants = new Set(job.skills.flatMap(id => ctx.templates.skills.get(id)?.grants ?? []));
    registerWatchTools(server, ctx, job, grants);
    if (job.agentKind === 'head') registerHeadNotebookTools(server, ctx, job);
    if (job.agentKind === 'head' || grants.has('improvements')) registerImprovementTools(server, ctx, job);
    return server;
  }
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
        await tx.update(proposals).set({ status: 'dismissed' }).where(and(eq(proposals.companyId, job.companyId), eq(proposals.kind, 'structure'), eq(proposals.status, 'pending')));
        const [row] = await tx.insert(proposals).values({ companyId: job.companyId, agentId: job.agentId, jobId: job.id, brief, items }).returning({ id: proposals.id });
        return row!;
      });
      await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'proposal', data: { proposalId: proposal.id, brief, items } });
      return say('Shown to the CEO. Wait for their answer.');
    },
  );
  server.registerTool(
    'staffing_options',
    {
      description:
        'What a department can be staffed with: the department with its products and employees, its roster of roles with their skills ' +
        '(locked ones every employee keeps), and the subscriptions and API keys that may serve it with the models each can run. Call it before propose_staff.',
      inputSchema: { department: z.uuid() },
    },
    async ({ department }) => {
      const dept = await departmentOf(ctx.db, job.companyId, department);
      if (!dept) return say(`There is no department with id ${department}. Call company to see the current ids.`, true);
      return say(JSON.stringify(await staffingOptions(ctx, job.companyId, dept)));
    },
  );
  server.registerTool(
    'propose_staff',
    {
      description:
        'Shows the CEO a card with employees to hire into one department and returns at once. The CEO unticks, changes models or subscriptions, and decides with one click; wait for their answer. ' +
        'brief: what the department will do first, in one to three sentences. Each person is { role, name?, product?, model?, subscription?, skills?: { on, off }, checked }: ' +
        'role and product ids from staffing_options, model one the subscription runs (left out for Default), skills only where they differ from the role. A newer card for the same department replaces the older one.',
      inputSchema: StaffProposal.shape,
    },
    async ({ department, brief, people }) => {
      const dept = await departmentOf(ctx.db, job.companyId, department);
      if (!dept) return say(`There is no department with id ${department}. Call company to see the current ids.`, true);
      const problem = await checkStaff(ctx, job.companyId, dept, people.map(p => ({ ...p, skills: p.skills ?? { on: [], off: [] } })));
      if (problem) return say(problem, true);
      const proposal = await ctx.db.transaction(async tx => {
        await tx
          .update(proposals)
          .set({ status: 'dismissed' })
          .where(and(eq(proposals.companyId, job.companyId), eq(proposals.kind, 'staff'), eq(proposals.departmentId, dept.id), eq(proposals.status, 'pending')));
        const [row] = await tx
          .insert(proposals)
          .values({ companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'staff', departmentId: dept.id, brief, items: people })
          .returning({ id: proposals.id });
        return row!;
      });
      await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'proposal', data: { proposalId: proposal.id, kind: 'staff', department: dept.id, brief, people } });
      return say('Shown to the CEO. Wait for their answer.');
    },
  );
  registerControlTools(server, ctx, app, job);
  registerDatabaseTool(server, ctx, job);
  registerOrchestratorImprovementTools(server, ctx, job);
  return server;
}

/* Streamable HTTP without sessions: every POST gets its own server and transport. */
export function mcpRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/mcp', async (req, reply) => {
    const job = await jobOf(ctx, req);
    const server = toolsFor(ctx, app, job);
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
