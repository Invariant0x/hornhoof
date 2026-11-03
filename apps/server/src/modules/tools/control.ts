import { ORCHESTRATOR_EFFORT } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { orchestratorDecisionHeaders, orchestratorHeaders } from '../../auth/internal.js';
import { departments, people } from '../../db/schema.js';
import { AgentPatch } from '../agents/routes.js';
import { ceoPrincipal, decisionPrincipal, withInputLock } from '../conversation/decision-context.js';
import { deptName } from '../departments/templates.js';
import { BuildBody, RepoBody } from '../departments/routes.js';
import { LinkBody } from '../link/routes.js';
import { SHOWN_TO_CEO } from '../nodes/command.js';
import { LendBody } from '../nodes/routes.js';
import { NOTE_MAX, NoteBody } from '../notebook/book.js';
import { carriesFile, encodedHint } from '../tasks/attachments.js';
import { InviteBody, PersonPatch } from '../people/routes.js';
import { BudgetBody, ConnectBody, SubscriptionBody } from '../subscriptions/routes.js';
import { UpdateBody } from '../updates/routes.js';
import { departmentOf, runsTier, servingSubscriptions, skillsFor, spotIn, StaffLine, type HireLine } from './staff.js';

type ToolJob = { id: string; companyId: string; agentId: string };
/* asCeo: only the CEO may ask for this one call of a tool anyone may ask for. */
type Call = { method: HTTPMethods; url: string; payload?: unknown; asCeo?: true };
type Dept = typeof departments.$inferSelect;
type Hire = Omit<StaffLine, 'checked'>;

/* Answers longer than this are cut, so one view does not fill the orchestrator's context. */
const MAX_ANSWER = 30_000;

/* Pages the orchestrator does not read with view: live streams, files and sign-in. */
const UNREAD = /^\/api\/(stream|attachments|auth|invites|setup|nodes)(\/|$)|\/terminal$/;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Id = (what: string) => z.uuid().describe(`The ${what}'s id, from company or view.`);

/* The tools that change people, their access, money or the company's reach. The orchestrator is the CEO's hands, so he
   uses them only in a turn that answers the CEO or the CEO delegate now, as that person, never because an employee, a
   timer, a task or another person asked. */
export const CEO_ONLY = new Set([
  'invite_person',
  'change_person',
  'invite_again',
  'add_api_key',
  'connect_plans',
  'plan_command',
  'machine_command',
  'add_plan_to_machine',
  'set_budget',
  'move_orchestrator',
  'remove_subscription',
  'disconnect_machine',
  'lend_machine',
  'set_repository',
  'remove_repository',
  'set_public_link',
  'remove_public_link',
  'update_hornhoof',
]);
export const ONLY_CEO = 'Only the CEO or the CEO delegate can ask for this, in a turn that answers them: the last person who wrote into it. Nothing was changed. Ask the CEO first.';

/* The tools that take a decision for a person: the one this turn answers, who must have the right to take it. */
const DECIDES = new Set(['answer_request', 'build_structure', 'hire']);
const NO_PRINCIPAL =
  'This turn answers no person who may take a decision now: the last message in it came from an employee or from Hornhoof, or words for it are still on their way. ' +
  'Nothing was changed. Ask the person who takes it (the CEO, the CEO delegate or, for a department, its people) to decide it, or to tell you so in this window.';
const NOT_THEIRS =
  'The person this turn answers may not take this decision. Nothing was changed. Tell them who takes it (the CEO, the CEO delegate or, for a department, its people) and leave it to them.';

/* The tools that make a machine command. Hornhoof shows it to the CEO in this window and tells him only that, so the
   code reaches neither him nor his conversation. */
const SHOWS_COMMAND = new Set(['connect_plans', 'plan_command', 'machine_command', 'add_plan_to_machine']);

/* What the CEO can do in Hornhoof's screens, as the orchestrator's tools. Each one calls the same route the screen calls,
   as the company's owner, so it is allowed and refused exactly what the CEO is; what only the CEO asks for goes as the
   CEO or the CEO delegate the turn answers. Hornhoof records it as the orchestrator's. */
