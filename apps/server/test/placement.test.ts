import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments } from '../src/db/schema.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

type Run = { type: 'job.run'; jobId: string; prompt: string; sessionId: string | null };

const MAC = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
const LAPTOP = { ...MAC, machineId: 'laptop-0002-abcd', hostname: 'ivan-laptop' };
const codeOf = (command: string) => command.split('--join ')[1]!;
const hello = { type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [] };

/* Ivan's Claude plan on his Mac and on his laptop, each node online and signed in, and two employees on the plan. */
async function planOnTwoMachines() {
  const { app, db } = await testApp();
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
