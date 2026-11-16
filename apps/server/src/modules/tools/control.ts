import { ORCHESTRATOR_EFFORT } from '@hornhoof/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { z } from 'zod';
import { idOnly } from '../../db/selections.js';
import { Text } from '../tasks/long-text.js';
import type { Ctx } from '../../app.js';
import { orchestratorDecisionHeaders, orchestratorHeaders } from '../../auth/internal.js';
import { departments, people } from '../../db/schema.js';
import { AgentPatch } from '../agents/routes.js';
import { cardPrincipal, ceoPrincipal, decisionPrincipal, departmentPrincipal, standingPrincipal, withInputLock } from '../conversation/decision-context.js';
import { deptName } from '../departments/templates.js';
import { BuildBody, RepoBody, RepositoryBody } from '../departments/routes.js';
import { NewRepositoryBody } from '../departments/repo-hosts.js';
import { LinkBody } from '../link/routes.js';
import { SHOWN_TO_CEO } from '../nodes/command.js';
import { LendBody } from '../nodes/routes.js';
import { NOTE_MAX, NoteBody } from '../notebook/book.js';
import { carriesFile, encodedHint } from '../tasks/attachments.js';
import { MESSAGE_TASK_HINT, TaskReference } from '../tasks/external-wait.js';
import { resolveStuck } from '../tasks/stuck.js';
import { wakeAll } from '../tasks/wake.js';
import type { Answer } from '../tasks/engine.js';
import { InviteBody, PersonPatch } from '../people/routes.js';
import { ApiKeyFields, BudgetBody, ConnectBody } from '../subscriptions/routes.js';
import { UpdateBody } from '../updates/routes.js';
import { departmentOf, runsTier, servingSubscriptions, skillsFor, spotIn, StaffLine, type HireLine } from './staff.js';

type ToolJob = { id: string; companyId: string; agentId: string };
/* asCeo: only the CEO may ask for this one call of a tool anyone may ask for. permission: the CEO's answer in a task's card
   that lets a machine change go when no CEO's words are in the turn. department: the department the change stays in, whose
   owner asks for it as the CEO does. first: without them it still goes, as a department's first repository only. */
type Call = { method: HTTPMethods; url: string; payload?: unknown; asCeo?: true; permission?: string; department?: string; first?: true };
type Dept = typeof departments.$inferSelect;
type Hire = Omit<StaffLine, 'checked'>;

/* Answers longer than this are cut, so one view does not fill the orchestrator's context. */
const MAX_ANSWER = 30_000;

/* Pages the orchestrator does not read with view: live streams, files and sign-in. */
const UNREAD = /^\/api\/(stream|attachments|auth|invites|setup|nodes)(\/|$)|\/terminal$/;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const Id = (what: string) => z.uuid().describe(`The ${what}'s id, from company or view.`);

/* The tools that change people, their access, money or the company's reach. What is not forbidden is allowed, and the
   orchestrator can do everything in the company (Ivan's rule of 16 November 2026): he uses them in any turn, as the CEO
   or the CEO delegate who wrote to him, or else as the company's owner, whoever asked, an employee, a timer, a task or
   another person. What the company wants him not to do is written in its notebook. Only a company with no active owner
   leaves them to the CEO's word. */
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
  'add_repository',
  'create_repository',
  'remove_repository',
  'set_public_link',
  'remove_public_link',
  'update_hornhoof',
  'set_team_urgent_only',
]);
export const ONLY_CEO = 'Only the CEO or the CEO delegate can ask for this, in a turn that answers them: the last person who wrote into it. Nothing was changed. Ask the CEO first.';
export const ONLY_DEPARTMENT_OWNER =
  "Only the CEO, the CEO delegate or this department's owner can ask for this, and the last person who wrote to you is none of them. Nothing was changed. Ask one of them.";
/* Making work urgent outside any department, which goes for the last person who asked, in any turn. */
export const ONLY_CEO_ASKED = 'Only the CEO or the CEO delegate can ask for this, and the last person who wrote to you is neither. Nothing was changed. Ask the CEO.';
const NO_PERMISSION =
  "That answer is no permission to change machines: it is the CEO's or the CEO delegate's own answer to a question about machines, in the card of a task that is still open. Nothing was changed. Ask the CEO first.";

/* The tools that change the CEO's machines. They also go by the CEO's own answer about machines in a task's card. */
const PERMISSION = {
  permission: z
    .uuid()
    .optional()
    .describe("The id of the CEO's or the CEO delegate's answer in an open task's card to your ask_person with topic machines, when they answered there and not in this window."),
};