export function registerControlTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  /* One tool for one screen action. The id fields name the thing in the address; the rest is the body. A call that
     cannot be made comes back as the reason. */
  const register = server.registerTool.bind(server) as (name: string, config: { description: string; inputSchema: z.ZodRawShape }, cb: (a: never) => Promise<ReturnType<typeof say>>) => unknown;
  const tool = <S extends z.ZodRawShape>(name: string, description: string, input: S, call: (a: z.infer<z.ZodObject<S>>) => Call | string | Promise<Call | string>) =>
    register(name, { description, inputSchema: input }, async (a: z.infer<z.ZodObject<S>>) => {
      const made = await call(a);
      if (typeof made === 'string') return say(made, true);
      const answer = await carry(ctx, app, job, name, made);
      return SHOWS_COMMAND.has(name) && !answer.isError ? say(SHOWN_TO_CEO) : answer;
    });

  tool(
    'view',
    'Reads any page of Hornhoof the CEO can open, as JSON: GET /api/org, /api/people, /api/subscriptions, /api/machines, /api/tasks?status=all, /api/tasks/<id>, ' +
      '/api/requests, /api/turns, /api/agents/<id> (an employee card with its skills, instructions and latest changes), /api/agents/<id>/events (its conversation), ' +
      '/api/departments/<id>/roster, /api/updates, /api/link (the public link) and /api/link/names/<name> (whether a name for it is free).',
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
      'products are added, remove takes a department without employees away with its products. proposalId applies a card you proposed. ' +
      'Only in a turn that answers the CEO or the CEO delegate, as their decision.',
    BuildBody.shape,
    body => ({ method: 'POST', url: '/api/departments/build', payload: body }),
  );

  tool(
    'hire',
    'Hires employees into a department, as the CEO\'s click on a staff card does. Each person is { role, name?, product?, model?, subscription?, skills?: { on, off } } as in propose_staff: ' +
      'left out, the name is the role\'s title, the model is Default, the subscription is the first one that serves the department and runs the role, and the skills are the role\'s. ' +
      'Call staffing_options first. A department has one head. proposalId: the staff card this hires from, so it closes. ' +
      'Only in a turn that answers the CEO or the CEO delegate, as their decision.',
    { department: Id('department'), proposalId: z.uuid().optional(), people: z.array(StaffLine.omit({ checked: true })).min(1).max(30) },
    async ({ department, proposalId, people: lines }) => {
      const url = `/api/departments/${department}/staff`;
      const dept = await departmentOf(ctx.db, job.companyId, department);
      return dept ? { method: 'POST', url, payload: { proposalId, people: await hireLines(ctx, job.companyId, dept, lines) } } : { method: 'POST', url };
    },
  );

  tool(
    'set_repository',
    'Connects the git repository a department\'s agents work in: an https address, the branch (main by default), a token that may push, author { name, email } for their commits, ' +
      'and testMemoryGb, the free memory a machine needs to take a test run of it (4 by default).',
    { department: Id('department'), ...RepoBody.shape },
    ({ department, ...body }) => ({ method: 'PUT', url: `/api/departments/${department}/repository`, payload: body }),
  );
  tool('remove_repository', 'Disconnects a department\'s git repository.', { department: Id('department') }, ({ department }) => ({ method: 'DELETE', url: `/api/departments/${department}/repository` }));

  tool(
    'change_employee',
    'Changes an employee as its card does: name, model (\'\' for Default), effort (a level its model takes, null for its role\'s level fitted to its model), subscription (null for none), skills { id: on/off }, base (its role text, null for the template\'s), ' +
      'skillText { id: text or null }, on (false switches it off: it ends the turn it runs and takes no task turns until it is on again), ' +
      'and timer { minutes, order, forWork? } (null for none): it wakes every so many minutes, 5 to 1440, outside any task, and does what the order says; ' +
      'with forWork true it skips a round while no task is open and nothing failed since the last one.',
    { employee: Id('employee'), ...AgentPatch.shape },
    ({ employee, ...body }) => {
      /* A skill that grants tools shows the whole company through the employee, and his own subscription is where his
         turns and their tokens go: both are the CEO's to ask for. */
      const grants = Object.entries(body.skills ?? {}).some(([id, on]) => on && (ctx.templates.skills.get(id)?.grants ?? []).length > 0);
      const ceos = grants || (employee === job.agentId && body.subscription !== undefined);
      return { method: 'PATCH', url: `/api/agents/${employee}`, payload: body, ...(ceos ? { asCeo: true as const } : {}) };
    },
  );
  tool('reset_employee', 'Puts an employee back to its role as the templates have it now: its skills, texts and effort. Its model and subscription stay.', { employee: Id('employee') }, ({ employee }) => ({
    method: 'POST',
    url: `/api/agents/${employee}/reset`,
  }));
  tool('fire_employee', 'Removes an employee from the company. Its history stays. Not while it works or holds tasks.', { employee: Id('employee') }, ({ employee }) => ({ method: 'DELETE', url: `/api/agents/${employee}` }));
  tool(
    'message_employee',
    'Writes to an employee in its own window, as yourself. It reads it in its next turn, or at once when it is free.',
    { employee: Id('employee'), text: z.string().trim().min(1).max(4000) },
    ({ employee, text }) => (carriesFile(text) ? encodedHint() : { method: 'POST', url: `/api/agents/${employee}/messages`, payload: { text } }),
  );
  tool('stop_employee', 'Stops the turn an employee runs now, as Esc in its window does.', { employee: Id('employee') }, ({ employee }) => ({ method: 'POST', url: `/api/agents/${employee}/stop` }));

  tool(
    'answer_request',
    'Answers what an employee asked people (see /api/requests): answer for a question; approve true or false, with an optional answer, for a commit; pick (0 for the first way) for a choice; retry true for a stuck task. ' +
      'It is the decision of the person this turn answers, the last one who wrote into it, and goes through only when they may take it.',
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
    'Connects the CEO\'s own plans (claude, codex, kimi, glm, antigravity for Google AI Pro or Ultra): the CEO sees the command to run on their machine in this window, you do not.',
    ConnectBody.shape,
    body => ({ method: 'POST', url: '/api/subscriptions/connect', payload: body }),
  );
  tool('plan_command', 'A new machine command for one of the CEO\'s plans that still waits for a machine; a plan on a machine already goes to another one only with add_plan_to_machine.', { subscription: Id('subscription') }, ({ subscription }) => ({
    method: 'POST',
    url: `/api/subscriptions/${subscription}/command`,
  }));
  tool('machine_command', 'A command that connects a machine of the CEO\'s without a plan: it lends itself to test runs, and add_plan_to_machine puts plans on it later.', {}, () => ({
    method: 'POST',
    url: '/api/machines/command',
  }));
  tool(
    'add_plan_to_machine',
    'A command that puts one of the CEO\'s own plans on one more of the CEO\'s machines; it works on that machine only, and the plan signs in there by itself.',
    { machine: Id('machine'), subscription: Id('subscription') },
    ({ machine, subscription }) => ({ method: 'POST', url: `/api/machines/${machine}/plans`, payload: { subscription } }),
  );
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
    `Changes your own model ('' for Default) and effort (a level your model takes, null for ${ORCHESTRATOR_EFFORT} fitted to your model), as your card does. They count from your next turn.`,
    { model: AgentPatch.shape.model, effort: AgentPatch.shape.effort },
    body => ({ method: 'PATCH', url: `/api/agents/${job.agentId}`, payload: body }),
  );
  tool(
    'set_budget',
    "Sets the share of a plan's limits, in percent from 10 to 100, that task turns may use: past it they wait for the window to start over, while people's own messages still go. null takes it off.",
    { subscription: Id('subscription'), budget: BudgetBody.shape.budget },
    ({ subscription, budget }) => ({ method: 'PATCH', url: `/api/subscriptions/${subscription}`, payload: { budget } }),
  );
  tool('remove_subscription', 'Removes a subscription or API key; the employees on it stay without one.', { subscription: Id('subscription') }, ({ subscription }) => ({
    method: 'DELETE',
    url: `/api/subscriptions/${subscription}`,
  }));
  tool('disconnect_machine', 'Disconnects a machine: everything on it stops, and a plan that runs nowhere else waits for a machine again.', { machine: Id('machine') }, ({ machine }) => ({
    method: 'POST',
    url: `/api/machines/${machine}/disconnect`,
  }));
  tool(
    'pool',
    "Lists the company's machines: whose each is, whether it is online and lent to runs, how busy it is (a loaded one gets no new part), and the parts of test and work runs it runs; " +
      'the built-in node, with the machine it runs on when the server is on one of them, which is then one computer; and every part that waits for a machine, with why it waits.',
    {},
    () => ({ method: 'GET', url: '/api/pool' }),
  );
  tool(
    'lend_machine',
    "Lends a machine to the company's test runs and work runs (lendsTests true), which go to whichever lent machine is freest, or takes it back.",
    { machine: Id('machine'), ...LendBody.shape },
    ({ machine, ...body }) => ({ method: 'PATCH', url: `/api/machines/${machine}`, payload: body }),
  );

  tool('check_updates', 'Looks for a newer Hornhoof now.', {}, () => ({ method: 'POST', url: '/api/updates/check' }));
  tool(
    'update_hornhoof',
    'Installs a Hornhoof version: version "latest" or a tag from check_updates. whenIdle waits until no agent works. Hornhoof restarts, and so does your turn.',
    UpdateBody.shape,
    body => ({ method: 'POST', url: '/api/updates', payload: body }),
  );
  tool('cancel_update', 'Calls off an update that waits for the agents to finish.', {}, () => ({ method: 'DELETE', url: '/api/updates' }));

  tool(
    'set_public_link',
    'Opens Hornhoof on the internet at <name>.hornhoof.org, or moves it to another name: 1 to 63 lowercase Latin letters, digits and hyphens. Left out, the name is long and random. ' +
      'A name people can guess is protected only by the company\'s sign-in. Machines connected through the old link lose it and need a new command.',
    LinkBody.shape,
    body => ({ method: 'PUT', url: '/api/link', payload: body }),
  );
  tool('remove_public_link', 'Closes the public link: Hornhoof opens only at its own address again.', {}, () => ({ method: 'DELETE', url: '/api/link' }));

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

