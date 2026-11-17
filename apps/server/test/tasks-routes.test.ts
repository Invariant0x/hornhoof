import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agents, companies, departments, jobs, requests, subscriptions, tasks } from '../src/db/schema.js';
import { ask, createTask, submit } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { as, invitePerson, listen, openStream, setUpCompany, testApp, until, ownPlan, echelonsTurn } from './helpers.js';

/* With a turn open in echelons, unless asked for none. */
async function company({ turn = true } = {}) {
  const { app, db } = await testApp();
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
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
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  const post = (token: string, path: string, payload: object) => app.inject({ method: 'POST', url: path, payload, ...as(token) });
  const get = (token: string, path: string) => app.inject({ url: path, ...as(token) });
  if (turn) await echelonsTurn(db, companyId);
  return { app, db, url, ctx: app.ctx, companyId, ceo, oleg, maria, orchestrator: orchestrator!, dev: dev!, sales: sales!, head, bruno, hire, post, get };
}

describe('tasks for people', () => {
  it('shows everyone the tasks of the company, and a person only what waits for them', async () => {
    const { ctx, db, head, bruno, dev, sales, ceo, oleg, maria, get } = await company();
    await ownPlan(db, 'oleg@acme.com', bruno.id);
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: 'The API.', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code' });
    await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?' });
    expect((await get(oleg, `/api/tasks?department=${dev.id}`)).json().tasks.map((t: { number: number }) => t.number)).toEqual([1]);
    expect((await get(maria, `/api/tasks?department=${sales.id}`)).json().tasks).toEqual([]);
    expect((await get(maria, `/api/tasks?department=${dev.id}`)).json().tasks.map((t: { number: number }) => t.number)).toEqual([1]);
    expect((await get(maria, `/api/tasks/${task.id}`)).json().task).toMatchObject({ number: 1, title: 'Checkout API', executor: { name: 'Bruno' } });
    expect((await get(oleg, `/api/tasks/${task.id}`)).json().task).toMatchObject({ number: 1, title: 'Checkout API', executor: { name: 'Bruno' } });
    expect((await get(oleg, '/api/requests')).json().requests).toMatchObject([{ kind: 'question', text: 'Which currency?', task: { number: 1, title: 'Checkout API' } }]);
    expect((await get(maria, '/api/requests')).json().requests).toEqual([]);
    expect((await get(ceo, '/api/requests')).json().requests).toHaveLength(1);
  });

  it('answers that the task is made even when waking its head breaks', async () => {
    const { ctx, db, dev, head, oleg, post } = await company();
    vi.spyOn(ctx.hub, 'isReady').mockImplementation(() => {
      throw new Error('The node table is gone.');
    });
    const made = await post(oleg, '/api/tasks', { title: 'Payments', brief: '', body: '', department: dev.id });
    expect(made.statusCode).toBe(201);
    expect(await db.select({ assignee: tasks.assigneeAgentId }).from(tasks)).toEqual([{ assignee: head.id }]);
  });

  it("gives a person's task to the department's head, or the orchestrator's to the whole company only", async () => {
    const { db, dev, sales, head, orchestrator, ceo, oleg, post } = await company();
    await ownPlan(db, 'oleg@acme.com', head.id);
    const made = await post(oleg, '/api/tasks', { title: 'Payments', brief: 'Take card payments.', body: 'Stripe.', department: dev.id });
    expect(made.statusCode).toBe(201);
    expect(made.json().task).toMatchObject({ number: 1, assignee: { name: 'Hana' } });
    const elsewhere = await post(oleg, '/api/tasks', { title: 'Leads', brief: '', body: '', department: sales.id });
    expect([elsewhere.statusCode, elsewhere.json().error.reason]).toEqual([403, 'not_your_department']);
    expect((await post(ceo, '/api/tasks', { title: 'Leads', brief: '', body: '', department: sales.id })).json().error.reason).toBe('no_head');
    expect((await post(oleg, '/api/tasks', { title: 'Plan', brief: '', body: '' })).json().error.reason).toBe('company_scope_only');
    expect((await post(ceo, '/api/tasks', { title: 'Plan', brief: '', body: '' })).json().task.assignee.name).toBe('Orchestrator');
    expect((await db.select({ a: tasks.assigneeAgentId }).from(tasks)).map(r => r.a)).toEqual([head.id, orchestrator.id]);
  });

  it('comments, cancels and answers for someone who sees the task', async () => {
    const { ctx, db, head, bruno, dev, oleg, maria, ceo, post, get } = await company();
    await ownPlan(db, 'oleg@acme.com', bruno.id);
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    expect((await post(oleg, `/api/tasks/${task.id}/comments`, { text: 'EUR only.' })).statusCode).toBe(201);
    expect((await post(maria, `/api/tasks/${task.id}/comments`, { text: 'Hi.' })).statusCode).toBe(403);
    /* A question without its topic is the CEO's: the department's people take the ones about its tasks and employees. */
    const { request: plain } = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which bank?' });
    expect((await post(oleg, `/api/requests/${plain.id}`, { answer: 'Any.' })).json().error.reason).toBe('decision_not_allowed');
    expect((await post(ceo, `/api/requests/${plain.id}`, { answer: 'Any.' })).statusCode).toBe(200);
    const { request } = await ask(ctx, bruno.id, task.id, { kind: 'question', text: 'Which currency?', topic: 'task' });
    expect((await post(oleg, `/api/requests/${request.id}`, { approve: true })).json().error.reason).toBe('task_invalid');
    expect((await post(maria, `/api/requests/${request.id}`, { answer: 'EUR' })).statusCode).toBe(403);
    expect((await post(oleg, `/api/requests/${request.id}`, { answer: 'EUR' })).statusCode).toBe(200);
    expect((await get(oleg, `/api/tasks/${task.id}`)).json().task).toMatchObject({ status: 'working', log: expect.arrayContaining([expect.objectContaining({ kind: 'answered', text: 'EUR' })]) });
    expect((await post(oleg, `/api/tasks/${task.id}/cancel`, { why: 'Not now.' })).json().task.status).toBe('cancelled');
    expect((await db.select().from(requests))[0]!.status).toBe('answered');
  });

  it('shows inside a task the tasks around it, of whatever department', async () => {
    const { ctx, db, dev, sales, head, orchestrator, hire, ceo, oleg, maria, get } = await company();
    const sam = await hire('Sam', 'head', 'SAL-HEAD', sales.id);
    await ownPlan(db, 'oleg@acme.com', head.id);
    await ownPlan(db, 'maria@acme.com', sam.id);
    const { task: payments } = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Payments', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    const { task: pricing } = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Pricing page', brief: '', body: '', departmentId: sales.id, parentId: payments.id, assigneeAgentId: sam.id });
    expect((await get(oleg, `/api/tasks/${payments.id}`)).json().task.subtasks.map((t: { id: string }) => t.id)).toEqual([pricing.id]);
    expect((await get(maria, `/api/tasks/${pricing.id}`)).json().task.parent).toMatchObject({ id: payments.id });
    expect((await get(ceo, `/api/tasks/${payments.id}`)).json().task.subtasks.map((t: { id: string }) => t.id)).toEqual([pricing.id]);
    expect((await get(ceo, `/api/tasks/${pricing.id}`)).json().task.parent).toMatchObject({ id: payments.id });
  });

  it('gives a person\'s task to the head who works in the department now', async () => {
    const { db, dev, head, hire, oleg, post } = await company();
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, head.id));
    const ivo = await hire('Ivo', 'head', 'DEV-HEAD');
    await ownPlan(db, 'oleg@acme.com', ivo.id);
    const made = await post(oleg, '/api/tasks', { title: 'Payments', brief: '', body: '', department: dev.id });
    expect(made.statusCode).toBe(201);
    expect(made.json().task.assignee.name).toBe('Ivo');
  });

  it('tells whoever gave a task that a person cancelled it', async () => {
    const { ctx, db, head, bruno, dev, oleg, post } = await company();
    await ownPlan(db, 'oleg@acme.com', bruno.id);
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    await post(oleg, `/api/tasks/${task.id}/cancel`, { why: 'Not now.' });
    const turns = await db.select().from(jobs).where(eq(jobs.agentId, head.id));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain('#1 "Checkout API", which you gave out, was cancelled');
    expect(turns[0]!.prompt).toContain('Not now.');
  });

  it('keeps a current owner and gives a removed future owner\'s Review to an eligible checker of the same role', async () => {
    const { app, ctx, db, ceo, head, bruno, dev, hire } = await company();
    const rita = await hire('Rita', 'worker', 'DEV-REV');
    const ira = await hire('Ira', 'worker', 'DEV-REV');
    await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev.id));
    for (const agent of [bruno, ira]) await db.update(agents).set({ model: 'claude-opus-5-5', skills: ctx.templates.roles.get(agent.roleKey!)!.skills.filter(s => s.on).map(s => s.id) }).where(eq(agents.id, agent.id));
    ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
    ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: rita.id });
    const remove = (id: string) => app.inject({ method: 'DELETE', url: `/api/agents/${id}`, ...as(ceo) });
    const refused = await remove(bruno.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.reason).toBe('agent_has_tasks');
    expect(refused.json().error.message).toContain('#1');
    expect((await remove(rita.id)).statusCode).toBe(204);
    const [now] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    /* #1190: the stage of a removed employee goes to an eligible employee of the same role at once, not at the handoff. */
    expect(routeSnapshot(await routeOf(db, now!), now!.assigneeAgentId).stages).toContainEqual(expect.objectContaining({ stage: 'review', status: 'pending', ownerAgentId: ira.id, reason: null }));
    const sent = await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'Changed total tests.', review: { baseCommit: BASE } });
    expect(sent.task.assigneeAgentId).toBe(ira.id);
    expect(routeSnapshot(await routeOf(db, sent.task), ira.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: ira.id });
    expect((await remove(ira.id)).json().error.reason).toBe('agent_has_tasks');
  });

  it('gives no task to an employee without a subscription', async () => {
    const { ctx, db, head, bruno, dev, oleg, post } = await company();
    await db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, bruno.id));
    await expect(createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true })).rejects.toMatchObject({ reason: 'no_subscription' });
    await db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, head.id));
    const made = await post(oleg, '/api/tasks', { title: 'Payments', brief: '', body: '', department: dev.id });
    expect(made.statusCode).toBe(409);
    expect(made.json().error.reason).toBe('no_subscription');
  });

  it("stops the turns on a task a person cancels, and the tasks under it", async () => {
    const { ctx, db, head, bruno, dev, oleg, post } = await company();
    const { task: parent } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    const { task: child } = await createTask(ctx, { agentId: bruno.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, parentId: parent.id, assigneeAgentId: head.id, executor: true });
    await wakeAll(ctx, [
      { agentId: bruno.id, taskId: parent.id, why: 'assigned' },
      { agentId: head.id, taskId: child.id, why: 'assigned' },
    ]);
    const [running] = await db.select().from(jobs).where(eq(jobs.taskId, parent.id));
    await db.update(jobs).set({ status: 'running', startedAt: new Date() }).where(eq(jobs.id, running!.id));
    await ownPlan(db, 'oleg@acme.com', bruno.id);
    await post(oleg, `/api/tasks/${parent.id}/cancel`, { why: 'Not now.' });
    const ended = await db.select({ taskId: jobs.taskId, status: jobs.status, error: jobs.error }).from(jobs).where(inArray(jobs.taskId, [parent.id, child.id]));
    expect(ended).toEqual(expect.arrayContaining([
      { taskId: parent.id, status: 'failed', error: 'cancelled' },
      { taskId: child.id, status: 'failed', error: 'cancelled' },
    ]));
  });

  it("shows a commit to approve to the people of the department and of its product, and lets the department's people approve it", async () => {
    const { app, ctx, db, companyId, head, bruno, dev, oleg, ceo, post, get } = await company();
    /* A person of a product alone reads its approvals and takes none: they are the department's. */
    const [shop] = await db.insert(departments).values({ companyId, name: 'Shop', parentId: dev.id, roleCode: 'DEV', position: 1 }).returning();
    await db.update(agents).set({ productId: shop!.id }).where(eq(agents.id, bruno.id));
    const pia = await invitePerson(app, ceo, { name: 'Pia', email: 'pia@acme.com', access: { departments: [shop!.id] } });
    await ownPlan(db, 'pia@acme.com', bruno.id);
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Release', brief: '', body: '', departmentId: dev.id, productId: shop!.id, assigneeAgentId: bruno.id, executor: true });
    const { request } = await ask(ctx, bruno.id, task.id, { kind: 'approval', text: 'Release 0.5.0 to main.', commit: 'a'.repeat(40) });
    for (const person of [pia, oleg]) expect((await get(person, '/api/requests')).json().requests.map((r: { id: string }) => r.id)).toEqual([request.id]);
    expect((await post(pia, `/api/requests/${request.id}`, { approve: true })).json().error.reason).toBe('decision_not_allowed');
    expect((await post(oleg, `/api/requests/${request.id}`, { approve: true })).json().request.status).toBe('approved');
  });

  it('leaves starting and closing turns to the orchestrator', async () => {
    const { ceo, post, get } = await company({ turn: false });
    expect((await post(ceo, '/api/turns', { goal: 'Payments' })).statusCode).toBe(404);
    expect((await get(ceo, '/api/turns')).json().turns).toEqual([]);
    expect((await get(ceo, '/api/turns/current')).json().turn).toBe(null);
  });

  it('keeps a repository token secret and refuses plain http', async () => {
    const { db, companyId, dev, ceo, oleg, maria, app, get } = await company();
    const put = (token: string, payload: object) => app.inject({ method: 'PUT', url: `/api/departments/${dev.id}/repository`, payload, ...as(token) });
    expect((await put(maria, { url: 'https://github.com/acme/app.git', branch: 'main', token: 'ghp_secret1234' })).json().error.reason).toBe('department_owner_only');
    expect((await put(oleg, { url: 'https://github.com/acme/app.git', branch: 'main' })).statusCode).toBe(200);
    expect((await put(ceo, { url: 'http://github.com/acme/app.git', branch: 'main' })).json().error.reason).toBe('repo_invalid');
    /* An address that is no address is refused too, with a token or without. */
    for (const token of ['', 'ghp_secret1234']) {
      const broken = await put(ceo, { url: 'https://[', branch: 'main', token });
      expect([broken.statusCode, broken.json().error.reason]).toEqual([400, 'repo_invalid']);
    }
    const saved = await put(ceo, { url: 'https://github.com/acme/app.git', branch: 'main', token: 'ghp_secret1234' });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('ghp_secret');
    const org = await get(ceo, '/api/org');
    expect(org.body).not.toContain('ghp_secret');
    expect(org.json().departments.find((d: { id: string }) => d.id === dev.id).repository).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234', author: null, testMemoryGb: 4, fullTestCommand: null });
    expect((await put(ceo, { url: 'https://github.com/acme/app2.git', branch: 'dev' })).json().repository.tokenLast4).toBe('1234');
    /* Another host never gets the token saved for the first one. */
    expect((await put(ceo, { url: 'https://gitlab.com/acme/app.git', branch: 'dev' })).json().repository.tokenLast4).toBe(null);
    const [moved] = await db.select().from(departments).where(eq(departments.id, dev.id));
    expect(moved!.repoTokenEnc).toBe(null);
    const [shop] = await db.insert(departments).values({ companyId, name: 'Shop', parentId: dev.id, roleCode: 'DEV', position: 1 }).returning();
    await put(ceo, { url: 'https://github.com/acme/app.git', branch: 'main', token: 'ghp_secret1234' });
    await app.inject({ method: 'PUT', url: `/api/departments/${shop!.id}/repository`, payload: { url: 'https://github.com/acme/shop.git', branch: 'main', token: 'ghp_shop9999' }, ...as(ceo) });
    const products = (await get(ceo, '/api/org')).json().departments.find((d: { id: string }) => d.id === dev.id).products;
    expect(products).toEqual([{ id: shop!.id, name: 'Shop', repository: { url: 'https://github.com/acme/shop.git', branch: 'main', tokenLast4: '9999', author: null, testMemoryGb: 4, fullTestCommand: null } }]);
    /* Only people who set a department's repositories read where they are: the whole company and the department's people. */
    const seen = (await get(oleg, '/api/org')).json().departments.find((d: { id: string }) => d.id === dev.id);
    expect(seen.repository).toMatchObject({ url: 'https://github.com/acme/app.git', tokenLast4: '1234' });
    expect(seen.products).toEqual([{ id: shop!.id, name: 'Shop', repository: expect.objectContaining({ url: 'https://github.com/acme/shop.git' }) }]);
    const listed = (await get(maria, '/api/org')).json().departments.find((d: { id: string }) => d.id === dev.id);
    expect(listed.repository).toBe(null);
    expect(listed.products).toEqual([{ id: shop!.id, name: 'Shop', repository: null }]);
    expect((await app.inject({ method: 'DELETE', url: `/api/departments/${dev.id}/repository`, ...as(ceo) })).statusCode).toBe(204);
    expect((await get(ceo, '/api/org')).json().departments.find((d: { id: string }) => d.id === dev.id).repository).toBe(null);
  });

  it("names who the agents' commits are by, and keeps it until it is changed", async () => {
    const { dev, ceo, app, get } = await company();
    const put = (payload: object) => app.inject({ method: 'PUT', url: `/api/departments/${dev.id}/repository`, payload, ...as(ceo) });
    const author = { name: 'Alex Rivera', email: 'alex@acme.example' };
    expect((await put({ url: 'https://github.com/acme/app.git', branch: 'main', author })).json().repository).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: null, author, testMemoryGb: 4, fullTestCommand: null });
    expect((await put({ url: 'https://github.com/acme/app.git', branch: 'dev' })).json().repository.author).toEqual(author);
    expect((await get(ceo, '/api/org')).json().departments.find((d: { id: string }) => d.id === dev.id).repository.author).toEqual(author);
    expect((await put({ url: 'https://github.com/acme/app.git', branch: 'dev', author: { ...author, email: 'ivan' } })).json().error.reason).toBe('repo_invalid');
    expect((await put({ url: 'https://github.com/acme/app.git', branch: 'dev', author: null })).json().repository.author).toBe(null);
  });

  it('names the free memory a machine needs for a test run of the repository, 4 GB unless set', async () => {
    const { dev, ceo, app, get } = await company();
    const put = (payload: object) => app.inject({ method: 'PUT', url: `/api/departments/${dev.id}/repository`, payload, ...as(ceo) });
    const repoOf = async () => (await get(ceo, '/api/org')).json().departments.find((d: { id: string }) => d.id === dev.id).repository;
    expect((await put({ url: 'https://github.com/acme/app.git', branch: 'main', testMemoryGb: 12 })).json().repository.testMemoryGb).toBe(12);
    expect((await repoOf()).testMemoryGb).toBe(12);
    /* Left out, it stays; null takes the default again. */
    expect((await put({ url: 'https://github.com/acme/app.git', branch: 'dev' })).json().repository.testMemoryGb).toBe(12);
    expect((await put({ url: 'https://github.com/acme/app.git', branch: 'dev', testMemoryGb: null })).json().repository.testMemoryGb).toBe(4);
    for (const bad of [0, 1.5, 1000]) expect((await put({ url: 'https://github.com/acme/app.git', branch: 'dev', testMemoryGb: bad })).statusCode).toBe(400);
  });

  it("streams a task's changes to everyone of the company", async () => {
    const { app, ctx, db, head, bruno, dev, oleg, maria } = await company();
    await ownPlan(db, 'oleg@acme.com', bruno.id);
    const olegs = await openStream(app, oleg);
    const marias = await openStream(app, maria);
    const { task } = await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true });
    await until(() => olegs.messages.some(m => m.type === 'task' && m.id === task.id));
    await until(() => marias.messages.some(m => m.type === 'task' && m.id === task.id));
    olegs.close();
    marias.close();
  });

  it('shows everyone what a department works on now, and keeps a department with open tasks', async () => {
    const { ctx, db, companyId, ceo, maria, post, get, hire } = await company();
    const [design] = await db.insert(departments).values({ companyId, templateKey: 'design', roleCode: 'DSN', position: 3 }).returning();
    const lead = await hire('Dora', 'head', 'DSN-HEAD', design!.id);
    const { task } = await createTask(ctx, { personId: (await get(ceo, '/api/me')).json().person.id }, { title: 'Payments', brief: '', body: '', departmentId: design!.id, assigneeAgentId: lead!.id });
    expect((await get(ceo, '/api/org')).json().departments.find((d: { id: string }) => d.id === design!.id).current).toMatchObject({ number: 1, title: 'Payments' });
    expect((await get(maria, '/api/org')).json().departments.find((d: { id: string }) => d.id === design!.id).current).toMatchObject({ number: 1, title: 'Payments' });
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, lead!.id));
    const dev = design!;
    const kept = await post(ceo, '/api/departments/build', { items: [{ department: dev.id, note: '', remove: true }] });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().error.message).toMatch(/open tasks/);
    await post(ceo, `/api/tasks/${task.id}/cancel`, { why: 'Dropped.' });
    expect((await post(ceo, '/api/departments/build', { items: [{ department: dev.id, note: '', remove: true }] })).statusCode).toBe(201);
    expect((await db.select().from(tasks))[0]).toMatchObject({ departmentId: null, status: 'cancelled' });
  });

  it('names an independent executor to everyone, also to one who does not open that agent', async () => {
    const { app, ctx, db, dev, head, bruno, ceo, oleg, get } = await company();
    /* The whole company runs no department: such a person opens only the agents on a plan of their own. */
    const wes = await invitePerson(app, ceo, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    await ownPlan(db, 'wes@acme.com', head.id);
    const prerequisite = (await createTask(ctx, { agentId: head.id }, { title: 'Prerequisite', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id })).task;
    const made = await app.inject({ method: 'POST', url: '/api/tasks', payload: {
      title: 'Launch', department: dev.id, after: [prerequisite.number],
      independentPart: { title: 'Examples', brief: '', body: 'Write examples.', executor: bruno.id },
    }, ...as(wes) });
    expect(made.statusCode).toBe(201);
    expect(made.json().task.independentPart).toMatchObject({ title: 'Examples', executor: { id: bruno.id } });
    expect((await get(oleg, `/api/tasks/${made.json().task.id}`)).json().task.independentPart).toMatchObject({ title: 'Examples' });
  });
});
