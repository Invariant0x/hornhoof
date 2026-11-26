import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agents, jobs, machines, nodes, subscriptions, tasks } from '../src/db/schema.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { BUILTIN } from './builtin.js';
import { failureCompany } from './failure-company.js';

async function plan() {
  const c = await failureCompany();
  const hire = (name: string) => c.hire(name, 'worker', 'DEV-BE', c.dev.id);
  const turn = (agentId: string, taskId?: string) =>
    enqueueTurn(c.ctx, { companyId: c.companyId, agentId, prompt: 'Start work.', createdBy: null, taskId });
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
  const [task] = await c.db.insert(tasks).values({
    companyId: c.companyId, departmentId: c.dev.id, assigneeAgentId: team[5]!.id, executorAgentId: team[5]!.id,
    number: 1, title: 'Urgent work', urgent: true,
  }).returning();
  const urgent = await c.turn(team[5]!.id, task!.id);
  const later = await c.turn(team[6]!.id);
  expect(await Promise.all([normal, urgent, later].map(c.status))).toEqual(['queued', 'queued', 'queued']);
  await c.finish(active[0]!);
  expect(await Promise.all([normal, urgent, later].map(c.status))).toEqual(['queued', 'running', 'queued']);
  await c.finish(active[1]!);
  expect(await Promise.all([normal, urgent, later].map(c.status))).toEqual(['running', 'running', 'queued']);
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

it('keeps a separate count for each machine of a personal plan', async () => {
  const c = await plan();
  await c.db.update(subscriptions).set({ kind: 'personal', provider: 'claude' }).where(eq(subscriptions.id, c.sub.id));
  const addNode = async (name: string) => {
    const [machine] = await c.db.insert(machines).values({
      companyId: c.companyId, personId: c.sub.ownerPersonId, machineKey: name,
    }).returning();
    const [node] = await c.db.insert(nodes).values({
      companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, keyHash: name, status: 'ready', version: '0.44.3',
    }).returning();
    return node!;
  };
  const first = await addNode('capacity-first');
  const second = await addNode('capacity-second');
  const team = await c.team(5);
  for (const agent of team) await c.db.update(agents).set({ nodeId: first.id }).where(eq(agents.id, agent.id));
  for (const agent of team.slice(0, 4)) expect((await c.jobOf(await c.turn(agent.id))).nodeId).toBe(first.id);
  const sent = await c.jobOf(await c.turn(team[4]!.id));
  expect(sent).toMatchObject({ status: 'running', nodeId: second.id });
  expect(c.sent.mock.calls.some(([where, msg]) => where.kind === 'node' && where.nodeId === second.id && msg.type === 'job.run' && msg.jobId === sent.id)).toBe(true);
});
