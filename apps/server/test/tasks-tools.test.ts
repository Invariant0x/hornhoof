import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, approvalPolicies, companies, departments, jobs, people, requests, subscriptions, taskEvents, tasks, taskWaits, waitPolicies } from '../src/db/schema.js';
import { createTask, submit, updateTask, type Task } from '../src/modules/tasks/engine.js';
import { TASK_ANSWER } from '../src/modules/tasks/tools.js';
import { listEvents } from '../src/modules/events/store.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { as, echelonsTurn, listen, mcp, setUpCompany, testApp } from './helpers.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { BASE, HEAD } from './development-echelons-fixture.js';

/* With a turn open in echelons, unless asked for none. */
async function company({ turn = true } = {}) {
  const { app, db } = await testApp();
  await listen(app);
  const ceoToken = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/shop.git' },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)!.skills.filter(skill => skill.on).map(skill => skill.id) }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const tess = await hire('Tess', 'worker', 'DEV-TEST');
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
  app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  if (turn) await echelonsTurn(db, companyId);
  return { app, db, ctx: app.ctx, companyId, ceoToken, ceo: ceo!, orchestrator: orchestrator!, dev: dev!, sales: sales!, head, bruno, rita, tess, sam, tools };
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;

describe('task tools', () => {
  it('lists an older held task first even behind more than 200 open tasks', async () => {
    const { ctx, db, dev, sales, head, bruno, sam, tools } = await company();
    const { task: own } = await createTask(ctx, { agentId: head.id }, { departmentId: dev.id, title: 'My old task', brief: '', body: '', assigneeAgentId: bruno.id, resultKind: 'coordination' });
    await db.insert(tasks).values(Array.from({ length: 210 }, (_, i) => ({ companyId: dev.companyId, departmentId: sales.id, number: 2002 + i, title: `Other task ${i}`, assigneeAgentId: sam.id })));
    const client = await tools(bruno);
    const result = await call(client, 'tasks', {});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)[0]).toMatchObject({ id: own.id });
  });

  it('lets the company watchdog inspect a task in another department without moving it', async () => {
    const { ctx, db, dev, head, bruno, tools } = await company();
    const [watchdog] = await db.insert(agents).values({ companyId: dev.companyId, kind: 'worker', roleKey: 'OPS-WATCH', name: 'Watchdog', model: '', skills: ['ops-task-watch'] }).returning();
    const { task } = await createTask(ctx, { agentId: head.id }, { departmentId: dev.id, title: 'Check invoices', brief: '', body: 'Look at what stalled.', assigneeAgentId: bruno.id, resultKind: 'coordination' });
    const client = await tools(watchdog!);
    const read = await call(client, 'task', { task: task.number });
    expect(read.isError, text(read)).toBeFalsy();
    expect(JSON.parse(text(read))).toMatchObject({ id: task.id, body: 'Look at what stalled.' });
    expect((await call(client, 'comment', { task: task.number, text: 'Change the plan.' })).isError).toBe(true);
  });
  it.each(['comment', 'submit', 'report'] as const)('keeps a long UTF-8 %s intact through MCP', async kind => {
    const c = await company();
    const words = 'Report: права доступа и полный текст.\n'.repeat(500).slice(0, 11999) + '!';
    const owner = kind === 'report' ? c.head : c.bruno;
    const task = (await createTask(c.ctx, { agentId: c.orchestrator.id }, { title: 'Long report', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: owner.id, executor: kind !== 'report', small: true, paths: ['logic/totals.ts'] })).task;
    const client = await c.tools(owner);
    const args = kind === 'comment' ? { text: words } : kind === 'submit' ? { summary: words, evidence: words, review: { baseCommit: BASE } } : { done: true, summary: words, recorded: { path: 'reports/long.md' } };
    const result = await call(client, kind, { task: task.number, ...args });
    expect(result.isError, text(result)).toBeFalsy();
    const detail = JSON.parse(text(await call(client, 'task', { task: task.number })));
    const event = detail.log.find((e: { kind: string }) => e.kind === (kind === 'submit' ? 'submitted' : kind));
    expect(event.by.id).toBe(owner.id);
    for (const field of kind === 'submit' ? ['text', 'evidence'] : ['text']) {
      const ref = event.data.fullTexts?.find((f: { field: string }) => f.field === field);
      const bytes = ref ? (await c.app.inject({ url: `/api/attachments/${ref.id}`, ...as(c.ceoToken) })).rawPayload : Buffer.from(field === 'text' ? event.text : event.data.evidence);
      expect(bytes.equals(Buffer.from(words))).toBe(true);
    }
  });

  it('keeps a long UTF-8 verdict intact through MCP and task readback', async () => {
    const c = await company();
    const words = 'Finding: проверка доступа, данные и повтор. 🌿\n'.repeat(400).slice(0, 12000);
    expect(words.length).toBe(12000);
    const task = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Long review', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: c.rita.id, testsAgentId: c.tess.id })).task;
    await submit(c.ctx, c.bruno.id, task.id, { summary: 'Ready.', evidence: 'Targeted checks.', review: { baseCommit: BASE } });
    const client = await c.tools(c.rita);
    const result = await call(client, 'verdict', { task: task.number, pass: true, reviewedCommit: HEAD, comment: words });
    expect(result.isError, text(result)).toBeFalsy();
    const detail = JSON.parse(text(await call(client, 'task', { task: task.number })));
    const event = detail.log.find((e: { kind: string }) => e.kind === 'verdict');
    expect(event.by.id).toBe(c.rita.id);
    const file = event.data.fullTexts?.find((f: { field: string }) => f.field === 'text');
    const bytes = file ? (await c.app.inject({ url: `/api/attachments/${file.id}`, ...as(c.ceoToken) })).rawPayload : Buffer.from(event.text);
    expect(bytes.equals(Buffer.from(words))).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(words).digest('hex'));
    expect((await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'))))).toHaveLength(1);
  });

  it('gives each kind of agent its task tools', async () => {
    const { orchestrator, head, bruno, tools } = await company();
    const names = async (agent: { id: string }) => (await (await tools(agent)).listTools()).tools.map(t => t.name).sort();
    expect(await names(orchestrator)).toEqual(['add_api_key', 'add_plan_to_machine', 'add_repository', 'add_tasks', 'answer_request', 'api', 'apply_pipeline', 'approval_policy', 'ask_person', 'backlog', 'build_structure', 'cancel_task', 'cancel_update', 'change_employee', 'change_orchestrator', 'change_person', 'check_updates', 'close_improvement', 'close_task', 'comment', 'company', 'computer', 'computer_result', 'connect_plans', 'create_google_sheet', 'create_repository', 'database', 'delete_person', 'disconnect_machine', 'edit_turn', 'escalate_missed_goal', 'explain_request', 'find_tool', 'fire_employee', 'forget', 'goals', 'hire', 'improvements', 'inbox', 'inbox_mark', 'invite_again', 'invite_person', 'lend_machine', 'logs', 'machine_command', 'machines', 'merge_conflicts', 'merge_pick', 'message_employee', 'move_orchestrator', 'notebook', 'open_computer_access', 'pause_task', 'phone_acquire', 'phone_action', 'phone_release', 'phone_session', 'phones', 'pipeline_catalog', 'pipeline_report', 'plan_command', 'pool', 'program_keys', 'program_recovery_release', 'program_screen', 'propose_staff', 'propose_structure', 'record_answer', 'remember', 'remove_public_link', 'remove_repository', 'remove_subscription', 'replan_wait', 'report', 'request_approval', 'reset_employee', 'resolve_goal_risk', 'resume_task', 'rewrite_note', 'send_telegram_file', 'set_approval_policy', 'set_autonomous_release', 'set_budget', 'set_department_owner', 'set_goal', 'set_pipeline', 'set_public_link', 'set_repository', 'set_team_urgent_only', 'set_urgent', 'set_wait_policy', 'shell', 'source', 'staffing_options', 'stop_employee', 'task', 'tasks', 'test_subscription', 'track_work', 'turns', 'update_hornhoof', 'update_task', 'use_tool', 'vault_entries', 'vault_entry', 'wait_for']);
    expect(await names(head)).toEqual(['add_tasks', 'approval_policy', 'ask_person', 'backlog', 'blocked', 'briefing', 'calls', 'cancel_task', 'change_department', 'change_employee', 'check_author', 'comment', 'company', 'computer', 'computer_result', 'confirm_finding', 'create_google_sheet', 'create_task', 'edit_turn', 'end_wait', 'escalate_missed_goal', 'fire_employee', 'forget', 'goals', 'hire', 'improvements', 'inbox', 'inbox_mark', 'machines', 'message_employee', 'notebook', 'pause_task', 'phone_acquire', 'phone_action', 'phone_release', 'phone_session', 'phones', 'propose_improvement', 'record_answer', 'release_turn', 'remember', 'replan_wait', 'report', 'request_approval', 'reset_employee', 'resolve_goal_risk', 'resume_task', 'rewrite_note', 'run_tests', 'run_work', 'send_telegram_file', 'set_approval_policy', 'set_autonomous_release', 'set_employee_assignment', 'set_goal', 'set_pipeline', 'set_team_urgent_only', 'set_wait_policy', 'staffing_options', 'start_calls', 'stop_calls', 'stop_tests', 'stop_work', 'submit', 'task', 'tasks', 'tell_orchestrator', 'test_harness', 'test_run', 'track_work', 'turns', 'update_task', 'vault_entries', 'vault_entry', 'verdict', 'wait_for', 'work_run']);
    expect(await names(bruno)).toEqual(['approval_policy', 'ask_person', 'blocked', 'briefing', 'calls', 'check_author', 'comment', 'company', 'computer', 'computer_result', 'confirm_finding', 'create_google_sheet', 'end_wait', 'goals', 'inbox', 'inbox_mark', 'machines', 'message_employee', 'phone_acquire', 'phone_action', 'phone_release', 'phone_session', 'phones', 'record_answer', 'release_turn', 'replan_wait', 'report', 'request_approval', 'run_tests', 'run_work', 'send_telegram_file', 'start_calls', 'stop_calls', 'stop_tests', 'stop_work', 'submit', 'task', 'tasks', 'test_harness', 'test_run', 'track_work', 'vault_entries', 'vault_entry', 'verdict', 'wait_for', 'work_run']);
  });

  it("describes one whole department result and explicit scope for its checking owners", async () => {
    const { head, tools } = await company();
    const create = (await (await tools(head)).listTools()).tools.find(t => t.name === 'create_task')!;
    expect(create.description).toContain('Assigns one whole result in your department.');
    expect(create.description).toContain('A code task needs its repository paths (paths)');
    expect(create.description).toContain('eligible skill owners are selected');
  });

  it('tells the head to assign connected blocks to one developer and independent blocks at once, and the orchestrator one task per goal', async () => {
    const { orchestrator, head, tools } = await company();
    const said = async (agent: { id: string }, name: string) => (await (await tools(agent)).listTools()).tools.find(t => t.name === name)!.description!;
    expect(await said(head, 'create_task')).toContain('Code follows Architecture (unless small or shared with its Development owner), Development, Review, risk-based Security, then Tests on the final candidate.');
    expect(await said(head, 'check_author')).toContain('Disabled.');
    expect(await said(head, 'create_task')).not.toContain('may skip Review');
    expect(await said(orchestrator, 'add_tasks')).toContain('Gives tasks to the heads of their departments');
    const add = await said(orchestrator, 'add_tasks');
    expect(add).toContain('hh-lead-tasks');
    expect(add).not.toContain('only when the CEO says now');
    const prompt = wakePrompt({ kind: 'head' }, { number: 1, title: 'Payments', executorAgentId: null } as unknown as Task, { agentId: head.id, taskId: 't', why: 'assigned' });
    expect(prompt).toContain('Use the department\'s route and assign each part to someone with the abilities to deliver it.');
    expect(prompt).toContain('Give independent parts out together with create_task under parent 1. Use the checks each result requires and report the accepted results.');
    expect(prompt).not.toMatch(/2-4|two to four|pieces to different members/);
  });

  it('lets a head assign a current reviewer by identity only inside its department', async () => {
    const { db, head, bruno, rita, sam, tools } = await company();
    const client = await tools(head);
    const made = await call(client, 'create_task', { paths: ['apps/**'], title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', executor: bruno.id, reviewerAgentId: rita.id });
    expect(made.isError).toBeFalsy();
    const [task] = await db.select().from(tasks);
    expect(task).toMatchObject({ executorAgentId: bruno.id, createdByAgentId: head.id });
    const route = await routeOf(db, task!);
    expect(route.state.stages.find(step => step.stage === 'review')).toMatchObject({ ownerAgentId: rita.id, status: 'pending' });
    const outside = await call(client, 'create_task', { paths: ['apps/**'], title: 'Call leads', brief: '', body: '', executor: sam.id });
    expect(outside.isError).toBe(true);
  });

  it('keeps mandatory Review and skips optional Security when no risk was assigned', async () => {
    const { db, dev, head, bruno, rita, tools } = await company();
    const [sid] = await db.select().from(agents).where(eq(agents.id, rita.id));
    await db.insert(agents).values({ companyId: sid!.companyId, kind: 'worker', name: 'Sid', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sid!.subscriptionId });
    const made = await call(await tools(head), 'create_task', { paths: ['apps/**'], title: 'Checkout API', brief: 'The API.', body: 'POST /checkout.', executor: bruno.id });
    expect(made.isError).toBeFalsy();
    const [task] = await db.select().from(tasks);
    const snapshot = routeSnapshot(await routeOf(db, task!), task!.assigneeAgentId);
    expect(snapshot.stage).toBe('development');
    expect(snapshot.stages.find(step => step.stage === 'architecture')).toMatchObject({ status: 'skipped', reason: 'same_executor' });
    expect(snapshot.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending' });
    expect(snapshot.stages.find(step => step.stage === 'security')).toMatchObject({ status: 'skipped' });
    expect(snapshot.stages.some(step => step.stage === 'cleanup')).toBe(false);
  });

  it("refuses a member's move on another member's task with a readable error", async () => {
    const { ctx, db, head, bruno, tess, dev, tools } = await company();
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    const res = await call(await tools(tess), 'submit', { task: task.number, summary: 'Done.', evidence: 'npm test' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('#1');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('open');
  });

  it('accepts a needed assignment after ten tasks in the same turn', async () => {
    const { orchestrator, dev, tools } = await company({ turn: false });
    const client = await tools(orchestrator);
    const ten = Array.from({ length: 10 }, (_, i) => ({ department: dev.id, title: `Task ${i + 1}`, brief: '', body: '' }));
    expect((await call(client, 'add_tasks', { tasks: ten })).isError).toBeFalsy();
    const eleventh = await call(client, 'add_tasks', { tasks: [{ department: dev.id, title: 'Task 11', brief: '', body: '' }] });
    expect(eleventh.isError, text(eleventh)).toBeFalsy();
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
  it('asks a person only with every promised material attached, and keeps a note that should not end a wait off the task', async () => {
    const { head, tools } = await company();
    const said = async (name: string) => (await (await tools(head)).listTools()).tools.find(t => t.name === name)!.description!;
    expect(await said('ask_person')).toMatch(/Ask only once every instruction and material the question promises is ready, attached to it instead of a pointer to a task's log, and let one sender ask it once\./);
    expect(await said('comment')).toMatch(/A note that should leave the wait standing goes to its holder with message_employee naming no task\./);
  });

  it('keeps the question as an outgoing message to its responsible person', async () => {
    const { ctx, db, dev, head, bruno, ceo, tools } = await company();
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    const asked = await call(await tools(bruno), 'ask_person', { task: task.number, question: 'Which cards do we take?' });
    expect(asked.isError).toBeFalsy();
    const outgoing = (await listEvents(db, bruno.id, 0)).find(e => e.message?.direction === 'out');
    expect(outgoing).toMatchObject({ kind: 'message', data: { text: 'Which cards do we take?' }, message: { direction: 'out', from: { kind: 'agent', id: bruno.id, agentKind: 'worker' }, to: { kind: 'person', id: ceo.id, name: 'Ivan', role: { en: 'CEO' } } } });
  });

  it('keeps what the question is about, and takes no topic it does not know', async () => {
    const { ctx, db, dev, head, bruno, tools } = await company();
    const task = (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true })).task;
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

describe('a small task', () => {
  it('is set and read by the giver, never by its executor', async () => {
    const { app, db, ceoToken, head, bruno, orchestrator, tools } = await company();
    const client = await tools(head);
    const made = await call(client, 'create_task', { paths: ['apps/**'], title: 'Small copy', brief: '', body: '', executor: bruno.id, small: true });
    expect(made.isError).toBeFalsy();
    const [row] = await db.select().from(tasks);
    expect(row).toMatchObject({ small: true });
    expect(JSON.parse(text(await call(client, 'tasks', {})))[0]).toMatchObject({ number: row!.number, small: true });
    expect(JSON.parse(text(await call(client, 'task', { task: row!.number })))).toMatchObject({ small: true });
    const read = await app.inject({ method: 'GET', url: `/api/tasks/${row!.id}`, ...as(ceoToken) });
    expect(read.json().task).toMatchObject({ small: true });

    expect((await call(client, 'update_task', { task: row!.number, small: false })).isError).toBeFalsy();
    expect((await db.select().from(tasks))[0]).toMatchObject({ small: false });
    expect((await call(await tools(orchestrator), 'update_task', { task: row!.number, small: true })).isError).toBeFalsy();
    expect((await call(await tools(bruno), 'update_task', { task: row!.number, small: false })).isError).toBe(true);
    expect((await db.select().from(tasks))[0]).toMatchObject({ small: true });
  });

  it('is not small by default', async () => {
    const { db, head, bruno, tools } = await company();
    await call(await tools(head), 'create_task', { paths: ['apps/**'], title: 'Ordinary', brief: '', body: '', executor: bruno.id });
    expect((await db.select().from(tasks))[0]).toMatchObject({ small: false });
  });
});

describe("a task's kind and risk class", () => {
  const work = (department: string, title: string, labels: Record<string, string> = {}) => ({ department, title, brief: 'Why.', body: 'What.', ...labels });

  it('are kept when a head gives the task out, and read back by tasks, task and the API', async () => {
    const { app, db, ceoToken, head, bruno, tools } = await company();
    const client = await tools(head);
    const made = await call(client, 'create_task', { paths: ['apps/**'], title: 'Fix login', brief: '', body: 'Fix it.', executor: bruno.id, workKind: 'bug', riskClass: 'access' });
    expect(made.isError).toBeFalsy();
    const [row] = await db.select().from(tasks);
    expect(row).toMatchObject({ workKind: 'bug', riskClass: 'access' });
    expect(JSON.parse(text(await call(client, 'tasks', {})))[0]).toMatchObject({ number: row!.number, workKind: 'bug', riskClass: 'access' });
    expect(JSON.parse(text(await call(client, 'task', { task: row!.number })))).toMatchObject({ workKind: 'bug', riskClass: 'access' });
    const read = await app.inject({ method: 'GET', url: `/api/tasks/${row!.id}`, ...as(ceoToken) });
    expect(read.json().task).toMatchObject({ workKind: 'bug', riskClass: 'access' });
  });

  it('are empty until someone names them', async () => {
    const { db, head, bruno, tools } = await company();
    const client = await tools(head);
    await call(client, 'create_task', { paths: ['apps/**'], title: 'Plain', brief: '', body: '', executor: bruno.id });
    const [row] = await db.select().from(tasks);
    expect(row).toMatchObject({ workKind: null, riskClass: null });
    expect(JSON.parse(text(await call(client, 'task', { task: row!.number })))).toMatchObject({ workKind: null, riskClass: null });
  });

  it('changes the work kind without waking whoever holds the task, and a log line says so', async () => {
    const { db, ctx, head, bruno, tools } = await company();
    const client = await tools(head);
    await call(client, 'create_task', { paths: ['apps/**'], title: 'Plain', brief: '', body: '', executor: bruno.id });
    const [row] = await db.select().from(tasks);
    const moved = await updateTask(ctx, head.id, row!.id, { workKind: 'legacy_code' });
    expect(moved.wakes).toEqual([]);
    expect(moved.task).toMatchObject({ workKind: 'legacy_code' });
    const updated = await db.select().from(taskEvents).where(eq(taskEvents.kind, 'updated'));
    expect(updated.at(-1)!.data).toEqual({ fields: ['workKind'] });
    const again = await call(client, 'update_task', { task: row!.number, workKind: 'unknown_path' });
    expect(again.isError).toBeFalsy();
    expect((await db.select().from(tasks))[0]).toMatchObject({ workKind: 'unknown_path' });
  });

  it('leaves the wait, task version and current route intact when only the work kind changes', async () => {
    const { db, ctx, head, bruno, tools } = await company();
    await call(await tools(head), 'create_task', { paths: ['apps/**'], title: 'Plain', brief: '', body: '', executor: bruno.id });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const [row] = await db.update(tasks).set({ externalWait: { reason: 'A build', since: new Date().toISOString(), until } }).returning();
    const route = await routeOf(db, row!);
    const moved = await updateTask(ctx, head.id, row!.id, { workKind: 'known_behavior' });
    expect(await routeOf(db, moved.task)).toEqual(route);
    expect(moved.task.externalWait).toMatchObject({ reason: 'A build', until });
    expect(moved.task.version).toBe(row!.version);
    expect((await updateTask(ctx, head.id, row!.id, { workKind: 'known_behavior' })).task.updatedAt).toEqual(moved.task.updatedAt);
  });

  it('adds required Security and informs the current owner when the head changes the risk', async () => {
    const { db, ctx, head, bruno, tools } = await company();
    await call(await tools(head), 'create_task', { paths: ['apps/**'], title: 'Plain', brief: '', body: '', executor: bruno.id });
    const [row] = await db.select().from(tasks);
    const before = await routeOf(db, row!);
    const moved = await updateTask(ctx, head.id, row!.id, { riskClass: 'data' });
    const after = await routeOf(db, moved.task);
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([bruno.id]);
    expect(after.state).toMatchObject({ stage: before.state.stage, candidateId: before.state.candidateId, security: { required: true, reason: 'data', addedBy: head.id } });
    expect(after.state.stages.find(step => step.stage === 'security')).toMatchObject({ status: 'pending' });
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('still wake the holder when the body changes with them', async () => {
    const { db, ctx, head, bruno, tools } = await company();
    await call(await tools(head), 'create_task', { paths: ['apps/**'], title: 'Plain', brief: '', body: '', executor: bruno.id });
    const [row] = await db.select().from(tasks);
    const moved = await updateTask(ctx, head.id, row!.id, { body: 'New truth.', workKind: 'bug' });
    expect(moved.wakes.map(w => w.agentId)).toEqual([bruno.id]);
  });

  it('come from the orchestrator in add_tasks, on each task', async () => {
    const { db, dev, orchestrator, tools } = await company({ turn: false });
    const client = await tools(orchestrator);
    const planned = await call(client, 'add_tasks', { tasks: [work(dev.id, 'One', { workKind: 'known_behavior', riskClass: 'none' }), work(dev.id, 'Two')] });
    expect(planned.isError).toBeFalsy();
    const added = await call(client, 'add_tasks', { tasks: [work(dev.id, 'Three', { workKind: 'bug', riskClass: 'money' })] });
    expect(added.isError).toBeFalsy();
    const rows = await db.select({ title: tasks.title, workKind: tasks.workKind, riskClass: tasks.riskClass }).from(tasks).orderBy(tasks.number);
    expect(rows).toEqual([
      { title: 'One', workKind: 'known_behavior', riskClass: 'none' },
      { title: 'Two', workKind: null, riskClass: null },
      { title: 'Three', workKind: 'bug', riskClass: 'money' },
    ]);
  });

  it('refuses a kind or a risk class it does not know', async () => {
    const { db, head, bruno, tools } = await company();
    const client = await tools(head);
    const asked = (labels: Record<string, string>) => call(client, 'create_task', { paths: ['apps/**'], title: 'Plain', brief: '', body: '', executor: bruno.id, ...labels });
    expect((await asked({ workKind: 'feature' })).isError).toBe(true);
    expect((await asked({ riskClass: 'fun' })).isError).toBe(true);
    expect(await db.select().from(tasks)).toEqual([]);
  });
});

describe('dates through the tools', () => {
  const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const promise = (c: Awaited<ReturnType<typeof company>>) => ({
    version: 1, ownerDueAt: later(1), headDueAt: later(2), decisionDueAt: later(3),
    provenance: { kind: 'explicit_promise', actor: { personId: c.ceo.id }, ref: 'promise-1', revision: 1, origin: 'test' },
    finalReview: { headAgentId: c.head.id, anchorAt: later(4), intervalMs: 3_600_000 },
  });
  const strict = (c: Awaited<ReturnType<typeof company>>) => c.db.insert(waitPolicies).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'review', stage: '', version: 1, ownerMs: 3_600_000, headMs: 7_200_000, decisionMs: 10_800_000, reviewIntervalMs: 14_400_000, createdByPersonId: c.ceo.id });
  const piece = (title: string, executor: string, more: object = {}) => ({ title, brief: '', body: '', executor, paths: ['apps/**'], ...more });

  it('takes a promise for one edge in create_task, and refuses what comes without one where dates are set', async () => {
    const c = await company();
    await strict(c);
    const client = await c.tools(c.head);
    const first = JSON.parse(text(await call(client, 'task', { task: (await createTask(c.ctx, { agentId: c.head.id }, { title: 'First', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true })).task.number })));
    const without = await call(client, 'create_task', piece('Follow', c.rita.id, { after: [first.number], independentNone: 'One piece.' }));
    expect(without.isError).toBe(true);
    expect(text(without)).toContain('sets dates for its waits');
    const made = await call(client, 'create_task', piece('Follow', c.rita.id, { after: [first.number], independentNone: 'One piece.', afterPlans: [{ task: first.number, plan: promise(c) }] }));
    expect(made.isError, text(made)).toBeFalsy();
    const [follow] = await c.db.select().from(tasks).where(eq(tasks.title, 'Follow'));
    expect(await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, follow!.id))).toMatchObject([{ kind: 'after', state: 'active', plan: { provenance: { kind: 'explicit_promise' } } }]);
    const seen = JSON.parse(text(await call(client, 'task', { task: follow!.number })));
    expect(seen.waits).toMatchObject([{ kind: 'after', state: 'active', owner: { agentId: c.bruno.id } }]);
  });

  it('takes a promise for what update_task adds', async () => {
    const c = await company();
    await strict(c);
    const client = await c.tools(c.head);
    const first = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'First', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true })).task;
    const later = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Later', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.rita.id, executor: true })).task;
    const updated = await call(client, 'update_task', { task: later.number, after: [first.number], independentNone: 'One piece.', afterPlans: [{ task: first.number, plan: promise(c) }] });
    expect(updated.isError, text(updated)).toBeFalsy();
    expect(await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, later.id))).toMatchObject([{ state: 'active' }]);
  });

  it('takes a promise in ask_person and request_approval, and a question with none where dates are set for others', async () => {
    const c = await company();
    await strict(c);
    const client = await c.tools(c.bruno);
    const work = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Work', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true })).task;
    const plain = await call(client, 'ask_person', { task: work.number, question: 'Which?', topic: 'task' });
    expect(plain.isError, text(plain)).toBeFalsy();
    const asked = await call(client, 'ask_person', { task: work.number, question: 'And which?', topic: 'task', plan: promise(c) });
    expect(asked.isError, text(asked)).toBeFalsy();
    await c.db.insert(approvalPolicies).values({ companyId: c.companyId, departmentId: c.dev.id, channel: 'spend', mode: 'every' });
    const approval = await call(client, 'request_approval', { task: work.number, channel: 'spend', kind: 'ads', text: 'Buy ads?', plan: promise(c) });
    expect(approval.isError, text(approval)).toBeFalsy();
    expect(await c.db.select().from(requests).where(eq(requests.taskId, work.id))).toHaveLength(3);
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, work.id))).map(w => w.kind)).toEqual(['person', 'person', 'person']);
  });
});

