import type { DiskReport } from '@hornhoof/protocol';
import type { FastifyInstance } from 'fastify';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';
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
});
