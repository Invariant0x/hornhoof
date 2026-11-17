import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { lineState, RETURN_MS, type WorkLine } from '@hornhoof/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, mapReturns, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { GONE_ALONG, pump } from '../src/modules/conversation/queue.js';
import { mapLines, recordMapReturn, returnAlongLine, workStarts, type MapLine } from '../src/modules/org/map-state.js';
import { ask, brokeDown, comment, createTask, leaveWork, loadTask, report, startWork, submit, verdict } from '../src/modules/tasks/engine.js';
import { agentState } from '../src/modules/conversation/queue.js';
import { afterJob, wakeAll } from '../src/modules/tasks/wake.js';
import type { Db } from '../src/db/client.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until, type FakeNode, ownDatabases, echelonsTurn } from './helpers.js';
import { rowsRead } from './rows-read.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';

ownDatabases();

type Org = { serverNow: string; workLines: WorkLine[]; departments: { id: string; workLines: WorkLine[]; reworkAt: string | null }[] };

/* Development with Hana at its head, Bruno and Felix who build, and Rita who reviews; the orchestrator gives Hana the
   department's work. Everyone is on the company key. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp(env);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV', position: 0 }).returning();
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL', position: 1 }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id, extra: Partial<typeof agents.$inferInsert> = {}) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [], ...extra }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const felix = await hire('Felix', 'worker', 'DEV-FE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev!.id));
  let commit = HEAD;
  const atCommit = (sha: string) => { commit = sha; };
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: commit });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  await echelonsTurn(db, acme!.id);
  const top = (await createTask(ctx, { agentId: orchestrator!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: hana.id })).task;
  const member = async (title: string, agentId: string, reviewerAgentId = rita.id) =>
    (await createTask(ctx, { agentId: hana.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: top.id, assigneeAgentId: agentId, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId })).task;
  /* A turn of the agent on the task goes out, as the queue takes it: running, with the new cycle of its lines in the same
     write, and then its task at work. */
  const run = async (agentId: string, taskId: string | null, at = new Date()) => {
    const job = await db.transaction(async tx => {
      const [row] = await tx
        .insert(jobs)
        .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId, taskId, kind: 'conversation', prompt: 'go', status: 'running', startedAt: at, timeoutMs: 900000 })
        .returning();
      await workStarts(tx, { id: row!.id, companyId: acme!.id, agentId, taskIds: [taskId] });
      return row!;
    });
    await startWork(ctx, job.id);
    return job;
  };
  const end = (jobId: string, status: 'done' | 'failed' = 'done') => db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, jobId));
  const org = async (token = ceo, on: FastifyInstance = app): Promise<Org> => (await on.inject({ url: '/api/org', ...as(token) })).json();
  return { app, db, config, ctx, ceo, acme: acme!, sub: sub!, orchestrator: orchestrator!, dev: dev!, sales: sales!, hire, hana, bruno, felix, rita, top, member, run, end, org, atCommit };
}

const allLines = (org: Org) => [...org.workLines, ...org.departments.flatMap(d => d.workLines)];
const lineOf = (org: Org, up: string, down: string) => allLines(org).find(l => l.upstreamAgentId === up && l.downstreamAgentId === down);

/* What the browser draws for the line at the time the server gave. */
function stateOf(org: Org, up: { id: string }, down: { id: string }): string {
  const line = lineOf(org, up.id, down.id);
  if (!line) return 'none';
  return lineState({ working: line.working, workEpoch: line.workEpoch, returnedEpoch: line.returnedEpoch, returnedAt: line.returnedAt ? Date.parse(line.returnedAt) : null }, Date.parse(org.serverNow));
}

