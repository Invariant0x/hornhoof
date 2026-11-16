import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { orchestratorDecisionHeaders } from '../../auth/internal.js';
import { agents, departments, teams } from '../../db/schema.js';
import type { AgentCard } from '../agents/routes.js';
import { AgentPatch } from '../agents/routes.js';
import { standingPrincipal } from '../conversation/decision-context.js';
import { hireLines } from './control.js';
import type { ToolJob } from './job.js';
import { departmentOf, StaffLine, staffingOptions } from './staff.js';
import { ChangeItem } from './structure.js';

/* A head runs its own department in any turn with its named owner's rights, otherwise the CEO's. The same screen routes
   keep current permissions and record the acting head and whose rights it used. Tools remain limited to its department,
   products, sub-units and employees, even when its principal is the CEO. */

type Call = { method: HTTPMethods; url: string; payload?: unknown };

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Id = (what: string) => z.uuid().describe(`The ${what}'s id, from company or staffing_options.`);

const NO_PRINCIPAL = 'No active department owner or CEO is available, or input for this turn is still being recorded. Nothing was changed.';
const NOT_THEIRS = 'The person whose rights you use may not decide this. Nothing was changed. Check your department rules and access.';
const outside = (what: string) => `${what} is not in your department. Nothing was changed. You change only your own department: its sub-units, products and employees.`;

/* Why the route refused, in the head's words: the person it went for may not do it there, or the turn answers nobody. */
const REFUSED: Record<string, string> = {
  decision_not_allowed: NOT_THEIRS,
  department_owner_only: NOT_THEIRS,
  company_scope_only: NOT_THEIRS,
  not_your_department: NOT_THEIRS,
  agent_hidden: NOT_THEIRS,
  decision_context_missing: NO_PRINCIPAL,
};

const errorOf = (body: string): { message?: string; reason?: string } => {
  try {
    return (JSON.parse(body) as { error?: { message?: string; reason?: string } }).error ?? {};
  } catch {
    return {};
  }
};

/* The route's answer, or why it refused. */
function answered(res: { statusCode: number; body: string }, shown: (body: string) => string = body => body) {
  if (res.statusCode < 400) return say(res.body ? shown(res.body) : 'Done.');
  const { message, reason } = errorOf(res.body);
  return say(REFUSED[reason ?? ''] ?? message ?? `Hornhoof answered ${res.statusCode}.`, true);
}

/* An employee as the head needs to read it back after a change: what the card holds, without its instructions. */
const employeeLine = (body: string): string => {
  const card = JSON.parse(body) as AgentCard;
  return JSON.stringify({
    id: card.id,
    name: card.name,
    team: card.team,
    model: card.model,
    effort: card.effort,
    subscription: card.subscription ? { id: card.subscription.id, label: card.subscription.label } : null,
    state: card.state,
    skills: card.skills.filter(s => s.on).map(s => s.id),
  });
};

