import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { WebSocket } from 'ws';
import { agents, machines, nodes, subscriptions } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

/* When the machine an employee's plan runs on is offline, its card and the card of its task say which machine and since when.
   Who runs the department moves the employee to another plan of the department in one step; nothing outside it. */

type C = Awaited<ReturnType<typeof company>>;
const send = (c: C, token: string, method: 'GET' | 'PATCH', url: string, payload?: object) => c.app.inject({ method, url, ...(payload ? { payload } : {}), ...as(token) });
const SEEN = new Date('2026-11-13T18:07:00.000Z');

async function plan(c: C, label: string, ownerPersonId: string) {
  const [row] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'claude', kind: 'personal', label, status: 'ready', ownerPersonId }).returning();
  return row!;
}

/* A plan's machine as a node row; it counts as online only while a socket of it is attached. */
async function machineOf(c: C, sub: { id: string; ownerPersonId: string }, hostname: string, lastSeenAt: Date | null) {
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: sub.ownerPersonId, machineKey: hostname.toLowerCase(), hostname }).returning();
  const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: sub.id, status: 'ready', version: '0.23.5', keyHash: `hash-${hostname}`, lastSeenAt }).returning();
  return node!;
}

function connect(c: C, nodeId: string): void {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    close() { socket.readyState = 3; socket.emit('close', 1000); },
    ping() { socket.emit('pong'); },
    terminate() { socket.readyState = 3; socket.emit('close', 1006); },
  });
  c.app.ctx.hub.attach(nodeIdentity(nodeId), socket as unknown as WebSocket);
  onTestFinished(() => socket.close());
}

/* Bruno of Development works on Dana's plan, whose only machine Marselle last spoke at 18:07; her second plan runs on a
   machine online now, and Sam's plan serves Sales only. */
async function staged() {
  const c = await company();
  const away = await plan(c, 'Dana at home', c.ids.dana);
  const spare = await plan(c, 'Dana at work', c.ids.dana);
  const sales = await plan(c, 'Sam', c.ids.sam);
  await machineOf(c, away, 'Marselle', SEEN);
  connect(c, (await machineOf(c, spare, 'Office', new Date('2026-11-13T21:00:00.000Z'))).id);
  await c.db.update(agents).set({ subscriptionId: away.id }).where(eq(agents.id, c.worker.id));
  return { ...c, away, spare, sales };
}

describe('an employee whose machine is offline', () => {
  it('says on its card and on the card of its task which machine is offline and since when', async () => {
    const c = await staged();
    const card = await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`);
    expect(card.json().offline).toEqual({ hostname: 'Marselle', since: SEEN.toISOString() });
    const task = await send(c, c.danaToken, 'GET', `/api/tasks/${c.task.id}`);
    expect(task.json().task.assigneeOffline).toEqual({ hostname: 'Marselle', since: SEEN.toISOString() });
  });

  it('says nothing of a machine once one machine of the plan is online, and nothing for a plan with no machine', async () => {
    const c = await staged();
    await c.db.update(agents).set({ subscriptionId: c.spare.id }).where(eq(agents.id, c.worker.id));
    expect((await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`)).json().offline).toBeNull();
    expect((await send(c, c.danaToken, 'GET', `/api/tasks/${c.task.id}`)).json().task.assigneeOffline).toBeNull();
    await c.db.update(agents).set({ subscriptionId: c.sales.id }).where(eq(agents.id, c.worker.id));
    expect((await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`)).json().offline).toBeNull();
  });

  it('names the machine heard from last when every machine of the plan is offline, and no time when it never spoke', async () => {
    const c = await staged();
    await machineOf(c, c.away, 'Laptop', new Date('2026-11-13T19:30:00.000Z'));
    expect((await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`)).json().offline).toEqual({ hostname: 'Laptop', since: '2026-11-13T19:30:00.000Z' });
    await c.db.update(nodes).set({ lastSeenAt: null });
    expect((await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`)).json().offline).toMatchObject({ since: null });
  });
});

describe('moving an employee to another plan in one step', () => {
  it('lets a person who runs the department move its employee to a plan of the department that is online', async () => {
    const c = await staged();
    const moved = await send(c, c.danaToken, 'PATCH', `/api/agents/${c.worker.id}`, { subscription: c.spare.id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ subscription: { id: c.spare.id }, offline: null });
  });

  it('refuses a plan that does not serve the department, and an employee of another department', async () => {
    const c = await staged();
    const foreign = await send(c, c.danaToken, 'PATCH', `/api/agents/${c.worker.id}`, { subscription: c.sales.id });
    expect([foreign.statusCode, foreign.json().error.reason]).toEqual([400, 'subscription_cannot_serve']);
    const theirs = await send(c, c.danaToken, 'PATCH', `/api/agents/${c.seller.id}`, { subscription: c.spare.id });
    expect(theirs.statusCode).toBe(403);
    const bySam = await send(c, c.samToken, 'PATCH', `/api/agents/${c.worker.id}`, { subscription: c.sales.id });
    expect(bySam.statusCode).toBe(403);
    expect((await c.db.select({ sub: agents.subscriptionId }).from(agents).where(eq(agents.id, c.worker.id)))[0]!.sub).toBe(c.away.id);
  });
});

describe('an agent writing to an employee whose machine is offline', () => {
  it('hears which machine is off, that the pushed work stays in the repository, and who goes on with it', async () => {
    const c = await staged();
    const hana = await c.tools(c.head);
    const res = (await hana.callTool({ name: 'message_employee', arguments: { employee: c.worker.id, text: 'Go on with the leads' } })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(
      'Bruno cannot run now: Marselle, the machine of its plan, is offline. The work it pushed stays in the repository: an employee who is on can go on from its branch, and a person who runs the department can move Bruno to a plan of the department that is online.',
    );
  });
});
