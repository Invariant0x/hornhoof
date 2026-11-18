import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments } from '../src/db/schema.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

type Run = { type: 'job.run'; jobId: string; prompt: string };

const GIB = 1024 ** 3;
const MAC = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
const codeOf = (command: string) => command.split('--join ')[1]!;
/* What the node says of its machine: 7 GB of 15 free, and whether its kernel killed a process for want of memory since
   its report before. */
const load = (memoryShort: boolean, memFree = 7 * GIB) => ({ cpus: 10, load: 1, memFree, memTotal: 15 * GIB, tests: 0, jobs: 0, memoryShort });
/* live: the agents whose programs run on the node, as a node that says so names them. */
const hello = (memoryShort: boolean, live?: string[]) => ({ type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [], load: load(memoryShort), ...(live ? { live } : {}) });

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
  const online = async (frame: Parameters<FakeNode['send']>[0]) => {
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

describe('a new agent program on a machine whose kernel killed for want of memory', () => {
  it('waits, says why, and starts by itself with the next report that finds no new kill', async () => {
    const { app, ceo, mac, bruno, online } = await planOnOneMachine();
    await online(hello(true, []));
    await write(app, ceo, bruno.id, 'Start when there is room');
    expect(await state(app, ceo, bruno.id)).toMatchObject({ ready: true, reason: null, queued: 1, memoryWait: true });
    expect(mac.queued()).toBe(0);
    mac.send({ type: 'load', ...load(false), live: [] });
    expect((await nextRun(mac)).prompt).toContain('Start when there is room');
    expect((await state(app, ceo, bruno.id)).memoryWait).toBe(false);
  });

  it('does not hold the turn of an agent whose program already runs there', async () => {
    const { app, ceo, mac, bruno, vera, online } = await planOnOneMachine();
    await online(hello(true, [bruno.id]));
    await write(app, ceo, bruno.id, 'Go on');
    expect((await nextRun(mac)).prompt).toContain('Go on');
    await write(app, ceo, vera.id, 'Wait for room');
    expect(await state(app, ceo, vera.id)).toMatchObject({ queued: 1, memoryWait: true });
    expect(mac.queued()).toBe(0);
  });

  it('lets every new program that waited go with the first report that finds no new kill, not one by one', async () => {
    const { app, ceo, mac, bruno, vera, rita, online } = await planOnOneMachine();
    await online(hello(true, []));
    for (const agent of [bruno, vera, rita]) await write(app, ceo, agent.id, `For ${agent.name}`);
    expect(mac.queued()).toBe(0);
    mac.send({ type: 'load', ...load(false), live: [] });
    const prompts = [(await nextRun(mac)).prompt, (await nextRun(mac)).prompt, (await nextRun(mac)).prompt];
    for (const agent of [bruno, vera, rita]) expect(prompts.some(p => p.includes(`For ${agent.name}`))).toBe(true);
  });

  it('starts new programs on a machine with little free memory and busy processors while its kernel killed nothing', async () => {
    const { app, ceo, mac, bruno, vera, online } = await planOnOneMachine();
    await online({ ...hello(false, [bruno.id]), load: { ...load(false, 0.25 * GIB), load: 40 } });
    await write(app, ceo, bruno.id, 'Busy machine');
    expect((await nextRun(mac)).prompt).toContain('Busy machine');
    await write(app, ceo, vera.id, 'New program');
    expect((await nextRun(mac)).prompt).toContain('New program');
    expect((await state(app, ceo, vera.id)).memoryWait).toBe(false);
  });

  it('is not held on a node that says nothing of kills, as one from before does', async () => {
    const { app, ceo, mac, bruno, online } = await planOnOneMachine();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- a node from before says nothing of kills
    const { memoryShort: _, ...before } = load(false, 0.25 * GIB);
    await online({ ...hello(false, []), load: before });
    await write(app, ceo, bruno.id, 'As before');
    expect((await nextRun(mac)).prompt).toContain('As before');
    expect((await state(app, ceo, bruno.id)).memoryWait).toBe(false);
  });
});