/* A screen's route, called as this person, the company's owner when none is named. */
async function send(ctx: Ctx, app: FastifyInstance, job: ToolJob, { method, url, payload }: Call, personId?: string) {
  const [owner] = personId
    ? [{ id: personId }]
    : await ctx.db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.companyId, job.companyId), eq(people.isOwner, true)));
  if (!owner) return say('This company has no owner to act for.', true);
  const res = await app.inject({ method, url, headers: orchestratorHeaders(owner.id, job.agentId), ...(payload === undefined ? {} : { payload: payload as object }) });
  return answered(res);
}

/* What only the CEO asks for goes as the CEO or the CEO delegate this turn answers now, kept under the input lock from words
   that would change it meanwhile, so the route sees the person it is for and allows that person what their own screen
   does. */
function asCeo(ctx: Ctx, app: FastifyInstance, job: ToolJob, made: Call) {
  return withInputLock(ctx, job.agentId, async () => {
    const personId = await ceoPrincipal(ctx.db, job.id);
    return personId ? send(ctx, app, job, made, personId) : say(ONLY_CEO, true);
  });
}

/* A tool's call goes as a decision of the person this turn answers, as the CEO or the delegate, or as the owner. */
function carry(ctx: Ctx, app: FastifyInstance, job: ToolJob, name: string, made: Call) {
  if (DECIDES.has(name)) return decide(ctx, app, job, made);
  return CEO_ONLY.has(name) || made.asCeo ? asCeo(ctx, app, job, made) : send(ctx, app, job, made);
}