describe('dates over HTTP', () => {
  it('takes a promise for an edge in POST /api/tasks, and refuses without one where dates are set, with the same words', async () => {
    const c = await company();
    await c.db.insert(waitPolicies).values({ companyId: c.companyId, departmentId: c.dev.id, kind: 'review', stage: '', version: 1, ownerMs: 3_600_000, headMs: 7_200_000, decisionMs: 10_800_000, reviewIntervalMs: 14_400_000, createdByPersonId: c.ceo.id });
    const first = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'First', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true })).task;
    const post = (payload: object) => c.app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 'Follow', department: c.dev.id, after: [first.number], independentNone: 'One piece.', ...payload }, ...as(c.ceoToken) });
    const refused = await post({});
    expect(refused.statusCode).toBe(400);
    expect(refused.json().reason ?? refused.json().error).toBeDefined();
    expect(refused.body).toContain('sets dates for its waits');
    const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const plan = { version: 1, ownerDueAt: later(1), headDueAt: later(2), decisionDueAt: later(3), provenance: { kind: 'explicit_promise', actor: { personId: c.ceo.id }, ref: 'promise-1', revision: 1, origin: 'test' }, finalReview: { headAgentId: c.head.id, anchorAt: later(4), intervalMs: 3_600_000 } };
    const made = await post({ afterPlans: [{ task: first.number, plan }] });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().task.waits).toMatchObject([{ kind: 'after', state: 'active' }]);
  });
});
