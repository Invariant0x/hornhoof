import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { orchestratorHeaders } from '../../auth/internal.js';
import { departments, people } from '../../db/schema.js';
import { AgentPatch } from '../agents/routes.js';
import { deptName } from '../departments/templates.js';
import { BuildBody, RepoBody } from '../departments/routes.js';
import { NOTE_MAX, NoteBody } from '../notebook/book.js';
import { InviteBody, PersonPatch } from '../people/routes.js';
import { ConnectBody, SubscriptionBody } from '../subscriptions/routes.js';
import { UpdateBody } from '../updates/routes.js';
import { departmentOf, runsTier, servingSubscriptions, skillsFor, spotIn, StaffLine, type HireLine } from './staff.js';

type ToolJob = { companyId: string; agentId: string };
type Call = { method: HTTPMethods; url: string; payload?: unknown };
type Dept = typeof departments.$inferSelect;
type Hire = Omit<StaffLine, 'checked'>;

/* Answers longer than this are cut, so one view does not fill the orchestrator's context. */
const MAX_ANSWER = 30_000;

/* Pages the orchestrator does not read with view: live streams, files and sign-in. */
const UNREAD = /^\/api\/(stream|attachments|auth|invites|setup|nodes)(\/|$)|\/terminal$/;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Id = (what: string) => z.uuid().describe(`The ${what}'s id, from company or view.`);

/* What the CEO can do in Hornhoof's screens, as the orchestrator's tools. Each one calls the same route the screen calls,
   as the company's owner, so it is allowed and refused exactly what the CEO is; Hornhoof records it as the orchestrator's. */
