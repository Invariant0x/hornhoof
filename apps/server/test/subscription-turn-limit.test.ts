import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { agents, jobs, machines, nodes, subscriptions, tasks } from '../src/db/schema.js';
import { enqueueTurn, openTypedTurn, pump } from '../src/modules/conversation/queue.js';
import { createRoute, departmentStages } from '../src/modules/tasks/echelons-store.js';
import { routeOf } from '../src/modules/tasks/route-records.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { BUILTIN } from './builtin.js';
import { failureCompany } from './failure-company.js';

async function plan() {
  const c = await failureCompany();
  const hire = (name: string) => c.hire(name, 'worker', 'DEV-BE', c.dev.id);
  const turn = (agentId: string) =>
    enqueueTurn(c.ctx, { companyId: c.companyId, agentId, prompt: 'Start work.', createdBy: null });
  const patch = (turnLimit: number) => c.app.inject({
    method: 'PATCH', url: `/api/subscriptions/${c.sub.id}`, payload: { turnLimit }, ...c.as(c.ceo),
  });
  const finish = (jobId: string) => handleNodeMessage(c.ctx, BUILTIN, {
    type: 'job.done', jobId, ok: true, sessionId: 'test-session', result: 'Done.', tail: '', error: null,
  });
  const status = async (jobId: string) => (await c.jobOf(jobId)).status;
  const team = (size: number) => Promise.all(Array.from({ length: size }, (_, i) => hire(`Worker ${i + 1}`)));
  return { ...c, hire, turn, patch, finish, status, team };
}

async function urgentTurn(c: Awaited<ReturnType<typeof plan>>, agentId: string) {
  const [task] = await c.db.insert(tasks).values({
    companyId: c.companyId, departmentId: c.dev.id, assigneeAgentId: agentId, executorAgentId: agentId,
    number: 1, title: 'Urgent work', urgent: true,
  }).returning();
  const stages = await departmentStages(c.ctx, c.dev.id);
  await c.db.transaction(tx => createRoute(tx, task!, {}, stages));
  const route = await routeOf(c.db, task!);
  return enqueueTurn(c.ctx, {
    companyId: c.companyId, agentId, taskId: task!.id, prompt: 'Urgent work.', createdBy: null,
    message: { personId: null, text: 'Urgent work.', taskWake: taskWakeOf(task!, { why: 'assigned', version: task!.version }, route.state) },
  });
}

it('starts four concurrent turns by default and reports why the fifth waits', async () => {
  const c = await plan();
  const team = await c.team(5);
  const active = await Promise.all(team.slice(0, 4).map(agent => c.turn(agent.id)));
  expect(await Promise.all(active.map(c.status))).toEqual(['running', 'running', 'running', 'running']);
  expect(await c.status(await c.turn(team[4]!.id))).toBe('queued');
  const { state } = (await c.app.inject({ url: `/api/agents/${team[4]!.id}/events`, ...c.as(c.ceo) })).json();
  expect(state).toMatchObject({ queued: 1, memoryWait: false, subscriptionWait: { label: c.sub.label, running: 4, limit: 4 } });
});

it('admits the fifth turn at a custom limit and keeps the sixth waiting', async () => {
  const c = await plan();
  expect((await c.patch(5)).statusCode).toBe(200);
  const team = await c.team(6);
  const first = await Promise.all(team.slice(0, 5).map(agent => c.turn(agent.id)));
  expect(await Promise.all(first.map(c.status))).toEqual(Array(5).fill('running'));
  expect(await c.status(await c.turn(team[5]!.id))).toBe('queued');
});

