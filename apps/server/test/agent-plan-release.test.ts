import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, people } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

type Seen = { type: string; jobId?: string; agentKey?: string };

const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
const hello = { type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [] };
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const codeOf = (command: string) => command.split('--join ')[1]!;

/* A person's Claude and Codex plans, each with its node on one machine and online, and one employee on the Claude plan. */
async function twoPlans() {
  const { app, db } = await testApp();
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) })).json();
  const plans = connected.subscriptions as { id: string; provider: string }[];
  const claude = plans.find(plan => plan.provider === 'claude')!.id;
  const codex = plans.find(plan => plan.provider === 'codex')!.id;
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...MACHINE } })).json().nodes as { nodeId: string; key: string; subscriptionId?: string; subscription?: string }[];
  const keyOf = (plan: string) => joined.find(node => (node.subscriptionId ?? node.subscription) === plan)!;
  const onA = keyOf(claude);
  const onB = keyOf(codex);
  const a = await connectNode(url, onA.key);
  a.send(hello);
  const b = await connectNode(url, onB.key);
  b.send(hello);
  const [company] = await db.select().from(companies);
  const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [bruno] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: claude }).returning();
  await until(async () => (await app.inject({ url: `/api/agents/${bruno!.id}/events`, ...as(ceo) })).json().state.ready);
  return { app, db, url, ceo, claude, codex, onA, onB, a, b, bruno: bruno!, dev: dev! };
}

const move = (app: FastifyInstance, ceo: string, id: string, subscription: string | null) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload: { subscription }, ...as(ceo) });
const write = (app: FastifyInstance, ceo: string, id: string, text: string) => app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, payload: { text }, ...as(ceo) });

async function nextOf(node: FakeNode, type: string): Promise<Seen> {
  for (;;) {
    const message = await node.next() as Seen;
    if (message.type === type) return message;
  }
}

/* What came to this node by now, of this type. */
async function arrived(node: FakeNode, type: string): Promise<Seen[]> {
  await sleep(150);
  const seen: Seen[] = [];
  while (node.queued()) {
    const message = await node.next() as Seen;
    if (message.type === type) seen.push(message);
  }
  return seen;
}

const started = (node: FakeNode, jobId: string) => node.send({ type: 'job.started', jobId });
const finish = (node: FakeNode, jobId: string) => node.send({ type: 'job.done', jobId, ok: true, sessionId: 's-1', result: 'ok', tail: '', error: null });

async function oneTurn({ app, ceo, bruno, a, db }: Awaited<ReturnType<typeof twoPlans>>): Promise<string> {
  await write(app, ceo, bruno.id, 'Hello');
  const { jobId } = await nextOf(a, 'job.run');
  started(a, jobId!);
  finish(a, jobId!);
  await until(async () => (await db.select().from(jobs).where(eq(jobs.id, jobId!)))[0]?.status === 'done');
  return jobId!;
}

/* One more turn like this one, as if it had run. */
async function pastTurn({ db }: Awaited<ReturnType<typeof twoPlans>>, like: string, more: Partial<typeof jobs.$inferInsert>): Promise<string> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, like));
  const id = randomUUID();
  await db.insert(jobs).values({ ...row!, id, toolTokenHash: null, ...more });
  return id;
}

