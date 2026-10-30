import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, people, requests, subscriptions, tasks } from '../src/db/schema.js';
import { afterJob } from '../src/modules/conversation/queue.js';
import { createTask, submit } from '../src/modules/tasks/engine.js';
import { SILENT_TURNS, startWork, wakeAll } from '../src/modules/tasks/wake.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  await setUpCompany(app);
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
  return { ctx, db, ceo: ceo!, dev: dev!, head, bruno, rita, memberTask, turnsOf, finish };
}

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
    expect(queued[0]!.timeoutMs).toBeGreaterThan(15 * 60_000);
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
    expect(first.workspace).toEqual({ key: bruno.id, repo: { url: 'https://github.com/acme/shop.git', branch: 'release', token: 'ghp_shop2222' } });
    expect(first.prompt).toContain('https://github.com/acme/shop.git');
    expect(first.prompt).toContain('./shop');
    expect(first.prompt).not.toContain('ghp_');
    await wakeAll(ctx, [{ agentId: pia.id, taskId: (await task(pia.id)).id, why: 'assigned' }]);
    expect((await nextRun(builtin)).workspace).toEqual({ key: pia.id, repo: { url: 'https://github.com/acme/platform.git', branch: 'main', token: 'ghp_platform1111' } });
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