it('gives a freed place to urgent work first and then to the earliest normal turn', async () => {
  const c = await plan();
  const team = await c.team(7);
  const active: string[] = [];
  for (const agent of team.slice(0, 4)) active.push(await c.turn(agent.id));
  const normal = await c.turn(team[4]!.id);
  const urgent = await urgentTurn(c, team[5]!.id);
  const later = await c.turn(team[6]!.id);
  expect(await Promise.all([normal, urgent, later].map(c.status))).toEqual(['queued', 'queued', 'queued']);
  await c.finish(active[0]!);
  expect(await Promise.all([normal, urgent, later].map(c.status))).toEqual(['queued', 'running', 'queued']);
  await c.finish(active[1]!);
  expect(await Promise.all([normal, urgent, later].map(c.status))).toEqual(['running', 'running', 'queued']);
});

it('orders the turns that can actually go without changing the order within an agent', async () => {
  const c = await plan();
  expect((await c.patch(1)).statusCode).toBe(200);
  const [busy, first, second] = await c.team(3);
  const active = await c.turn(busy!.id);
  const oldest = await c.turn(first!.id);
  const later = await c.turn(second!.id);
  const urgent = await urgentTurn(c, second!.id);
  const arrivals = [oldest, later, urgent];
  for (const [order, id] of arrivals.entries()) {
    await c.db.update(jobs).set({ createdAt: new Date(1_000 + order) }).where(eq(jobs.id, id));
  }
  expect(await Promise.all(arrivals.map(c.status))).toEqual(['queued', 'queued', 'queued']);

  await c.finish(active);
  expect(await Promise.all(arrivals.map(c.status))).toEqual(['running', 'queued', 'queued']);
  await c.finish(oldest);
  expect(await Promise.all(arrivals.map(c.status))).toEqual(['done', 'running', 'queued']);
  await c.finish(later);
  expect(await c.status(urgent)).toBe('running');
});

it('gives an urgent waiter the destination place ahead of a normal turn moved onto its plan', async () => {
  const c = await plan();
  const [activeAgent, waiter, moving] = await c.team(3);
  const [destination] = await c.db.insert(subscriptions).values({
    companyId: c.companyId, ownerPersonId: c.sub.ownerPersonId, kind: 'api_key',
    provider: c.sub.provider, label: 'Destination', status: 'ready', turnLimit: 1,
  }).returning();
  for (const agent of [activeAgent!, waiter!]) await c.db.update(agents).set({ subscriptionId: destination!.id }).where(eq(agents.id, agent.id));
  const active = await c.turn(activeAgent!.id);
  const urgent = await urgentTurn(c, waiter!.id);
  expect(await c.status(active)).toBe('running');
  expect(await c.status(urgent)).toBe('queued');
  /* Make a place available while its completion wake has yet to reach the destination queue. */
  await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, active));
  const beforeDispatch = c.ctx.conversationEffects.beforeDispatch;
  vi.spyOn(c.ctx.conversationEffects, 'beforeDispatch').mockImplementation(async (ctx, id) => {
    if (id !== moving!.id) return beforeDispatch(ctx, id);
    const [moved] = await ctx.db.update(agents).set({ subscriptionId: destination!.id })
      .where(eq(agents.id, id)).returning({ id: agents.id });
    return Boolean(moved);
  });
  const normal = await c.turn(moving!.id);
  await pump(c.ctx, waiter!.id);
  expect(await Promise.all([urgent, normal].map(c.status))).toEqual(['running', 'queued']);
});

it('counts a person-started terminal turn while further agent turns wait', async () => {
  const c = await plan();
  expect((await c.patch(1)).statusCode).toBe(200);
  const [agent, typist, next] = await c.team(3);
  const active = await c.turn(agent!.id);
  expect(await c.status(active)).toBe('running');
  const entered = await openTypedTurn(c.ctx, BUILTIN, typist!.id, 'Words typed by the owner.', c.sub.ownerPersonId);
  expect(entered).not.toBeNull();
  expect(await c.status(entered!.jobId)).toBe('running');
  const waiting = await c.turn(next!.id);
  expect(await c.status(waiting)).toBe('queued');
  await c.finish(active);
  expect(await c.status(waiting)).toBe('queued');
  await c.finish(entered!.jobId);
  expect(await c.status(waiting)).toBe('running');
});

