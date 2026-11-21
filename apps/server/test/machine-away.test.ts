import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents, departments, jobs, machines, nodeConnections, nodes, people, requests, turns, waitNotices } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { serverStarted } from '../src/modules/nodes/connections.js';
import { releaseRound, uncheckedInRelease } from '../src/modules/tasks/releases.js';
import { closeIdleTurns } from '../src/modules/tasks/turn-ends.js';
import { GitHubRateLimited } from '../src/modules/testruns/github-limit.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as } from './helpers.js';

const MINUTE = 60_000;
const DROP = Date.parse('2026-11-06T08:32:00.000Z');
const after = (ms: number) => new Date(DROP + ms);

type Card = {
  id: string;
  hostname: string;
  owner: { id: string; name: string } | null;
  since: string;
  back: string | null;
  agents: number;
  important: { name: string; kind: string }[];
};
type Waiting = { machinesAway?: Card[]; githubLimits?: { repository: string; resetAt: number | null }[]; counts: { total: number; byPerson: Record<string, number> } };

afterEach(() => { vi.useRealTimers(); });
const at = (time: Date) => { vi.useFakeTimers({ toFake: ['Date'], now: time }); };

async function world() {
  at(after(-60 * MINUTE));
  const c = await aclCompany();
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { ...c, orchestrator: orchestrator! };
}

/* A machine of a person, connected since an hour before the drop, with these agents on it. */
async function aMachine(c: AclCompany, owner: string, hostname: string, on: { id: string }[]) {
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: owner, machineKey: `${hostname}-key-12345`, hostname }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, lastSeenAt: after(0) }).returning();
  await c.db.insert(nodeConnections).values({ companyId: c.companyId, machineId: machine!.id, nodeId: node!.id, connectedAt: after(-60 * MINUTE) });
  for (const agent of on) await c.db.update(agents).set({ nodeId: node!.id }).where(eq(agents.id, agent.id));
  return { machine: machine!, node: node! };
}

const standing = (nodeId: string) => and(eq(nodeConnections.nodeId, nodeId), isNull(nodeConnections.disconnectedAt));
const drops = (c: AclCompany, node: { id: string }, time: Date, cause: 'network' | 'server_stopped' = 'network') =>
  c.db.update(nodeConnections).set({ disconnectedAt: time, cause }).where(standing(node.id));
const returns = (c: AclCompany, machine: { id: string }, node: { id: string }, time: Date) =>
  c.db.insert(nodeConnections).values({ companyId: c.companyId, machineId: machine.id, nodeId: node.id, connectedAt: time });

async function waiting(c: AclCompany, token: string): Promise<Waiting> {
  const answer = await c.app.inject({ url: '/api/requests', ...as(token) });
  expect(answer.statusCode).toBe(200);
  return answer.json();
}
const cardsOf = async (c: AclCompany, token: string) => (await waiting(c, token)).machinesAway ?? [];

it('shows a repeated GitHub limit in Failures to the company owner without creating a person wait', async () => {
  const c = await world();
  const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token' };
  const limit = { remaining: 0 as const, resetAt: +after(0) };
  c.app.ctx.githubLimits.refused(repo, limit);
  expect((await waiting(c, c.tokens.ceo)).githubLimits).toEqual([]);
  c.app.ctx.githubLimits.refused(repo, limit);
  const owner = await waiting(c, c.tokens.ceo);
  expect(owner.githubLimits).toEqual([{ repository: 'acme/shop', resetAt: limit.resetAt }]);
  expect(owner.counts.total).toBe(0);
  expect((await waiting(c, c.tokens.bob)).githubLimits).toEqual([]);
});

it('keeps background turn checks quiet on GitHub rate limits and still logs unexpected errors', async () => {
  const c = await world();
  const MAIN = 'a'.repeat(40);
  const AHEAD = 'b'.repeat(40);
  await c.db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git', repoBranch: 'main' }).where(eq(departments.id, c.dev.id));
  const [devTurn] = await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.dev.id, number: 7, goal: 'Ship.', status: 'open', openedAt: after(0), baseVersion: 'v1.0.0', baseCommit: MAIN }).returning();
  const limit = new GitHubRateLimited({ remaining: 0, resetAt: +after(60 * MINUTE) });
  const errors = vi.spyOn(c.app.ctx.log, 'error');
  const limited = {
    ...c.app.ctx,
    readBranches: async () => ({ heads: { main: MAIN, 'turn-7': AHEAD } }),
    readTags: async () => ({ tags: { 'v1.1.0': AHEAD } }),
    readCommit: async (_repo: unknown, ref: { branch: string } | { task: number }) => {
      const branch = 'branch' in ref ? ref.branch : `task-${ref.task}`;
      return { branch, commitSha: branch === 'main' ? MAIN : AHEAD };
    },
    readMerged: async () => { throw limit; },
  };
  await closeIdleTurns(limited);
  await releaseRound(limited);
  expect(await uncheckedInRelease(limited, { companyId: c.companyId, productId: null, departmentId: c.dev.id }, AHEAD)).toBeNull();
  expect(errors).not.toHaveBeenCalled();
  expect((await c.db.select().from(turns).where(eq(turns.id, devTurn!.id)))[0]).toMatchObject({ status: 'open' });

  await releaseRound({ ...limited, readTags: async () => { throw new Error('tags failed'); } });
  expect(errors).toHaveBeenCalledTimes(1);

  await c.db.insert(turns).values({ companyId: c.companyId, departmentId: c.sales.id, number: 8, goal: 'Close.', status: 'open', openedAt: after(0) });
  vi.spyOn(c.app.ctx.bus, 'publish').mockImplementationOnce(() => { throw new Error('bus failed'); });
  await closeIdleTurns(limited);
  expect(errors).toHaveBeenCalledTimes(2);

  const failingDb = { select: () => { throw new Error('db failed'); } } as unknown as typeof c.db;
  await expect(uncheckedInRelease({ ...limited, db: failingDb }, { companyId: c.companyId, productId: null, departmentId: c.dev.id }, AHEAD)).rejects.toThrow('db failed');
});

