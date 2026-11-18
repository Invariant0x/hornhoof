import { ORCHESTRATOR_EFFORT } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { z } from 'zod';
import { Text } from '../tasks/long-text.js';
import type { Ctx } from '../../app.js';
import { orchestratorJobHeaders } from '../../auth/internal.js';
import { departments } from '../../db/schema.js';
import { AgentPatch } from '../agents/routes.js';
import { deptName } from '../departments/templates.js';
import { BuildBody, RepoBody, RepositoryBody } from '../departments/routes.js';
import { NewRepositoryBody } from '../departments/repo-hosts.js';
import { LinkBody } from '../link/routes.js';
import { LendBody } from '../nodes/routes.js';
import { NoteBody } from '../notebook/book.js';
import { carriesFile, encodedHint } from '../tasks/attachments.js';
import { MESSAGE_TASK_HINT, TaskReference } from '../tasks/external-wait.js';
import { InviteBody, PersonPatch } from '../people/routes.js';
import { ApiKeyFields, BudgetBody, ConnectBody } from '../subscriptions/routes.js';
import { UpdateBody } from '../updates/routes.js';
import { entryByName, secretsOf } from '../vault/store.js';
import { departmentOf, runsTier, servingSubscriptions, skillsFor, spotIn, StaffLine, type HireLine } from './staff.js';

type ToolJob = { id: string; companyId: string; agentId: string };
type Call = { method: HTTPMethods; url: string; payload?: unknown };
type Dept = typeof departments.$inferSelect;
type Hire = Omit<StaffLine, 'checked'>;

/* Answers longer than this are cut, so one page does not fill the orchestrator's context. */
const MAX_ANSWER = 30_000;

/* Routes that stream for as long as someone listens, with no answer to wait for: the live stream and the sockets. */
const STREAMS = /^\/api\/(stream|nodes\/socket)$|\/terminal$/;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Id = (what: string) => z.uuid().describe(`The ${what}'s id, from company or api.`);
const VaultEntry = z.string().trim().min(1).optional().describe('Name of the vault entry for this repository host. Save any missing token in the vault.');

async function repositoryCredential(ctx: Ctx, companyId: string, url: string, entry: string | undefined) {
  if (!entry) return {};
  const saved = await entryByName(ctx, companyId, entry);
  if (!saved) return 'Ask the person responsible to save the repository credential in the vault and give you its entry name.';
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || new URL(saved.site).origin !== target.origin) return 'Use a vault entry for this repository host.';
  } catch {
    return 'Use an HTTPS address for both the repository and its vault entry.';
  }
  return { token: secretsOf(ctx, saved).password };
}

export const ONLY_DEPARTMENT_OWNER = "Only the CEO, the CEO delegate or this department's owner can make this change.";
export const ONLY_CEO_ASKED = 'Only the CEO or the CEO delegate can make this change.';

