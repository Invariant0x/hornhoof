import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments, jobs, machines, nodes, subscriptions, testParts, testRuns } from '../src/db/schema.js';
import { agentState, enqueueTurn, orchestratorState } from '../src/modules/conversation/queue.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { pumpTests, startRun } from '../src/modules/testruns/runs.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'builtin-node-key-0123456789abcdef';
/* No ping comes in a test, so no stand-in node is dropped for a pong that came late on a busy machine. */
const NODE_PING_MS = '2147483647';
const GIB = 1024 ** 3;
const load = (over: object = {}) => ({ cpus: 8, load: 1, memFree: 8 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...over });
const machinesOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json();
const poolOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/pool', ...as(token) })).json();

describe('browser launch readiness before handing out work', () => {
  it('runs agent turns on a personal node whose browser failed, refuses new runs with the named cause while holding queued parts, and dispatches runs once recovered', async () => {
    const { app, db } = await testApp({ NODE_PING_MS, NODE_KEY });
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
    await db.update(machines).set({ lendsTests: true }).where(eq(machines.id, joined.machine.id));

    const [bruno] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-ENG', departmentId: dev!.id, model: '', subscriptionId }).returning();
    const [head] = await db.insert(agents).values({ companyId, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev!.id, model: '', subscriptionId }).returning();
    const task = (await createTask(app.ctx, { agentId: head!.id }, { title: 'Browser E2E', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno!.id, executor: true })).task;

    /* Before hello, waitsFor and placement follow node readiness (needs_login, node_outdated, machine_offline), never browser_failed. */
    expect(await orchestratorState(app.ctx, '00000000-0000-0000-0000-000000000000')).toEqual({
      ready: false, limitUntil: null, budgetUntil: null, held: null, reason: 'no_subscription', browserError: null,
      busy: false, runningJobId: null, queued: 0, terminal: false, turnRefused: null, program: null, alarm: null, retry: null, failure: null, obsolete: null, machineDrain: null, memoryWait: false, roomWait: null,
    });
    expect(await agentState(app.ctx, bruno!.id)).toMatchObject({ ready: false, reason: 'needs_login', browserError: null });
    await db.update(nodes).set({ status: 'ready', version: '0.1.0' }).where(eq(nodes.id, nodeId));
    await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, subscriptionId));
    expect(await agentState(app.ctx, bruno!.id)).toMatchObject({ ready: false, reason: 'node_outdated', browserError: null });
    await db.update(nodes).set({ status: 'ready', version: '0.6.1' }).where(eq(nodes.id, nodeId));
    expect(await agentState(app.ctx, bruno!.id)).toMatchObject({ ready: false, reason: 'machine_offline', browserError: null });

    const socket = await connectNode(url, key);
    const route = routeSnapshot(await routeOf(db, task), task.assigneeAgentId);
    const turnId = await enqueueTurn(app.ctx, { companyId, agentId: bruno!.id, taskId: task.id, prompt: 'Implement backend', createdBy: null,
      message: { personId: null, text: 'Implement backend', taskWake: taskWakeOf(task, { why: 'assigned' }, route) } });
    expect((await db.select().from(agents).where(eq(agents.id, bruno!.id)))[0]!.nodeId).toBeNull();
    socket.send({
      type: 'hello',
      version: '0.6.1',
      loggedIn: true,
      running: [],
      work: true,
      load: load(),
      browserError: 'libnss3.so: cannot open shared object file',
      noRuns: 'Playwright browsers could not start: libnss3.so: cannot open shared object file',
    });
    await until(() => app.ctx.hub.isReady(nodeIdentity(nodeId)));

    /* The agent's turn goes out right away while browserError stays visible on agentState, /api/machines and /api/pool. */
    expect(await agentState(app.ctx, bruno!.id)).toMatchObject({
      ready: true,
      reason: null,
      browserError: 'libnss3.so: cannot open shared object file',
    });
    await until(async () => (await db.select().from(jobs).where(and(eq(jobs.id, turnId), eq(jobs.status, 'running')))).length === 1);

    const toolJob = { id: turnId, companyId, agentId: bruno!.id, agentKind: 'worker' as const, departmentId: dev!.id, roleKey: 'DEV-ENG', skills: [] };
    await expect(startRun(app.ctx, toolJob, { command: 'npx playwright test', branch: 'main' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      reason: 'browser_failed',
      message: expect.stringContaining('worker-1 (libnss3.so: cannot open shared object file)'),
    });
    await expect(startRun(app.ctx, toolJob, { command: 'node check.js' }, 'work')).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      reason: 'browser_failed',
      message: expect.stringContaining('worker-1 (libnss3.so: cannot open shared object file)'),
    });

    const [run] = await db.insert(testRuns).values({ companyId, number: 1, kind: 'work', departmentId: dev!.id, taskId: task.id, agentId: bruno!.id, jobId: turnId, branch: 'main', command: 'echo ok', parts: 1, timeoutMs: 60_000, status: 'running' }).returning();
    await db.insert(testParts).values({ runId: run!.id, companyId, part: 1, status: 'queued' });
    await pumpTests(app.ctx);

    expect((await db.select().from(testParts).where(eq(testParts.runId, run!.id)))[0]!.status).toBe('queued');
    expect((await machinesOf(app, ceo)).machines[0]).toMatchObject({
      hostname: 'worker-1',
      online: true,
      browserError: 'libnss3.so: cannot open shared object file',
    });
    const poolBefore = await poolOf(app, ceo);
    expect(poolBefore.machines[0]).toMatchObject({
      name: 'worker-1',
      noRuns: 'Playwright browsers could not start: libnss3.so: cannot open shared object file',
    });
    expect(poolBefore.waiting[0]?.why).toContain('worker-1 (libnss3.so: cannot open shared object file)');

    /* Once the node reports browser recovery via status, waiting runs go out immediately and browserError clears. */
    socket.send({ type: 'status', loggedIn: true, limits: null, browserError: null, noRuns: null });
    await until(async () => (await db.select().from(testParts).where(and(eq(testParts.runId, run!.id), eq(testParts.status, 'running')))).length === 1);

    expect(await agentState(app.ctx, bruno!.id)).toMatchObject({ ready: true, reason: null, browserError: null });
    expect((await machinesOf(app, ceo)).machines[0]!.browserError).toBeNull();
    expect((await poolOf(app, ceo)).machines[0]!.noRuns).toBeNull();
  });

  it('keeps agent turns running on a broken-browser personal node and on the built-in node while routing runs to a healthy peer machine', async () => {
    const { app, db } = await testApp({ NODE_PING_MS, NODE_KEY });
    const url = await listen(app);
    onTestFinished(() => app.close());
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const companyId = acme!.id;
    const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/shop.git' }).returning();
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
    await db.update(machines).set({ lendsTests: true });

    const broken = await connectNode(url, brokenKey);
    const healthy = await connectNode(url, healthyKey);
    broken.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], work: true, load: load(), browserError: 'libnss3.so missing' });
    healthy.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], work: true, load: load() });
    await until(() => app.ctx.hub.isReady(nodeIdentity(brokenId)) && app.ctx.hub.isReady(nodeIdentity(healthyId)));

    /* An agent already placed on broken-host keeps getting turns there, while runs skip broken-host for healthy-host. */
    const [vera] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Vera', roleKey: 'DEV-ENG', departmentId: dev!.id, model: '', subscriptionId, nodeId: brokenId }).returning();
    const [head] = await db.insert(agents).values({ companyId, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev!.id, model: '', subscriptionId }).returning();
    const task = (await createTask(app.ctx, { agentId: head!.id }, { title: 'Check', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: vera!.id, executor: true })).task;
    expect(await agentState(app.ctx, vera!.id)).toMatchObject({ ready: true, reason: null, browserError: 'libnss3.so missing' });
    const route = routeSnapshot(await routeOf(db, task), task.assigneeAgentId);
    const veraTurn = await enqueueTurn(app.ctx, { companyId, agentId: vera!.id, taskId: task.id, prompt: 'Check', createdBy: null,
      message: { personId: null, text: 'Check', taskWake: taskWakeOf(task, { why: 'assigned' }, route) } });
    await until(async () => (await db.select().from(jobs).where(and(eq(jobs.id, veraTurn), eq(jobs.status, 'running')))).length === 1);
    expect((await db.select().from(jobs).where(eq(jobs.id, veraTurn)))[0]!.nodeId).toBe(brokenId);

    const veraJob = { id: veraTurn, companyId, agentId: vera!.id, agentKind: 'worker' as const, departmentId: dev!.id, roleKey: 'DEV-ENG', skills: [] };
    const started = await startRun(app.ctx, veraJob, { command: 'npx playwright test', branch: 'main' });
    expect(started).toContain('on healthy-host');

    /* The orchestrator on an API key still runs turns on BUILTIN even when BUILTIN's browser failed. */
    const [apiSub] = await db.select().from(subscriptions).where(eq(subscriptions.kind, 'api_key'));
    const [orch] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await db.update(agents).set({ subscriptionId: apiSub!.id, nodeId: brokenId }).where(eq(agents.id, orch!.id));
    expect(await orchestratorState(app.ctx, companyId)).toMatchObject({ ready: false, reason: 'machine_offline', browserError: null });

    const builtin = await connectNode(url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], work: true, load: load(), browserError: 'libgbm.so.1 missing' });
    await until(() => app.ctx.hub.isReady(BUILTIN));

    expect((await machinesOf(app, ceo)).builtin).toMatchObject({ online: true, browserError: 'libgbm.so.1 missing' });
    expect((await poolOf(app, ceo)).builtin.noRuns).toBe('browser_failed: libgbm.so.1 missing');
    expect(await orchestratorState(app.ctx, companyId)).toMatchObject({ ready: true, reason: null, browserError: 'libgbm.so.1 missing' });
    const orchTurn = await enqueueTurn(app.ctx, { companyId, agentId: orch!.id, prompt: 'Hello', createdBy: null });
    await until(async () => (await db.select().from(jobs).where(and(eq(jobs.id, orchTurn), eq(jobs.status, 'running')))).length === 1);
    expect((await db.select().from(agents).where(eq(agents.id, orch!.id)))[0]!.nodeId).toBeNull();

    /* If peer machines are not lent, only BUILTIN + broken-host remain and startRun refuses naming the broken browsers. */
    await db.update(machines).set({ lendsTests: false });
    await expect(startRun(app.ctx, veraJob, { command: 'npx playwright test', branch: 'main' })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
      reason: 'browser_failed',
      message: expect.stringContaining('the built-in node (libgbm.so.1 missing)'),
    });

    builtin.send({ type: 'status', loggedIn: true, limits: null, browserError: null, noRuns: null });
    await until(async () => (await machinesOf(app, ceo)).builtin.browserError === null);
    expect(await agentState(app.ctx, orch!.id)).toMatchObject({ ready: true, reason: null, browserError: null });
  });
});