/* Why a decision did not go through, in the orchestrator's words; nothing for any other answer. */
const REFUSED: Record<string, string> = { decision_not_allowed: NOT_THEIRS, decision_context_missing: NO_PRINCIPAL };

/* A decision goes as the person this turn answers, found from the turn itself; the route checks the turn again and that
   person's right while it keeps the decision. */
async function decide(ctx: Ctx, app: FastifyInstance, job: ToolJob, { method, url, payload }: Call) {
  const principal = await decisionPrincipal(ctx.db, job.id);
  if (!principal) return say(NO_PRINCIPAL, true);
  const headers = orchestratorDecisionHeaders({ ...principal, agentId: job.agentId, jobId: job.id });
  const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const refused = REFUSED[reasonOf(res.body) ?? ''];
  return refused ? say(refused, true) : answered(res);
}

const errorBody = (body: string): { message?: string; reason?: string } | undefined => {
  try {
    return (JSON.parse(body) as { error?: { message?: string; reason?: string } }).error;
  } catch {
    return undefined;
  }
};
const errorOf = (body: string): string | undefined => errorBody(body)?.message;
const reasonOf = (body: string): string | undefined => errorBody(body)?.reason;

function answered(res: { statusCode: number; body: string }) {
  if (res.statusCode >= 400) return say(errorOf(res.body) ?? `Hornhoof answered ${res.statusCode}.`, true);
  if (!res.body) return say('Done.');
  return say(res.body.length > MAX_ANSWER ? `${res.body.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : res.body);
}
