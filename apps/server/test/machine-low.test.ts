import type { DiskReport } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments, jobs, subscriptions, tasks } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, listen, nextOf, setUpCompany, testApp, until, type FakeNode } from './helpers.js';
import { invitePerson } from './helpers-company.js';

/* No ping comes in a test, so no node is dropped for a pong that came late on a busy machine. */
const NODE_PING_MS = '2147483647';
const GB = 1e9;
const LOW_SINCE = '2026-11-20T10:00:00.000Z';
/* A made-up machine's disk: 40 GB free of 500, under the 50 GB it needs for heavy work after cleaning 8 GB itself. */
const DISK: DiskReport = {
  total: 500 * GB,
  free: 40 * GB,
  parts: { images: 60 * GB, volumes: 30 * GB, buildCache: 20 * GB, workingCopies: 12 * GB, recordings: 2 * GB, checkTemp: 5 * GB },
  threshold: 50 * GB,
  low: { since: LOW_SINCE },
  cleaned: [{ part: 'checkTemp', bytes: 8 * GB, at: '2026-11-20T09:59:00.000Z' }],
};
const ROOMY: DiskReport = { ...DISK, free: 120 * GB, low: null };
const load = (disk?: DiskReport) => ({ type: 'load' as const, cpus: 8, load: 1, memFree: 8 * GB, memTotal: 16 * GB, tests: 0, jobs: 0, ...(disk ? { disk } : {}) });

type Card = { id: string; hostname: string | null; owner: { id: string; name: string } | null; since: string; disk: DiskReport; names: Record<string, string> };

/* Bob's machine worker-1, joined with his own plan and connected, and Carol, who sees one department only. */
async function bobsMachine() {
  const { app, db } = await testApp({ NODE_PING_MS });
  onTestFinished(() => app.close());
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const bob = await invitePerson(app, ceo, { name: 'Bob', email: 'bob@example.com', access: { whole: true } });
  const [acme] = await db.select().from(companies);
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const carol = await invitePerson(app, ceo, { name: 'Carol', email: 'carol@example.com', access: { departments: [sales!.id] } });
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(bob) })).json();
  const code = (connected.command as string).split('--join ')[1];
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'linux-0001-abcd', hostname: 'worker-1', os: 'linux', arch: 'x86_64' } })).json();
  const node = await connectNode(url, joined.nodes[0].key as string);
  node.send({ type: 'hello', version: '0.41.0', loggedIn: true, running: [], load: load(ROOMY) });
  const me = (await app.inject({ url: '/api/me', ...as(bob) })).json();
  return { app, db, ceo, bob, carol, node, machine: joined.machine.id as string, bobId: (me.person?.id ?? me.id) as string };
}

/* Bob's machine worker-2 with his Claude and Codex plans, each with its node connected and saying nothing of its disk yet. */
async function twoPlans() {
  const { app } = await testApp({ NODE_PING_MS });
  onTestFinished(() => app.close());
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) })).json();
  const plans = connected.subscriptions as { id: string; provider: string }[];
  const code = (connected.command as string).split('--join ')[1];
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'linux-0002-abcd', hostname: 'worker-2', os: 'linux', arch: 'x86_64' } })).json();
  const nodes = joined.nodes as { key: string; subscriptionId?: string; subscription?: string }[];
  const plug = async (provider: string) => {
    const plan = plans.find(p => p.provider === provider)!.id;
    const node = await connectNode(url, nodes.find(n => (n.subscriptionId ?? n.subscription) === plan)!.key);
    node.send({ type: 'hello', version: '0.41.0', loggedIn: true, running: [], load: load() });
    return { plan, node };
  };
  return { app, ceo, claude: await plug('claude'), codex: await plug('codex') };
}

const cardsOf = async (app: FastifyInstance, token: string): Promise<Card[]> => {
  const answer = await app.inject({ url: '/api/requests', ...as(token) });
  expect(answer.statusCode).toBe(200);
  return answer.json().machinesLow ?? [];
};
const diskOn = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json().machines[0]?.load?.disk;
const says = async (app: FastifyInstance, token: string, node: FakeNode, disk: DiskReport) => {
  node.send(load(disk));
  /* The server says it back in the schema's own order of keys, so the two are compared as values. */
  await until(async () => isDeepStrictEqual(await diskOn(app, token), disk));
};

