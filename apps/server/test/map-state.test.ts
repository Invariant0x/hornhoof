import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { lineState, RETURN_MS, type WorkLine } from '@hornhoof/protocol';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, mapReturns, people, subscriptions } from '../src/db/schema.js';
import { GONE_ALONG } from '../src/modules/conversation/queue.js';
import { recordMapReturn } from '../src/modules/org/map-state.js';
import { ask, brokeDown, comment, createTask, loadTask, report, startWork, submit, verdict } from '../src/modules/tasks/engine.js';
import { agentState } from '../src/modules/conversation/queue.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

type Org = { serverNow: string; workLines: WorkLine[]; departments: { id: string; workLines: WorkLine[] }[] };

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
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id, ...extra }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const felix = await hire('Felix', 'worker', 'DEV-FE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const ctx = app.ctx;
  const top = (await createTask(ctx, { agentId: orchestrator!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: hana.id })).task;
  const member = async (title: string, agentId: string, gates: string[] = []) =>
    (await createTask(ctx, { agentId: hana.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: top.id, assigneeAgentId: agentId, executor: true, gates })).task;
  /* A turn of the agent on the task goes out, as the queue sends it. */
  const run = async (agentId: string, taskId: string | null, at = new Date()) => {
    const [job] = await db
      .insert(jobs)
      .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId, taskId, kind: 'conversation', prompt: 'go', status: 'running', startedAt: at, timeoutMs: 900000 })
      .returning();
    await startWork(ctx, job!.id);
    return job!;
  };
  const end = (jobId: string, status: 'done' | 'failed' = 'done') => db.update(jobs).set({ status, finishedAt: new Date() }).where(eq(jobs.id, jobId));
  const org = async (token = ceo, on: FastifyInstance = app): Promise<Org> => (await on.inject({ url: '/api/org', ...as(token) })).json();
  return { app, db, config, ctx, ceo, acme: acme!, sub: sub!, orchestrator: orchestrator!, dev: dev!, sales: sales!, hire, hana, bruno, felix, rita, top, member, run, end, org };
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
  it('run blue while an employee works on its task, and yellow once it hands the work in', async () => {
    const { ctx, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    expect(stateOf(await org(), hana, bruno)).toBe('quiet');
    const job = await run(bruno.id, api.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test' });
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
    const page = await member('Checkout page', bruno.id, [rita.id]);
    await run(bruno.id, page.id);
    await submit(ctx, bruno.id, page.id, { summary: 'Done', evidence: 'npm test' });
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
    expect(stateOf(await org(), hana, rita)).toBe('quiet');
    await run(rita.id, page.id);
    expect(stateOf(await org(), hana, rita)).toBe('blue');
    await verdict(ctx, rita.id, page.id, { pass: true, comment: 'Fine.' });
    expect(stateOf(await org(), hana, rita)).toBe('yellow');
  });

  it("count one reviewer's verdict while another at the same gate still checks", async () => {
    const { ctx, db, acme, bruno, rita, hana, hire, member, run, org } = await company();
    /* Rex reviews on Codex, so both check the work at once. */
    const [ceoPerson] = await db.select().from(people);
    const [codex] = await db.insert(subscriptions).values({ companyId: acme.id, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: ceoPerson!.id, status: 'ready' }).returning();
    const rex = await hire('Rex', 'worker', 'DEV-REV', undefined, { subscriptionId: codex!.id });
    const page = await member('Checkout page', bruno.id, [rita.id]);
    await run(bruno.id, page.id);
    await submit(ctx, bruno.id, page.id, { summary: 'Done', evidence: 'npm test' });
    const panel = (await loadTask(db, page.id)).panel;
    expect(panel).toEqual(expect.arrayContaining([rita.id, rex.id]));
    await run(rita.id, page.id);
    await run(rex.id, page.id);
    await verdict(ctx, rex.id, page.id, { pass: true, comment: 'Fine.' });
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
    const page = await createTask(ctx, { agentId: hana.id }, { title: 'Page', brief: '', body: '', departmentId: (await loadTask(db, api.id)).departmentId, assigneeAgentId: bruno.id, executor: true, gates: [] });
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

describe('the cycles of a line', () => {
  it('put out an old return once new work starts, even when that work ends without one, also after a restart', async () => {
    const { db, config, ctx, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    const first = await run(bruno.id, api.id);
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test' });
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
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test' });
    const page = await member('Checkout page', bruno.id);
    await run(bruno.id, page.id);
    await submit(ctx, bruno.id, page.id, { summary: 'Done too', evidence: 'npm test' });
    const now = await org();
    expect(stateOf(now, hana, bruno)).toBe('yellow');
    const line = lineOf(now, hana.id, bruno.id)!;
    expect(line.returnedEpoch).toBe(line.workEpoch);
  });

  it('keep the rest of the five minutes after a reload and a restart', async () => {
    const { db, config, ctx, bruno, hana, member, run, end, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await end((await run(bruno.id, api.id)).id);
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test' });
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

  it('begin one cycle per turn, however often its start is told', async () => {
    const { db, ctx, bruno, hana, member, run, org } = await company();
    const job = await run(bruno.id, (await member('Checkout API', bruno.id)).id);
    const before = lineOf(await org(), hana.id, bruno.id)!.workEpoch;
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
  it("shows a person only the lines of the departments they reach, and no task or job of them", async () => {
    const { app, ctx, ceo, dev, sales, orchestrator, bruno, hana, member, run, org } = await company();
    const api = await member('Checkout API', bruno.id);
    await run(bruno.id, api.id);
    await submit(ctx, bruno.id, api.id, { summary: 'Done', evidence: 'npm test' });
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    const hers = await org(maria);
    expect(lineOf(hers, hana.id, bruno.id)).toBeUndefined();
    expect(lineOf(hers, orchestrator.id, hana.id)).toBeUndefined();
    const dan = await invitePerson(app, ceo, { name: 'Dan', email: 'dan@acme.com', access: { departments: [dev.id] } });
    const his = await org(dan);
    expect(stateOf(his, hana, bruno)).toBe('yellow');
    expect(Object.keys(lineOf(his, hana.id, bruno.id)!).sort()).toEqual(['downstreamAgentId', 'returnedAt', 'returnedEpoch', 'upstreamAgentId', 'workEpoch', 'working']);
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
    const [job] = await c.db
      .insert(jobs)
      .values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId, taskId, kind: 'conversation', prompt: 'go', status: 'running', startedAt: new Date(), timeoutMs: 900000, toolTokenHash: hashToken(token) })
      .returning();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(c.app.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    onTestFinished(() => client.close());
    const call = async (name: string, args: object) => (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { job: job!, call };
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

  it('keep the turn that gave a message back off the line while it runs, until a new turn starts', async () => {
    const { db, ctx, hana, bruno, member, run, tools, org, end } = await online();
    const api = await member('Checkout API', bruno.id);
    const { job, call } = await tools(bruno.id, api.id);
    await startWork(ctx, job.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    await call('message_employee', { employee: hana.id, text: 'Halfway: the API answers, the page is next.' });
    expect(stateOf(await org(), hana, bruno)).toBe('yellow');
    await end(job.id);
    await run(bruno.id, api.id);
    expect(stateOf(await org(), hana, bruno)).toBe('blue');
    expect(await db.select().from(mapReturns)).not.toHaveLength(0);
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
