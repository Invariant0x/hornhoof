import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, nodes as nodeRows, subscriptions, tasks } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { PROGRAM_OPERATOR_ROLE } from '../src/modules/operations/required.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

type Run = { type: 'job.run'; jobId: string; prompt: string; sessionId: string | null };

const MAC = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
const LAPTOP = { ...MAC, machineId: 'laptop-0002-abcd', hostname: 'ivan-laptop' };
const codeOf = (command: string) => command.split('--join ')[1]!;
const hello = { type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [] };

/* Ivan's Claude plan on his Mac and on his laptop, each node online and signed in, and two employees on the plan. */
async function planOnTwoMachines(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp(env);
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
  const plan = connected.subscriptions[0].id as string;
  const onMac = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...MAC } })).json();
  const alone = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json();
  const laptop = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(alone.command), ...LAPTOP } })).json();
  const added = (await app.inject({ method: 'POST', url: `/api/machines/${laptop.machine.id}/plans`, payload: { subscription: plan }, ...as(ceo) })).json();
  const onLaptop = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(added.command), ...LAPTOP } })).json();
  const nodes = { mac: onMac.nodes[0] as { nodeId: string; key: string }, laptop: onLaptop.nodes[0] as { nodeId: string; key: string } };
  const mac = await connectNode(url, nodes.mac.key);
  mac.send(hello);
  const lap = await connectNode(url, nodes.laptop.key);
  lap.send(hello);
  const [acme] = await db.select().from(companies);
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string) => (await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: plan }).returning())[0]!;
  const bruno = await hire('Bruno');
  const vera = await hire('Vera');
  await until(async () => (await state(app, ceo, bruno.id)).ready);
  return { app, db, url, ceo, plan, nodes, mac, lap, bruno, vera };
}

const state = async (app: FastifyInstance, token: string, id: string) => (await app.inject({ url: `/api/agents/${id}/events`, ...as(token) })).json().state;
const write = async (app: FastifyInstance, token: string, id: string, text: string) =>
  expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, payload: { text }, ...as(token) })).statusCode).toBeLessThan(300);

async function nextRun(node: FakeNode): Promise<Run> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as Run;
}

const finish = (node: FakeNode, run: Run, sessionId: string) => node.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId, result: 'ok', tail: '', error: null });