describe("a machine's disk", () => {
  it('shows on its card as its node says it: the total, the free space and Hornhoof’s share by part', async () => {
    const { app, ceo, bob, node } = await bobsMachine();
    await says(app, ceo, node, ROOMY);
    expect(await diskOn(app, ceo)).toEqual(ROOMY);
    expect(await diskOn(app, bob)).toEqual(ROOMY);
  });

  it("adds up what each node measures in its own folder, and names each node's working folders by its plan, the biggest first", async () => {
    const { app, ceo, claude, codex } = await twoPlans();
    const own = { workingCopies: 12 * GB, recordings: 2 * GB, checkTemp: 5 * GB };
    claude.node.send({ ...load({ ...ROOMY, parts: { images: 60 * GB, volumes: 50 * GB, ...own } }), tests: 1 });
    codex.node.send({ ...load({ ...ROOMY, parts: { images: 60 * GB, volumes: 50 * GB, workingCopies: 20 * GB, checkTemp: GB }, cleaned: [] }), tests: 2 });
    /* Both nodes' words are in once the machine counts the tests of both. */
    const machine = async () => (await app.inject({ url: '/api/machines', ...as(ceo) })).json().machines[0];
    await until(async () => (await machine())?.load?.tests === 3);
    const shown = await machine();
    expect(shown.load.disk.parts).toEqual({ images: 60 * GB, volumes: 50 * GB, workingCopies: 32 * GB, recordings: 2 * GB, checkTemp: 6 * GB });
    expect(shown.folders).toEqual([{ plan: codex.plan, bytes: 20 * GB }, { plan: claude.plan, bytes: 12 * GB }]);
  });

  it('shows nothing of the disk of a node too old to say it', async () => {
    const { app, ceo, node } = await bobsMachine();
    node.send(load());
    await until(async () => (await diskOn(app, ceo)) === undefined);
    expect(await cardsOf(app, ceo)).toEqual([]);
  });
});

