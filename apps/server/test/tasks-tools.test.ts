import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { createTask, type Task } from '../src/modules/tasks/engine.js';
import { TASK_ANSWER } from '../src/modules/tasks/tools.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const tess = await hire('Tess', 'worker', 'DEV-TEST');
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  return { app, db, ctx: app.ctx, companyId, ceo: ceo!, orchestrator: orchestrator!, dev: dev!, sales: sales!, head, bruno, rita, tess, sam, tools };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: object) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;

describe('task tools', () => {
  it('gives each kind of agent its task tools', async () => {
    const { orchestrator, head, bruno, tools } = await company();
    const names = async (agent: { id: string }) => (await (await tools(agent)).listTools()).tools.map(t => t.name).sort();
    expect(await names(orchestrator)).toEqual(['add_api_key', 'add_plan_to_machine', 'add_tasks', 'answer_request', 'ask_computer_access', 'ask_person', 'build_structure', 'cancel_task', 'cancel_update', 'change_employee', 'change_orchestrator', 'change_person', 'check_updates', 'close_improvement', 'comment', 'company', 'computer', 'computer_result', 'connect_plans', 'database', 'disconnect_machine', 'edit_turn', 'explain_request', 'fire_employee', 'forget', 'hire', 'improvements', 'invite_again', 'invite_person', 'lend_machine', 'machine_command', 'merge_turn', 'message_employee', 'move_orchestrator', 'notebook', 'plan_command', 'plan_turn', 'pool', 'propose_staff', 'propose_structure', 'remember', 'remove_public_link', 'remove_repository', 'remove_subscription', 'report', 'reset_employee', 'rewrite_note', 'set_budget', 'set_public_link', 'set_repository', 'staffing_options', 'stop_employee', 'task', 'tasks', 'test_subscription', 'turns', 'update_hornhoof', 'update_task', 'view']);
    expect(await names(head)).toEqual(['ask_person', 'blocked', 'cancel_task', 'comment', 'company', 'create_task', 'forget', 'improvements', 'message_employee', 'notebook', 'propose_improvement', 'remember', 'report', 'rewrite_note', 'run_tests', 'run_work', 'stop_tests', 'stop_work', 'submit', 'task', 'tasks', 'tell_orchestrator', 'test_run', 'update_task', 'verdict', 'work_run']);
    expect(await names(bruno)).toEqual(['ask_person', 'blocked', 'comment', 'company', 'message_employee', 'run_tests', 'run_work', 'stop_tests', 'stop_work', 'submit', 'task', 'tasks', 'test_run', 'verdict', 'work_run']);
  });

  it("tells a head to give work to members, and to itself only when no member can do it", async () => {
    const { head, tools } = await company();
    const create = (await (await tools(head)).listTools()).tools.find(t => t.name === 'create_task')!;
    expect(create.description).toContain('Gives work to a member of your department');
    expect(create.description).toContain('Name yourself only when no member can do it.');
    expect(create.description).not.toContain('(or yourself)');
  });

  it('tells the head to give work out in a few large pieces with only the gates they need, and the orchestrator one task per goal', async () => {
    const { orchestrator, head, tools } = await company();
    const said = async (agent: { id: string }, name: string) => (await (await tools(agent)).listTools()).tools.find(t => t.name === name)!.description!;
    expect(await said(head, 'create_task')).toContain("leave them out for code in a repository under your department's task of the turn, which the review of the turn checks all at once; [] for research, reports, plans and docs");
    expect(await said(orchestrator, 'plan_turn')).toContain("one for each of the CEO's goals, for the one department that owns it end to end");
    expect(await said(orchestrator, 'add_tasks')).toContain('A new ask goes into the next planned turn, into the running turn only when the CEO says now.');
    expect(wakePrompt({ kind: 'head' }, { number: 1, title: 'Payments', executorAgentId: null, panel: [] } as unknown as Task, { agentId: head.id, taskId: 't', why: 'assigned' })).toContain(
      'Give it out in 2-4 large self-contained pieces to different members at once with create_task, each under it (parent 1) with its executor and no gates for code: the review of the turn checks all of it once the last piece is in',
    );
  });

  it('lets a head give a member task with gates named by role, only inside its department', async () => {
    const { db, head, bruno, rita, sam, tools } = await company();
    const client = await tools(head);
    const made = await call(client, 'create_task', { title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', executor: bruno.id, gates: ['DEV-REV'] });
    expect(made.isError).toBeFalsy();
    const [task] = await db.select().from(tasks);
    expect(task).toMatchObject({ executorAgentId: bruno.id, gates: [rita.id], createdByAgentId: head.id });
    const outside = await call(client, 'create_task', { title: 'Call leads', brief: '', body: '', executor: sam.id });
    expect(outside.isError).toBe(true);
  });

  it('gives a task whose gates the head left out only the first review stage, not every gate role of the department', async () => {
    const { db, dev, head, bruno, rita, tools } = await company();
    const [sid] = await db.select().from(agents).where(eq(agents.id, rita.id));
    await db.insert(agents).values({ companyId: sid!.companyId, kind: 'worker', name: 'Sid', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sid!.subscriptionId });
    const made = await call(await tools(head), 'create_task', { title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', executor: bruno.id });
    expect(made.isError).toBeFalsy();
    const [task] = await db.select().from(tasks);
    expect(task!.gates).toEqual([rita.id]);
  });

  it("refuses a member's move on another member's task with a readable error", async () => {
    const { ctx, db, head, bruno, tess, dev, tools } = await company();
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, gates: [] });
    const res = await call(await tools(tess), 'submit', { task: task.number, summary: 'Done.', evidence: 'npm test' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('#1');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('open');
  });

  it('refuses the eleventh task in one turn', async () => {
    const { orchestrator, dev, tools } = await company();
    const client = await tools(orchestrator);
    const ten = Array.from({ length: 10 }, (_, i) => ({ department: dev.id, title: `Task ${i + 1}`, brief: '', body: '' }));
    expect((await call(client, 'plan_turn', { title: 'Big', goal: 'Ten things.', tasks: ten })).isError).toBeFalsy();
    const eleventh = await call(client, 'add_tasks', { turn: 1, tasks: [{ department: dev.id, title: 'Task 11', brief: '', body: '' }] });
    expect(eleventh.isError).toBe(true);
    expect(text(eleventh)).toMatch(/10 tasks/);
  });

  it('keeps the newest of a long log within one answer, and says how much of it was left out', async () => {
    const { ctx, db, ceo, head, dev, tools } = await company();
    const { task } = await createTask(ctx, { personId: ceo.id }, { title: 'Payments', brief: '', body: 'Stripe.', departmentId: dev.id, assigneeAgentId: head.id });
    await db.insert(taskEvents).values(Array.from({ length: 60 }, (_, i) => ({ companyId: task.companyId, taskId: task.id, kind: 'comment' as const, text: `${i + 1}. ${'x'.repeat(3990)}`, agentId: head.id })));
    const answer = text(await call(await tools(head), 'task', { task: task.number }));
    expect(answer.length).toBeLessThanOrEqual(TASK_ANSWER);
    const read = JSON.parse(answer);
    expect(read.log.at(-1).text).toMatch(/^60\. /);
    expect(read.logLeftOut).toBe(61 - read.log.length);
    expect(read.body).toBe('Stripe.');
  });

  it("hides other departments' tasks from an employee", async () => {
    const { ctx, ceo, head, bruno, sam, sales, dev, tools } = await company();
    await createTask(ctx, { personId: ceo.id }, { title: 'Payments', brief: '', body: 'Stripe.', departmentId: dev.id, assigneeAgentId: head.id });
    const { task: theirs } = await createTask(ctx, { agentId: head.id }, { title: 'Sales deck', brief: '', body: '', departmentId: sales.id, assigneeAgentId: sam.id, executor: true });
    const client = await tools(bruno);
    expect((await call(client, 'task', { task: theirs.number })).isError).toBe(true);
    const mine = JSON.parse(text(await call(client, 'task', { task: 1 })));
    expect(mine).toMatchObject({ number: 1, title: 'Payments', body: 'Stripe.', assignee: { name: 'Hana' } });
    const listed = JSON.parse(text(await call(client, 'tasks', {})));
    expect(listed.map((t: { number: number }) => t.number)).toEqual([1]);
  });
});

describe('asking a person', () => {
  it('keeps what the question is about, and takes no topic it does not know', async () => {
    const { ctx, db, dev, head, bruno, tools } = await company();
    const task = (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
    const client = await tools(bruno);
    expect((await call(client, 'ask_person', { task: task.number, question: 'Which cards do we take?', topic: 'task' })).isError).toBeFalsy();
    expect((await call(client, 'ask_person', { task: task.number, question: 'Who pays for the card fees?', topic: 'money' })).isError).toBe(true);
    expect((await call(client, 'ask_person', { task: task.number, question: 'Which banks?' })).isError).toBeFalsy();
    const asked = await db.select({ text: requests.text, topic: requests.decisionTopic }).from(requests).orderBy(requests.createdAt);
    expect(asked).toEqual([
      { text: 'Which cards do we take?', topic: 'task' },
      { text: 'Which banks?', topic: null },
    ]);
  });
});