/* The tools that take a decision for a person, who must have the right to take it. answer_request takes the decision a
   question asked of that person, so only in the turn that answers them; a structure or a hire is the orchestrator's own
   work of running the company, which goes in any turn of his for the last person who asked him. */
const DECIDES = new Set(['answer_request', 'build_structure', 'hire']);
/* What goes in any turn of the orchestrator, for the last person who asked him and with their right: a structure, a hire,
   and installing a Hornhoof version for the CEO or the delegate, as the head of Development and he run releases end to
   end. Calling an update off goes as the owner. Anything else only the CEO asks for goes only in the turn that answers them. */
const STANDING = new Set(['build_structure', 'hire', 'update_hornhoof']);
const findFor = (name: string): typeof decisionPrincipal => (STANDING.has(name) ? standingPrincipal : decisionPrincipal);
const NOBODY_ASKED =
  "No person's words stand behind this: nobody wrote to you yet, or words for this turn are still on their way. Nothing was changed. " +
  'Ask the person who takes it (the CEO, the CEO delegate or, for a department, its people) to decide it.';
const NO_PRINCIPAL =
  'This turn answers no person who may take a decision now: the last message in it came from an employee or from Hornhoof, or words for it are still on their way. ' +
  'Nothing was changed. Ask the person who takes it (the CEO, the CEO delegate or, for a department, its people) to decide it, or to tell you so in this window.';
