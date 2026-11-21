import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskRoutes, tasks, turns } from '../src/db/schema.js';
import { echelonsTurn, invitePerson } from './helpers.js';
import { call, company, text, work } from './turns-company.js';

describe('turns as releases, with the work flowing', () => {
  it('gives the orchestrator and a head the tools of the flow, and nobody a tool to plan, merge or switch turns', async () => {
    const { orchestrator, hana, tools } = await company();
    const names = async (agent: { id: string }) => (await (await tools(agent)).listTools()).tools.map(t => t.name).sort();
    expect(await names(orchestrator)).toEqual(['add_api_key', 'add_plan_to_machine', 'add_repository', 'add_tasks', 'answer_request', 'api', 'apply_pipeline', 'approval_policy', 'ask_person', 'backlog', 'build_structure', 'cancel_task', 'cancel_update', 'change_employee', 'change_orchestrator', 'change_person', 'check_updates', 'close_improvement', 'close_task', 'comment', 'company', 'computer', 'computer_result', 'connect_plans', 'create_google_sheet', 'create_repository', 'database', 'delete_person', 'disconnect_machine', 'edit_turn', 'escalate_missed_goal', 'explain_request', 'find_tool', 'fire_employee', 'forget', 'goals', 'hire', 'improvements', 'inbox', 'inbox_mark', 'invite_again', 'invite_person', 'lend_machine', 'logs', 'machine_command', 'machines', 'merge_conflicts', 'merge_pick', 'message_employee', 'move_orchestrator', 'notebook', 'open_computer_access', 'pause_task', 'phone_acquire', 'phone_action', 'phone_release', 'phone_session', 'phones', 'pipeline_catalog', 'pipeline_report', 'plan_command', 'pool', 'program_keys', 'program_recovery_release', 'program_screen', 'propose_staff', 'propose_structure', 'remember', 'remove_public_link', 'remove_repository', 'remove_subscription', 'replan_wait', 'report', 'request_approval', 'reset_employee', 'resolve_goal_risk', 'resume_company', 'resume_task', 'rewrite_note', 'send_telegram_file', 'set_approval_policy', 'set_autonomous_release', 'set_budget', 'set_department_owner', 'set_goal', 'set_pipeline', 'set_public_link', 'set_repository', 'set_team_urgent_only', 'set_urgent', 'set_wait_policy', 'shell', 'source', 'staffing_options', 'stop_employee', 'task', 'tasks', 'test_subscription', 'track_work', 'turns', 'update_hornhoof', 'update_task', 'use_tool', 'vault_entries', 'vault_entry', 'wait_for']);
    const head = await names(hana);
    expect(head).toEqual(expect.arrayContaining(['create_task', 'turns', 'backlog', 'add_tasks', 'edit_turn', 'release_turn']));
    /* A head sets its own department's approvals on the word of a person who runs it: department-owner-control.test.ts. */
    for (const gone of ['plan_turn', 'merge_turn', 'pipeline_report', 'set_urgent', 'set_department_owner']) expect(head).not.toContain(gone);
  });

  it("gives each task to its department's head at once, in no turn", async () => {
    const { db, orchestrator, dev, sales, hana, sara, tools, queued } = await company();
    const res = await call(await tools(orchestrator), 'add_tasks', { tasks: [work(dev.id, 'Checkout'), work(dev.id, 'Receipts'), work(sales.id, 'Pricing page copy')] });
    expect(res.isError, text(res)).toBeFalsy();
    expect(text(res)).toContain('#1 to Hana');
    const rows = await db.select().from(tasks).orderBy(asc(tasks.number));
    expect(rows.map(t => [t.title, t.status, t.assigneeAgentId, t.turnId, t.createdByAgentId, t.parentId])).toEqual([
      ['Checkout', 'open', hana.id, null, orchestrator.id, null],
      ['Receipts', 'open', hana.id, null, orchestrator.id, null],
      ['Pricing page copy', 'open', sara.id, null, orchestrator.id, null],
    ]);
    expect((await queued(hana.id)).map(j => j.taskId)).toEqual([rows[0]!.id, rows[1]!.id]);
    expect((await queued(sara.id)).map(j => j.taskId)).toEqual([rows[2]!.id]);
  });

  it('refuses work it cannot place, in words the orchestrator can act on', async () => {
    const { db, orchestrator, design, tools } = await company();
    const client = await tools(orchestrator);
    const headless = await call(client, 'add_tasks', { tasks: [work(design.id, 'Logo')] });
    expect(headless.isError).toBe(true);
    expect(text(headless)).toMatch(/no head/i);
    expect((await call(client, 'add_tasks', { tasks: [] })).isError).toBe(true);
    expect(await db.select().from(tasks)).toEqual([]);
  });

  it('lists every open task for the tracker even after many newer closed ones', async () => {
    const { db, companyId, orchestrator, dev, tools, ceoToken, get } = await company();
    await call(await tools(orchestrator), 'add_tasks', { tasks: [work(dev.id, 'Checkout')] });
    const history = await db.insert(tasks).values(Array.from({ length: 500 }, (_, i) => ({ companyId, departmentId: dev.id, number: i + 2, title: `Old ${i}`, status: 'done' as const, closedAt: new Date() }))).returning();
    /* Closed coordination history has a terminal route and no invented executable check. */
    const state: typeof taskRoutes.$inferInsert['state'] = { kind: 'development_echelons', version: 1, resultKind: 'coordination', stage: null, phase: 'done', candidateId: null, assignment: null, stages: [], abilities: {}, security: { required: false, reason: null, addedBy: null } };
    await db.insert(taskRoutes).values(history.map(task => ({ taskId: task.id, companyId, state, paths: [] })));
    const listed = await get(ceoToken, `/api/tasks?status=all&department=${dev.id}`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect((listed.json().tasks as { number: number }[]).some(t => t.number === 1)).toBe(true);
  });

  it("renames a department's open turn, and not a released one", async () => {
    const { db, companyId, orchestrator, tools } = await company();
    const open = await echelonsTurn(db, companyId);
    const client = await tools(orchestrator);
    expect((await call(client, 'edit_turn', { turn: open.number, title: 'Card payments', goal: 'Cards and Apple Pay.' })).isError).toBeFalsy();
    expect((await db.select().from(turns).where(eq(turns.id, open.id)))[0]).toMatchObject({ title: 'Card payments', goal: 'Cards and Apple Pay.' });
    await db.update(turns).set({ status: 'closed', closedAt: new Date(), version: 'v1.2.0' }).where(eq(turns.id, open.id));
    expect(text(await call(client, 'edit_turn', { turn: open.number, title: 'Late' }))).toMatch(/released/);
  });

  it("lists each department's last release and open turn with the results accepted into them", async () => {
    const { db, companyId, orchestrator, dev, tools } = await company();
    const open = await echelonsTurn(db, companyId);
    await call(await tools(orchestrator), 'add_tasks', { tasks: [work(dev.id, 'Checkout')] });
    await db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId: open.id }).where(eq(tasks.number, 1));
    const listed = JSON.parse(text(await call(await tools(orchestrator), 'turns', {}))) as { number: number; status: string; version: string | null; tasks: { number: number }[] }[];
    const mine = listed.find(t => t.number === open.number)!;
    expect(mine).toMatchObject({ status: 'open', version: null });
    expect(mine.tasks.map(t => t.number)).toEqual([1]);
  });

  it('shows turns to everyone and the words behind them only to people with the whole company', async () => {
    const { app, db, companyId, dev, ceoToken, get } = await company();
    const [turn] = await db.insert(turns).values({ companyId, departmentId: dev.id, number: 1, title: 'Payments', goal: 'Card payments.', status: 'open', openedAt: new Date(), messages: [{ by: 'Ivan', text: 'We need card payments.', at: new Date().toISOString() }] }).returning();
    const mine = (await get(ceoToken, '/api/turns')).json().turns;
    expect(mine.find((t: { id: string }) => t.id === turn!.id)).toMatchObject({ title: 'Payments', status: 'open', version: null, messages: [{ by: 'Ivan', text: 'We need card payments.' }], tasks: { total: 0, done: 0 } });
    const oleg = await invitePerson(app, ceoToken, { name: 'Oleg', email: 'oleg@acme.test', access: { departments: [dev.id] } });
    const theirs = (await get(oleg, '/api/turns')).json().turns;
    expect(theirs.find((t: { id: string }) => t.id === turn!.id).messages).toEqual([]);
    expect(await db.select().from(turns).where(and(eq(turns.companyId, companyId), eq(turns.status, 'open')))).toHaveLength(1);
  });
});