/* Named and generic calls use the same routes and the same company authority. */
export function registerControlTools(server: McpServer, ctx: Ctx, app: FastifyInstance, job: ToolJob): void {
  /* One tool for one screen action. The id fields name the thing in the address; the rest is the body. A call that
     cannot be made comes back as the reason. */
  const register = server.registerTool.bind(server) as (name: string, config: { description: string; inputSchema: z.ZodRawShape }, cb: (a: never) => Promise<ReturnType<typeof say>>) => unknown;
  const tool = <S extends z.ZodRawShape>(name: string, description: string, input: S, call: (a: z.infer<z.ZodObject<S>>) => Call | string | Promise<Call | string>) =>
    register(name, { description, inputSchema: input }, async (a: z.infer<z.ZodObject<S>>) => {
      const made = await call(a);
      if (typeof made === 'string') return say(made, true);
      return send(app, job, made);
    });

  tool(
    'api',
    "Calls Hornhoof's request and response API as the company's owner. Live streams and terminal sockets require their own connection, and long replies may be cut. Use the protected setup surfaces for credentials. " +
      'method is GET by default; path starts with /api/, with its query; body is the JSON the route takes. Pages worth reading: /api/org, /api/people, /api/subscriptions, /api/machines, /api/task-departments, ' +
      '/api/tasks?status=all&department=<department id, or none for your own>, /api/tasks/<id>, /api/departments/<id>/backlog, /api/requests, /api/turns, /api/agents/<id> (an employee card with its skills, instructions and latest changes), ' +
      "/api/agents/<id>/events (its conversation), /api/departments/<id>/roster, /api/updates, /api/link (the public link), /api/link/names/<name> (whether a name for it is free) and /api/repo-host (the GitHub owner whose key creates the company's repositories).",
    {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
      path: z.string().trim().min(1).max(2000).describe('The route, starting with /api/.'),
      body: z.unknown().optional().describe('The JSON body, for a route that takes one.'),
    },
    ({ method = 'GET', path, body }) => {
      const url = new URL(path, 'http://hornhoof');
      if (!url.pathname.startsWith('/api/')) return `${url.pathname} is no route of the API: it starts with /api/.`;
      if (STREAMS.test(url.pathname)) return `${url.pathname} streams without end, so it has no answer to give. Read the pages it streams from instead.`;
      return { method, url: url.pathname + url.search, ...(body === undefined ? {} : { payload: body }) };
    },
  );

  tool(
    'build_structure',
    'Applies requested changes to the company structure. Get the CEO’s yes before an irreversible deletion. Use brief to describe the company when it changes. ' +
      'Each item is a new department { template, name?, note?, products?, teams?, staff? } (name only when a template is used a second time; staff defaults to true) or a change { department, note?, products?, teams?, remove? }: ' +
      'products are added, teams creates sub-units by name or renames ({ id, name }) / removes ({ id, remove: true }) existing sub-units (moving their employees back to the pipeline), remove takes a department without employees away with its products. proposalId applies a card you proposed. ' +
      'You apply it as the company owner in any turn.',
    BuildBody.shape,
    /* A department he creates comes with its people unless he says otherwise, as the card's box is ticked at first. */
    body => ({ method: 'POST', url: '/api/departments/build', payload: { ...body, items: body.items.map(item => ('template' in item ? { ...item, staff: item.staff ?? true } : item)) } }),
  );

  tool(
    'hire',
    'Carries out the department’s staffing decisions. Each person is { role, name?, product?, model?, subscription?, skills?: { on, off } }: ' +
      'left out, the name is the role\'s title, the model is Default, the subscription is the first one that serves the department and runs the role, and the skills are the role\'s. ' +
      'Call staffing_options first. A department has one head. proposalId: the staff card this hires from, so it closes. ' +
      'You apply it as the company owner in any turn.',
    { department: Id('department'), proposalId: z.uuid().optional(), people: z.array(StaffLine.omit({ checked: true })).min(1).max(30) },
    async ({ department, proposalId, people: lines }) => {
      const url = `/api/departments/${department}/staff`;
      const dept = await departmentOf(ctx.db, job.companyId, department);
      return dept ? { method: 'POST', url, payload: { proposalId, people: await hireLines(ctx, job.companyId, dept, lines) } } : { method: 'POST', url };
    },
  );

  tool(
    'set_repository',
    'Connects a department’s repository. Give its HTTPS address, main branch and commit author. Use vaultEntry by name if the repository needs a credential. Use fullTestCommand for the whole test suite. A run of that command can publish hornhoof/tests on the exact checked commit if the repository permits writing commit statuses.',
    { department: Id('department'), ...RepoBody.omit({ token: true }).shape, vaultEntry: VaultEntry },
    async ({ department, vaultEntry, ...body }) => {
      const credential = await repositoryCredential(ctx, job.companyId, body.url, vaultEntry);
      return typeof credential === 'string' ? credential : { method: 'PUT', url: `/api/departments/${department}/repository`, payload: { ...body, ...credential } };
    },
  );
  tool(
    'add_repository',
    'Adds a git repository to a department beside its own: it comes as a new product of the department, named after the end of its address unless you give a name, ' +
      'and a task names that product to change it. The fields are those of set_repository. To connect a repository to a product the department has, use set_repository with the product\'s id.',
    { department: Id('department'), ...RepositoryBody.omit({ token: true }).shape, vaultEntry: VaultEntry },
    async ({ department, vaultEntry, ...body }) => {
      const credential = await repositoryCredential(ctx, job.companyId, body.url, vaultEntry);
      return typeof credential === 'string' ? credential : { method: 'POST', url: `/api/departments/${department}/repositories`, payload: { ...body, ...credential } };
    },
  );
  tool(
    'create_repository',
    'Creates a private repository on GitHub for a department, with a first commit holding its README, and connects it with the same key: the key the department saved, else the company\'s. ' +
      'It becomes the repository of a department or product that has none, else a new product of the department named after it. name: its name on GitHub; author { name, email } as in set_repository. ' +
      'If a key is missing, ask the person responsible for that account to use protected setup or connect an existing repository with set_repository.',
    { department: Id('department'), ...NewRepositoryBody.shape },
    ({ department, ...body }) => ({ method: 'POST', url: `/api/departments/${department}/repositories/new`, payload: body }),
  );
  tool('remove_repository', 'Disconnects a department\'s git repository.', { department: Id('department') }, ({ department }) => ({ method: 'DELETE', url: `/api/departments/${department}/repository` }));

  tool(
    'change_employee',
    'Changes an employee as its card does: name, model (\'\' for Default), effort (a level its model takes, null for its role\'s level fitted to its model), subscription (null for none), team (sub-unit id in its department, or null for the pipeline), skills { id: on/off }, base (its personal assignment, null to clear it), ' +
      'skillText { id: text or null }, on (false switches it off: it ends the turn it runs and takes no task turns until it is on again), ' +
      'and timer { minutes, order, forWork? } (null for none): it wakes every so many minutes, 5 to 1440, outside any task, and does what the order says; ' +
      'with forWork true it skips a round while every open task waits on purpose, for a person, for other tasks or for what it said it waits for, and nothing failed since the last one.',
    { employee: Id('employee'), ...AgentPatch.shape },
    ({ employee, ...body }) => ({ method: 'PATCH', url: `/api/agents/${employee}`, payload: body }),
  );
  tool(
    'set_team_urgent_only',
    'Says whether a sub-unit of a department takes only urgent work. Who is in it holds what they hold; from then on work that is not urgent is not given to them.',
    { department: Id('department'), team: Id('sub-unit'), urgentOnly: z.boolean() },
    ({ department, team, urgentOnly }) => ({ method: 'PATCH', url: `/api/departments/${department}/teams/${team}`, payload: { urgentOnly } }),
  );
  tool('reset_employee', 'Puts an employee back to its role as the templates have it now: its skills, texts and effort. Its model and subscription stay.', { employee: Id('employee') }, ({ employee }) => ({
    method: 'POST',
    url: `/api/agents/${employee}/reset`,
  }));
  tool('fire_employee', 'Removes an employee from the company. Its history stays. Not while it works or holds tasks.', { employee: Id('employee') }, ({ employee }) => ({ method: 'DELETE', url: `/api/agents/${employee}` }));
  tool(
    'message_employee',
    'Writes to an employee in its own window, as yourself. It reads it in its next turn, or at once when it is free.' + MESSAGE_TASK_HINT,
    { employee: Id('employee'), text: Text.trim().min(1), task: TaskReference.optional() },
    ({ employee, text, task }) => (carriesFile(text) ? encodedHint() : { method: 'POST', url: `/api/agents/${employee}/messages`, payload: { text, task } }),
  );
  tool('stop_employee', 'Stops the turn an employee runs now, as Esc in its window does.', { employee: Id('employee') }, ({ employee }) => ({ method: 'POST', url: `/api/agents/${employee}/stop` }));

  tool(
    'answer_request',
    'Answers what an employee asked people (see /api/requests): answer for a question; approve true or false, with an optional answer, for a commit; pick (0 for the first way) for a choice; retry true for a stuck task. ' +
      'Hornhoof records you as the agent that answered. A recorded human decision comes from the person who made it.',
    {
      request: Id('request'),
      answer: Text.optional(),
      approve: z.boolean().optional(),
      pick: z.number().int().min(0).max(9).optional(),
      retry: z.literal(true).optional(),
    },
    ({ request, ...body }) => ({ method: 'POST', url: `/api/requests/${request}`, payload: body }),
  );

  tool(
    'explain_request',
    'Puts what an employee asks into the recipient’s language and plain words. Say what the work is for, what they need to supply and what each choice changes.',
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
  tool(
    'delete_person',
    'Permanently deletes a person and their assistants after the CEO has recorded a yes for that person. After a failure, call again with the same id to finish cleanup.',
    { person: Id('person') },
    ({ person }) => ({ method: 'DELETE', url: `/api/people/${person}` }),
  );
  tool('invite_again', 'Makes a new invite link for a person who has not joined yet.', { person: Id('person') }, ({ person }) => ({ method: 'POST', url: `/api/people/${person}/invite` }));

  tool(
    'add_api_key',
    'Adds a company API connection, paid by the token, with a key the CEO gave you: provider anthropic_api, openai_api, openrouter, or custom_api for any API that speaks Anthropic\'s or OpenAI\'s protocol at an address (baseUrl and protocol anthropic | openai, both required for custom_api; protocol optional for openrouter, anthropic by default); a label; the key; models [{ id, name }] it runs, which openrouter and custom_api need; and target { kind: orchestrator | any } or { kind: department | team, id }. The key is stored encrypted and only its last 4 characters are ever shown.',
    ApiKeyFields.omit({ kind: true }).shape,
    body => ({ method: 'POST', url: '/api/subscriptions', payload: { kind: 'api_key', ...body } }),
  );
  tool(
    'connect_plans',
    'Connects the CEO\'s own plans (claude, codex, kimi, glm, antigravity for Google AI Pro or Ultra): returns the install command and shows it on the CEO\'s screen.',
    ConnectBody.shape,
    body => ({ method: 'POST', url: '/api/subscriptions/connect', payload: body }),
  );
  tool('plan_command', 'A new machine command for one of the CEO\'s plans that still waits for a machine; a plan on a machine already goes to another one only with add_plan_to_machine.', { subscription: Id('subscription') }, ({ subscription }) => ({
    method: 'POST',
    url: `/api/subscriptions/${subscription}/command`,
  }));
  tool('machine_command', 'A command that connects a machine of the CEO\'s without a plan: it lends itself to test runs, and add_plan_to_machine puts plans on it later.', { permission: z.uuid().optional() }, () => ({
    method: 'POST',
    url: '/api/machines/command',
  }));
  tool(
    'add_plan_to_machine',
    'A command that puts one of the CEO\'s own plans on one more of the CEO\'s machines; it works on that machine only, and the plan signs in there by itself.',
    { machine: Id('machine'), subscription: Id('subscription'), permission: z.uuid().optional() },
    ({ machine, subscription }) => ({ method: 'POST', url: `/api/machines/${machine}/plans`, payload: { subscription } }),
  );
  tool('test_subscription', 'Sends a tiny prompt through a subscription to prove it works; read /api/jobs/<id> with api for the answer.', { subscription: Id('subscription') }, ({ subscription }) => ({
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
  tool('disconnect_machine', 'Disconnects a machine: everything on it stops, and a plan that runs nowhere else waits for a machine again.', { machine: Id('machine'), permission: z.uuid().optional() }, ({ machine }) => ({
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
    { machine: Id('machine'), ...LendBody.shape, permission: z.uuid().optional() },
    ({ machine, lendsTests }) => ({ method: 'PATCH', url: `/api/machines/${machine}`, payload: { lendsTests } }),
  );

  tool('check_updates', 'Looks for a newer Hornhoof now.', {}, () => ({ method: 'POST', url: '/api/updates/check' }));
  tool(
    'update_hornhoof',
    'Installs a Hornhoof version: version "latest" or a tag from check_updates. whenIdle (the default) starts no new turn of the company and waits until no agent works, ' +
      'for idleWaitMinutes at most: when the agents have not finished by then, the update is called off, nothing running stops, the turns start again and you are told. ' +
      'A turn whose node said nothing of its program for ten minutes is not waited for. The answer, and check_updates later, say which turns it waits for and until when. ' +
      'Hornhoof restarts, and so does your turn.',
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
      "People who see the whole company read and change it too. With department it goes into that department's notebook, for its head.",
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

/* The staff card's lines from the orchestrator's or a head's: what it leaves out is what the card starts with. A role the
   department does not have goes through as it is, for the route to name. */
export async function hireLines(ctx: Ctx, companyId: string, dept: Dept, lines: Hire[]): Promise<HireLine[]> {
  const products = await ctx.db.select().from(departments).where(eq(departments.parentId, dept.id));
  const out: HireLine[] = [];
  for (const line of lines) {
    const role = ctx.templates.roles.get(line.role);
    const product = products.find(p => p.id === line.product);
    const title = role?.title.en ?? line.role;
    const serving = line.subscription || !role ? [] : await servingSubscriptions(ctx, companyId, spotIn(dept, line.product));
    out.push({
      role: line.role,
      name: line.name ?? (product ? `${title} (${deptName(product)})` : title),
      product: line.product,
      team: line.team,
      model: line.model ?? '',
      subscription: line.subscription ?? serving.find(s => runsTier(s.provider, role!.tier))?.id ?? null,
      skills: role ? skillsFor(role, { ...line, checked: true }) : [],
    });
  }
  return out;
}

async function send(app: FastifyInstance, job: ToolJob, made: Call) {
  const { method, url, payload } = made;
  const res = await app.inject({ method, url, headers: orchestratorJobHeaders(job), ...(payload === undefined ? {} : { payload: payload as object }) });
  return answered(res);
}

function errorOf(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
  } catch {
    return undefined;
  }
}

function answered(res: { statusCode: number; body: string }) {
  if (res.statusCode >= 400) return say(errorOf(res.body) ?? `Hornhoof answered ${res.statusCode}.`, true);
  if (!res.body) return say('Done.');
  return say(res.body.length > MAX_ANSWER ? `${res.body.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : res.body);
}