describe('an agent moved to another plan', () => {
  it('tells the old node to release the program of its last turn', async () => {
    const setup = await twoPlans();
    const last = await oneTurn(setup);
    expect((await move(setup.app, setup.ceo, setup.bruno.id, setup.codex)).statusCode).toBe(200);
    expect(await nextOf(setup.a, 'agent.release')).toEqual({ type: 'agent.release', agentKey: setup.bruno.id, jobId: last });
    expect(await arrived(setup.b, 'agent.release')).toEqual([]);
  });

  it('tells it of a turn that still runs there, which goes on, and the next turn waits for it', async () => {
    const setup = await twoPlans();
    await write(setup.app, setup.ceo, setup.bruno.id, 'Hello');
    const { jobId } = await nextOf(setup.a, 'job.run');
    started(setup.a, jobId!);
    await until(async () => (await setup.db.select().from(jobs).where(eq(jobs.id, jobId!)))[0]?.status === 'running');
    await move(setup.app, setup.ceo, setup.bruno.id, setup.codex);
    expect(await nextOf(setup.a, 'agent.release')).toMatchObject({ jobId });
    await write(setup.app, setup.ceo, setup.bruno.id, 'And then');
    expect(await arrived(setup.b, 'job.run')).toEqual([]);
    finish(setup.a, jobId!);
    const next = await nextOf(setup.b, 'job.run');
    expect(next.jobId).not.toBe(jobId);
    const [row] = await setup.db.select().from(jobs).where(eq(jobs.id, jobId!));
    expect(row).toMatchObject({ status: 'done' });
  });

  it('tells it when the agent goes to no plan at all', async () => {
    const setup = await twoPlans();
    const last = await oneTurn(setup);
    await move(setup.app, setup.ceo, setup.bruno.id, null);
    expect(await nextOf(setup.a, 'agent.release')).toMatchObject({ jobId: last });
  });

  it('tells it when the orchestrator moves to another plan', async () => {
    const setup = await twoPlans();
    const last = await oneTurn(setup);
    const [orchestrator] = await setup.db.update(agents).set({ subscriptionId: setup.claude }).where(eq(agents.kind, 'orchestrator')).returning();
    const his = await pastTurn(setup, last, { agentId: orchestrator!.id, createdAt: new Date(Date.now() + 1000) });
    expect((await setup.app.inject({ method: 'POST', url: `/api/subscriptions/${setup.codex}/orchestrator`, ...as(setup.ceo) })).statusCode).toBe(200);
    expect(await nextOf(setup.a, 'agent.release')).toEqual({ type: 'agent.release', agentKey: orchestrator!.id, jobId: his });
  });

  it('says nothing when the orchestrator is put on the plan he is on', async () => {
    const setup = await twoPlans();
    const last = await oneTurn(setup);
    const [orchestrator] = await setup.db.update(agents).set({ subscriptionId: setup.claude }).where(eq(agents.kind, 'orchestrator')).returning();
    await pastTurn(setup, last, { agentId: orchestrator!.id, createdAt: new Date(Date.now() + 1000) });
    expect((await setup.app.inject({ method: 'POST', url: `/api/subscriptions/${setup.claude}/orchestrator`, ...as(setup.ceo) })).statusCode).toBe(200);
    expect(await arrived(setup.a, 'agent.release')).toEqual([]);
  });

  it('tells it when the owner of its plan no longer reaches the agent', async () => {
    const setup = await twoPlans();
    const last = await oneTurn(setup);
    const maria = await invitePerson(setup.app, setup.ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [setup.dev.id] } });
    const connected = (await setup.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(maria) })).json();
    const plan = connected.subscriptions[0].id as string;
    const joined = (await setup.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...MACHINE, machineId: 'maria-0002-abcd', hostname: 'maria-mac' } })).json().nodes[0] as { nodeId: string; key: string };
    const hers = await connectNode(setup.url, joined.key);
    hers.send(hello);
    await setup.db.update(agents).set({ subscriptionId: plan, nodeId: joined.nodeId }).where(eq(agents.id, setup.bruno.id));
    const onHers = await pastTurn(setup, last, { subscriptionId: plan, nodeId: joined.nodeId, createdAt: new Date(Date.now() + 1000) });
    const [person] = await setup.db.select().from(people).where(eq(people.email, 'maria@acme.com'));
    expect((await setup.app.inject({ method: 'PATCH', url: `/api/people/${person!.id}`, payload: { access: { departments: [] } }, ...as(setup.ceo) })).statusCode).toBe(200);
    expect(await nextOf(hers, 'agent.release')).toEqual({ type: 'agent.release', agentKey: setup.bruno.id, jobId: onHers });
  });

  it('says nothing to a node that ran no turn of it', async () => {
    const setup = await twoPlans();
    await move(setup.app, setup.ceo, setup.bruno.id, setup.codex);
    expect(await arrived(setup.a, 'agent.release')).toEqual([]);
  });

  it('names no turn that never reached the node', async () => {
    const setup = await twoPlans();
    const last = await oneTurn(setup);
    await pastTurn(setup, last, { status: 'failed', startedAt: null, createdAt: new Date(Date.now() + 1000) });
    await move(setup.app, setup.ceo, setup.bruno.id, setup.codex);
    expect(await nextOf(setup.a, 'agent.release')).toMatchObject({ jobId: last });
  });

  it('names a turn the node was sent and has not started', async () => {
    const setup = await twoPlans();
    await write(setup.app, setup.ceo, setup.bruno.id, 'Hello');
    const { jobId } = await nextOf(setup.a, 'job.run');
    await move(setup.app, setup.ceo, setup.bruno.id, setup.codex);
    expect(await nextOf(setup.a, 'agent.release')).toMatchObject({ jobId });
  });

  it('stays quiet for another model on the same plan', async () => {
    const setup = await twoPlans();
    await oneTurn(setup);
    expect((await setup.app.inject({ method: 'PATCH', url: `/api/agents/${setup.bruno.id}`, payload: { model: 'claude-opus-5-5' }, ...as(setup.ceo) })).statusCode).toBe(200);
    expect(await arrived(setup.a, 'agent.release')).toEqual([]);
  });

  it('there and back: the old node hears once, and the next turn comes to it after that', async () => {
    const setup = await twoPlans();
    await oneTurn(setup);
    await move(setup.app, setup.ceo, setup.bruno.id, setup.codex);
    await move(setup.app, setup.ceo, setup.bruno.id, setup.claude);
    await write(setup.app, setup.ceo, setup.bruno.id, 'Back again');
    await nextOf(setup.a, 'agent.release');
    const { jobId } = await nextOf(setup.a, 'job.run');
    expect(jobId).toEqual(expect.any(String));
    expect(await arrived(setup.a, 'agent.release')).toEqual([]);
    expect(await arrived(setup.b, 'agent.release')).toEqual([]);
  });
});

describe('a node that comes back', () => {
  it('hears of what it missed while it was away', async () => {
    const setup = await twoPlans();
    const last = await oneTurn(setup);
    setup.a.close();
    await sleep(50);
    await move(setup.app, setup.ceo, setup.bruno.id, setup.codex);
    const back = await connectNode(setup.url, setup.onA.key);
    back.send(hello);
    expect(await nextOf(back, 'agent.release')).toEqual({ type: 'agent.release', agentKey: setup.bruno.id, jobId: last });
  });

  it('hears nothing of an agent still on its plan, or back on it', async () => {
    const setup = await twoPlans();
    await oneTurn(setup);
    await move(setup.app, setup.ceo, setup.bruno.id, setup.codex);
    await move(setup.app, setup.ceo, setup.bruno.id, setup.claude);
    await nextOf(setup.a, 'agent.release');
    setup.a.close();
    await sleep(50);
    const back = await connectNode(setup.url, setup.onA.key);
    back.send(hello);
    expect(await arrived(back, 'agent.release')).toEqual([]);
  });

  it('hears nothing of a turn that a newer turn elsewhere followed and came back from', async () => {
    const setup = await twoPlans();
    await oneTurn(setup);
    setup.b.send(hello);
    expect(await arrived(setup.b, 'agent.release')).toEqual([]);
  });
});
