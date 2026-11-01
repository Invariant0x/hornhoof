import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { blocked, createTask, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { wakePrompt } from '../src/modules/tasks/wake.js';
import { setUpCompany, statements, testApp } from './helpers.js';

/* Development works in a repository; Bruno's task passes Rita's gate. */
async function company(repository = true) {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: repository ? 'https://github.com/acme/shop.git' : null }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const task = (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: bruno.id, executor: true, gates: [rita.id] })).task;
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  /* Bruno hands it in and Rita passes it. */
  const passed = async () => {
    await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' });
    return verdict(ctx, rita.id, task.id, { pass: true, comment: 'Good.' });
  };
  return { app, ctx, db, head, bruno, rita, task, read, passed };
}

const woken = (r: { wakes: { agentId: string; why: string }[] }) => r.wakes.map(w => [w.agentId, w.why]);

describe('a task that passed its last gate', () => {
  it('goes back to its executor to merge into the turn branch, and its head is not woken for it', async () => {
    const { ctx, db, bruno, task, read, passed } = await company();
    const last = await passed();
    expect(last.task).toMatchObject({ status: 'open', stage: 0, merging: true, assigneeAgentId: bruno.id });
    expect(woken(last)).toEqual([[bruno.id, 'merge']]);
    const [me] = await db.select().from(agents).where(eq(agents.id, bruno.id));
    const prompt = wakePrompt(me!, await read(task.id), last.wakes[0]!);
    expect(prompt).toContain("passed its gates. Merge your branch into the turn's branch and report");
    expect(prompt).toContain('submit');
    expect(prompt).toContain('If the merge fails, report what blocks it with blocked');
    const merged = await submit(ctx, bruno.id, task.id, { summary: 'Merged into turn-3.', evidence: 'git log: 1a2b3c4' });
    expect(merged.task).toMatchObject({ status: 'done', assigneeAgentId: null });
    const [handedIn] = await db.select({ kind: taskEvents.kind, data: taskEvents.data }).from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(taskEvents.id).then(r => r.slice(-1));
    expect(handedIn).toEqual({ kind: 'submitted', data: { evidence: 'git log: 1a2b3c4', merged: true } });
  });

  it("names the turn's branch to merge into", async () => {
    const { db, bruno, task, read, passed } = await company();
    const [turn] = await db.insert(turns).values({ companyId: task.companyId, number: 3, title: 'Payments', goal: 'Card payments.' }).returning();
    await db.update(tasks).set({ turnId: turn!.id }).where(eq(tasks.id, task.id));
    const last = await passed();
    const [me] = await db.select().from(agents).where(eq(agents.id, bruno.id));
    expect(wakePrompt(me!, await read(task.id), last.wakes[0]!)).toContain("Merge your branch into turn-3, the turn's branch, and report");
  });

  it('shows its gates passed while its executor merges it', async () => {
    const { app, task, read, passed } = await company();
    await passed();
    const detail = await taskDetail(app.ctx, await read(task.id), () => true);
    expect(detail.merging).toBe(true);
    expect(detail.gates.map(g => g.state)).toEqual(['passed']);
  });

  it("lets the executor say what blocks the merge, which its head answers, and the merge goes on", async () => {
    const { ctx, head, bruno, task, passed } = await company();
    await passed();
    const stopped = await blocked(ctx, bruno.id, task.id, 'Conflict in cart.ts with #4.');
    expect(stopped.task.status).toBe('blocked');
    expect(woken(stopped)).toEqual([[head.id, 'blocked']]);
    const again = await updateTask(ctx, head.id, task.id, { body: 'Take the cart from #4 as it is.' });
    expect(again.task).toMatchObject({ status: 'open', merging: true, assigneeAgentId: bruno.id });
    expect((await submit(ctx, bruno.id, task.id, { summary: 'Merged.', evidence: 'git log' })).task.status).toBe('done');
  });

  it('is done at once where no repository is set', async () => {
    const { passed } = await company(false);
    expect((await passed()).task).toMatchObject({ status: 'done', merging: false });
  });
});

describe('the head', () => {
  it('hears once that every task under its department task is closed, not each time one is done', async () => {
    const { ctx, head, bruno, task, passed } = await company(false);
    const docs = (await createTask(ctx, { agentId: head.id }, { title: 'Docs', brief: '', body: '', departmentId: task.departmentId, parentId: task.parentId, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
    expect(woken(await passed())).toEqual([]);
    expect(woken(await submit(ctx, bruno.id, docs.id, { summary: 'Written.', evidence: 'docs/checkout.md' }))).toEqual([[head.id, 'subtasks']]);
  });

  it('takes the department task first when work under it closes, so the last two closing at once still tell it', async () => {
    const { ctx, bruno, task } = await company(false);
    const docs = (await createTask(ctx, { agentId: task.createdByAgentId! }, { title: 'Docs', brief: '', body: '', departmentId: task.departmentId, parentId: task.parentId, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
    const seen = statements();
    await submit(ctx, bruno.id, docs.id, { summary: 'Written.', evidence: 'docs/checkout.md' });
    const at = (test: (s: { sql: string; params: unknown[] }) => boolean) => seen.findIndex(test);
    const lock = at(s => /^select .* from "tasks" where "tasks"\."id" = \$1 for update$/.test(s.sql) && s.params[0] === task.parentId);
    const closing = at(s => s.sql.startsWith('update "tasks"') && s.params.includes(docs.id));
    const counting = at(s => s.sql.includes('"tasks"."parent_id" = $1') && s.sql.includes('not in') && s.params[0] === task.parentId);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(closing);
    expect(closing).toBeLessThan(counting);
  });

  it('hears it once the last of them is merged', async () => {
    const { ctx, head, bruno, task, passed } = await company();
    await passed();
    expect(woken(await submit(ctx, bruno.id, task.id, { summary: 'Merged.', evidence: 'git log' }))).toEqual([[head.id, 'subtasks']]);
  });

  it('still hears when a task it gave out on its own, under no department task, is done', async () => {
    const { ctx, head, bruno, task } = await company(false);
    const loose = (await createTask(ctx, { agentId: head.id }, { title: 'Loose end', brief: '', body: '', departmentId: task.departmentId, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
    expect(woken(await submit(ctx, bruno.id, loose.id, { summary: 'Done.', evidence: 'npm test' }))).toEqual([[head.id, 'done']]);
  });
});