describe('lines between a head and its employees', () => {
  it('reports no rework when work has not been returned, including after a hand-in', async () => {
    const { ctx, bruno, member, org, dev } = await company();
    const task = await member('Checkout API', bruno.id);
    expect((await org()).departments.find(d => d.id === dev.id)!.reworkAt).toBeNull();
    await submit(ctx, bruno.id, task.id, { summary: 'Handed in', evidence: 'Tests pass', review: { baseCommit: BASE } });
    expect((await org()).departments.find(d => d.id === dev.id)!.reworkAt).toBeNull();
  });

  it('reports the actual rework event time only in its department, to everyone of the company, and drops it after ten minutes', async () => {
    const { app, ceo, ctx, db, bruno, rita, member, org, dev, sales, atCommit, run, hana } = await company();
    const task = await member('Checkout API', bruno.id, rita.id);
    await submit(ctx, bruno.id, task.id, { summary: 'Handed in', evidence: 'Tests pass', review: { baseCommit: BASE } });
    await run(rita.id, task.id);
    await verdict(ctx, rita.id, task.id, { pass: false, reviewedCommit: HEAD, comment: 'Handle retries.' });
    expect(stateOf(await org(), hana, rita)).toBe('blue');
    expect((await org()).departments.find(d => d.id === dev.id)!.reworkAt).toBeNull();
    atCommit('c'.repeat(40));
    await submit(ctx, rita.id, task.id, { summary: 'Handle retries in the same branch.', evidence: 'Changed retry tests.', review: { baseCommit: BASE } });
    const [event] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data}->'candidate'->>'parentId' IS NOT NULL`));
    const snapshot = await org();
    expect(stateOf(snapshot, hana, rita)).toBe('yellow');
    expect(snapshot.departments.find(d => d.id === dev.id)!.reworkAt).toBe(event!.createdAt.toISOString());
    expect(snapshot.departments.find(d => d.id === sales.id)!.reworkAt).toBeNull();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    expect((await org(maria)).departments.find(d => d.id === dev.id)!.reworkAt).toBe(event!.createdAt.toISOString());
    await db.update(taskEvents).set({ createdAt: new Date(Date.parse(snapshot.serverNow) - 600_000) }).where(eq(taskEvents.id, event!.id));
    expect((await org()).departments.find(d => d.id === dev.id)!.reworkAt).toBeNull();
  });

  it('does not invent a repair when the current checker leaves after a finding', async () => {
    const { ctx, db, hana, bruno, rita, member, org, dev } = await company();
    const task = await member('Checkout API', bruno.id);
    await submit(ctx, bruno.id, task.id, { summary: 'Handed in', evidence: 'Tests pass', review: { baseCommit: BASE } });
    await verdict(ctx, rita.id, task.id, { pass: false, reviewedCommit: HEAD, comment: 'Handle retries.' });
    const before = routeSnapshot(await routeOf(db, await loadTask(db, task.id)), rita.id);
    await db.update(taskEvents).set({ createdAt: new Date(Date.now() - 900_000) }).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict')));
    await leaveWork(ctx, { agentId: hana.id }, rita);
    const current = await loadTask(db, task.id);
    const route = routeSnapshot(await routeOf(db, current), current.assigneeAgentId);
    expect(current).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(route).toMatchObject({ stage: 'review', phase: 'waiting', candidateId: before.candidateId });
    expect((await org()).departments.find(d => d.id === dev.id)!.reworkAt).toBeNull();
  });

  it('run blue while an employee works on its task, and yellow once it hands the work in', async () => {
    const { ctx, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
    const job = await run(bruno.id, api.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    /* Its turn still writes its last words: the work it handed in is no longer at work. */
    const after = await org();
    expect(stateOf(after, hana, bruno)).toBe('yellow');
    const line = lineOf(after, hana.id, bruno.id)!;
    expect(Date.parse(after.serverNow) - Date.parse(line.returnedAt!)).toBeGreaterThanOrEqual(0);
    expect(Date.parse(after.serverNow) - Date.parse(line.returnedAt!)).toBeLessThan(RETURN_MS);
    await end(job.id);
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
  });

  it('count a hand-in as given back to the head even when a reviewer takes the task next', async () => {
    const { ctx, bruno, rita, hana, member, run, org } = await company();
    const page = await member('Checkout page', bruno.id, rita.id);
    await run(bruno.id, page.id);
    await submit(ctx, bruno.id, page.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
    expect(stateOf(await org(), hana, rita)).toBe('quiet');
    await run(rita.id, page.id);
    expect(stateOf(await org(), hana, rita)).toBe('blue');
    await verdict(ctx, rita.id, page.id, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' });
    expect(stateOf(await org(), hana, rita)).toBe('yellow');
  });

  it('returns one review line while another checker works on an independent candidate', async () => {
    const { ctx, db, bruno, felix, rita, hana, hire, member, run, org } = await company();
    const rex = await hire('Rex', 'worker', 'DEV-REV');
    const page = await member('Checkout page', bruno.id, rita.id);
    const api = await member('Checkout API', felix.id, rex.id);
    await submit(ctx, bruno.id, page.id, { summary: 'Page candidate', evidence: 'Changed page tests.', review: { baseCommit: BASE } });
    await submit(ctx, felix.id, api.id, { summary: 'API candidate', evidence: 'Changed API tests.', review: { baseCommit: BASE } });
    expect((await loadTask(db, page.id)).assigneeAgentId).toBe(rita.id);
    expect((await loadTask(db, api.id)).assigneeAgentId).toBe(rex.id);
    await run(rita.id, page.id);
    await run(rex.id, api.id);
    await verdict(ctx, rex.id, api.id, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' });
    const now = await org();
    expect(stateOf(now, hana, rex)).toBe('yellow');
    expect(stateOf(now, hana, rita)).toBe('blue');
  });

  it('stay off yellow without a return: a comment, a question, a crash or a turn that keeps breaking', async () => {
    const { ctx, db, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    const job = await run(bruno.id, api.id);
    await comment(ctx, { agentId: bruno.id }, api.id, 'Halfway there.');
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    await ask(ctx, bruno.id, api.id, { kind: 'question', text: 'Which cards?' });
    /* Waiting for a person is not work, and not a return either. */
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
    await end(job.id, 'failed');
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
    const page = await createTask(ctx, { agentId: hana.id }, { title: 'Page', brief: '', body: '', departmentId: (await loadTask(db, api.id)).departmentId, assigneeAgentId: bruno.id, executor: true });
    await run(bruno.id, page.task.id);
    await brokeDown(ctx, bruno.id, await loadTask(db, page.task.id), 'Its turns keep breaking.');
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
  });

  it('show no blue to an employee switched off, and no line to one removed', async () => {
    const { db, bruno, felix, hana, member, run, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await run(bruno.id, api.id);
    await db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, bruno.id));
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
    await db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, felix.id));
    expect(lineOf(await org(), hana.id, felix.id)).toBeUndefined();
  });

  it("run to a product's employee from the head of the department that holds the product", async () => {
    const { db, acme, dev, hana, hire, org } = await company();
    const [shop] = await db.insert(departments).values({ companyId: acme.id, name: 'Shop', parentId: dev.id, roleCode: 'DEV', position: 2 }).returning();
    const paula = await hire('Paula', 'worker', 'DEV-BE', dev.id, { productId: shop!.id });
    const now = await org();
    expect(lineOf(now, hana.id, paula.id)).toBeDefined();
    expect(now.departments.find(d => d.id === dev.id)!.workLines.map(l => l.downstreamAgentId)).toContain(paula.id);
  });
});

describe('lines between the orchestrator and a department', () => {
  it('run blue while anyone in the department works on its tasks, with its head asleep', async () => {
    const { orchestrator, hana, bruno, member, run, org } = await company();
    expect(stateOf(await org(), orchestrator, hana)).toBe('quiet');
    await run(bruno.id, (await member('Checkout API', bruno.id)).id);
    expect(stateOf(await org(), orchestrator, hana)).toBe('blue');
  });

  it('turn yellow when the head reports the work done or blocked', async () => {
    const { ctx, orchestrator, hana, top, run, org } = await company();
    await run(hana.id, top.id);
    expect(stateOf(await org(), orchestrator, hana)).toBe('blue');
    await report(ctx, hana.id, top.id, { done: false, summary: 'No access to the payment provider.' });
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
  });

  it("keep blue while the head's turn still carries another task of the department", async () => {
    const { ctx, db, acme, sub, orchestrator, hana, top, run, org } = await company();
    const second = (await createTask(ctx, { agentId: orchestrator.id }, { title: 'Refunds', brief: '', body: '', departmentId: top.departmentId, assigneeAgentId: hana.id })).task;
    const started = new Date(Date.now() - 1000);
    await run(hana.id, top.id, started);
    /* The second task's turn went out inside the first one. */
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, taskId: second.id, kind: 'conversation', prompt: 'go', status: 'done', result: GONE_ALONG, startedAt: new Date(started.getTime() + 1), finishedAt: new Date(started.getTime() + 1), timeoutMs: 900000 });
    await report(ctx, hana.id, top.id, { done: true, summary: 'Payments are live.' });
    expect(stateOf(await org(), orchestrator, hana)).toBe('blue');
    await report(ctx, hana.id, second.id, { done: true, summary: 'Refunds are live.' });
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
  });

  it("does not keep blue for work under a department task its head reported blocked", async () => {
    const { ctx, orchestrator, hana, bruno, top, member, run, org } = await company();
    await run(bruno.id, (await member('Checkout API', bruno.id)).id);
    await run(hana.id, top.id);
    await report(ctx, hana.id, top.id, { done: false, summary: 'Waiting for the provider.' });
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
  });

  it('lights nothing for a turn with no task, on a timer or in a chat', async () => {
    const { orchestrator, hana, bruno, run, org } = await company();
    await run(bruno.id, null);
    await run(hana.id, null);
    const now = await org();
    expect(stateOf(now, orchestrator, hana)).toBe('quiet');
    expect(stateOf(now, hana, bruno)).toBe('quiet');
  });
});

describe('lines to an employee whose turn a message started', () => {
  /* The head or a colleague wrote to it, so its turn carries no task: it acts on the one its card shows. */
  it('run blue while it acts on its open task in Development, and so does its department', async () => {
    const { orchestrator, hana, bruno, member, run, org } = await company();
    await member('Checkout API', bruno.id);
    await run(bruno.id, null);
    const now = await org();
    expect(stateOf(now, hana, bruno)).toBe('blue');
    expect(stateOf(now, orchestrator, hana)).toBe('blue');
  });

  it('stay quiet when it has no open task', async () => {
    const { db, orchestrator, hana, bruno, member, run, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await db.update(tasks).set({ status: 'cancelled', closedAt: new Date() }).where(eq(tasks.id, api.id));
    await run(bruno.id, null);
    const now = await org();
    expect(stateOf(now, hana, bruno)).toBe('quiet');
    expect(stateOf(now, orchestrator, hana)).toBe('quiet');
  });

  it('stay quiet while its task waits for another one', async () => {
    const { ctx, hana, bruno, felix, top, member, run, org } = await company();
    const schema = await member('Schema', felix.id);
    await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: '', departmentId: top.departmentId, parentId: top.id, assigneeAgentId: bruno.id, executor: true, after: [schema.id], independentNone: 'Genuine dependency in the existing behavior test.' });
    await run(bruno.id, null);
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
  });

  it("keep to the task of a turn that carries one: handed in, it does not light for the employee's other task", async () => {
    const { ctx, hana, bruno, member, run, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await member('Docs', bruno.id);
    await run(bruno.id, api.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
  });

  it('run blue for the current Review owner', async () => {
    const { ctx, hana, bruno, rita, member, run, end, org } = await company();
    const page = await member('Checkout page', bruno.id, rita.id);
    const built = await run(bruno.id, page.id);
    await submit(ctx, bruno.id, page.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    await end(built.id);
    await run(rita.id, null);
    expect(stateOf(await org(), hana, rita)).toBe('blue');
  });
});

describe('the cycles of a line', () => {
  it('put out an old return once new work starts, even when that work ends without one, also after a restart', async () => {
    const { db, config, ctx, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    const first = await run(bruno.id, api.id);
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    await end(first.id);
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
    const page = await member('Checkout page', bruno.id);
    const second = await run(bruno.id, page.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    await end(second.id, 'failed');
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
    /* The same database under a new server: the cycles were kept, so the old return stays out. */
    const again = await buildApp({ db, config });
    try {
      expect(stateOf(await org(undefined, again), hana, bruno)).toBe('quiet');
    } finally {
      await again.close();
    }
  });

  it('lights again with a fresh return in the new cycle', async () => {
    const { ctx, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await end((await run(bruno.id, api.id)).id);
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    const page = await member('Checkout page', bruno.id);
    await run(bruno.id, page.id);
    await submit(ctx, bruno.id, page.id, { summary: 'Done too', evidence: 'npm test', review: { baseCommit: BASE } });
    const now = await org();
    expect(stateOf(now, hana, bruno)).toBe('yellow');
    const line = lineOf(now, hana.id, bruno.id)!;
    expect(line.returnedEpoch).toBe(line.workEpoch);
  });

  it('keep the rest of the five minutes after a reload and a restart', async () => {
    const { db, config, ctx, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await end((await run(bruno.id, api.id)).id);
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    /* The return came two minutes ago. */
    await db.update(mapReturns).set({ returnedAt: sql`now() - interval '2 minutes'` }).where(eq(mapReturns.downstreamAgentId, bruno.id));
    const again = await buildApp({ db, config });
    try {
      for (const now of [await org(), await org(undefined, again)]) {
        const line = lineOf(now, hana.id, bruno.id)!;
        const left = Date.parse(line.returnedAt!) + RETURN_MS - Date.parse(now.serverNow);
        expect(stateOf(now, hana, bruno)).toBe('yellow');
        expect(left).toBeGreaterThan(170_000);
        expect(left).toBeLessThanOrEqual(180_000);
      }
    } finally {
      await again.close();
    }
  });

  it('begin one cycle per turn, however often it is taken or its start is told', async () => {
    const { db, ctx, acme, bruno, hana, member, run, org } = await company();
    const api = await member('Checkout API', bruno.id);
    const job = await run(bruno.id, api.id);
    const before = lineOf(await org(), hana.id, bruno.id)!.workEpoch;
    expect(await db.transaction(tx => workStarts(tx, { id: job.id, companyId: acme.id, agentId: bruno.id, taskIds: [api.id] }))).toBeNull();
    await startWork(ctx, job.id);
    expect(lineOf(await org(), hana.id, bruno.id)!.workEpoch).toBe(before);
    const [row] = await db.select().from(mapReturns).where(and(eq(mapReturns.upstreamAgentId, hana.id), eq(mapReturns.downstreamAgentId, bruno.id)));
    expect(row!.workEpoch).toBe(before);
  });

  it('keep a return once and never go back to an older one', async () => {
    const { db, acme, bruno, hana, member, run, org } = await company();
    await run(bruno.id, (await member('Checkout API', bruno.id)).id);
    const edge = { companyId: acme.id, upstreamAgentId: hana.id, downstreamAgentId: bruno.id };
    const [{ epoch }] = (await db.select({ epoch: mapReturns.workEpoch }).from(mapReturns).where(eq(mapReturns.downstreamAgentId, bruno.id))) as [{ epoch: number }];
    const at = new Date(Date.now() - 60_000);
    await db.transaction(tx => recordMapReturn(tx, { ...edge, workEpoch: epoch, sourceKey: 'task:2', sourceJobId: null, sourceTaskId: null, returnedAt: at }));
    await db.transaction(tx => recordMapReturn(tx, { ...edge, workEpoch: epoch, sourceKey: 'task:2', sourceJobId: null, sourceTaskId: null, returnedAt: new Date() }));
    await db.transaction(tx => recordMapReturn(tx, { ...edge, workEpoch: epoch, sourceKey: 'task:1', sourceJobId: null, sourceTaskId: null, returnedAt: new Date(at.getTime() - 60_000) }));
    const line = lineOf(await org(), hana.id, bruno.id)!;
    expect(Date.parse(line.returnedAt!)).toBe(at.getTime());
    /* A return from an earlier cycle is kept out of the newer one. */
    await db.transaction(tx => recordMapReturn(tx, { ...edge, workEpoch: epoch - 1, sourceKey: 'task:3', sourceJobId: null, sourceTaskId: null, returnedAt: new Date() }));
    expect(Date.parse(lineOf(await org(), hana.id, bruno.id)!.returnedAt!)).toBe(at.getTime());
  });

  it('refuse a line that is not between an agent and the one above it', async () => {
    const { db, acme, bruno, felix } = await company();
    await expect(db.transaction(tx => recordMapReturn(tx, { companyId: acme.id, upstreamAgentId: felix.id, downstreamAgentId: bruno.id, workEpoch: 0, sourceKey: 'task:9', sourceJobId: null, sourceTaskId: null, returnedAt: new Date() }))).rejects.toThrow();
    expect(await db.select().from(mapReturns)).toEqual([]);
  });
});

describe('who sees the lines', () => {
  it('shows everyone of the company every line between its agents, and no task or job of them', async () => {
    const { app, ctx, ceo, dev, sales, orchestrator, bruno, hana, member, run, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await run(bruno.id, api.id);
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    const all = await org();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    const dan = await invitePerson(app, ceo, { name: 'Dan', email: 'dan@acme.com', access: { whole: true } });
    const lee = await invitePerson(app, ceo, { name: 'Lee', email: 'lee@acme.com', access: { departments: [dev.id] } });
    /* One of another department, one with the whole company and no plan, one of the department itself. */
    for (const token of [maria, dan, lee]) {
      const theirs = await org(token);
      expect(stateOf(theirs, hana, bruno)).toBe('yellow');
      expect(lineOf(theirs, orchestrator.id, hana.id)).toEqual(lineOf(all, orchestrator.id, hana.id));
      expect(Object.keys(lineOf(theirs, hana.id, bruno.id)!).sort()).toEqual(['downstreamAgentId', 'returnedAt', 'returnedEpoch', 'upstreamAgentId', 'workEpoch', 'working']);
    }
  });
});

const NODE_KEY = 'k'.repeat(40);

/* The company with the built-in node online, so its agents can run, and a tool client for one agent's running turn. */
async function online() {
  const c = await company({ NODE_KEY });
  const url = await listen(c.app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await agentState(c.app.ctx, c.hana.id)).ready);
  const tools = async (agentId: string, taskId: string | null = null) => {
    const token = `tool-token-${agentId}`;
    const job = await c.db.transaction(async tx => {
      const [row] = await tx
        .insert(jobs)
        .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId, taskId, kind: 'conversation', prompt: 'go', status: 'running', startedAt: new Date(), timeoutMs: 900000, toolTokenHash: hashToken(token) })
        .returning();
      await workStarts(tx, { id: row!.id, companyId: c.acme.id, agentId, taskIds: [taskId] });
      return row!;
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(c.app.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    onTestFinished(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { job, call };
  };
  return { ...c, tools, builtin };
}

describe('results given back in a message', () => {
  it("turn the department line yellow when its head writes to the orchestrator", async () => {
    const { orchestrator, hana, tools, org } = await online();
    const { call } = await tools(hana.id);
    expect((await call('tell_orchestrator', { text: 'Payments are blocked on the provider contract.' })).isError).toBeFalsy();
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
  });

  it('count a message to the own head as a return, and one to another employee or from the head down as none', async () => {
    const { orchestrator, hana, bruno, felix, tools, org } = await online();
    const head = await tools(hana.id);
    expect((await head.call('message_employee', { employee: felix.id, text: 'Take the card form next.' })).isError).toBeFalsy();
    expect(stateOf(await org(), hana, felix)).toBe('quiet');
    expect(stateOf(await org(), orchestrator, hana)).toBe('quiet');
    const { call } = await tools(bruno.id);
    expect((await call('message_employee', { employee: felix.id, text: 'Which branch has the cart?' })).isError).toBeFalsy();
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
    expect(stateOf(await org(), hana, felix)).toBe('quiet');
    expect((await call('message_employee', { employee: hana.id, text: 'The API is ready for the page.' })).isError).toBeFalsy();
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
  });

  it('keep blue while the turn that wrote to its head runs, also about the task it works on, and turn yellow once it ends', async () => {
    const { db, ctx, orchestrator, hana, bruno, member, run, tools, org, end } = await online();
    const api = await member('Checkout API', bruno.id);
    const { job, call } = await tools(bruno.id, api.id);
    await startWork(ctx, job.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    /* A question in the middle of the work: it goes on while the head reads. */
    expect((await call('message_employee', { employee: hana.id, text: 'One question: is one retry enough? Until you answer I go on with one.', task: api.number })).isError).toBeFalsy();
    const asked = await org();
    expect(stateOf(asked, hana, bruno)).toBe('blue');
    expect(stateOf(asked, orchestrator, hana)).toBe('blue');
    await call('message_employee', { employee: hana.id, text: 'Halfway: the API answers, the page is next.' });
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    await end(job.id);
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
    await run(bruno.id, api.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    expect(await db.select().from(mapReturns)).not.toHaveLength(0);
  });

  it("keep the department line blue while its head, at work on the department's task, writes to the orchestrator", async () => {
    const { ctx, orchestrator, hana, top, tools, org, end } = await online();
    const { job, call } = await tools(hana.id, top.id);
    await startWork(ctx, job.id);
    expect((await call('tell_orchestrator', { text: 'Which provider do we take? Until you answer I prepare both.' })).isError).toBeFalsy();
    expect(stateOf(await org(), orchestrator, hana)).toBe('blue');
    await end(job.id);
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
  });

  it('keep a task the turn handed in off the line, also once that turn writes to the one above', async () => {
    const { db, ctx, orchestrator, hana, top, tools, org } = await online();
    const { job, call } = await tools(hana.id, top.id);
    await startWork(ctx, job.id);
    /* The turn hands the task in while it still reads as at work, as a member's task the head accepts does under the
       department task. */
    await db.transaction(tx => returnAlongLine(tx, { agentId: hana.id, sourceKey: 'task:accepted', sourceTaskId: top.id, returnedAt: new Date() }));
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
    expect((await call('tell_orchestrator', { text: 'Payments are in, I tidy up the notes.' })).isError).toBeFalsy();
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
  });
});

/* What the browser draws for the line, read straight from the company's lines. */
async function drawn(db: Db, companyId: string, up: { id: string }, down: { id: string }): Promise<string> {
  const { lines, serverNow } = await mapLines(db, companyId);
  const line = lines.find(l => l.upstreamAgentId === up.id && l.downstreamAgentId === down.id);
  if (!line) return 'none';
  return lineState({ working: line.working, workEpoch: line.workEpoch, returnedEpoch: line.returnedEpoch, returnedAt: line.returnedAt ? Date.parse(line.returnedAt) : null }, serverNow.getTime());
}

describe('results a checking stage gives back to the head', () => {
  it('turn the Tests owner\'s line yellow once it hands the verified candidate to the head', async () => {
    const f = await testsFixture();
    expect(await drawn(f.db, f.task.companyId, f.head, f.tester)).toBe('quiet');
    await report(f.ctx, f.tester.id, f.task.id, f.verified());
    expect(await drawn(f.db, f.task.companyId, f.head, f.tester)).toBe('yellow');
  });

  it('give a failed check back to the head', async () => {
    const f = await testsFixture();
    await report(f.ctx, f.tester.id, f.task.id, { ...f.verified(), done: false });
    expect(await drawn(f.db, f.task.companyId, f.head, f.tester)).toBe('yellow');
  });

  it("turn a reviewer's line yellow when it sends a wrong goal back to the head", async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed totals and tests.', review: { baseCommit: BASE } });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, reviewedCommit: HEAD, escalate: true, comment: 'The requested total is missing; this implements a different goal.' });
    expect(await drawn(f.db, f.task.companyId, f.head, f.reviewer)).toBe('yellow');
  });
});

describe('a turn the node tells of', () => {
  it('begins a cycle when a turn on a task starts there, once however often it is told', async () => {
    const { db, acme, sub, hana, bruno, member, org, builtin } = await online();
    const api = await member('Checkout API', bruno.id);
    const [job] = await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: bruno.id, taskId: api.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000 }).returning();
    builtin.send({ type: 'job.started', jobId: job!.id });
    await until(async () => lineOf(await org(), hana.id, bruno.id)!.workEpoch === 1);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    expect((await loadTask(db, api.id)).status).toBe('working');
    builtin.send({ type: 'job.started', jobId: job!.id });
    builtin.send({ type: 'job.event', jobId: job!.id, seq: 0, event: { kind: 'text', text: 'On it.' } });
    await until(async () => (await db.select().from(agentEvents).where(eq(agentEvents.jobId, job!.id))).length > 0);
    expect(lineOf(await org(), hana.id, bruno.id)!.workEpoch).toBe(1);
  });
});

/* From here on the database refuses every change to the table's rows that the condition names, as a server that stops
   right there writes nothing more. What it gives back takes the refusal away again. */
async function stopAt(db: Db, table: 'tasks' | 'map_returns', when = 'true'): Promise<() => Promise<unknown>> {
  await db.execute(sql.raw(`create or replace function hh_stop() returns trigger language plpgsql as $$ begin raise exception 'The server stopped here.'; end $$`));
  await db.execute(sql.raw(`create trigger hh_stop before update on ${table} for each row when (${when}) execute function hh_stop()`));
  return () => db.execute(sql.raw(`drop trigger hh_stop on ${table}`));
}

/* The next turn the node was sent. */
async function sentTo(node: FakeNode): Promise<{ jobId: string; prompt: string }> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m;
}

/* A task that is open and goes to work once its turn does. */
const AT_WORK = `old.status = 'open' and new.status = 'working'`;

describe('a turn the queue takes', () => {
  /* The first work on the line came back, Bruno's handed in or Hana's reported done, and the next work waits for the queue. */
  async function returned(level: 'member' | 'department') {
    const c = await online();
    const { ctx, orchestrator, hana, bruno, top, member, run, end } = c;
    if (level === 'member') {
      const api = await member('Checkout API', bruno.id);
      const first = await run(bruno.id, api.id);
      await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
      await end(first.id);
      return { ...c, up: hana, down: bruno, next: await member('Checkout page', bruno.id) };
    }
    const first = await run(hana.id, top.id);
    await report(ctx, hana.id, top.id, { done: true, summary: 'Payments are live.' });
    await end(first.id);
    const next = (await createTask(ctx, { agentId: orchestrator.id }, { title: 'Refunds', brief: '', body: '', departmentId: top.departmentId, assigneeAgentId: hana.id })).task;
    return { ...c, up: orchestrator, down: hana, next };
  }

  it.each(['member', 'department'] as const)('begins the new cycle of a %s line with the turn it takes, so a server that stops once the turn went out leaves the old return out', async level => {
    const { ctx, db, config, up, down, next, org, end, builtin } = await returned(level);
    expect(stateOf(await org(), up, down)).toBe('yellow');
    await stopAt(db, 'tasks', AT_WORK);
    await wakeAll(ctx, [{ agentId: down.id, taskId: next.id, why: 'assigned' }]);
    const turn = await sentTo(builtin);
    expect(stateOf(await org(), up, down)).toBe('blue');
    await end(turn.jobId, 'failed');
    expect(stateOf(await org(), up, down)).toBe('quiet');
    const again = await buildApp({ db, config });
    try {
      expect(stateOf(await org(undefined, again), up, down)).toBe('quiet');
    } finally {
      await again.close();
    }
  });

  it.each(['member', 'department'] as const)('takes no turn when the new cycle of its %s line cannot be kept, and sends it with its cycle on the next try', async level => {
    const { ctx, db, up, down, next, org, builtin } = await returned(level);
    const before = builtin.queued();
    const goOn = await stopAt(db, 'map_returns');
    await wakeAll(ctx, [{ agentId: down.id, taskId: next.id, why: 'assigned' }]);
    /* Nothing went out: the turn still waits, and the line still shows the result that came back. */
    expect(await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.taskId, next.id))).toEqual([{ status: 'queued' }]);
    expect(builtin.queued()).toBe(before);
    expect(stateOf(await org(), up, down)).toBe('yellow');
    await goOn();
    await pump(ctx, down.id);
    await sentTo(builtin);
    const now = await org();
    expect(stateOf(now, up, down)).toBe('blue');
    expect(lineOf(now, up.id, down.id)!.workEpoch).toBe(2);
  });

  it("begins the cycle of a task that goes out inside a head's turn with that turn, also when its own task keeps no line on", async () => {
    const { ctx, db, config, acme, sub, orchestrator, hana, top, run, end, org, builtin } = await online();
    const first = await run(hana.id, top.id);
    await report(ctx, hana.id, top.id, { done: false, summary: 'Waiting for the provider.' });
    await end(first.id);
    expect(stateOf(await org(), orchestrator, hana)).toBe('yellow');
    const refunds = (await createTask(ctx, { agentId: orchestrator.id }, { title: 'Refunds', brief: '', body: '', departmentId: top.departmentId, assigneeAgentId: hana.id })).task;
    /* Hana is busy, so the turn on the blocked department task and the one on the new task wait, and go out as one. */
    const [busy] = await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: hana.id, kind: 'conversation', prompt: 'Plan the turn.', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    await wakeAll(ctx, [
      { agentId: hana.id, taskId: top.id, why: 'assigned' },
      { agentId: hana.id, taskId: refunds.id, why: 'assigned' },
    ]);
    await stopAt(db, 'tasks', AT_WORK);
    await end(busy!.id);
    /* The next turn goes out, and the server stops before the task that went with it is at work. */
    await expect(afterJob(ctx, busy!.id)).rejects.toMatchObject({ cause: { message: 'The server stopped here.' } });
    const turn = await sentTo(builtin);
    expect(turn.prompt).toContain('Refunds');
    expect(stateOf(await org(), orchestrator, hana)).toBe('blue');
    await end(turn.jobId, 'failed');
    const again = await buildApp({ db, config });
    try {
      expect(stateOf(await org(undefined, again), orchestrator, hana)).toBe('quiet');
    } finally {
      await again.close();
    }
  });
});

describe('the lines of a company with a long history', () => {
  const HEAD_TURNS = 300;

  /* 50 closed turns with 2000 tasks of the department, some still blocked or open; 500 finished turns of each employee
     and 300 of the head; and the lines of 30 employees who left. */
  async function history(c: Awaited<ReturnType<typeof company>>) {
    const { db, acme, sub, dev, hana, bruno, felix, rita, hire } = c;
    const closed = await db
      .insert(turns)
      .values(Array.from({ length: 50 }, (_, i) => ({ companyId: acme.id, number: i + 100, goal: `Goal ${i + 100}`, status: 'closed' as const })))
      .returning({ id: turns.id });
    const statusOf = (i: number): 'blocked' | 'open' | 'done' | 'cancelled' => (i % 50 === 0 ? 'blocked' : i % 50 === 1 ? 'open' : i % 2 ? 'done' : 'cancelled');
    for (let from = 0; from < 2000; from += 500) {
      await db.insert(tasks).values(
        Array.from({ length: 500 }, (_, k) => {
          const i = from + k;
          const status = statusOf(i);
          const closedAt = status === 'done' || status === 'cancelled' ? new Date(Date.now() - 86_400_000) : null;
          return { companyId: acme.id, number: 10_000 + i, turnId: closed[i % 50]!.id, departmentId: dev.id, title: `Old ${i}`, status, closedAt, executorAgentId: i % 3 ? bruno.id : null };
        }),
      );
    }
    const finished = (agentId: string, n: number) =>
      db.insert(jobs).values(Array.from({ length: n }, () => ({ companyId: acme.id, subscriptionId: sub.id, agentId, kind: 'conversation' as const, prompt: 'old', status: 'done' as const, startedAt: new Date(Date.now() - 86_400_000), timeoutMs: 900000 })));
    await finished(bruno.id, 500);
    await finished(felix.id, 500);
    await finished(rita.id, 500);
    await finished(hana.id, HEAD_TURNS);
    for (let i = 0; i < 30; i++) {
      const gone = await hire(`Gone ${i}`, 'worker', 'DEV-BE', dev.id, { removedAt: new Date() });
      await db.insert(mapReturns).values({ companyId: acme.id, upstreamAgentId: hana.id, downstreamAgentId: gone.id, workEpoch: 3, returnedEpoch: 3, returnedAt: new Date(), sourceKey: `gone-${i}` });
    }
  }

  /* Bruno works on his task, Felix gave his back and his turn still ends, Rita runs a turn on a task that waits for Bruno's,
     and Hana works on the department task. */
  async function now(c: Awaited<ReturnType<typeof company>>) {
    const { ctx, db, hana, bruno, felix, rita, top, member, run } = c;
    const api = await member('Checkout API', bruno.id);
    const docs = await member('Docs', felix.id);
    const later = (await createTask(ctx, { agentId: hana.id }, { title: 'Release', brief: '', body: '', departmentId: c.dev.id, parentId: top.id, assigneeAgentId: rita.id, executor: true, after: [api.id], independentNone: 'Genuine dependency in the existing behavior test.' })).task;
    await run(bruno.id, api.id);
    await run(felix.id, docs.id);
    await db.transaction(tx => returnAlongLine(tx, { agentId: felix.id, sourceKey: 'docs-1', sourceTaskId: docs.id, returnedAt: new Date('2026-11-03T05:00:00Z') }));
    await run(rita.id, later.id);
    await run(hana.id, top.id);
  }

  const named = (c: Awaited<ReturnType<typeof company>>, lines: MapLine[]) => {
    const names = new Map([c.orchestrator, c.hana, c.bruno, c.felix, c.rita].map(a => [a.id, a.name]));
    return lines
      .map(l => ({ line: `${names.get(l.upstreamAgentId) ?? '?'} > ${names.get(l.downstreamAgentId) ?? '?'}`, kind: l.kind, working: l.working, workEpoch: l.workEpoch, returnedEpoch: l.returnedEpoch, returnedAt: l.returnedAt }))
      .sort((a, b) => a.line.localeCompare(b.line));
  };

  /* What the lines were before the reads took only what the lines need now. */
  const EXPECTED = [
    { line: 'Hana > Bruno', kind: 'member', working: true, workEpoch: 1, returnedEpoch: null, returnedAt: null },
    { line: 'Hana > Felix', kind: 'member', working: false, workEpoch: 1, returnedEpoch: 1, returnedAt: '2026-11-03T05:00:00.000Z' },
    { line: 'Hana > Rita', kind: 'member', working: false, workEpoch: 0, returnedEpoch: null, returnedAt: null },
    { line: 'Orchestrator > Hana', kind: 'department', working: true, workEpoch: 3, returnedEpoch: null, returnedAt: null },
  ];

  it('gives the same lines as with a short one', async () => {
    const c = await company();
    await history(c);
    await now(c);
    const { lines } = await mapLines(c.db, c.acme.id);
    expect(named(c, lines)).toEqual(EXPECTED);
  });

  it('reads the running turns and their tasks, not the history', async () => {
    const c = await company();
    await history(c);
    await now(c);
    const { result, read } = await rowsRead(c.db, ['tasks', 'jobs'], () => mapLines(c.db, c.acme.id));
    expect(named(c, result.lines)).toEqual(EXPECTED);
    /* The four running turns' tasks and the department task above them, not the 2000 of the closed turns. */
    expect(read.tasks).toBeLessThanOrEqual(10);
    /* The running turns and the head's earlier ones: the turns that went out inside its running one are known only by
       the time they started, which no index of jobs holds yet. The employees' 1500 earlier turns stay unread. */
    expect(read.jobs).toBeLessThanOrEqual(HEAD_TURNS + 10);
  });

  it('locks only the lines of a new turn as it starts', async () => {
    const c = await company();
    await history(c);
    /* The lines among 45 agents who left, 1980 of them: enough that Postgres looks a line up by its key instead of reading
       the whole small table, as it does on a live database. */
    const gone = await Promise.all(Array.from({ length: 45 }, (_, i) => c.hire(`Left ${i}`, 'worker', 'DEV-BE', c.dev.id, { removedAt: new Date() })));
    await c.db.insert(mapReturns).values(gone.flatMap(up => gone.filter(down => down.id !== up.id).map(down => ({ companyId: c.acme.id, upstreamAgentId: up.id, downstreamAgentId: down.id, workEpoch: 3, returnedEpoch: 3, returnedAt: new Date(), sourceKey: `${up.name}>${down.name}` }))));
    const task = await c.member('Checkout API', c.bruno.id);
    const { read } = await rowsRead(c.db, ['tasks', 'map_returns'], () => c.run(c.bruno.id, task.id));
    /* Bruno's line and the department's, each locked by its key. */
    expect(read.map_returns).toBeLessThanOrEqual(8);
    expect(read.tasks).toBeLessThanOrEqual(10);
  });
});
