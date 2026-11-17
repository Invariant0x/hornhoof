import { EventEmitter } from 'node:events';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { WebSocket } from 'ws';
import { agentEvents, agents, jobs, machines, nodeConnections, nodes, subscriptions, tasks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { pump } from '../src/modules/conversation/queue.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { company } from './department-owner-fixture.js';
import { as } from './helpers.js';

/* When the machine an employee's plan runs on is offline, its card and the card of its task say which machine and since when.
   Who runs the department moves the employee to another plan of the department in one step; nothing outside it. */

type C = Awaited<ReturnType<typeof company>>;
const send = (c: C, token: string, method: 'GET' | 'PATCH', url: string, payload?: object) => c.app.inject({ method, url, ...(payload ? { payload } : {}), ...as(token) });
const SEEN = new Date('2026-11-13T18:07:00.000Z');
const MINUTE = 60_000;

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
    send() {},
    close() { socket.readyState = 3; socket.emit('close', 1000); },
    ping() { socket.emit('pong'); },
    terminate() { socket.readyState = 3; socket.emit('close', 1006); },
  });
  c.app.ctx.hub.attach(nodeIdentity(nodeId), socket as unknown as WebSocket);
  onTestFinished(() => socket.close());
}

/* Bruno of Development works on Dana's plan, whose only machine Homebox last spoke at 18:07; her second plan runs on a
   machine online now, and Sam's plan serves Sales only. */
async function staged() {
  const c = await company();
  const away = await plan(c, 'Dana at home', c.ids.dana);
  const spare = await plan(c, 'Dana at work', c.ids.dana);
  const salesPlan = await plan(c, 'Sam', c.ids.sam);
  await machineOf(c, away, 'Homebox', SEEN);
  connect(c, (await machineOf(c, spare, 'Office', new Date('2026-11-13T21:00:00.000Z'))).id);
  await c.db.update(agents).set({ subscriptionId: away.id }).where(eq(agents.id, c.worker.id));
  /* The server's clock reads the evening of that day, long after Homebox went quiet. */
  c.app.ctx.clock = () => Date.parse('2026-11-13T21:10:00.000Z');
  return { ...c, away, spare, salesPlan };
}

