import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments, machines } from '../src/db/schema.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

/* A phone that is a machine of the company: a node in its terminal app runs agent programs for the plan, a few at a time, and
   holds new ones while the phone needs its memory for itself. */

type Run = { type: 'job.run'; jobId: string; prompt: string };

const GIB = 1024 ** 3;
const PHONE = { machineId: 'phone-0001-abcd', hostname: 'phone', os: 'linux', arch: 'arm64', kind: 'phone' };
const codeOf = (command: string) => command.split('--join ')[1]!;
/* What the phone's node says of it: 3 GB of memory, of it free what the test says. */
const load = (memFree = 2 * GIB) => ({ cpus: 8, load: 1, memFree, memTotal: 3 * GIB, tests: 0, jobs: 0 });
const hello = (live: string[]) => ({ type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [], load: load(), live });

/* The CEO's Claude plan on a phone, and three employees on the plan. */
async function planOnPhone() {
  const { app, db } = await testApp();
  onTestFinished(() => app.close());
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
  const plan = connected.subscriptions[0].id as string;
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...PHONE } })).json();
  const phone = await connectNode(url, joined.nodes[0].key as string);
  const [acme] = await db.select().from(companies);
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string) => (await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: plan }).returning())[0]!;
  const bruno = await hire('Bruno');
  const vera = await hire('Vera');
  const rita = await hire('Rita');
  const online = async (live: string[]) => {
    phone.send(hello(live));
    await until(async () => (await state(app, ceo, bruno.id)).ready);
  };
  const [machine] = await db.select().from(machines).where(eq(machines.machineKey, PHONE.machineId));
  return { app, db, ceo, phone, machine: machine!, bruno, vera, rita, online };
}

const state = async (app: FastifyInstance, token: string, id: string) => (await app.inject({ url: `/api/agents/${id}/events`, ...as(token) })).json().state;
const write = async (app: FastifyInstance, token: string, id: string, text: string) =>
  expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, payload: { text }, ...as(token) })).statusCode).toBeLessThan(300);

async function nextRun(node: FakeNode): Promise<Run> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as Run;
}

const done = (node: FakeNode, jobId: string) => node.send({ type: 'job.done', jobId, ok: true, sessionId: 's-1', result: 'ok', tail: '', error: null });

describe('a phone that is a machine of the company', () => {
  it('runs one agent program at a time, and starts the next one once the first is gone', async () => {
    const { app, ceo, phone, bruno, vera, online } = await planOnPhone();
    await online([]);
    await write(app, ceo, bruno.id, 'First');
    expect((await nextRun(phone)).prompt).toContain('First');
    phone.send({ type: 'load', ...load(), live: [bruno.id] });
    await write(app, ceo, vera.id, 'Second');
    expect(await state(app, ceo, vera.id)).toMatchObject({ ready: true, queued: 1, roomWait: 'sessions' });
    expect(phone.queued()).toBe(0);
    phone.send({ type: 'load', ...load(), live: [] });
    expect((await nextRun(phone)).prompt).toContain('Second');
    expect((await state(app, ceo, vera.id)).roomWait).toBeNull();
  });

  it('runs two at a time when its owner allows two, and never more than two', async () => {
    const { app, ceo, phone, machine, bruno, vera, rita, online } = await planOnPhone();
    expect((await app.inject({ method: 'PATCH', url: `/api/machines/${machine.id}`, payload: { sessions: 3 }, ...as(ceo) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/machines/${machine.id}`, payload: { sessions: 2 }, ...as(ceo) })).statusCode).toBe(200);
    await online([bruno.id]);
    await write(app, ceo, vera.id, 'Second');
    expect((await nextRun(phone)).prompt).toContain('Second');
    phone.send({ type: 'load', ...load(), live: [bruno.id, vera.id] });
    await write(app, ceo, rita.id, 'Third');
    expect(await state(app, ceo, rita.id)).toMatchObject({ queued: 1, roomWait: 'sessions' });
    expect(phone.queued()).toBe(0);
  });

  /* A program stays on the phone after its turn, so it holds the room until the phone closes it. It is closed only once its
     turn is over, and only when a turn of another agent waits for the room. */
  it("closes another agent's program once its turn is over, when a turn waits for its room", async () => {
    const { app, ceo, phone, bruno, vera, online } = await planOnPhone();
    await online([]);
    await write(app, ceo, bruno.id, 'First');
    const first = await nextRun(phone);
    phone.send({ type: 'job.started', jobId: first.jobId });
    phone.send({ type: 'load', ...load(), live: [bruno.id] });
    await write(app, ceo, vera.id, 'Second');
    expect(await state(app, ceo, vera.id)).toMatchObject({ queued: 1, roomWait: 'sessions' });
    expect(phone.queued()).toBe(0);
    done(phone, first.jobId);
    expect(await phone.next()).toEqual({ type: 'agent.release', agentKey: bruno.id, jobId: first.jobId });
    phone.send({ type: 'load', ...load(), live: [] });
    expect((await nextRun(phone)).prompt).toContain('Second');
  });

  it('closes the program of an agent whose turn is over when a turn comes for the full phone', async () => {
    const { app, ceo, phone, bruno, vera, online } = await planOnPhone();
    await online([]);
    await write(app, ceo, bruno.id, 'First');
    const first = await nextRun(phone);
    phone.send({ type: 'job.started', jobId: first.jobId });
    phone.send({ type: 'load', ...load(), live: [bruno.id] });
    done(phone, first.jobId);
    await until(async () => !(await state(app, ceo, bruno.id)).busy);
    await write(app, ceo, vera.id, 'Second');
    expect(await phone.next()).toEqual({ type: 'agent.release', agentKey: bruno.id, jobId: first.jobId });
    phone.send({ type: 'load', ...load(), live: [] });
    expect((await nextRun(phone)).prompt).toContain('Second');
  });

  it('closes no program while no turn waits for its room', async () => {
    const { app, ceo, phone, bruno, online } = await planOnPhone();
    await online([]);
    await write(app, ceo, bruno.id, 'First');
    const first = await nextRun(phone);
    phone.send({ type: 'job.started', jobId: first.jobId });
    phone.send({ type: 'load', ...load(), live: [bruno.id] });
    done(phone, first.jobId);
    await until(async () => !(await state(app, ceo, bruno.id)).busy);
    expect(phone.queued()).toBe(0);
  });

  it('takes a limit of programs only for a phone: a computer runs as many as its memory takes', async () => {
    const { app, db, ceo, machine } = await planOnPhone();
    const [computer] = await db.insert(machines).values({ companyId: machine.companyId, personId: machine.personId, machineKey: 'computer-0001-abcd', hostname: 'desk', os: 'linux', arch: 'x86_64' }).returning();
    expect((await app.inject({ method: 'PATCH', url: `/api/machines/${computer!.id}`, payload: { sessions: 1 }, ...as(ceo) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/machines/${machine.id}`, payload: { sessions: 1 }, ...as(ceo) })).json()).toMatchObject({ sessions: 1 });
  });

  it('lets a turn of a program that runs there go on, at its limit too', async () => {
    const { app, ceo, phone, bruno, online } = await planOnPhone();
    await online([bruno.id]);
    await write(app, ceo, bruno.id, 'Go on');
    expect((await nextRun(phone)).prompt).toContain('Go on');
  });
});
