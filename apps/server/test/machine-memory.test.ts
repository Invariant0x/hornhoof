import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments } from '../src/db/schema.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

type Run = { type: 'job.run'; jobId: string; prompt: string };

const GIB = 1024 ** 3;
const MAC = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
const codeOf = (command: string) => command.split('--join ')[1]!;
const load = (memFree: number) => ({ cpus: 10, load: 1, memFree, memTotal: 12 * GIB, tests: 0, jobs: 0 });
/* live: the agents whose programs run on the node, as a node that says so names them. */
const hello = (memFree: number, live?: string[]) => ({ type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [], load: load(memFree), ...(live ? { live } : {}) });

/* The CEO's Claude plan on dev-mac, and two employees on the plan. */
async function planOnOneMachine() {
  const { app, db } = await testApp();
  onTestFinished(() => app.close());
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
  const plan = connected.subscriptions[0].id as string;
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...MAC } })).json();
  const mac = await connectNode(url, joined.nodes[0].key as string);
  const [acme] = await db.select().from(companies);
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string) => (await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: plan }).returning())[0]!;
  const bruno = await hire('Bruno');
  const vera = await hire('Vera');
  const rita = await hire('Rita');
  const online = async (frame: ReturnType<typeof hello>) => {
    mac.send(frame);
    await until(async () => (await state(app, ceo, bruno.id)).ready);
  };
  return { app, ceo, mac, bruno, vera, rita, online };
}

const state = async (app: FastifyInstance, token: string, id: string) => (await app.inject({ url: `/api/agents/${id}/events`, ...as(token) })).json().state;
const write = async (app: FastifyInstance, token: string, id: string, text: string) =>
  expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, payload: { text }, ...as(token) })).statusCode).toBeLessThan(300);

async function nextRun(node: FakeNode): Promise<Run> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as Run;
}

describe('a new agent program on a machine short of free memory', () => {
  it('waits, says why, and starts by itself once memory frees up', async () => {
    const { app, ceo, mac, bruno, online } = await planOnOneMachine();
    await online(hello(1.5 * GIB, []));
    await write(app, ceo, bruno.id, 'Start when there is room');
    expect(await state(app, ceo, bruno.id)).toMatchObject({ ready: true, reason: null, queued: 1, memoryWait: true });
    expect(mac.queued()).toBe(0);
    mac.send({ type: 'load', ...load(3 * GIB), live: [] });
    expect((await nextRun(mac)).prompt).toContain('Start when there is room');
    expect((await state(app, ceo, bruno.id)).memoryWait).toBe(false);
  });

  it('does not hold the turn of an agent whose program already runs there', async () => {
    const { app, ceo, mac, bruno, vera, online } = await planOnOneMachine();
    await online(hello(0.5 * GIB, [bruno.id]));
    await write(app, ceo, bruno.id, 'Go on');
    expect((await nextRun(mac)).prompt).toContain('Go on');
    await write(app, ceo, vera.id, 'Wait for room');
    expect(await state(app, ceo, vera.id)).toMatchObject({ queued: 1, memoryWait: true });
    expect(mac.queued()).toBe(0);
  });

  it('counts a program sent to start against the free memory until the node names it', async () => {
    const { app, ceo, mac, bruno, vera, online } = await planOnOneMachine();
    await online(hello(2.5 * GIB, []));
    await write(app, ceo, bruno.id, 'First');
    expect((await nextRun(mac)).prompt).toContain('First');
    await write(app, ceo, vera.id, 'Second');
    expect(await state(app, ceo, vera.id)).toMatchObject({ queued: 1, memoryWait: true });
    expect(mac.queued()).toBe(0);
    mac.send({ type: 'load', ...load(2.5 * GIB), live: [bruno.id] });
    expect((await nextRun(mac)).prompt).toContain('Second');
  });

  it('holds an employee\'s turn into a running program while the machine is overloaded and another turn runs there', async () => {
    const { app, ceo, mac, bruno, vera, online } = await planOnOneMachine();
    await online({ ...hello(8 * GIB, [bruno.id, vera.id]), load: { ...load(8 * GIB), load: 20 } });
    await write(app, ceo, bruno.id, 'The only turn here');
    expect((await nextRun(mac)).prompt).toContain('The only turn here');
    await write(app, ceo, vera.id, 'Wait for the processors');
    expect(await state(app, ceo, vera.id)).toMatchObject({ queued: 1, memoryWait: true });
    expect(mac.queued()).toBe(0);
    mac.send({ type: 'load', ...load(8 * GIB), live: [bruno.id, vera.id] });
    expect((await nextRun(mac)).prompt).toContain('Wait for the processors');
  });

  it('lets a turn whose program runs there, which waited for the processors, go before one that came later, while another program still starts', async () => {
    const { app, ceo, mac, bruno, vera, rita, online } = await planOnOneMachine();
    await online({ ...hello(2.5 * GIB, [bruno.id, vera.id]), load: { ...load(2.5 * GIB), load: 20 } });
    await write(app, ceo, rita.id, 'Start a program');
    expect((await nextRun(mac)).prompt).toContain('Start a program');
    await write(app, ceo, vera.id, 'Waited first');
    expect(await state(app, ceo, vera.id)).toMatchObject({ queued: 1, memoryWait: true });
    mac.send({ type: 'load', ...load(2.5 * GIB), live: [bruno.id, vera.id] });
    await write(app, ceo, bruno.id, 'Came later');
    expect((await nextRun(mac)).prompt).toContain('Waited first');
  });

  it('is not held on a node that does not say which programs run there', async () => {
    const { app, ceo, mac, bruno, online } = await planOnOneMachine();
    await online(hello(0.5 * GIB));
    await write(app, ceo, bruno.id, 'As before');
    expect((await nextRun(mac)).prompt).toContain('As before');
    expect((await state(app, ceo, bruno.id)).memoryWait).toBe(false);
  });
});