describe('an employee whose machine is offline', () => {
  it('says on its card and on the card of its task which machine is offline and since when', async () => {
    const c = await staged();
    const card = await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`);
    expect(card.json().offline).toEqual({ hostname: 'Homebox', since: SEEN.toISOString() });
    const task = await send(c, c.danaToken, 'GET', `/api/tasks/${c.task.id}`);
    expect(task.json().task.assigneeOffline).toEqual({ hostname: 'Homebox', since: SEEN.toISOString() });
  });

  it('says nothing of a machine once one machine of the plan is online, and nothing for a plan with no machine', async () => {
    const c = await staged();
    await c.db.update(agents).set({ subscriptionId: c.spare.id }).where(eq(agents.id, c.worker.id));
    expect((await send(c, c.ceoToken, 'GET', `/api/agents/${c.worker.id}`)).json().offline).toBeNull();
    expect((await send(c, c.danaToken, 'GET', `/api/tasks/${c.task.id}`)).json().task.assigneeOffline).toBeNull();
    await c.db.update(agents).set({ subscriptionId: c.salesPlan.id }).where(eq(agents.id, c.worker.id));
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

describe('the machine of an employee outside the department', () => {
  it('is named to no person who may not open the employee, on its card or on the card of its task', async () => {
    const c = await staged();
    const task = await send(c, c.samToken, 'GET', `/api/tasks/${c.task.id}`);
    expect(task.statusCode).toBe(200);
    expect(task.json().task.assigneeOffline).toBeNull();
    expect(task.body).not.toContain('Homebox');
    const card = await send(c, c.samToken, 'GET', `/api/agents/${c.worker.id}`);
    expect(card.statusCode).toBe(403);
    expect(card.body).not.toContain('Homebox');
    expect((await send(c, c.wholeToken, 'GET', `/api/tasks/${c.task.id}`)).json().task.assigneeOffline).toBeNull();
    expect((await send(c, c.wholeToken, 'GET', `/api/agents/${c.worker.id}`)).statusCode).toBe(403);
  });

  it('is named to no agent of another department that reads the task, and to the head of the department it is', async () => {
    const c = await staged();
    await c.db.update(tasks).set({ executorAgentId: c.seller.id }).where(eq(tasks.id, c.task.id));
    const read = async (agent: { id: string }) => {
      const res = (await (await c.tools(agent)).callTool({ name: 'task', arguments: { task: c.task.number } })) as { content: { text: string }[] };
      return res.content[0]!.text;
    };
    const sid = await read(c.seller);
    expect(JSON.parse(sid).assigneeOffline).toBeNull();
    expect(sid).not.toContain('Homebox');
    expect(JSON.parse(await read(c.head)).assigneeOffline).toEqual({ hostname: 'Homebox', since: SEEN.toISOString() });
    expect(JSON.parse(await read(c.orchestrator)).assigneeOffline).toEqual({ hostname: 'Homebox', since: SEEN.toISOString() });
  });

  it('is named to no agent of another department that answers the employee', async () => {
    const c = await staged();
    /* Bruno wrote to Sid last, so Sid may answer him once from Sales. */
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.seller.id, kind: 'message', data: { from: 'agent', by: c.worker.id, text: 'Which leads are yours?' } });
    const res = (await (await c.tools(c.seller)).callTool({ name: 'message_employee', arguments: { employee: c.worker.id, text: 'The ones from the fair' } })) as { content: { text: string }[]; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe(
      'Bruno cannot run now: the machine of its plan is offline. The work it pushed stays in the repository: an employee who is on can go on from its branch, and a person who runs the department can move Bruno to a plan of the department that is online.' +
        `\nNot delivered: reason machine_offline, recipient ${c.worker.id}, task none.`,
    );
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
    const foreign = await send(c, c.danaToken, 'PATCH', `/api/agents/${c.worker.id}`, { subscription: c.salesPlan.id });
    expect([foreign.statusCode, foreign.json().error.reason]).toEqual([400, 'subscription_cannot_serve']);
    const theirs = await send(c, c.danaToken, 'PATCH', `/api/agents/${c.seller.id}`, { subscription: c.spare.id });
    expect(theirs.statusCode).toBe(403);
    const bySam = await send(c, c.samToken, 'PATCH', `/api/agents/${c.worker.id}`, { subscription: c.salesPlan.id });
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
      'Bruno cannot run now: Homebox, the machine of its plan, is offline. The work it pushed stays in the repository: an employee who is on can go on from its branch, and a person who runs the department can move Bruno to a plan of the department that is online.' +
        `\nNot delivered: reason machine_offline, recipient ${c.worker.id}, task none.`,
    );
  });
});

describe('an agent writing to an employee whose machine is getting back on the line', () => {
  type Answer = { content: { text: string }[]; isError?: boolean };
  /* Homebox was on the line for an hour until SEEN, when its connection closed; the server's clock reads this long after. */
  async function dropped(c: C, after: number) {
    const [homebox] = await c.db.select({ id: nodes.id, machineId: nodes.machineId }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(machines.hostname, 'Homebox'));
    await c.db.insert(nodeConnections).values({ companyId: c.companyId, machineId: homebox!.machineId, nodeId: homebox!.id, connectedAt: new Date(SEEN.getTime() - 60 * MINUTE), disconnectedAt: SEEN, cause: 'network' });
    c.app.ctx.clock = () => SEEN.getTime() + after;
    const hana = await c.tools(c.head);
    const write = (text: string) => hana.callTool({ name: 'message_employee', arguments: { employee: c.worker.id, text } }) as Promise<Answer>;
    return { homebox: homebox!, write };
  }
  const waiting = (c: C) => c.db.select().from(jobs).where(and(eq(jobs.agentId, c.worker.id), eq(jobs.status, 'queued')));
  const statusOf = async (c: C, id: string) => (await c.db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, id)))[0]!.status;

  it('keeps the message while the connection is closed, and sends it once the machine is back and says hello', async () => {
    const c = await staged();
    const { homebox, write } = await dropped(c, MINUTE);
    const sent = await write('Go on with the leads');
    expect([sent.isError, sent.content[0]!.text]).toEqual([undefined, 'Sent to Bruno. Its machine is getting back on the line, so the turn starts once it is back.']);
    const [turn, ...more] = await waiting(c);
    expect([turn!.prompt, more]).toEqual([expect.stringContaining('Go on with the leads'), []]);
    connect(c, homebox.id);
    await pump(c.app.ctx, c.worker.id);
    expect(await statusOf(c, turn!.id)).toBe('queued');
    c.app.ctx.hub.greet(nodeIdentity(homebox.id), true);
    await pump(c.app.ctx, c.worker.id);
    expect(await statusOf(c, turn!.id)).toBe('running');
  });

  it('keeps a message until the machine has been off as long as its card takes, and refuses one with the code from then', async () => {
    const c = await staged();
    const { write } = await dropped(c, 5 * MINUTE - 1000);
    expect((await write('Go on with the leads')).isError).toBeFalsy();
    c.app.ctx.clock = () => SEEN.getTime() + 5 * MINUTE;
    const refused = await write('Are you there?');
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe(
      'Bruno cannot run now: Homebox, the machine of its plan, is offline. The work it pushed stays in the repository: an employee who is on can go on from its branch, and a person who runs the department can move Bruno to a plan of the department that is online.' +
        `\nNot delivered: reason machine_offline, recipient ${c.worker.id}, task none.`,
    );
    expect((await waiting(c)).map(j => j.prompt)).toEqual([expect.stringContaining('Go on with the leads')]);
  });
});
