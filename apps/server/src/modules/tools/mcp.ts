import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { proposals } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import { appendEvent } from '../events/store.js';
import { isOperations } from '../operations/required.js';
import { ApiError } from '../../errors.js';
import { guardTools, invocationOf } from './calls.js';
import { callName, CUT_OFF, cutOff, PAUSED, READ_TOOLS } from './read-tools.js';
import { READ_ONLY_MESSAGE } from '../keeper/app-mode.js';
import { readKeeperState } from '../keeper/state.js';
import { companyView } from './company.js';
import { jobOf, type ToolJob } from './job.js';
import { answerOutside } from './outside.js';
import { registerApprovalControlTools, registerApprovalTools, registerHeadPolicyTools } from './approval-policy.js';
import { registerControlTools } from './control.js';
import { registerDepartmentControlTools } from './department-control.js';
import { registerComputerTools } from '../computer/tools.js';
import { registerMergeTools } from '../merge/tools.js';
import { registerDatabaseTool } from './database.js';
import { checkStaff, departmentOf, requiredState, StaffProposal, staffingOptions, withRequiredRoles } from './staff.js';
import { checkItems, Proposal } from './structure.js';
import { registerTaskTools } from '../tasks/tools.js';
import { registerTrackerTools } from '../tracker/tools.js';
import { registerTelegramTools } from '../telegram/tools.js';
import { registerGoogleSheetsTools } from '../google/tools.js';
import { registerTestTools } from '../testruns/tools.js';
import { registerInboxTools } from './inbox.js';
import { registerWatchTools } from './watch.js';
import { registerHeadNotebookTools } from '../notebook/tools.js';
import { registerBriefingTool } from '../briefings/tools.js';
import { registerImprovementTools, registerOrchestratorImprovementTools } from '../improvements/tools.js';
import { registerOutboundControlTools, registerOutboundHeadTools, registerOutboundTools } from '../outbound/extension.js';
import { assistantAgentTools } from '../assistants/mcp.js';
import { registerAssignmentTools } from '../agents/assignment.js';
import { registerProgramAccessTools } from '../program-operator/tools.js';
import { registerReleaseTool } from '../program-operator/release.js';

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/* The head of Operations keeps the company running, so it reads Hornhoof's database; changes stay with the orchestrator. */
export const DATABASE_ROLES = ['OPS-HEAD'];

type StaffLines = ReturnType<typeof withRequiredRoles>;

const withSkills = (lines: StaffLines) => lines.map(p => ({ ...p, skills: p.skills ?? { on: [], off: [] } }));

/* A card for Operations hires nobody when everyone ticked on it is already there. */
async function nothingToHire(ctx: Ctx, dept: Parameters<typeof withRequiredRoles>[0], lines: StaffLines): Promise<boolean> {
  if (!isOperations(dept)) return false;
  const state = await requiredState(ctx.db, dept);
  return lines.every(line => !line.checked || state(line.role).holder);
}

/* Hornhoof's tools as one agent's job sees them: every agent reads the company, an employee runs tests on free machines
   and gets the tools its skills grant, a head keeps its department notebook, changes its department as the people who run
   it decide, tells the orchestrator and puts what to improve under Improvements, and the orchestrator also proposes cards
   and does whatever the CEO can do in the screens. */
