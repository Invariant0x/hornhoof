import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments, jobs, subscriptions, testParts, testRuns } from '../src/db/schema.js';
import { agentState, enqueueTurn } from '../src/modules/conversation/queue.js';
import { BUILTIN, nodeIdentity } from '../src/modules/nodes/hub.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { pumpTests } from '../src/modules/testruns/runs.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'builtin-node-key-0123456789abcdef';
const GIB = 1024 ** 3;
const load = (over: object = {}) => ({ cpus: 8, load: 1, memFree: 8 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...over });
const machinesOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json();
const poolOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/pool', ...as(token) })).json();

describe('browser launch readiness before handing out work', () => {
  it('holds queued turns and runs on a personal node whose browser failed, names the reason in /api/machines and /api/pool, and dispatches once recovered', async () => {
    const { app, db } = await testApp({ NODE_PING_MS: '50', NODE_KEY });
    const url = await listen(app);
    onTestFinished(() => app.close());
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const companyId = acme!.id;
    const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/shop.git' }).returning();
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'linux-0001-abcd', hostname: 'worker-1', os: 'linux', arch: 'x86_64' } })).json();
    const [{ nodeId, subscriptionId, key }] = joined.nodes;

    const [bruno] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-ENG', departmentId: dev!.id, model: '', subscriptionId }).returning();
    const [head] = await db.insert(agents).values({ companyId, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev!.id, model: '', subscriptionId }).returning();
    const task = (await createTask(app.ctx, { agentId: head!.id }, { title: 'Browser E2E', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno!.id, executor: true, gates: [] })).task;

    const socket = await connectNode(url, key);
    socket.send({
      type: 'hello',
      version: '0.6.1',
      loggedIn: true,
      running: [],
      work: true,
      load: load(),
      browserError: 'libnss3.so: cannot open shared object file',
      noRuns: 'browser_failed: libnss3.so: cannot open shared object file',
    });
    await until(() => app.ctx.hub.isReady(nodeIdentity(nodeId)));

    const turnId = await enqueueTurn(app.ctx, { companyId, agentId: bruno!.id, taskId: task.id, prompt: 'Run browser checks', createdBy: null });
    const [run] = await db.insert(testRuns).values({ companyId, number: 1, kind: 'work', departmentId: dev!.id, taskId: task.id, agentId: bruno!.id, jobId: turnId, branch: 'main', command: 'echo ok', parts: 1, timeoutMs: 60_000, status: 'running' }).returning();
    await db.insert(testParts).values({ runId: run!.id, companyId, part: 1, status: 'queued' });
    await pumpTests(app.ctx);

    /* Neither the agent's turn nor the work part is handed to the broken node. */
    expect((await db.select().from(jobs).where(eq(jobs.id, turnId)))[0]!.status).toBe('queued');
    expect((await db.select().from(testParts).where(eq(testParts.runId, run!.id)))[0]!.status).toBe('queued');
    expect(await agentState(app.ctx, bruno!.id)).toMatchObject({ ready: false, reason: 'browser_failed' });
    expect((await machinesOf(app, ceo)).machines[0]).toMatchObject({
      hostname: 'worker-1',
      online: true,
      browserError: 'libnss3.so: cannot open shared object file',
    });
    expect((await poolOf(app, ceo)).machines[0]).toMatchObject({
      name: 'worker-1',
      noRuns: 'browser_failed: libnss3.so: cannot open shared object file',
    });

    /* Once the node reports browser recovery via status, waiting turns and runs go out immediately. */
    socket.send({ type: 'status', loggedIn: true, limits: null, browserError: null, noRuns: null });
    await until(async () => (await db.select().from(jobs).where(and(eq(jobs.id, turnId), eq(jobs.status, 'running')))).length === 1);
    await until(async () => (await db.select().from(testParts).where(and(eq(testParts.runId, run!.id), eq(testParts.status, 'running')))).length === 1);

    expect(await agentState(app.ctx, bruno!.id)).toMatchObject({ ready: true, reason: null });
    expect((await machinesOf(app, ceo)).machines[0]!.browserError).toBeNull();
    expect((await poolOf(app, ceo)).machines[0]!.noRuns).toBeNull();
  });

  it('routes turns to a healthy peer machine of the same plan while one machine has a broken browser, and holds built-in API-key turns when the built-in node browser fails', async () => {
    const { app, db } = await testApp({ NODE_PING_MS: '50', NODE_KEY });
    const url = await listen(app);
    onTestFinished(() => app.close());
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const companyId = acme!.id;
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    const code1 = connected.json().command.split('--join ')[1];
    const joined1 = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: code1, machineId: 'linux-0001-abcd', hostname: 'broken-host', os: 'linux', arch: 'x86_64' } })).json();
    const [{ nodeId: brokenId, subscriptionId, key: brokenKey }] = joined1.nodes;
    const cmd2 = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json().command.split('--join ')[1];
    const machine2 = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: cmd2, machineId: 'linux-0002-abcd', hostname: 'healthy-host', os: 'linux', arch: 'x86_64' } })).json().machine.id as string;
    const addPlan = (await app.inject({ method: 'POST', url: `/api/machines/${machine2}/plans`, payload: { subscription: subscriptionId }, ...as(ceo) })).json();
    const code2 = addPlan.command.split('--join ')[1];
    const joined2 = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: code2, machineId: 'linux-0002-abcd', hostname: 'healthy-host', os: 'linux', arch: 'x86_64' } })).json();
    const [{ nodeId: healthyId, key: healthyKey }] = joined2.nodes;

    const broken = await connectNode(url, brokenKey);
    const healthy = await connectNode(url, healthyKey);
    broken.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], load: load(), browserError: 'libnss3.so missing' });
    healthy.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], load: load() });
    await until(() => app.ctx.hub.isReady(nodeIdentity(brokenId)) && app.ctx.hub.isReady(nodeIdentity(healthyId)));

    const [worker] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Vera', roleKey: 'DEV-ENG', model: '', subscriptionId }).returning();
    const peerTurn = await enqueueTurn(app.ctx, { companyId, agentId: worker!.id, prompt: 'Check', createdBy: null });
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, peerTurn)))[0]!.nodeId !== null);
    expect((await db.select().from(jobs).where(eq(jobs.id, peerTurn)))[0]!.nodeId).toBe(healthyId);

    const [apiSub] = await db.select().from(subscriptions).where(eq(subscriptions.kind, 'api_key'));
    const [orch] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await db.update(agents).set({ subscriptionId: apiSub!.id }).where(eq(agents.id, orch!.id));

    const builtin = await connectNode(url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], load: load(), browserError: 'libgbm.so.1 missing' });
    await until(() => app.ctx.hub.isReady(BUILTIN));

    expect((await machinesOf(app, ceo)).builtin).toMatchObject({ online: true, browserError: 'libgbm.so.1 missing' });
    expect((await poolOf(app, ceo)).builtin.noRuns).toBe('browser_failed: libgbm.so.1 missing');
    expect(await agentState(app.ctx, orch!.id)).toMatchObject({ ready: false, reason: 'browser_failed' });
    const orchTurn = await enqueueTurn(app.ctx, { companyId, agentId: orch!.id, prompt: 'Hello', createdBy: null });
    expect((await db.select().from(jobs).where(eq(jobs.id, orchTurn)))[0]!.status).toBe('queued');

    builtin.send({ type: 'status', loggedIn: true, limits: null, browserError: null, noRuns: null });
    await until(async () => (await db.select().from(jobs).where(and(eq(jobs.id, orchTurn), eq(jobs.status, 'running')))).length === 1);
    expect((await machinesOf(app, ceo)).builtin.browserError).toBeNull();
  });
});