const NOT_THEIRS =
  'The person you act for here may not take this decision. Nothing was changed. Tell them who takes it (the CEO, the CEO delegate or, for a department, its people) and leave it to them.';

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
    'Reads any page of Hornhoof the CEO can open, as JSON: GET /api/org, /api/people, /api/subscriptions, /api/machines, /api/task-departments, /api/tasks?status=all&department=<department id, or none for your own>, /api/tasks/<id>, /api/departments/<id>/backlog, ' +
      '/api/requests, /api/turns, /api/agents/<id> (an employee card with its skills, instructions and latest changes), /api/agents/<id>/events (its conversation), ' +
      '/api/departments/<id>/roster, /api/updates, /api/link (the public link), /api/link/names/<name> (whether a name for it is free) and /api/repo-host (the GitHub owner whose key creates the company\'s repositories; /api/org shows each department\'s as repoHost).',
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
      'Each item is a new department { template, name?, note?, products?, teams?, staff? } (name only when a template is used a second time; it comes with the people of its template, each on the plan and model its role asks for, or waiting for a plan; staff false only when the CEO asked for one without people) or a change { department, note?, products?, teams?, remove? }: ' +
      'products are added, teams creates sub-units by name or renames ({ id, name }) / removes ({ id, remove: true }) existing sub-units (moving their employees back to the pipeline), remove takes a department without employees away with its products. proposalId applies a card you proposed. ' +
      'It goes as the decision of the last person who asked you, in this turn or an earlier one: the CEO or the CEO delegate, or the owner of a department for products and sub-units of their own department.',
    BuildBody.shape,
    /* A department he creates comes with its people unless he says otherwise, as the card's box is ticked at first. */
    body => ({ method: 'POST', url: '/api/departments/build', payload: { ...body, items: body.items.map(item => ('template' in item ? { ...item, staff: item.staff ?? true } : item)) } }),
  );

  tool(
    'hire',
    'Hires employees into a department, as the CEO\'s click on a staff card does. Each person is { role, name?, product?, model?, subscription?, skills?: { on, off } } as in propose_staff: ' +
      'left out, the name is the role\'s title, the model is Default, the subscription is the first one that serves the department and runs the role, and the skills are the role\'s. ' +
      'Call staffing_options first. A department has one head. proposalId: the staff card this hires from, so it closes. ' +
      'It goes as the decision of the last person who asked you, in this turn or an earlier one: the CEO, the CEO delegate or the owner of this department.',
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
      'testMemoryGb, the free memory a machine needs to take a test run of it (4 by default), ' +
      'and fullTestCommand, the command that runs its whole test suite (null takes it away): a run of exactly that sets the GitHub status hornhoof/tests on the commit it checked, for which the token needs the right to write commit statuses, and GitHub then builds images without running the tests again.',
    { department: Id('department'), ...RepoBody.shape },
    ({ department, ...body }) => ({ method: 'PUT', url: `/api/departments/${department}/repository`, payload: body, department }),
  );
  tool(
    'add_repository',
    'Adds a git repository to a department beside its own: it comes as a new product of the department, named after the end of its address unless you give a name, ' +
      'and a task names that product to change it. The fields are those of set_repository. To connect a repository to a product the department has, use set_repository with the product\'s id.',
    { department: Id('department'), ...RepositoryBody.shape },
    ({ department, ...body }) => ({ method: 'POST', url: `/api/departments/${department}/repositories`, payload: body, department }),
  );
  tool(
    'create_repository',
    'Creates a private repository on GitHub for a department, with a first commit holding its README, and connects it with the same key: the key the department saved, else the company\'s. ' +
      'It becomes the repository of a department or product that has none, else a new product of the department named after it. name: its name on GitHub; author { name, email } as in set_repository. ' +
      "In any turn it creates a department's first one, when neither the department nor its products keep one; any other for the last person who asked you, if they are the CEO, the CEO delegate or the department's owner. " +
      "Without a key it answers what is missing: tell the CEO or the department's owner that, and offer to connect a repository they have with set_repository instead.",
    { department: Id('department'), ...NewRepositoryBody.shape },
    ({ department, ...body }) => ({ method: 'POST', url: `/api/departments/${department}/repositories/new`, payload: body, department, first: true }),
  );
  tool('remove_repository', 'Disconnects a department\'s git repository.', { department: Id('department') }, ({ department }) => ({ method: 'DELETE', url: `/api/departments/${department}/repository`, department }));

  tool(
    'change_employee',
    'Changes an employee as its card does: name, model (\'\' for Default), effort (a level its model takes, null for its role\'s level fitted to its model), subscription (null for none), team (sub-unit id in its department, or null for the pipeline), skills { id: on/off }, base (its personal assignment, null to clear it), ' +
      'skillText { id: text or null }, on (false switches it off: it ends the turn it runs and takes no task turns until it is on again), ' +
      'and timer { minutes, order, forWork? } (null for none): it wakes every so many minutes, 5 to 1440, outside any task, and does what the order says; ' +
      'with forWork true it skips a round while every open task waits on purpose, for a person, for other tasks or for what it said it waits for, and nothing failed since the last one.',
    { employee: Id('employee'), ...AgentPatch.shape },
    ({ employee, ...body }) => {
      /* A skill that grants tools shows the whole company through the employee, and his own subscription is where his
         turns and their tokens go: both are the CEO's to ask for. */
      const grants = Object.entries(body.skills ?? {}).some(([id, on]) => on && (ctx.templates.skills.get(id)?.grants ?? []).length > 0);
      const ceos = grants || (employee === job.agentId && body.subscription !== undefined);
      return { method: 'PATCH', url: `/api/agents/${employee}`, payload: body, ...(ceos ? { asCeo: true as const } : {}) };
    },
  );
  tool(
    'set_team_urgent_only',
    'Says whether a sub-unit of a department takes only urgent work. Who is in it holds what they hold; from then on work that is not urgent is not given to them.',
    { department: Id('department'), team: Id('sub-unit'), urgentOnly: z.boolean() },
    ({ department, team, urgentOnly }) => ({ method: 'PATCH', url: `/api/departments/${department}/teams/${team}`, payload: { urgentOnly }, department }),
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
      'A human decision belongs to the person this turn answers. An internal stuck request assigned to the orchestrator is answered by the orchestrator itself, without a person principal.',
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
    'Adds a company API connection, paid by the token, with a key the CEO gave you: provider anthropic_api, openai_api, openrouter, or custom_api for any API that speaks Anthropic\'s or OpenAI\'s protocol at an address (baseUrl and protocol anthropic | openai, both required for custom_api; protocol optional for openrouter, anthropic by default); a label; the key; models [{ id, name }] it runs, which openrouter and custom_api need; and target { kind: orchestrator | any } or { kind: department | team, id }. The key is stored encrypted and only its last 4 characters are ever shown.',
    ApiKeyFields.omit({ kind: true }).shape,
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
  tool('machine_command', 'A command that connects a machine of the CEO\'s without a plan: it lends itself to test runs, and add_plan_to_machine puts plans on it later.', PERMISSION, ({ permission }) => ({
    method: 'POST',
    url: '/api/machines/command',
    permission,
  }));
  tool(
    'add_plan_to_machine',
    'A command that puts one of the CEO\'s own plans on one more of the CEO\'s machines; it works on that machine only, and the plan signs in there by itself.',
    { machine: Id('machine'), subscription: Id('subscription'), ...PERMISSION },
    ({ machine, subscription, permission }) => ({ method: 'POST', url: `/api/machines/${machine}/plans`, payload: { subscription }, permission }),
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
  tool('disconnect_machine', 'Disconnects a machine: everything on it stops, and a plan that runs nowhere else waits for a machine again.', { machine: Id('machine'), ...PERMISSION }, ({ machine, permission }) => ({
    method: 'POST',
    url: `/api/machines/${machine}/disconnect`,
    permission,
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
    { machine: Id('machine'), ...LendBody.shape, ...PERMISSION },
    ({ machine, permission, ...body }) => ({ method: 'PATCH', url: `/api/machines/${machine}`, payload: body, permission }),
  );

  tool('check_updates', 'Looks for a newer Hornhoof now.', {}, () => ({ method: 'POST', url: '/api/updates/check' }));
  tool(
    'update_hornhoof',
    'Installs a Hornhoof version: version "latest" or a tag from check_updates. whenIdle (the default) starts no new turn of the company and waits until no agent works, ' +
      'for idleWaitMinutes at most: when the agents have not finished by then, the update is called off, nothing running stops, the turns start again and you are told. ' +
      'A turn whose node said nothing of its program for ten minutes is not waited for. The answer, and check_updates later, say which turns it waits for and until when. ' +
      'Hornhoof restarts, and so does your turn. It goes for the CEO or the CEO delegate who asked you last, in this turn or an earlier one.',
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

/* A screen's route, called as this person, the company's owner when none is named. */
async function send(ctx: Ctx, app: FastifyInstance, job: ToolJob, { method, url, payload }: Call, personId?: string) {
  const [owner] = personId
    ? [{ id: personId }]
    : await ctx.db
        .select(idOnly(people))
        .from(people)
        .where(and(eq(people.companyId, job.companyId), eq(people.isOwner, true)));
  if (!owner) return say('This company has no owner to act for.', true);
  const res = await app.inject({ method, url, headers: orchestratorHeaders(owner.id, job.agentId), ...(payload === undefined ? {} : { payload: payload as object }) });
  return answered(res);
}

/* What only the CEO asks for goes as the CEO or the CEO delegate this turn answers now, kept under the input lock from words
   that would change it meanwhile, so the route sees the person it is for and allows that person what their own screen
   does. A change of one department's own resources goes, in any turn, as the last person who asked if they run it, and an
   update of Hornhoof as the CEO or the delegate who asked last. A machine change without them goes as the CEO whose answer
   in a task's card it names. */
function asCeo(ctx: Ctx, app: FastifyInstance, job: ToolJob, made: Call, find: typeof decisionPrincipal) {
  return withInputLock(ctx, job.agentId, async () => {
    if (made.department) {
      const runs = await departmentPrincipal(ctx.db, job.id, made.department, standingPrincipal);
      if (runs) return send(ctx, app, job, made, runs);
      /* A department's first repository, which the route creates as no other. */
      if (made.first) return send(ctx, app, job, { ...made, payload: { ...(made.payload as object), first: true } });
      return say(ONLY_DEPARTMENT_OWNER, true);
    }
    const personId = await ceoPrincipal(ctx.db, job.id, find);
    if (personId) return send(ctx, app, job, made, personId);
    if (!made.permission) return say(find === decisionPrincipal ? ONLY_CEO : ONLY_CEO_ASKED, true);
    const answered = await cardPrincipal(ctx.db, job.companyId, made.permission);
    return answered ? send(ctx, app, job, made, answered) : say(NO_PERMISSION, true);
  });
}

/* A tool's call goes as a decision of the person this turn answers, as the CEO or the delegate, or as the owner. */
async function carry(ctx: Ctx, app: FastifyInstance, job: ToolJob, name: string, made: Call) {
  if (name === 'answer_request' && made.url.startsWith('/api/requests/')) {
    try {
      const done = await resolveStuck(ctx, job, made.url.slice('/api/requests/'.length), made.payload as Answer);
      if (done) {
        await wakeAll(ctx, done.wakes);
        return say(JSON.stringify({ request: { id: done.request.id, status: done.request.status, picked: done.request.picked, answer: done.request.answer } }));
      }
    } catch (err) {
      return say(err instanceof Error ? err.message : 'The internal stuck answer did not go through.', true);
    }
  }
  if (DECIDES.has(name)) return decide(ctx, app, job, made, findFor(name));
  return CEO_ONLY.has(name) || made.asCeo ? asCeo(ctx, app, job, made, findFor(name)) : send(ctx, app, job, made);
}

/* Why a decision did not go through, in the orchestrator's words; nothing for any other answer. */
const REFUSED: Record<string, string> = { decision_not_allowed: NOT_THEIRS, decision_context_missing: NO_PRINCIPAL };

/* A decision goes as the person found from the turn itself; the route checks the turn again and that person's right while
   it keeps the decision. */
async function decide(ctx: Ctx, app: FastifyInstance, job: ToolJob, { method, url, payload }: Call, find: typeof decisionPrincipal) {
  const principal = await find(ctx.db, job.id);
  if (!principal) return say(find === decisionPrincipal ? NO_PRINCIPAL : NOBODY_ASKED, true);
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