function toolsFor(ctx: Ctx, app: FastifyInstance, job: ToolJob, invocation: string | null, reading: { cut: boolean } | null = null): McpServer {
  const server = new McpServer({ name: 'hornhoof', version: '0.5.0' });
  /* Before any tool is registered, so that every one of them is covered. */
  guardTools(server, ctx, job, invocation);
  /* On a machine that only reads, no tool that changes something runs, however the call came: cut off, it tells the
     agent to wrap up; else, that the call did not run. */
  if (reading) cutOff(server, { text: reading.cut ? CUT_OFF : PAUSED });
  server.registerTool(
    'company',
    { description: "The company as it is now: its brief, the people who run it, departments with their products and employees, subscriptions, and the department templates. An employee with ownText has text of its own over its role's, which may narrow the work it takes: ask it before you give it work its role would." },
    async () => say(JSON.stringify(await companyView(ctx.db, ctx.templates, job.companyId))),
  );
  const grants = new Set(job.skills.flatMap(id => ctx.templates.skills.get(id)?.grants ?? []));
  registerTaskTools(server, ctx, job);
  registerTrackerTools(server, ctx, job, grants);
  registerInboxTools(server, ctx, job);
  registerTelegramTools(server, ctx, job);
  registerGoogleSheetsTools(server, ctx, job);
  registerApprovalTools(server, ctx, job);
  registerOutboundTools(server, ctx, job);
  if (job.agentKind !== 'orchestrator') {
    registerBriefingTool(server, ctx, job);
    registerWatchTools(server, ctx, job, grants);
    registerTestTools(server, ctx, job);
    if (job.agentKind === 'head') {
      registerHeadNotebookTools(server, ctx, job);
      registerAssignmentTools(server, ctx, job);
      registerDepartmentControlTools(server, ctx, app, job);
      registerHeadPolicyTools(server, ctx, app, job);
      registerOutboundHeadTools(server, ctx, app, job);
    }
    if (job.agentKind === 'head' || grants.has('improvements')) registerImprovementTools(server, ctx, job);
    if (job.agentKind === 'head' && job.roleKey !== null && DATABASE_ROLES.includes(job.roleKey)) registerDatabaseTool(server, ctx, job, 'read');
    return server;
  }
  server.registerTool(
    'propose_structure',
    {
      description:
        'Shows the CEO a card with departments to create or change and returns at once. The CEO decides with one click; wait for their answer. ' +
        'brief: two to five sentences about the company. Each item is a new department { template, name?, checked, note, products?, staff? } ' +
        '(name only when a template is used a second time; staff true brings the people of its template with it, each on the plan and model its role asks for, or waiting for a plan) or a change { department, checked, note, products?, remove? }. A newer card replaces the older one.',
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
      ctx.bus.publish(job.companyId, { type: 'requests', spot: { departmentId: null } });
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
        'role and product ids from staffing_options, model one the subscription runs (left out for Default), skills only where they differ from the role. A newer card for the same department replaces the older one. ' +
        'The roles staffing_options marks required are always on the card, ticked; a role with a holder is not hired again, so propose what the department needs on top.',
      inputSchema: StaffProposal.shape,
    },
    async ({ department, brief, people }) => {
      const dept = await departmentOf(ctx.db, job.companyId, department);
      if (!dept) return say(`There is no department with id ${department}. Call company to see the current ids.`, true);
      const lines = withRequiredRoles(dept, people);
      const problem = await checkStaff(ctx, job.companyId, dept, withSkills(lines));
      if (problem) return say(problem, true);
      if (await nothingToHire(ctx, dept, lines)) return say(`Nothing to hire in ${deptName(dept)}: everyone ticked on this card is already there. Tick a role it does not have, or show no card.`, true);
      const proposal = await ctx.db.transaction(async tx => {
        await tx
          .update(proposals)
          .set({ status: 'dismissed' })
          .where(and(eq(proposals.companyId, job.companyId), eq(proposals.kind, 'staff'), eq(proposals.departmentId, dept.id), eq(proposals.status, 'pending')));
        const [row] = await tx
          .insert(proposals)
          .values({ companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'staff', departmentId: dept.id, brief, items: lines })
          .returning({ id: proposals.id });
        return row!;
      });
      await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId: job.id, kind: 'proposal', data: { proposalId: proposal.id, kind: 'staff', department: dept.id, brief, people: lines } });
      ctx.bus.publish(job.companyId, { type: 'requests', spot: { departmentId: null } });
      return say('Shown to the CEO. Wait for their answer.');
    },
  );
  registerControlTools(server, ctx, app, job);
  registerApprovalControlTools(server, ctx, app, job);
  registerOutboundControlTools(server, ctx, app, job);
  registerComputerTools(server, ctx, job);
  /* The orchestrator answers for nothing standing still anywhere: it sees any employee's program, types into it and releases
     its recovery hold, as Operations do. */
  registerProgramAccessTools(server, ctx, job);
  registerReleaseTool(server, ctx, job);
  /* On a machine that only reads, the orchestrator reads the database as a head does. */
  registerDatabaseTool(server, ctx, job, reading ? 'read' : 'write');
  registerOrchestratorImprovementTools(server, ctx, job);
  registerMergeTools(server, ctx, job);
  return server;
}

/* Streamable HTTP without sessions: every POST gets its own server and transport. What a program sends with no turn
   running comes the same way, from inside, in a step of its own. */
export function mcpRoutes(app: FastifyInstance, ctx: Ctx): void {
  ctx.toolsOutside = (node, call) => answerOutside(app, ctx, node, call);
  app.post('/mcp', async (req, reply) => {
    /* On a machine that only reads: a tool that changes something is turned away before any tool runs while the
       machine has the internet, since it then only waits for the leader or for the CEO, and the front door tries the
       call again; without the internet the tool itself tells the agent to wrap up. A call there runs as one with no
       id, so nothing is written of it. Several calls in one request are not taken there, as the front door takes
       none: each call is judged by itself. */
    const reading = ctx.mode.current() === 'read' ? { cut: readKeeperState(ctx.config.controlDir)?.internet === false } : null;
    const paused = () => new ApiError(503, 'unavailable', READ_ONLY_MESSAGE, 'read_only');
    if (reading && Array.isArray(req.body)) throw new ApiError(400, 'validation', 'Hornhoof takes one call per request.');
    const name = reading && !reading.cut ? callName(req.body) : null;
    if (name !== null && !READ_TOOLS.has(name)) throw paused();
    /* A copy may not hold yet that this turn runs: on a machine that only reads, a token it does not know is one to
       try again, not one that is wrong. */
    const bears = /^Bearer \S+$/.test(req.headers.authorization ?? '');
    const job = await jobOf(ctx, req).catch((err: unknown) => {
      throw reading && bears && err instanceof ApiError && err.reason === 'tool_token_invalid' ? paused() : err;
    });
    /* An assistant's own agent works for its owner alone, with the owner's assistant tools, never the company's; on a
       machine that only reads it waits, as its tools keep what they do. */
    if (reading && job.agentKind === 'assistant') throw paused();
    const server = job.agentKind === 'assistant' ? await assistantAgentTools(ctx, job, callName(req.body)) : toolsFor(ctx, app, job, reading ? null : await invocationOf(req, ctx.config), reading);
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