describe('a machine with agents that has gone away', () => {
  it('shows nothing at 4:59, and at 5:00 one card to its owner and to the CEO, with no agent asked', async () => {
    const c = await world();
    const { machine, node } = await aMachine(c, c.ids.bob, 'Air', [c.orchestrator, c.crew.head, c.crew.other]);
    await drops(c, node, after(0));
    const before = { jobs: (await c.db.select().from(jobs)).length, notices: (await c.db.select().from(waitNotices)).length };

    at(after(4 * MINUTE + 59_000));
    await minuteRound(c.app.ctx, new Date(), () => () => {});
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([]);
    expect(await cardsOf(c, c.tokens.bob)).toEqual([]);

    at(after(5 * MINUTE));
    await minuteRound(c.app.ctx, new Date(), () => () => {});
    const card = {
      id: machine.id,
      hostname: 'Air',
      owner: { id: c.ids.bob, name: 'Bob' },
      since: after(0).toISOString(),
      back: null,
      agents: 3,
      important: [{ name: c.orchestrator.name, kind: 'orchestrator' }, { name: 'Hana', kind: 'head' }],
    };
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([card]);
    expect(await cardsOf(c, c.tokens.bob)).toEqual([card]);

    expect(await c.db.select().from(requests)).toEqual([]);
    expect((await c.db.select().from(jobs)).length).toBe(before.jobs);
    expect((await c.db.select().from(waitNotices)).length).toBe(before.notices);
  });

  it('shows a machine failure to its people without counting it as a person wait', async () => {
    const c = await world();
    const { node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0));
    at(after(5 * MINUTE));
    for (const token of [c.tokens.ceo, c.tokens.bob]) {
      const view = await waiting(c, token);
      expect(view.machinesAway).toMatchObject([{ hostname: 'Air', back: null }]);
      expect(view.counts).toMatchObject({ total: 0, byPerson: {} });
      expect(view.counts.byPerson[c.ids.bob]).toBeUndefined();
      expect(view.counts.byPerson[c.ids.ceo]).toBeUndefined();
    }
    for (const token of [c.tokens.wes, c.tokens.clara, c.tokens.ann, c.tokens.olga]) {
      expect(await cardsOf(c, token)).toEqual([]);
      expect((await waiting(c, token)).counts.total).toBe(0);
    }
  });

  it('has one person when the owner is the CEO', async () => {
    const c = await world();
    const { node } = await aMachine(c, c.ids.ceo, 'Studio', [c.crew.other]);
    await drops(c, node, after(0));
    at(after(5 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toHaveLength(1);
  });

  it('goes to the CEO with no owner named when its owner has left', async () => {
    const c = await world();
    const { node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0));
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, c.ids.bob));
    at(after(5 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toMatchObject([{ hostname: 'Air', owner: null }]);
  });

  it('stays one card through more rounds and a restart of the server', async () => {
    const c = await world();
    const { node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0));
    for (const minute of [5, 6, 7]) {
      at(after(minute * MINUTE));
      await minuteRound(c.app.ctx, new Date(), () => () => {});
    }
    await serverStarted(c.db);
    c.app.ctx.startedAt = new Date();
    expect(await cardsOf(c, c.tokens.ceo)).toMatchObject([{ since: after(0).toISOString() }]);
  });

  it('gives each of two machines its own card', async () => {
    const c = await world();
    const air = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    const pro = await aMachine(c, c.ids.ann, 'Pro', [c.crew.mine]);
    await drops(c, air.node, after(0));
    await drops(c, pro.node, after(MINUTE));
    at(after(6 * MINUTE));
    expect((await cardsOf(c, c.tokens.ceo)).map(card => card.hostname)).toEqual(['Air', 'Pro']);
    expect((await cardsOf(c, c.tokens.bob)).map(card => card.hostname)).toEqual(['Air']);
    expect((await cardsOf(c, c.tokens.ann)).map(card => card.hostname)).toEqual(['Pro']);
  });

  it('closes by itself when the machine is back, with when, and a new drop is a new card', async () => {
    const c = await world();
    const { machine, node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0));
    at(after(30 * MINUTE));
    expect((await cardsOf(c, c.tokens.ceo)).filter(card => !card.back)).toHaveLength(1);

    await returns(c, machine, node, after(30 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toMatchObject([{ since: after(0).toISOString(), back: after(30 * MINUTE).toISOString() }]);
    expect((await waiting(c, c.tokens.ceo)).counts.total).toBe(0);

    await drops(c, node, after(40 * MINUTE));
    at(after(45 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toMatchObject([{ since: after(40 * MINUTE).toISOString(), back: null }]);
    expect((await cardsOf(c, c.tokens.ceo)).filter(card => !card.back)).toHaveLength(1);
  });

  it('forgets the line about its return after a day', async () => {
    const c = await world();
    const { machine, node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0));
    await returns(c, machine, node, after(30 * MINUTE));
    at(after(30 * MINUTE + 24 * 60 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([]);
  });

  it('leaves out a blink, however it ends', async () => {
    const c = await world();
    const { machine, node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0));
    await returns(c, machine, node, after(4 * MINUTE));
    at(after(20 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([]);
  });

  it('sees a machine as back while any one of its nodes is connected', async () => {
    const c = await world();
    const { machine, node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    const [second] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine.id, subscriptionId: c.plans.bob.id }).returning();
    await c.db.insert(nodeConnections).values({ companyId: c.companyId, machineId: machine.id, nodeId: second!.id, connectedAt: after(-MINUTE) });
    await drops(c, node, after(0));
    at(after(20 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([]);
  });

  it('asks nothing of a machine with no agents, or one taken away', async () => {
    const c = await world();
    const empty = await aMachine(c, c.ids.bob, 'Spare', []);
    const gone = await aMachine(c, c.ids.bob, 'Old', [c.crew.other]);
    await drops(c, empty.node, after(0));
    await drops(c, gone.node, after(0));
    await c.db.update(machines).set({ revokedAt: after(MINUTE) }).where(eq(machines.id, gone.machine.id));
    at(after(20 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([]);
  });

  it('counts no switched off agent', async () => {
    const c = await world();
    const { node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await c.db.update(agents).set({ switchedOffAt: after(-MINUTE) }).where(eq(agents.id, c.crew.other.id));
    await drops(c, node, after(0));
    at(after(20 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([]);
  });

  it("counts no assistant's own agent: it is its owner's, and no work of the company", async () => {
    const c = await world();
    const own = async (name: string) => (await c.db.insert(agents).values({ companyId: c.companyId, kind: 'assistant', model: '', name }).returning())[0]!;
    const alone = await aMachine(c, c.ids.bob, 'Spare', [await own('Ava')]);
    const shared = await aMachine(c, c.ids.bob, 'Air', [c.crew.other, await own('Max')]);
    await drops(c, alone.node, after(0));
    await drops(c, shared.node, after(0));
    at(after(20 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toMatchObject([{ hostname: 'Air', agents: 1 }]);
  });

  it('counts from when it was last heard of once its history has aged away', async () => {
    const c = await world();
    const { node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await c.db.delete(nodeConnections).where(eq(nodeConnections.nodeId, node.id));
    at(after(5 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toMatchObject([{ since: after(0).toISOString() }]);
  });

  it('does not blame a machine for the time the server itself was off', async () => {
    const c = await world();
    const { machine, node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0), 'server_stopped');
    at(after(30 * MINUTE));
    c.app.ctx.startedAt = new Date();
    expect(await cardsOf(c, c.tokens.ceo)).toEqual([]);

    at(after(35 * MINUTE));
    expect(await cardsOf(c, c.tokens.ceo)).toMatchObject([{ since: after(30 * MINUTE).toISOString(), back: null }]);

    await returns(c, machine, node, after(36 * MINUTE));
    at(after(37 * MINUTE));
    expect((await waiting(c, c.tokens.ceo)).counts.total).toBe(0);
  });

  it('tells screens once when a card comes and once when it closes, whatever the screen may see', async () => {
    const c = await world();
    const { machine, node } = await aMachine(c, c.ids.bob, 'Air', [c.crew.other]);
    await drops(c, node, after(0));
    const told = vi.spyOn(c.app.ctx.bus, 'publish');
    const nudges = () => told.mock.calls.filter(([, message]) => message.type === 'requests' && !('spot' in message)).length;
    const round = async (time: Date) => { at(time); await minuteRound(c.app.ctx, time, () => () => {}); };
    await round(after(4 * MINUTE));
    expect(nudges()).toBe(0);
    await round(after(5 * MINUTE));
    await round(after(6 * MINUTE));
    expect(nudges()).toBe(1);
    await returns(c, machine, node, after(7 * MINUTE));
    await round(after(7 * MINUTE));
    await round(after(8 * MINUTE));
    expect(nudges()).toBe(2);
  });
});