describe('agents of one plan on several machines', () => {
  it('lets the program operator resolve an asking turn while waiting, and blocks it during restarting', async () => {
    const { app, db, ceo, nodes, mac, lap, bruno, vera } = await planOnTwoMachines({ HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-operator-drain-')) });
    lap.close();
    await lap.closed;
    await db.update(agents).set({ nodeId: nodes.mac.nodeId, roleKey: PROGRAM_OPERATOR_ROLE }).where(eq(agents.id, bruno.id));
    await db.update(agents).set({ nodeId: nodes.mac.nodeId }).where(eq(agents.id, vera.id));
    await write(app, ceo, vera.id, 'Continue the task');
    const work = await nextRun(mac);
    mac.send({ type: 'job.program', jobId: work.jobId, state: 'asking', since: Date.now(), screenAt: Date.now() });
    await until(async () => (await state(app, ceo, vera.id)).program?.state === 'asking');
    const prepare = () => app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${nodes.mac.key}` }, payload: {} });
    expect((await prepare()).json().drain).toMatchObject({ state: 'waiting', turnsLeft: 1 });
    await write(app, ceo, bruno.id, 'Resolve the permission question for Vera');
    await until(() => mac.queued() > 0);
    const operator = await nextRun(mac);
    expect(operator.prompt).toContain('Resolve the permission question');
    expect((await prepare()).json().drain).toMatchObject({ state: 'waiting', turnsLeft: 2 });
    mac.send({ type: 'job.program', jobId: work.jobId, state: 'thinking', since: Date.now(), screenAt: Date.now() });
    finish(mac, operator, 'operator');
    finish(mac, work, 'vera');
    await until(async () => (await prepare()).json().ready === true);
    expect((await db.select().from(jobs).where(eq(jobs.id, work.jobId)))[0]).toMatchObject({ status: 'done', error: null });
    await write(app, ceo, bruno.id, 'This waits for the restart');
    expect(mac.queued()).toBe(0);
  });

  it('places new work on another node of the same plan while its current node waits for an update', async () => {
    const { app, db, ceo, nodes, mac, lap, bruno } = await planOnTwoMachines({ HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-placement-drain-')) });
    await db.update(agents).set({ nodeId: nodes.mac.nodeId }).where(eq(agents.id, bruno.id));
    const response = await app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${nodes.mac.key}` }, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json().ready).toBe(true);
    await write(app, ceo, bruno.id, 'Use the available machine');
    const sent = await nextRun(lap);
    expect(sent.prompt).toContain('Use the available machine');
    expect(mac.queued()).toBe(0);
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.nodeId).toBe(nodes.laptop.nodeId);
  });

  it('queues messages with machineDrain while every node of a plan waits for an update', async () => {
    const { app, ceo, nodes, mac, lap, bruno } = await planOnTwoMachines({ HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-placement-drain-')) });
    for (const node of [nodes.mac, nodes.laptop]) await app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${node.key}` }, payload: {} });
    await write(app, ceo, bruno.id, 'Wait for the update');
    expect(await state(app, ceo, bruno.id)).toMatchObject({ ready: true, reason: null, machineDrain: { state: 'restarting' } });
    expect(mac.queued() + lap.queued()).toBe(0);
  });

  it('starts each new employee on the machine of its plan with the fewest agents, and keeps it there', async () => {
    const { app, db, ceo, nodes, mac, lap, bruno, vera } = await planOnTwoMachines();
    await write(app, ceo, bruno.id, 'Hi');
    const first = await nextRun(mac);
    finish(mac, first, 'bruno-on-mac');
    await until(async () => !(await state(app, ceo, bruno.id)).busy);
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.nodeId).toBe(nodes.mac.nodeId);

    await write(app, ceo, vera.id, 'Hi');
    finish(lap, await nextRun(lap), 'vera-on-laptop');
    await until(async () => !(await state(app, ceo, vera.id)).busy);
    expect((await db.select().from(agents).where(eq(agents.id, vera.id)))[0]!.nodeId).toBe(nodes.laptop.nodeId);

    await write(app, ceo, bruno.id, 'Again');
    expect((await nextRun(mac)).sessionId).toBe('bruno-on-mac');
    expect(lap.queued()).toBe(0);
  });

  it('starts a new employee on the machine of its plan that its nodes say is freer, though it holds more agents', async () => {
    const { app, db, ceo, nodes, mac, lap, bruno, vera } = await planOnTwoMachines();
    const GIB = 1024 ** 3;
    mac.send({ type: 'load', cpus: 8, load: 7.6, memFree: 1 * GIB, memTotal: 16 * GIB, tests: 1, jobs: 3 });
    lap.send({ type: 'load', cpus: 8, load: 0.4, memFree: 12 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 1 });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(nodes.mac.nodeId))?.load === 7.6 && app.ctx.hub.loadOf(nodeIdentity(nodes.laptop.nodeId)) !== null);
    await db.update(agents).set({ nodeId: nodes.laptop.nodeId }).where(eq(agents.id, bruno.id));
    await write(app, ceo, vera.id, 'Hi');
    finish(lap, await nextRun(lap), 'vera-on-laptop');
    await until(async () => !(await state(app, ceo, vera.id)).busy);
    expect((await db.select().from(agents).where(eq(agents.id, vera.id)))[0]!.nodeId).toBe(nodes.laptop.nodeId);
    expect(mac.queued()).toBe(0);
  });

  it("moves an employee whose machine went away to another of its plan's machines, in a fresh session there", async () => {
    const { app, db, ceo, nodes, mac, lap, bruno } = await planOnTwoMachines();
    await write(app, ceo, bruno.id, 'Hi');
    finish(mac, await nextRun(mac), 'bruno-on-mac');
    await until(async () => !(await state(app, ceo, bruno.id)).busy);
    mac.close();
    await mac.closed;
    await write(app, ceo, bruno.id, 'Are you there?');
    const run = await nextRun(lap);
    expect(run.sessionId).toBeNull();
    expect(run.prompt).toContain('Are you there?');
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.nodeId).toBe(nodes.laptop.nodeId);
  });

  it('keeps an employee with a task in progress waiting for its own machine, whose folder may hold its work', async () => {
    const { app, db, ceo, url, nodes, mac, lap, bruno } = await planOnTwoMachines();
    await write(app, ceo, bruno.id, 'Hi');
    finish(mac, await nextRun(mac), 'bruno-on-mac');
    await until(async () => !(await state(app, ceo, bruno.id)).busy);
    await db.insert(tasks).values({ companyId: bruno.companyId, number: 1, title: 'Checkout API', executorAgentId: bruno.id, assigneeAgentId: bruno.id, status: 'working' });
    mac.close();
    await mac.closed;
    await until(async () => (await state(app, ceo, bruno.id)).reason === 'machine_offline');
    const back = await connectNode(url, nodes.mac.key);
    back.send(hello);
    await until(async () => (await state(app, ceo, bruno.id)).ready);
    await write(app, ceo, bruno.id, 'Are you there?');
    const run = await nextRun(back);
    expect(lap.queued()).toBe(0);
    expect(run.sessionId).toBe('bruno-on-mac');
    expect(run.prompt).toContain('Are you there?');
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.nodeId).toBe(nodes.mac.nodeId);
  });

  it('sends the waiting turn of an employee with work in progress to another machine of its plan once its own is disconnected', async () => {
    const { app, db, ceo, plan, nodes, mac, lap, bruno } = await planOnTwoMachines();
    await write(app, ceo, bruno.id, 'Hi');
    finish(mac, await nextRun(mac), 'bruno-on-mac');
    await until(async () => !(await state(app, ceo, bruno.id)).busy);
    await db.insert(tasks).values({ companyId: bruno.companyId, number: 1, title: 'Checkout API', executorAgentId: bruno.id, assigneeAgentId: bruno.id, status: 'working' });
    mac.close();
    await mac.closed;
    await until(async () => (await state(app, ceo, bruno.id)).reason === 'machine_offline');
    /* A turn waits for him, as a task or a timer queues one. */
    await db.insert(jobs).values({ companyId: bruno.companyId, subscriptionId: plan, agentId: bruno.id, kind: 'conversation', prompt: 'Go on with the checkout', timeoutMs: 900000, status: 'queued' });
    const [own] = await db.select({ machineId: nodeRows.machineId }).from(nodeRows).where(eq(nodeRows.id, nodes.mac.nodeId));
    expect((await app.inject({ method: 'POST', url: `/api/machines/${own!.machineId}/disconnect`, ...as(ceo) })).statusCode).toBe(204);
    const run = await Promise.race([nextRun(lap), new Promise<null>(r => setTimeout(() => r(null), 3000))]);
    expect(run?.prompt).toContain('Go on with the checkout');
    expect(run?.sessionId).toBeNull();
  });

  it('waits while no machine of the plan can take a turn, and goes out on the first that can', async () => {
    const { app, ceo, url, nodes, mac, lap, bruno } = await planOnTwoMachines();
    mac.close();
    lap.close();
    await Promise.all([mac.closed, lap.closed]);
    await until(async () => (await state(app, ceo, bruno.id)).reason === 'machine_offline');
    const back = await connectNode(url, nodes.laptop.key);
    back.send({ ...hello, loggedIn: false });
    await until(async () => (await state(app, ceo, bruno.id)).reason === 'needs_login');
    back.send({ type: 'status', loggedIn: true, limits: null });
    await until(async () => (await state(app, ceo, bruno.id)).ready);
    await write(app, ceo, bruno.id, 'Hi');
    expect((await nextRun(back)).prompt).toContain('Hi');
  });

  it("opens a new employee's window on the live terminal of the machine its first turn would go to", async () => {
    const { app, ceo, mac, lap, vera } = await planOnTwoMachines();
    expect((await state(app, ceo, vera.id)).terminal).toBe(false);
    mac.send({ ...hello, terminals: true });
    lap.send({ ...hello, terminals: true });
    await until(async () => (await state(app, ceo, vera.id)).terminal === true);
  });

  it('lets go of the machine of an employee moved to a company key, which runs it on the built-in node', async () => {
    const NODE_KEY = 'k'.repeat(40);
    const { app, db, url, ceo, mac, bruno } = await planOnTwoMachines({ NODE_KEY });
    await write(app, ceo, bruno.id, 'Hi');
    finish(mac, await nextRun(mac), 'bruno-on-mac');
    await until(async () => !(await state(app, ceo, bruno.id)).busy);
    const builtin = await connectNode(url, NODE_KEY);
    builtin.send(hello);
    const [key] = await db.select().from(subscriptions).where(eq(subscriptions.kind, 'api_key'));
    await db.update(agents).set({ subscriptionId: key!.id }).where(eq(agents.id, bruno.id));
    await until(async () => (await state(app, ceo, bruno.id)).ready);
    await write(app, ceo, bruno.id, 'On the key now');
    const run = await nextRun(builtin);
    expect(run.sessionId).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.nodeId).toBeNull();
    builtin.close();
  });

  it('shows the employee the machine it runs on', async () => {
    const { app, ceo, mac, bruno } = await planOnTwoMachines();
    const card = async () => (await app.inject({ url: `/api/agents/${bruno.id}`, ...as(ceo) })).json();
    expect((await card()).machine).toBeNull();
    await write(app, ceo, bruno.id, 'Hi');
    finish(mac, await nextRun(mac), 'bruno-on-mac');
    await until(async () => (await card()).machine !== null);
    expect((await card()).machine).toMatchObject({ hostname: 'ivan-mac' });
  });

  it('shows the orchestrator the machine it runs on', async () => {
    const { app, db, ceo, plan, nodes } = await planOnTwoMachines();
    const org = async () => (await app.inject({ url: '/api/org', ...as(ceo) })).json().orchestrator;
    expect((await org()).machine).toBeNull();
    await db.update(agents).set({ subscriptionId: plan, nodeId: nodes.laptop.nodeId }).where(eq(agents.kind, 'orchestrator'));
    expect((await org()).machine).toMatchObject({ hostname: 'ivan-laptop' });
  });
});