export function registerControlTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  async function send({ method, url, payload }: Call) {
    const [owner] = await ctx.db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.companyId, job.companyId), eq(people.isOwner, true)));
    if (!owner) return say('This company has no owner to act for.', true);
    const res = await app.inject({ method, url, headers: orchestratorHeaders(owner.id, job.agentId), ...(payload === undefined ? {} : { payload: payload as object }) });
    if (res.statusCode >= 400) return say(errorOf(res.body) ?? `Hornhoof answered ${res.statusCode}.`, true);
    if (!res.body) return say('Done.');
    return say(res.body.length > MAX_ANSWER ? `${res.body.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : res.body);
  }

  /* One tool for one screen action. The id fields name the thing in the address; the rest is the body. A call that
     cannot be made comes back as the reason. */
  const register = server.registerTool.bind(server) as (name: string, config: { description: string; inputSchema: z.ZodRawShape }, cb: (a: never) => Promise<ReturnType<typeof say>>) => unknown;
  const tool = <S extends z.ZodRawShape>(name: string, description: string, input: S, call: (a: z.infer<z.ZodObject<S>>) => Call | string | Promise<Call | string>) =>
    register(name, { description, inputSchema: input }, async (a: z.infer<z.ZodObject<S>>) => {
      const made = await call(a);
      return typeof made === 'string' ? say(made, true) : send(made);
    });

  tool(
    'view',
    'Reads any page of Hornhoof the CEO can open, as JSON: GET /api/org, /api/people, /api/subscriptions, /api/machines, /api/tasks?status=all, /api/tasks/<id>, ' +
      '/api/requests, /api/turns, /api/agents/<id> (an employee card with its skills, instructions and latest changes), /api/agents/<id>/events (its conversation), ' +
      '/api/departments/<id>/roster, /api/updates.',
    { path: z.string().trim().min(1).max(500).describe('The page address, starting with /api/.') },
    ({ path }) => {
      const url = new URL(path, 'http://hornhoof');
      if (!url.pathname.startsWith('/api/') || UNREAD.test(url.pathname)) return `${url.pathname} is not a page view reads. Use an /api/ page from the list.`;
      return { method: 'GET', url: url.pathname + url.search };
    },
  );

  tool(
    'build_structure',
    'Creates, changes and removes departments at once, as the CEO\'s click on a structure card does. brief: two to five sentences about the company, when it changed. ' +
      'Each item is a new department { template, name?, note?, products? } (name only when a template is used a second time) or a change { department, note?, products?, remove? }: ' +
      'products are added, remove takes a department without employees away with its products. proposalId applies a card you proposed.',
    BuildBody.shape,
    body => ({ method: 'POST', url: '/api/departments/build', payload: body }),
  );

  tool(
    'hire',
    'Hires employees into a department, as the CEO\'s click on a staff card does. Each person is { role, name?, product?, model?, subscription?, skills?: { on, off } } as in propose_staff: ' +
      'left out, the name is the role\'s title, the model is Default, the subscription is the first one that serves the department and runs the role, and the skills are the role\'s. ' +
      'Call staffing_options first. A department has one head. proposalId: the staff card this hires from, so it closes.',
    { department: Id('department'), proposalId: z.uuid().optional(), people: z.array(StaffLine.omit({ checked: true })).min(1).max(30) },
    async ({ department, proposalId, people: lines }) => {
      const url = `/api/departments/${department}/staff`;
      const dept = await departmentOf(ctx.db, job.companyId, department);
      return dept ? { method: 'POST', url, payload: { proposalId, people: await hireLines(ctx, job.companyId, dept, lines) } } : { method: 'POST', url };
    },
  );

  tool(
    'set_repository',
    'Connects the git repository a department\'s agents work in: an https address, the branch (main by default), a token that may push, and author { name, email } for their commits.',
    { department: Id('department'), ...RepoBody.shape },
    ({ department, ...body }) => ({ method: 'PUT', url: `/api/departments/${department}/repository`, payload: body }),
  );
  tool('remove_repository', 'Disconnects a department\'s git repository.', { department: Id('department') }, ({ department }) => ({ method: 'DELETE', url: `/api/departments/${department}/repository` }));

  tool(
    'change_employee',
    'Changes an employee as its card does: name, model (\'\' for Default), effort (a level its model takes, null for the program\'s default), subscription (null for none), skills { id: on/off }, base (its role text, null for the template\'s), ' +
      'skillText { id: text or null }, on (false switches it off: it ends the turn it runs and takes no task turns until it is on again), ' +
      'and timer { minutes, order, forWork? } (null for none): it wakes every so many minutes, 5 to 1440, outside any task, and does what the order says; ' +
      'with forWork true it skips a round while no task is open and nothing failed since the last one.',
    { employee: Id('employee'), ...AgentPatch.shape },
    ({ employee, ...body }) => ({ method: 'PATCH', url: `/api/agents/${employee}`, payload: body }),
  );
  tool('reset_employee', 'Puts an employee back to its role as the templates have it now: its skills and texts. Its model and subscription stay.', { employee: Id('employee') }, ({ employee }) => ({
    method: 'POST',
    url: `/api/agents/${employee}/reset`,
  }));
  tool('fire_employee', 'Removes an employee from the company. Its history stays. Not while it works or holds tasks.', { employee: Id('employee') }, ({ employee }) => ({ method: 'DELETE', url: `/api/agents/${employee}` }));
  tool(
    'message_employee',
    'Writes to an employee in its own window, as yourself. It reads it in its next turn, or at once when it is free.',
    { employee: Id('employee'), text: z.string().trim().min(1).max(4000) },
    ({ employee, text }) => ({ method: 'POST', url: `/api/agents/${employee}/messages`, payload: { text } }),
  );
  tool('stop_employee', 'Stops the turn an employee runs now, as Esc in its window does.', { employee: Id('employee') }, ({ employee }) => ({ method: 'POST', url: `/api/agents/${employee}/stop` }));

  tool(
    'answer_request',
    'Answers what an employee asked people (see /api/requests): answer for a question; approve true or false, with an optional answer, for a commit; pick (0 for the first way) for a choice; retry true for a stuck task.',
    {
      request: Id('request'),
      answer: z.string().max(4000).optional(),
      approve: z.boolean().optional(),
      pick: z.number().int().min(0).max(9).optional(),
      retry: z.literal(true).optional(),
    },
    ({ request, ...body }) => ({ method: 'POST', url: `/api/requests/${request}`, payload: body }),
  );

  tool(
    'explain_request',
    'Puts what an employee asks people into plain words for them, shown above their answer: which task and what for, what is needed from them and why, and the ways to go. In the CEO\'s language, without IT terms.',
    { request: Id('request'), text: z.string().min(1).max(3000) },
    ({ request, text }) => ({ method: 'POST', url: `/api/requests/${request}/explained`, payload: { text } }),
  );

  tool(
    'invite_person',
    'Invites a person: name, email, title, and access { whole: true } or { departments: [ids], teams: [ids] }. Returns the invite link for the CEO to send them.',
    InviteBody.shape,
    body => ({ method: 'POST', url: '/api/people/invite', payload: body }),
  );
  tool(
    'change_person',
    'Changes a person: title, access as for invite_person, status active or disabled. The owner stays as they are.',
    { person: Id('person'), ...PersonPatch.shape },
    ({ person, ...body }) => ({ method: 'PATCH', url: `/api/people/${person}`, payload: body }),
  );
  tool('invite_again', 'Makes a new invite link for a person who has not joined yet.', { person: Id('person') }, ({ person }) => ({ method: 'POST', url: `/api/people/${person}/invite` }));

  tool(
    'add_api_key',
    'Adds a company API key the CEO gave you: provider anthropic_api or openai_api, a label, the key, and target { kind: orchestrator | any } or { kind: department | team, id }.',
    SubscriptionBody.omit({ kind: true }).shape,
    body => ({ method: 'POST', url: '/api/subscriptions', payload: { kind: 'api_key', ...body } }),
  );
  tool(
    'connect_plans',
    'Connects the CEO\'s own plans (claude, codex, kimi, glm): returns the command the CEO runs on their machine.',
    ConnectBody.shape,
    body => ({ method: 'POST', url: '/api/subscriptions/connect', payload: body }),
  );
  tool('plan_command', 'A new machine command for one of the CEO\'s plans that waits for its machine.', { subscription: Id('subscription') }, ({ subscription }) => ({
    method: 'POST',
    url: `/api/subscriptions/${subscription}/command`,
  }));
  tool('test_subscription', 'Sends a tiny prompt through a subscription to prove it works; view /api/jobs/<id> for the answer.', { subscription: Id('subscription') }, ({ subscription }) => ({
    method: 'POST',
    url: `/api/subscriptions/${subscription}/test`,
  }));
  tool('move_orchestrator', 'Moves you, the orchestrator, to another subscription that serves the whole company.', { subscription: Id('subscription') }, ({ subscription }) => ({
    method: 'POST',
    url: `/api/subscriptions/${subscription}/orchestrator`,
  }));
  tool(
    'change_orchestrator',
    "Changes your own model ('' for Default) and effort (a level your model takes, null for the program's default), as your card does. They count from your next turn.",
    { model: AgentPatch.shape.model, effort: AgentPatch.shape.effort },
    body => ({ method: 'PATCH', url: `/api/agents/${job.agentId}`, payload: body }),
  );
  tool('remove_subscription', 'Removes a subscription or API key; the employees on it stay without one.', { subscription: Id('subscription') }, ({ subscription }) => ({
    method: 'DELETE',
    url: `/api/subscriptions/${subscription}`,
  }));
  tool('disconnect_machine', 'Disconnects a machine: its node stops and its subscriptions wait for a machine again.', { machine: Id('machine') }, ({ machine }) => ({
    method: 'POST',
    url: `/api/machines/${machine}/disconnect`,
  }));

  tool('check_updates', 'Looks for a newer Hornhoof now.', {}, () => ({ method: 'POST', url: '/api/updates/check' }));
  tool(
    'update_hornhoof',
    'Installs a Hornhoof version: version "latest" or a tag from check_updates. whenIdle waits until no agent works. Hornhoof restarts, and so does your turn.',
    UpdateBody.shape,
    body => ({ method: 'POST', url: '/api/updates', payload: body }),
  );
  tool('cancel_update', 'Calls off an update that waits for the agents to finish.', {}, () => ({ method: 'DELETE', url: '/api/updates' }));

  const Note = z.number().int().positive().describe('The note\'s number, as your notebook shows it, like 3 for [#3].');
  /* The company notebook, or with department the one its head carries. */
  const Book = { department: Id('department').optional().describe("A department's id for the notebook its head carries; left out, the company notebook.") };
  const bookUrl = (department: string | undefined) => (department ? `/api/departments/${department}/notebook` : '/api/notebook');
  tool('notebook', 'Reads the company notebook as it is now, or with department the one its head carries. People may change them while you work.', Book, ({ department }) => ({
    method: 'GET',
    url: bookUrl(department),
  }));
  tool(
    'remember',
    'Writes a note into the company notebook, which your instructions carry into every conversation: a decision, rule, preference or agreement that must outlive this one. One fact per note, ' +
      `${NOTE_MAX} characters at most. People who see the whole company read and change it too. With department it goes into that department's notebook, for its head.`,
    { ...Book, ...NoteBody.shape },
    ({ department, text }) => ({ method: 'POST', url: bookUrl(department), payload: { text } }),
  );
  tool('rewrite_note', 'Rewrites a note of the company notebook, or with department of that one, when what it says changed.', { ...Book, note: Note, ...NoteBody.shape }, ({ department, note, text }) => ({
    method: 'PATCH',
    url: `${bookUrl(department)}/${note}`,
    payload: { text },
  }));
  tool('forget', 'Removes a note that no longer holds from the company notebook, or with department from that one.', { ...Book, note: Note }, ({ department, note }) => ({
    method: 'DELETE',
    url: `${bookUrl(department)}/${note}`,
  }));
}

/* The staff card's lines from the orchestrator's: what it leaves out is what the card starts with. A role the department
   does not have goes through as it is, for the route to name. */
async function hireLines(ctx: Ctx, companyId: string, dept: Dept, lines: Hire[]): Promise<HireLine[]> {
  const products = await ctx.db.select().from(departments).where(eq(departments.parentId, dept.id));
  const out: HireLine[] = [];
  for (const line of lines) {
    const role = ctx.templates.roles.get(line.role);
    const product = products.find(p => p.id === line.product);
    const title = role?.title.en ?? line.role;
    const serving = line.subscription || !role ? [] : await servingSubscriptions(ctx, companyId, spotIn(dept, line.product ?? null));
    out.push({
      role: line.role,
      name: line.name ?? (product ? `${title} (${deptName(product)})` : title),
      product: line.product ?? null,
      model: line.model ?? '',
      subscription: line.subscription ?? serving.find(s => runsTier(s.provider, role!.tier))?.id ?? null,
      skills: role ? skillsFor(role, { ...line, checked: true }) : [],
    });
  }
  return out;
}

const errorOf = (body: string): string | undefined => {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
  } catch {
    return undefined;
  }
};