export function registerDepartmentControlTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  const own = job.departmentId;
  const inject = (made: Call, personId: string, sourceSeq: number | null) =>
    app.inject({
      method: made.method,
      url: made.url,
      headers: orchestratorDecisionHeaders({ personId, sourceSeq, agentId: job.agentId, jobId: job.id }),
      ...(made.payload === undefined ? {} : { payload: made.payload as object }),
    });

  /* A change goes with the current department owner's rights, otherwise the CEO's, in any turn. A structure change or a hire
     the route keeps under the head's input lock, checking that again; any other change it makes at once, as from that
     person's screen. The lock is not held around a route here: what the route moves may wake the head, and words for its
     turn take that lock. */
  const asPerson = async (made: Call, shown?: (body: string) => string) => {
    const principal = await standingPrincipal(ctx.db, job.id);
    if (!principal) return say(NO_PRINCIPAL, true);
    return answered(await inject(made, principal.personId, principal.sourceSeq), shown);
  };

  /* An employee of the head's own department, itself too: never the orchestrator, an assistant's agent or anyone elsewhere. */
  const ownEmployee = async (id: string): Promise<string | null> => {
    const [agent] = await ctx.db.select({ departmentId: agents.departmentId, kind: agents.kind }).from(agents).where(and(eq(agents.id, id), eq(agents.companyId, job.companyId), isNull(agents.removedAt)));
    return own && agent && agent.departmentId === own && (agent.kind === 'head' || agent.kind === 'worker') ? null : outside(`The employee ${id}`);
  };
  const ownDepartment = async () => (own ? departmentOf(ctx.db, job.companyId, own) : null);

  server.registerTool(
    'staffing_options',
    {
      description:
        'What your department can be staffed with: its products and employees, its roster of roles with their skills (locked ones every employee keeps), ' +
        'and the subscriptions and API keys that may serve it with the models each can run. Call it before hire.',
    },
    async () => {
      const dept = await ownDepartment();
      return dept ? say(JSON.stringify(await staffingOptions(ctx, job.companyId, dept))) : say(outside('This'), true);
    },
  );

  server.registerTool(
    'hire',
    {
      description:
        'Hires employees into your department in any turn with its named owner\'s rights, otherwise the CEO\'s, under your department rules. ' +
        'Each person is { role, name?, product?, team?, model?, subscription?, skills?: { on, off } }: left out, the name is the role\'s title, the model is Default, ' +
        'the subscription is the first one that serves the department and runs the role, and the skills are the role\'s. Call staffing_options first. A department has one head.',
      inputSchema: { people: z.array(StaffLine.omit({ checked: true })).min(1).max(30) },
    },
    async ({ people: lines }) => {
      const dept = await ownDepartment();
      if (!dept) return say(outside('This'), true);
      return asPerson({ method: 'POST', url: `/api/departments/${dept.id}/staff`, payload: { people: await hireLines(ctx, job.companyId, dept, lines) } });
    },
  );

  server.registerTool(
    'change_department',
    {
      description:
        'Changes your department in any turn with its named owner\'s rights, otherwise the CEO\'s, under your department rules: teams creates sub-units by name, ' +
        'renames ({ id, name }) or removes ({ id, remove: true }) existing ones, whose employees go back to the department\'s pipeline; products adds products by name, ' +
        'each with the people its template keeps for a product; removeProducts takes away products with no employees, people, keys or open tasks; ' +
        'about replaces the department description, such as the measures its pipeline report counts. ' +
        'A new department, another department and removing your own stay with the CEO.',
      inputSchema: {
        teams: ChangeItem.shape.teams,
        products: ChangeItem.shape.products,
        removeProducts: z.array(z.uuid()).max(10).optional(),
        about: z.string().trim().max(160).optional().describe('The new department description, up to 160 characters; empty clears it.'),
      },
    },
    async ({ teams: units, products, removeProducts = [], about }) => {
      if (!own) return say(outside('This'), true);
      const mine = new Set((await ctx.db.select({ id: departments.id }).from(departments).where(and(eq(departments.parentId, own), eq(departments.companyId, job.companyId)))).map(d => d.id));
      const stranger = removeProducts.find(id => !mine.has(id));
      if (stranger) return say(outside(`The product ${stranger}`), true);
      const items = [
        ...(units?.length || products?.length || about !== undefined
          ? [{ department: own, ...(units?.length ? { teams: units } : {}), ...(products?.length ? { products } : {}), ...(about !== undefined ? { about } : {}) }]
          : []),
        ...removeProducts.map(id => ({ department: id, remove: true })),
      ];
      if (!items.length) return say('Say what changes: teams, products, removeProducts or about.', true);
      return asPerson({ method: 'POST', url: '/api/departments/build', payload: { items } });
    },
  );

  server.registerTool(
    'set_team_urgent_only',
    {
      description:
        'Says whether a sub-unit of your department takes only urgent work, in any turn under your department rules. ' +
        'Who is in it holds what they hold; from then on work that is not urgent is not given to them.',
      inputSchema: { team: Id('sub-unit'), urgentOnly: z.boolean() },
    },
    async ({ team, urgentOnly }) => {
      const [unit] = own ? await ctx.db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, team), eq(teams.departmentId, own), eq(teams.companyId, job.companyId))) : [];
      if (!unit) return say(outside(`The sub-unit ${team}`), true);
      return asPerson({ method: 'PATCH', url: `/api/departments/${own}/teams/${team}`, payload: { urgentOnly } });
    },
  );

  server.registerTool(
    'change_employee',
    {
      description:
        'Changes an employee of your department as its card does, in any turn with its named owner\'s rights, otherwise the CEO\'s, under your department rules: ' +
        "name, model ('' for Default), effort (a level its model takes, null for its role's level fitted to its model), subscription (null for none), " +
        'team (sub-unit id in your department, or null for the pipeline), skills { id: on/off }, base (its personal assignment, null to clear it), skillText { id: text or null }, ' +
        'on (false switches it off: it ends the turn it runs and takes no task turns until it is on again), and timer { minutes, order, forWork? } (null for none). ' +
        'What that person may not change on the card is refused here too.',
      inputSchema: { employee: Id('employee'), ...AgentPatch.shape },
    },
    async ({ employee, ...body }) => {
      const refused = await ownEmployee(employee);
      return refused ? say(refused, true) : asPerson({ method: 'PATCH', url: `/api/agents/${employee}`, payload: body }, employeeLine);
    },
  );

  server.registerTool(
    'reset_employee',
    {
      description:
        'Puts an employee of your department back to its role as the templates have it now: its skills, texts and effort. Its model and subscription stay. ' +
        'In any turn with your department owner\'s rights, otherwise the CEO\'s, under its rules.',
      inputSchema: { employee: Id('employee') },
    },
    async ({ employee }) => {
      const refused = await ownEmployee(employee);
      return refused ? say(refused, true) : asPerson({ method: 'POST', url: `/api/agents/${employee}/reset` }, employeeLine);
    },
  );

  server.registerTool(
    'fire_employee',
    {
      description:
        'Removes an employee of your department from the company in any turn under your department rules. ' +
        'Its history stays. Not while it works or holds tasks, and never yourself.',
      inputSchema: { employee: Id('employee') },
    },
    async ({ employee }) => {
      if (employee === job.agentId) return say('You cannot remove yourself. The people who run your department remove you on its screen, if they want to.', true);
      const refused = await ownEmployee(employee);
      return refused ? say(refused, true) : asPerson({ method: 'DELETE', url: `/api/agents/${employee}` });
    },
  );
}