it('excludes running one-shot calls from the conversation ceiling', async () => {
  const c = await plan();
  await c.db.insert(jobs).values({
    companyId: c.companyId, subscriptionId: c.sub.id, kind: 'call', status: 'running',
    prompt: 'One-shot work.', timeoutMs: 1000, startedAt: new Date(),
  });
  const team = await c.team(5);
  const first = await Promise.all(team.slice(0, 4).map(agent => c.turn(agent.id)));
  expect(await Promise.all(first.map(c.status))).toEqual(Array(4).fill('running'));
  expect(await c.status(await c.turn(team[4]!.id))).toBe('queued');
});

it('stores the limit and refuses values outside the supported whole-number range', async () => {
  const c = await plan();
  const kept = await c.patch(5);
  expect(kept.statusCode).toBe(200);
  expect(kept.json().subscription.turnLimit).toBe(5);
  for (const invalid of [0, 1.5, 6]) expect((await c.patch(invalid)).statusCode).toBe(400);
  const listed = await c.app.inject({ url: '/api/subscriptions', ...c.as(c.ceo) });
  expect(listed.json().subscriptions).toContainEqual(expect.objectContaining({ id: c.sub.id, turnLimit: 5 }));
});

async function personalNode(c: Awaited<ReturnType<typeof plan>>, name: string, order: number) {
  const [machine] = await c.db.insert(machines).values({
    companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: name, role: 'worker',
  }).returning();
  const [node] = await c.db.insert(nodes).values({
    companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, keyHash: name,
    status: 'ready', version: '0.44.3', createdAt: new Date(order),
  }).returning();
  return node!;
}

it('keeps a separate count for each machine of a personal plan', async () => {
  const c = await plan();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'claude' }).where(eq(subscriptions.id, c.sub.id));
  const first = await personalNode(c, 'capacity-first', 1);
  const second = await personalNode(c, 'capacity-second', 2);
  const team = await c.team(5);
  for (const agent of team) await c.db.update(agents).set({ nodeId: first.id }).where(eq(agents.id, agent.id));
  for (const agent of team.slice(0, 4)) expect((await c.jobOf(await c.turn(agent.id))).nodeId).toBe(first.id);
  const sent = await c.jobOf(await c.turn(team[4]!.id));
  expect(sent).toMatchObject({ status: 'running', nodeId: second.id });
  expect(c.sent.mock.calls.some(([where, msg]) => where.kind === 'node' && where.nodeId === second.id && msg.type === 'job.run' && msg.jobId === sent.id)).toBe(true);
});

it('reports a full machine and uses an available alternate while an earlier alternate installs', async () => {
  const c = await plan();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'claude', turnLimit: 1 }).where(eq(subscriptions.id, c.sub.id));
  const full = await personalNode(c, 'capacity-full', 1);
  const installing = await personalNode(c, 'capacity-installing', 2);
  const spare = await personalNode(c, 'capacity-spare', 3);
  await c.db.update(machines).set({ goCommit: 'a'.repeat(40), goAt: new Date() }).where(eq(machines.id, installing.machineId));
  await c.db.update(nodes).set({ status: 'needs_setup' }).where(eq(nodes.id, spare.id));
  const [active, next] = await c.team(2);
  for (const member of [active!, next!]) await c.db.update(agents).set({ nodeId: full.id }).where(eq(agents.id, member.id));
  expect(await c.jobOf(await c.turn(active!.id))).toMatchObject({ status: 'running', nodeId: full.id });
  const waiting = await c.turn(next!.id);
  expect(await c.status(waiting)).toBe('queued');
  const state = (await c.app.inject({ url: `/api/agents/${next!.id}/events`, ...c.as(c.ceo) })).json().state;
  expect(state.subscriptionWait).toEqual({ label: c.sub.label, running: 1, limit: 1 });

  await c.db.update(nodes).set({ status: 'ready' }).where(eq(nodes.id, spare.id));
  await pump(c.ctx, next!.id);
  expect(await c.jobOf(waiting)).toMatchObject({ status: 'running', nodeId: spare.id });
});
