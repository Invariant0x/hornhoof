import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, people, personAccess, requests, subscriptions, tasks } from '../src/db/schema.js';
import { afterJob, agentState, openTypedTurn } from '../src/modules/conversation/queue.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { answer, ask, comment, createTask, GOING_ON_TURNS, report, submit, updateTask } from '../src/modules/tasks/engine.js';
import { SILENT_TURNS, startWork, wakeAll, wakePrompt } from '../src/modules/tasks/wake.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const owner = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  const memberTask = async (gates = [rita.id]) =>
    (await createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, gates })).task;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  /* The agent's oldest waiting turn runs and ends; what it did in between is up to the test. */
  const finish = async (agentId: string, during: () => Promise<unknown> = async () => {}, status: 'done' | 'failed' = 'done') => {
    const [job] = await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
    await db.update(jobs).set({ status: 'running', startedAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job!.id));
    await during();
    await db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await afterJob(ctx, job!.id);
    return job!;
  };
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, owner, ctx, db, sub: sub!, ceo: ceo!, dev: dev!, orchestrator: orchestrator!, head, bruno, rita, memberTask, turnsOf, finish };
}

describe('a person who speaks to an agent directly', () => {
  /* Bruno ends turns on his task without moving it until Hornhoof asks a person how he should go on. */
  async function stuck() {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.bruno.id);
    return { ...c, task };
  }
  const requestsOf = (c: Awaited<ReturnType<typeof company>>) =>
    c.db.select({ kind: requests.kind, status: requests.status, answer: requests.answer, answeredBy: requests.answeredBy }).from(requests).orderBy(asc(requests.createdAt));

  it("tells a stuck agent how to go on by typing into its terminal, and the task goes on", async () => {
    const c = await stuck();
    expect(await c.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'waiting' }]);
    expect(await openTypedTurn(c.ctx, identityOf(c.sub), c.bruno.id, 'Run the tests first, then submit.', c.ceo.id)).not.toBeNull();
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'answered', answer: 'Run the tests first, then submit.', answeredBy: c.ceo.id }]);
    expect(await c.db.select({ status: tasks.status, silent: tasks.silent }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'working', silent: 0 }]);
    /* After the typed turn the task's own turn follows, so a typed turn that goes nowhere still leaves the task watched. */
    const queued = (await c.turnsOf(c.bruno.id)).filter(j => j.status === 'queued');
    expect(queued.map(j => j.taskId)).toEqual([c.task.id]);
    expect(queued[0]!.prompt).toContain('Run the tests first, then submit.');
  });

  it('leaves what waits on a task alone for a person who cannot reach the task', async () => {
    const c = await stuck();
    const [sales] = await c.db.insert(departments).values({ companyId: c.dev.companyId, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const [maria] = await c.db.insert(people).values({ companyId: c.dev.companyId, name: 'Maria', email: 'maria@acme.com', status: 'active', scopeKind: 'listed' }).returning();
    await c.db.insert(personAccess).values({ companyId: c.dev.companyId, personId: maria!.id, departmentId: sales!.id });
    expect(await openTypedTurn(c.ctx, identityOf(c.sub), c.bruno.id, 'Skip the tests.', maria!.id)).not.toBeNull();
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'open', answer: null, answeredBy: null }]);
    expect(await c.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, c.task.id))).toEqual([{ status: 'waiting' }]);
  });

  it("answers the agent's question with a message in its window, and leaves a commit to approve open", async () => {
    const { app, db, ceo, hire, task } = await withRepositories();
    const bruno = await hire('Bruno', null);
    const mine = await task(bruno.id);
    await ask(app.ctx, bruno.id, mine.id, { kind: 'question', text: 'EUR or USD?' });
    await ask(app.ctx, bruno.id, mine.id, { kind: 'approval', text: 'Merge it?', commit: 'a'.repeat(40) });
    const [me] = await db.select().from(people);
    await until(async () => (await agentState(app.ctx, bruno.id)).ready);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/messages`, payload: { text: 'EUR only.' }, ...as(ceo) })).statusCode).toBe(202);
    expect(await db.select({ kind: requests.kind, status: requests.status, answer: requests.answer, answeredBy: requests.answeredBy }).from(requests).orderBy(asc(requests.createdAt))).toEqual([
      { kind: 'question', status: 'answered', answer: 'EUR only.', answeredBy: me!.id },
      { kind: 'approval', status: 'open', answer: null, answeredBy: null },
    ]);
    /* The message's own turn, and the task's after it. */
    expect((await db.select({ taskId: jobs.taskId }).from(jobs).where(eq(jobs.agentId, bruno.id)).orderBy(asc(jobs.createdAt))).map(j => j.taskId)).toEqual([null, mine.id]);
  });
});

describe("Hornhoof's note that a task stands still", () => {
  async function stuck() {
    const c = await company();
    const task = await c.memberTask();
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.bruno.id);
    const [kai] = await c.db.insert(agents).values({ companyId: c.dev.companyId, kind: 'worker', name: 'Kai', roleKey: 'DEV-BE', departmentId: c.dev.id, model: '', subscriptionId: c.sub.id }).returning();
    return { ...c, task, kai: kai! };
  }
  const requestsOf = (c: Awaited<ReturnType<typeof company>>) => c.db.select({ kind: requests.kind, status: requests.status }).from(requests);
  const taskOf = async (c: Awaited<ReturnType<typeof company>>, id: string) => (await c.db.select({ status: tasks.status, silent: tasks.silent }).from(tasks).where(eq(tasks.id, id)))[0];

  it('goes away when the head hands the task to someone else, who takes it up', async () => {
    const c = await stuck();
    const { wakes } = await updateTask(c.ctx, c.head.id, c.task.id, { executor: c.kai.id });
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'withdrawn' }]);
    expect(await taskOf(c, c.task.id)).toEqual({ status: 'open', silent: 0 });
    expect(wakes).toEqual([{ agentId: c.kai.id, taskId: c.task.id, why: 'assigned' }]);
  });

  it('goes away when the executor hands its work in after all', async () => {
    const c = await stuck();
    await submit(c.ctx, c.bruno.id, c.task.id, { summary: 'Done.', evidence: 'npm test: 12 passed' });
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'withdrawn' }]);
    expect(await taskOf(c, c.task.id)).toMatchObject({ status: 'review' });
  });

  it('goes away when the agent reports a task it owns', async () => {
    const c = await company();
    const { task } = await createTask(c.ctx, { agentId: c.head.id }, { title: 'Plan the sprint', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id });
    await wakeAll(c.ctx, [{ agentId: c.bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS; i++) await c.finish(c.bruno.id);
    await report(c.ctx, c.bruno.id, task.id, { done: true, summary: 'Planned.' });
    expect(await requestsOf(c)).toEqual([{ kind: 'stuck', status: 'withdrawn' }]);
  });

  it('still keeps a question the agent asked a person', async () => {
    const c = await stuck();
    await c.db.update(requests).set({ status: 'answered' });
    await c.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, c.task.id));
    await ask(c.ctx, c.bruno.id, c.task.id, { kind: 'question', text: 'EUR or USD?' });
    await expect(submit(c.ctx, c.bruno.id, c.task.id, { summary: 'Done.', evidence: 'npm test' })).rejects.toThrow(/waits for a person's answer/);
  });

  it('wakes whoever holds the task now when a person says try again', async () => {
    const c = await stuck();
    /* Handed on before Hornhoof let such notes go. */
    await c.db.update(tasks).set({ executorAgentId: c.kai.id, assigneeAgentId: c.kai.id }).where(eq(tasks.id, c.task.id));
    const [note] = await c.db.select({ id: requests.id }).from(requests);
    const { wakes } = await answer(c.ctx, { personId: c.ceo.id }, note!.id, { retry: true });
    expect(wakes.map(w => w.agentId)).toEqual([c.kai.id]);
  });
});

describe('waking agents for their tasks', () => {
  it('queues one turn per agent and task, naming the task', async () => {
    const { ctx, bruno, memberTask, turnsOf } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [
      { agentId: bruno.id, taskId: task.id, why: 'assigned' },
      { agentId: bruno.id, taskId: task.id, why: 'comment', text: 'EUR only.' },
    ]);
    const queued = await turnsOf(bruno.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ taskId: task.id, status: 'queued', kind: 'conversation' });
    expect(queued[0]!.prompt).toContain('#1 "Checkout API"');
    expect(queued[0]!.timeoutMs).toBe(2 * 3_600_000);
  });

  it('marks a task working when its turn starts', async () => {
    const { ctx, db, bruno, memberTask } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const [job] = await db.select().from(jobs).where(eq(jobs.taskId, task.id));
    await startWork(ctx, job!.id);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('working');
  });

  it('reminds an agent that ended a turn without moving its task, then asks a person', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 1; i < SILENT_TURNS; i++) {
      await finish(bruno.id);
      const queued = (await turnsOf(bruno.id)).filter(j => j.status === 'queued');
      expect(queued).toHaveLength(1);
      expect(queued[0]!.prompt).toContain('without moving it');
    }
    await finish(bruno.id);
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'waiting', silent: SILENT_TURNS });
    expect(await db.select({ kind: requests.kind, agentId: requests.agentId }).from(requests)).toEqual([{ kind: 'stuck', agentId: bruno.id }]);
  });

  it('lets an agent that told in the task how far it got go on in another turn, not counted as standing still', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < SILENT_TURNS + 1; i++) await finish(bruno.id, () => comment(ctx, { agentId: bruno.id }, task.id, `Part ${i} pushed.`));
    const queued = (await turnsOf(bruno.id)).filter(j => j.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain('Go on with the work from where you left off');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'open', silent: 0 });
    expect(await db.select().from(requests)).toEqual([]);
  });

  it('lets an agent whose turn ran out of time while it worked go on', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    const outOfTime = () => db.update(jobs).set({ error: 'timeout' }).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'running')));
    for (let i = 0; i < SILENT_TURNS; i++) await finish(bruno.id, outOfTime, 'failed');
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toHaveLength(1);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(0);
  });

  it('asks a person once an agent went on for many turns without handing anything in', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    for (let i = 0; i < GOING_ON_TURNS; i++) await finish(bruno.id, () => comment(ctx, { agentId: bruno.id }, task.id, `Part ${i} pushed.`));
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect(await db.select({ kind: requests.kind, status: requests.status }).from(requests)).toEqual([{ kind: 'stuck', status: 'open' }]);
  });

  it('counts a failed turn as silent', async () => {
    const { ctx, db, bruno, memberTask, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await finish(bruno.id, async () => {}, 'failed');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(1);
  });

  it('wakes nobody again after a turn that moved the task', async () => {
    const { ctx, db, bruno, rita, memberTask, turnsOf, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await finish(bruno.id, async () => wakeAll(ctx, (await submit(ctx, bruno.id, task.id, { summary: 'Done.', evidence: 'npm test' })).wakes));
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued')).toEqual([]);
    expect((await turnsOf(rita.id)).map(j => j.taskId)).toEqual([task.id]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(0);
  });

  it('reminds an agent about a task it left without moving, though a turn on another task waits', async () => {
    const { ctx, db, bruno, memberTask, turnsOf, finish } = await company();
    const first = await memberTask();
    const second = await memberTask();
    await wakeAll(ctx, [
      { agentId: bruno.id, taskId: first.id, why: 'assigned' },
      { agentId: bruno.id, taskId: second.id, why: 'assigned' },
    ]);
    await finish(bruno.id);
    expect((await db.select().from(tasks).where(eq(tasks.id, first.id)))[0]!.silent).toBe(1);
    expect((await turnsOf(bruno.id)).filter(j => j.status === 'queued').map(j => j.taskId).sort()).toEqual([first.id, second.id].sort());
  });

  it('leaves the count alone while a turn on the same task waits', async () => {
    const { ctx, db, bruno, memberTask, finish } = await company();
    const task = await memberTask();
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await finish(bruno.id, () => wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'comment', text: 'EUR only.' }]));
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.silent).toBe(0);
  });

  it('wakes an employee for its waiting tasks when it gets a subscription again', async () => {
    const { app, owner, ctx, db, sub, bruno, memberTask, turnsOf } = await company();
    const task = await memberTask();
    await db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, bruno.id));
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    expect(await turnsOf(bruno.id)).toEqual([]);
    const patched = await app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { subscription: sub.id }, ...as(owner) });
    expect(patched.statusCode).toBe(200);
    expect((await turnsOf(bruno.id)).map(j => j.taskId)).toEqual([task.id]);
  });

  it('wakes the orchestrator for his waiting tasks when he gets a subscription again', async () => {
    const { app, owner, ctx, db, sub, ceo, orchestrator, turnsOf } = await company();
    const { task } = await createTask(ctx, { personId: ceo.id }, { title: 'Turn 1: Launch', brief: '', body: '', departmentId: null, assigneeAgentId: orchestrator.id });
    await db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, orchestrator.id));
    await wakeAll(ctx, [{ agentId: orchestrator.id, taskId: task.id, why: 'assigned' }]);
    expect(await turnsOf(orchestrator.id)).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${sub.id}/orchestrator`, ...as(owner) })).statusCode).toBe(200);
    expect((await turnsOf(orchestrator.id)).map(j => j.taskId)).toEqual([task.id]);
  });

  it('wakes nobody when an agent moves from one subscription to another', async () => {
    const { app, owner, ctx, sub, ceo, orchestrator, turnsOf } = await company();
    await createTask(ctx, { personId: ceo.id }, { title: 'Turn 1: Launch', brief: '', body: '', departmentId: null, assigneeAgentId: orchestrator.id });
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${sub.id}/orchestrator`, ...as(owner) })).statusCode).toBe(200);
    expect(await turnsOf(orchestrator.id)).toEqual([]);
  });

  it("tells the orchestrator to go on with a department's task that cannot by the tools he has", async () => {
    const { ctx, dev, head, orchestrator } = await company();
    const { task } = await createTask(ctx, { agentId: orchestrator.id }, { title: 'Payments', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    const prompt = wakePrompt(orchestrator, task, { agentId: orchestrator.id, taskId: task.id, why: 'blocked', text: 'No designer.' });
    expect(prompt).not.toContain('update_task');
    expect(prompt).toContain('cancel_task');
    expect(prompt).toContain('add_tasks');
    expect(prompt).not.toContain('create_task');
    expect(prompt).toContain('No designer.');
  });

  it('lets a head wait for the tasks it gave out', async () => {
    const { ctx, ceo, dev, head, bruno, turnsOf, finish } = await company();
    const { task } = await createTask(ctx, { personId: ceo.id }, { title: 'Payments', brief: '', body: '', departmentId: dev.id, assigneeAgentId: head.id });
    await wakeAll(ctx, [{ agentId: head.id, taskId: task.id, why: 'assigned' }]);
    await finish(head.id, () => createTask(ctx, { agentId: head.id }, { title: 'Checkout API', brief: '', body: '', departmentId: dev.id, parentId: task.id, assigneeAgentId: bruno.id, executor: true }));
    await wakeAll(ctx, [{ agentId: head.id, taskId: task.id, why: 'comment', text: 'How is it going?' }]);
    await finish(head.id);
    expect((await turnsOf(head.id)).filter(j => j.status === 'queued')).toEqual([]);
  });
});

const NODE_KEY = 'k'.repeat(40);
type Run = { type: 'job.run'; jobId: string; prompt: string; workspace?: { key: string; repo: { url: string; branch: string; token: string } | null } | null };

async function nextRun(node: FakeNode): Promise<Run> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as Run;
}

/* A company on the built-in node, with Development and its product Shop. */
async function withRepositories() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [shop] = await db.insert(departments).values({ companyId, name: 'Shop', parentId: dev!.id, roleCode: 'DEV', position: 1 }).returning();
  const hire = async (name: string, productId: string | null, subscriptionId = sub!.id) =>
    (await db.insert(agents).values({ companyId, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: dev!.id, productId, model: '', subscriptionId }).returning())[0]!;
  const repository = (id: string, payload: object) => app.inject({ method: 'PUT', url: `/api/departments/${id}/repository`, payload, ...as(ceo) });
  const task = async (agentId: string) => (await createTask(app.ctx, { agentId }, { title: 'Checkout API', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: agentId, executor: true })).task;
  return { app, db, url, ceo, builtin, ctx: app.ctx, companyId, dev: dev!, shop: shop!, hire, repository, task };
}

describe("working in the product's repository", () => {
  it("sends an agent's turn with its product's repository, else its department's, and each agent its own folder", async () => {
    const { ctx, builtin, dev, shop, hire, repository, task } = await withRepositories();
    expect((await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111' })).statusCode).toBe(200);
    expect((await repository(shop.id, { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222' })).statusCode).toBe(200);
    const bruno = await hire('Bruno', shop.id);
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: (await task(bruno.id)).id, why: 'assigned' }]);
    const first = await nextRun(builtin);
    expect(first.workspace).toEqual({ key: bruno.id, repo: { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222', author: null } });
    expect(first.prompt).toContain('https://github.com/acme/shop.git');
    expect(first.prompt).toContain('./shop');
    expect(first.prompt).not.toContain('ghp_');
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).workspace).toEqual({ key: pia.id, repo: { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111', author: null } });
  });

  it('tells the agent who its commits are by, and to add no co-author lines', async () => {
    const { ctx, builtin, dev, hire, repository, task } = await withRepositories();
    const author = { name: 'Ivan Korol', email: 'ivan@acme.dev' };
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main', author });
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    const run = await nextRun(builtin);
    expect(run.workspace?.repo?.author).toEqual(author);
    expect(run.prompt).toContain('Commit as Ivan Korol <ivan@acme.dev>');
    expect(run.prompt).toContain('Co-Authored-By');
  });

  it('tells an agent started for its window where its repository is, with its instructions', async () => {
    const { builtin, dev, hire, repository } = await withRepositories();
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main' });
    const pia = await hire('Pia', null);
    builtin.send({ type: 'agent.start', agentKey: pia.id });
    const start = (await nextRun(builtin)) as Run & { context?: string | null; guidance?: string | null };
    expect(start.prompt).toBe('');
    /* Apart from the conversation, which the node keeps with the session: the repository can change. */
    expect(start.guidance).toContain('https://github.com/acme/platform.git');
    expect(start.guidance).toContain('./platform');
    expect(start.guidance).toContain('read its own rules first (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, README.md)');
    expect(start.context ?? '').not.toContain('platform');
  });

  it('sends a turn without a repository with the agent folder alone', async () => {
    const { ctx, builtin, hire, task } = await withRepositories();
    const pia = await hire('Pia', null);
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).workspace).toEqual({ key: pia.id, repo: null });
  });

  it('keeps a turn with a repository waiting for a machine whose Hornhoof is too old to clone it', async () => {
    const { app, db, url, ceo, ctx, dev, hire, repository, task } = await withRepositories();
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' } });
    const node = joined.json().nodes[0] as { subscriptionId: string; key: string };
    const mac = await connectNode(url, node.key);
    mac.send({ type: 'hello', version: '0.4.0', loggedIn: true, running: [] });
    await until(async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, node.subscriptionId)))[0]!.status === 'ready');
    const olga = await hire('Olga', null, node.subscriptionId);
    await wakeAll(ctx, [{ agentId: olga.id, taskId: (await task(olga.id)).id, why: 'assigned' }]);
    expect((await nextRun(mac)).workspace).toEqual({ key: olga.id, repo: null });
    await repository(dev.id, { url: 'https://github.com/acme/platform.git', branch: 'main' });
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, olga.id));
    await wakeAll(ctx, [{ agentId: olga.id, taskId: (await task(olga.id)).id, why: 'assigned' }]);
    await new Promise(r => setTimeout(r, 150));
    expect(mac.queued()).toBe(0);
    expect((await app.inject({ url: `/api/agents/${olga.id}/events`, ...as(ceo) })).json().state.reason).toBe('node_outdated');
  });
});