describe('the card of a machine short of disk space', () => {
  it('comes to its owner and the CEO while the node is low, with the numbers, and to nobody else', async () => {
    const { app, ceo, bob, carol, node, machine, bobId } = await bobsMachine();
    await says(app, ceo, node, ROOMY);
    expect(await cardsOf(app, ceo)).toEqual([]);

    await says(app, ceo, node, DISK);
    const card: Card = { id: machine, hostname: 'worker-1', owner: { id: bobId, name: 'Bob' }, since: LOW_SINCE, disk: DISK, names: {} };
    expect(await cardsOf(app, ceo)).toEqual([card]);
    expect(await cardsOf(app, bob)).toEqual([card]);
    expect(await cardsOf(app, carol)).toEqual([]);
  });

  it("names the company's employees whose work the node keeps, and no one it does not know", async () => {
    const { app, db, ceo, node } = await bobsMachine();
    const [employee] = await db.select({ id: agents.id, name: agents.name }).from(agents).limit(1);
    const elsewhere = '00000000-0000-4000-8000-000000000001';
    const kept: NonNullable<DiskReport['kept']> = [
      { part: 'workingCopies', agent: employee!.id, path: 'hornhoof', task: 12, bytes: 9 * GB, why: 'uncommitted' },
      { part: 'workingCopies', agent: elsewhere, path: 'copy', task: null, bytes: 2 * GB, why: 'unpushed' },
      { part: 'workingCopies', agent: 'not-an-id', path: 'scratch', task: null, bytes: GB, why: 'unpushed' },
    ];
    await says(app, ceo, node, { ...DISK, kept });
    const [card] = await cardsOf(app, ceo);
    expect(card!.disk.kept).toEqual(kept);
    expect(card!.names).toEqual({ [employee!.id]: employee!.name });
  });

  it('keeps ignored-file paths on a kept copy from the node load through to the low-space card', async () => {
    const { app, db, ceo, node } = await bobsMachine();
    const [employee] = await db.select({ id: agents.id, name: agents.name }).from(agents).limit(1);
    const kept: NonNullable<DiskReport['kept']> = [
      { part: 'workingCopies', agent: employee!.id, path: 'shop-7', task: 7, bytes: GB, why: 'ignored', ignored: ['.env', 'local/'] },
    ];
    node.send({ ...load({ ...DISK, kept }), tests: 1 });
    const machine = async () => (await app.inject({ url: '/api/machines', ...as(ceo) })).json().machines[0];
    await until(async () => (await machine())?.load?.tests === 1);
    const [card] = await cardsOf(app, ceo);
    expect(card?.disk.kept).toEqual(kept);
    expect(card?.names).toEqual({ [employee!.id]: employee!.name });
  });

  it('goes away by itself once the node has room again, or is off the line', async () => {
    const { app, ceo, node } = await bobsMachine();
    await says(app, ceo, node, DISK);
    expect(await cardsOf(app, ceo)).toHaveLength(1);
    await says(app, ceo, node, ROOMY);
    expect(await cardsOf(app, ceo)).toEqual([]);

    await says(app, ceo, node, DISK);
    node.close();
    await until(async () => (await cardsOf(app, ceo)).length === 0);
  });

  it('tells screens once when a card comes and once when it goes', async () => {
    const { app, ceo, node } = await bobsMachine();
    const told = vi.spyOn(app.ctx.bus, 'publish');
    const nudges = () => told.mock.calls.filter(([, message]) => message.type === 'requests' && 'machines' in message).length;
    const round = () => minuteRound(app.ctx, new Date(), () => () => {});
    await says(app, ceo, node, ROOMY);
    await round();
    expect(nudges()).toBe(0);
    await says(app, ceo, node, DISK);
    await round();
    await round();
    expect(nudges()).toBe(1);
    await says(app, ceo, node, ROOMY);
    await round();
    await round();
    expect(nudges()).toBe(2);
  });

  it('signals an Operations employee once per low spell when unowned space holds the threshold, falls back to the Program operator, and never asks a person to run commands', async () => {
    const NODE_KEY = 'k'.repeat(40);
    const { app, db } = await testApp({ NODE_PING_MS, NODE_KEY });
    onTestFinished(() => app.close());
    const url = await listen(app);
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const companyId = acme!.id;
    const [sub] = await db.select().from(subscriptions);
    const builtin = await connectNode(url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.43.0', loggedIn: true, running: [], load: load(ROOMY) });
    await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');

    const [ops] = await db.insert(departments).values({ companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [rob] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Rob', roleKey: 'OPS-FIX', departmentId: ops!.id, model: '', subscriptionId: sub!.id }).returning();
    const [pia] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Pia', roleKey: 'OPS-PROGRAM', departmentId: ops!.id, model: '', subscriptionId: sub!.id }).returning();

    /* Synthetic 126 GB data disk held under 20 GB by 66.1 GB of volumes and foreign space, cleaned list empty. */
    const gbBytes = (n: number) => Math.round(n * GB);
    const foreignLow: DiskReport = {
      total: gbBytes(126),
      free: gbBytes(18.4),
      threshold: gbBytes(20),
      parts: { volumes: gbBytes(66.1), containers: gbBytes(10.9), images: gbBytes(8.1), buildCache: gbBytes(0.8), workingCopies: gbBytes(1) },
      low: { since: '2026-11-24T10:14:00.000Z' },
      cleaned: [],
    };

    const round = () =>
      minuteRound(app.ctx, new Date('2026-11-24T10:15:00.000Z'), what => err => {
        throw err instanceof Error ? err : new Error(`${what}: ${String(err)}`);
      });
    builtin.send({ ...load(foreignLow), tests: 1 });
    await until(async () => (await app.inject({ url: '/api/machines', ...as(ceo) })).json().builtin?.load?.tests === 1);
    await round();
    await round();

    const robTurns = await db.select().from(jobs).where(eq(jobs.agentId, rob!.id)).orderBy(asc(jobs.createdAt));
    expect(robTurns).toHaveLength(1);
    expect(robTurns[0]!.prompt).toMatch(/18\.4 GB/);
    expect(robTurns[0]!.prompt).toMatch(/20 GB/);
    expect(robTurns[0]!.prompt).not.toMatch(/ask.*person.*command/i);

    /* When Rob (OPS-FIX) is switched off and a new low spell starts after recovery, Pia (OPS-PROGRAM) receives the signal. */
    builtin.send({ ...load(ROOMY), tests: 2 });
    await until(async () => (await app.inject({ url: '/api/machines', ...as(ceo) })).json().builtin?.load?.tests === 2);
    await round();

    await db.update(agents).set({ switchedOffAt: new Date('2026-11-24T10:20:00.000Z') }).where(eq(agents.id, rob!.id));
    builtin.send({ ...load({ ...foreignLow, low: { since: '2026-11-24T10:25:00.000Z' } }), tests: 3 });
    await until(async () => (await app.inject({ url: '/api/machines', ...as(ceo) })).json().builtin?.load?.tests === 3);
    await round();

    const piaTurns = await db.select().from(jobs).where(eq(jobs.agentId, pia!.id)).orderBy(asc(jobs.createdAt));
    expect(piaTurns).toHaveLength(1);
  });

  it('answers tasks.read on a node socket with open, paused, and blocked task numbers, and resolves largest working copies on /api/machines', async () => {
    const { app, db, ceo, node } = await bobsMachine();
    const [acme] = await db.select().from(companies);
    await until(async () => (await db.select().from(subscriptions))[0]?.status === 'ready');
    const [sub] = await db.select().from(subscriptions);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [hana] = await db.insert(agents).values({ companyId: acme!.id, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning();

    const tOpen = (await createTask(app.ctx, { agentId: hana!.id }, { title: 'Open task', brief: '', body: 'b', departmentId: dev!.id, assigneeAgentId: hana!.id, executor: true, resultKind: 'code' })).task;
    const tPaused = (await createTask(app.ctx, { agentId: hana!.id }, { title: 'Paused task', brief: '', body: 'b', departmentId: dev!.id, assigneeAgentId: hana!.id, executor: true, resultKind: 'code' })).task;
    await db.update(tasks).set({ paused: { at: '2026-11-24T10:00:00.000Z', reason: 'hold', by: { agentId: hana!.id }, root: tPaused.id } }).where(eq(tasks.id, tPaused.id));
    const tBlocked = (await createTask(app.ctx, { agentId: hana!.id }, { title: 'Blocked task', brief: '', body: 'b', departmentId: dev!.id, assigneeAgentId: hana!.id, executor: true, resultKind: 'code' })).task;
    await db.update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, tBlocked.id));
    const tDone = (await createTask(app.ctx, { agentId: hana!.id }, { title: 'Done task', brief: '', body: 'b', departmentId: dev!.id, assigneeAgentId: hana!.id, executor: true, resultKind: 'code' })).task;
    await db.update(tasks).set({ status: 'done', closedAt: new Date('2026-11-24T10:05:00.000Z') }).where(eq(tasks.id, tDone.id));
    const tCancelled = (await createTask(app.ctx, { agentId: hana!.id }, { title: 'Cancelled task', brief: '', body: 'b', departmentId: dev!.id, assigneeAgentId: hana!.id, executor: true, resultKind: 'code' })).task;
    await db.update(tasks).set({ status: 'cancelled', closedAt: new Date('2026-11-24T10:06:00.000Z') }).where(eq(tasks.id, tCancelled.id));

    node.send({ type: 'tasks.read' } as unknown as Parameters<FakeNode['send']>[0]);
    const reply = await nextOf(node, 'tasks.open' as Parameters<typeof nextOf>[1]) as unknown as { type: 'tasks.open'; tasks: { open: number[]; upTo: number } | null };
    expect(reply.tasks?.open).toEqual(expect.arrayContaining([tOpen.number, tPaused.number, tBlocked.number]));
    expect(reply.tasks?.open).not.toContain(tDone.number);
    expect(reply.tasks?.open).not.toContain(tCancelled.number);
    expect(reply.tasks?.upTo).toBeGreaterThanOrEqual(tCancelled.number);

    const withCopies = {
      ...ROOMY,
      copies: [{ agent: hana!.id, path: `shop-${tOpen.number}`, task: tOpen.number, bytes: 8 * GB }],
    } as DiskReport;
    node.send({ ...load(withCopies), tests: 4 });
    await until(async () => (await app.inject({ url: '/api/machines', ...as(ceo) })).json().machines[0]?.load?.tests === 4);
    const machine = (await app.inject({ url: '/api/machines', ...as(ceo) })).json().machines[0];
    expect(machine.load.disk.copies).toEqual([{ agent: hana!.id, path: `shop-${tOpen.number}`, task: tOpen.number, bytes: 8 * GB }]);
    expect(machine.copyNames).toEqual({ [hana!.id]: 'Hana' });
  });
});
