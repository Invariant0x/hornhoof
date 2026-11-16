import type { ServerMessage } from '@hornhoof/protocol';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, requests, subscriptions, tasks, taskRoutes, taskWaits, teams } from '../src/db/schema.js';
import { cancel, createTask, silentTurn, updateTask } from '../src/modules/tasks/engine.js';
import { checkLiveness, wakeAll } from '../src/modules/tasks/wake.js';
import { agentProgramState, checkSilentTurns } from '../src/modules/tasks/silent.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { keepWakes, wakesLeft } from '../src/modules/tasks/outbox.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { discardStaleTurn, taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { checkExternalWaits, waitFor } from '../src/modules/tasks/external-wait.js';
import { insertTurn } from '../src/modules/conversation/queue.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { as, connectNode, echelonsTurn, listen, mcp, setUpCompany, testApp, until } from './helpers.js';
import { BUILTIN } from './builtin.js';

const NODE_KEY = 'external-wait-test-node-key-0123456789abcdef';

async function fixture(env?: NodeJS.ProcessEnv) {
  const { app, db } = await testApp(env);
  const url = await listen(app);
  const owner = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const [head, worker, peer] = await db.insert(agents).values([
    { companyId: company!.id, departmentId: department!.id, kind: 'head', roleKey: 'DEV-HEAD', name: 'Hana', model: 'claude-opus-5-5', subscriptionId: sub!.id },
    { companyId: company!.id, departmentId: department!.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Bruno', model: 'claude-opus-5-5', subscriptionId: sub!.id },
    { companyId: company!.id, departmentId: department!.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Rita', model: 'claude-opus-5-5', subscriptionId: sub!.id },
  ]).returning();
  app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: 'b'.repeat(40) });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  await echelonsTurn(db, company!.id);
  const clients = new Map<string, Client>();
  const tools = async (agentId = worker!.id) => {
    const existing = clients.get(agentId);
    if (existing) return existing;
    const token = `external-wait-${agentId}-test-token`;
    await db.insert(jobs).values({ companyId: company!.id, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'Work.', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    const client = await mcp(app, token);
    clients.set(agentId, client);
    return client;
  };
  const task = async (holder = worker!.id) => (await createTask(app.ctx, { agentId: head!.id }, { title: 'Publish images', brief: '', body: '', departmentId: department!.id, assigneeAgentId: holder, executor: true, small: true, paths: ['logic/totals.ts'] })).task;
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const wait = async (ref: number | string, reason: string, until: string, agentId = worker!.id) => {
    const client = await tools(agentId);
    expect((await client.listTools()).tools.map(t => t.name)).toContain('wait_for');
    return await client.callTool({ name: 'wait_for', arguments: { task: ref, reason, until } }) as { isError?: boolean; content: { text: string }[] };
  };
  const messageState = async (task: Awaited<ReturnType<typeof read>>) => ({ ...taskWakeOf(task, { why: 'comment' }, routeSnapshot(await routeOf(db, task), task.assigneeAgentId)), why: 'message' });
  const atReview = async (task: Awaited<ReturnType<typeof read>>) => {
    const route = await routeOf(db, task);
    await db.update(tasks).set({ status: 'review', assigneeAgentId: peer!.id, externalWait: null }).where(eq(tasks.id, task.id));
    await db.update(taskRoutes).set({ state: { ...route.state, stage: 'review' } }).where(eq(taskRoutes.taskId, task.id));
  };
  return { app, ctx: app.ctx, db, owner, url, messageState, atReview, company: company!, sub: sub!, orchestrator: orchestrator!, department: department!, head: head!, worker: worker!, peer: peer!, task, read, tools, wait };
}

async function messaging() {
  const c = await fixture({ NODE_KEY });
  const node = await connectNode(c.url, NODE_KEY);
  node.ws.on('message', raw => {
    const message = JSON.parse(String(raw)) as ServerMessage;
    if (message.type === 'agent.say') node.send({ type: 'agent.said', ref: message.ref, ok: true });
  });
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true, skillFiles: true });
  await until(() => c.ctx.hub.isReady(identityOf(c.sub, null, null, BUILTIN)!));
  return { ...c, node };
}

describe('the record of a wait_for', () => {
  const HOUR = 3_600_000;
  const recordOf = async (c: Awaited<ReturnType<typeof fixture>>, id: string) => {
    const operation = (await c.read(id)).externalWait!.operation!;
    return { operation, wait: (await c.db.select().from(taskWaits).where(eq(taskWaits.sourceKey, `wait_for:${operation}`)))[0]! };
  };
  const planOf = (c: Awaited<ReturnType<typeof fixture>>, change: object = {}) => {
    const after = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
    return { version: 1, ownerDueAt: after(3), headDueAt: after(4), decisionDueAt: after(5), provenance: { kind: 'explicit_promise', actor: { agentId: c.head.id }, ref: 'promise-1', revision: 1, origin: 'wait_for' }, finalReview: { headAgentId: c.head.id, anchorAt: after(6), intervalMs: HOUR }, ...change };
  };
  const anHour = () => new Date(Date.now() + HOUR).toISOString();

  it('keeps it for the holder with no plan, its deadline being no promise', async () => {
    const c = await fixture();
    const task = await c.task();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour(), on: { kind: 'external', event: 'machine' } });
    const { operation, wait } = await recordOf(c, task.id);
    expect(operation).toMatch(/^[0-9a-f-]{36}$/);
    expect(wait).toMatchObject({ taskId: task.id, kind: 'external', state: 'legacy_needs_plan', ownerAgentId: c.worker.id, plan: null, ownerDueAt: null, nextActionAt: null, sourceRevision: 0, sourceState: { stage: 'waiting' } });
  });

  it('has the employee it names answer for it', async () => {
    const c = await fixture();
    const task = await c.task();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour(), on: { kind: 'employee', employee: c.peer.id } });
    expect((await recordOf(c, task.id)).wait).toMatchObject({ ownerAgentId: c.peer.id });
  });

  it('takes a plan, and holds its dates apart from the deadline of the wait', async () => {
    const c = await fixture();
    const task = await c.task();
    const plan = planOf(c);
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour(), plan: plan as never });
    const { wait } = await recordOf(c, task.id);
    expect(wait).toMatchObject({ state: 'active', generation: 1, ownerAgentId: c.worker.id });
    expect(wait.ownerDueAt!.toISOString()).toBe(plan.ownerDueAt);
    expect(wait.nextActionAt!.toISOString()).toBe(plan.ownerDueAt);
  });

  it('refuses the whole wait when its plan is no plan, leaving the task as it was', async () => {
    const c = await fixture();
    const task = await c.task();
    const before = await c.read(task.id);
    for (const plan of [planOf(c, { finalReview: { headAgentId: c.worker.id, anchorAt: anHour(), intervalMs: HOUR } }), planOf(c, { ownerDueAt: undefined }), planOf(c, { finalReview: { headAgentId: c.head.id, anchorAt: anHour(), intervalMs: null } })]) {
      await expect(waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour(), plan: plan as never })).rejects.toMatchObject({ reason: 'task_invalid' });
    }
    expect(await c.read(task.id)).toEqual(before);
    expect(await c.db.select().from(taskWaits)).toEqual([]);
  });

  it('gets a new operation with a new wait, which takes the place of the old one', async () => {
    const c = await fixture();
    const task = await c.task();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour() });
    const first = await recordOf(c, task.id);
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour() });
    const second = await recordOf(c, task.id);
    expect(second.operation).not.toBe(first.operation);
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.id, first.wait.id)))[0]).toMatchObject({ state: 'superseded', proofRef: `wait_for:${second.operation}` });
    expect(second.wait).toMatchObject({ state: 'legacy_needs_plan' });
  });

  it('leaves another source of the task alone when it is replaced', async () => {
    const c = await fixture();
    const task = await c.task();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour() });
    const [other] = await c.db.insert(taskWaits).values({ companyId: c.company.id, taskId: task.id, kind: 'external', sourceKey: `operation:${randomUUID()}`, sourceRevision: 0, state: 'legacy_needs_plan' }).returning();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: anHour() });
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.id, other!.id)))[0]).toMatchObject({ state: 'legacy_needs_plan' });
  });

  it('stays at its deadline, come back to be looked at, with one wake: a date passing proves nothing', async () => {
    const c = await fixture();
    const task = await c.task();
    const plan = planOf(c);
    const until = anHour();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until, plan: plan as never });
    const { wait } = await recordOf(c, task.id);
    expect(await checkExternalWaits(c.ctx, new Date(Date.parse(until) + 1))).toBe(1);
    expect(await checkExternalWaits(c.ctx, new Date(Date.parse(until) + 2))).toBe(0);
    const [back] = await c.db.select().from(taskWaits).where(eq(taskWaits.id, wait.id));
    expect(back).toMatchObject({ state: 'active', generation: 1, sourceRevision: 0, sourceState: { stage: 'check_back' }, ownerAgentId: c.worker.id, outcome: null, proofRef: null });
    expect(back!.ownerDueAt!.toISOString()).toBe(plan.ownerDueAt);
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toHaveLength(1);
  });

  it('comes back when a message on the task ends the wait, and goes on when the message does not go out', async () => {
    const c = await messaging();
    const task = await c.task();
    await c.wait(task.number, 'Images', anHour());
    const { wait } = await recordOf(c, task.id);
    const stageOf = async () => ((await c.db.select().from(taskWaits).where(eq(taskWaits.id, wait.id)))[0]!).sourceState.stage;
    expect(await stageOf()).toBe('waiting');
    const client = await c.tools(c.head.id);
    expect((await client.callTool({ name: 'message_employee', arguments: { employee: c.worker.id, task: task.number, text: 'Look at this.' } })).isError).toBeFalsy();
    expect((await c.read(task.id)).externalWait).toBeNull();
    expect(await stageOf()).toBe('check_back');
  });

  it('keeps every wait the machines kept before, with no operation of its own, ending as it did', async () => {
    const c = await fixture();
    const task = await c.task();
    const until = new Date(Date.now() + HOUR);
    await c.db.update(tasks).set({ externalWait: { reason: 'Images', since: new Date().toISOString(), until: until.toISOString() } }).where(eq(tasks.id, task.id));
    expect(await checkExternalWaits(c.ctx, new Date(until.getTime() + 1))).toBe(1);
    expect(await c.db.select().from(taskWaits)).toEqual([]);
  });
});

describe('external task wait', () => {
  it('stores the holder wait for two hours without changing the workflow status', async () => {
    const c = await fixture();
    const task = await c.task();
    await c.db.update(tasks).set({ silent: 2 }).where(eq(tasks.id, task.id));
    const since = Date.now();
    const until = new Date(since + 2 * 3_600_000).toISOString();
    const result = await c.wait(task.number, '  Images on the registry  ', until.replace('Z', '+00:00'));
    expect(result.isError).toBeFalsy();
    const row = await c.read(task.id);
    expect(row).toMatchObject({ status: 'open', assigneeAgentId: c.worker.id, silent: 0, externalWait: { reason: 'Images on the registry', until } });
    expect(Date.parse(row.externalWait!.since)).toBeGreaterThanOrEqual(since);
    expect(Date.parse(row.externalWait!.since)).toBeLessThanOrEqual(Date.now());
    const detail = await (await c.tools()).callTool({ name: 'task', arguments: { task: task.number } }) as { content: { text: string }[] };
    expect(JSON.parse(detail.content[0]!.text).externalWait).toEqual(row.externalWait);
    expect((await c.db.select().from(jobs)).filter(j => j.taskId === task.id)).toEqual([]);
  });

  it('refuses invalid reasons and deadlines without changing the task', async () => {
    const c = await fixture();
    const task = await c.task();
    const future = new Date(Date.now() + 60_000).toISOString();
    const inputs = [
      ['', future], ['First line\nSecond line', future], ['First line\rSecond line', future], ['First\u2028Second', future], ['x'.repeat(601), future],
      ['Images', 'not a date'], ['Images', new Date(Date.now() - 1000).toISOString()],
      ['Images', new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString()],
    ];
    for (const [reason, until] of inputs) {
      const result = await c.wait(task.number, reason!, until!);
      expect(result.isError, `${reason} ${until}`).toBe(true);
      expect(await c.read(task.id)).toMatchObject({ externalWait: null, version: task.version, silent: 0 });
    }
  });

  it('refuses another holder and closed tasks', async () => {
    const c = await fixture();
    const task = await c.task();
    const until = new Date(Date.now() + 60_000).toISOString();
    expect((await c.wait(task.number, 'Images', until, c.peer.id)).isError).toBe(true);
    for (const status of ['done', 'cancelled'] as const) {
      await c.db.update(tasks).set({ status, closedAt: new Date() }).where(eq(tasks.id, task.id));
      expect((await c.wait(task.number, 'Images', until)).isError).toBe(true);
      expect((await c.read(task.id)).externalWait).toBeNull();
    }
    const [outside] = await c.db.insert(departments).values({ companyId: c.company.id, roleCode: 'SAL', templateKey: 'sales' }).returning();
    const [other] = await c.db.insert(tasks).values({ companyId: c.company.id, departmentId: outside!.id, number: 9999, title: 'Their work' }).returning();
    expect((await c.wait(other!.id, 'Images', until)).isError).toBe(true);
    expect((await c.read(other!.id)).externalWait).toBeNull();
  });

  it('ends the previous wait when work is submitted, blocked or cancelled', async () => {
    const c = await fixture();
    const client = await c.tools();
    for (const action of ['submit', 'blocked', 'cancel'] as const) {
      const task = await c.task();
      expect((await c.wait(task.number, 'Images', new Date(Date.now() + 60_000).toISOString())).isError).toBeFalsy();
      if (action === 'cancel') await cancel(c.ctx, { agentId: c.head.id }, task.id, 'No longer needed.');
      else {
        const args = action === 'submit' ? { summary: 'Published.', evidence: 'Checked.', review: { baseCommit: 'a'.repeat(40) } } : { why: 'The build needs a decision.' };
        const result = await client.callTool({ name: action, arguments: { task: task.number, ...args } });
        expect(result.isError).toBeFalsy();
      }
      expect((await c.read(task.id)).externalWait).toBeNull();
    }
  });

  it.each(['done', 'failed'] as const)('does not count three %s task turns or ask people while the task waits', async status => {
    const c = await fixture();
    const task = await c.task();
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    for (let n = 0; n < 3; n++) {
      const startedAt = new Date(Date.now() + 1000);
      const [job] = await c.db.insert(jobs).values({ companyId: c.company.id, subscriptionId: c.sub.id, agentId: c.worker.id, taskId: task.id, kind: 'conversation', prompt: 'Wait for images.', timeoutMs: 900000, status, startedAt, finishedAt: new Date(startedAt.getTime() + 1000) }).returning();
      await checkLiveness(c.ctx, job!.id);
    }
    expect(await c.read(task.id)).toMatchObject({ status: 'open', silent: 0, externalWait: { reason: 'Images' } });
    expect((await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).filter(j => j.status === 'queued')).toEqual([]);
    expect(await c.db.select().from(requests).where(eq(requests.taskId, task.id))).toEqual([]);
  });

  it('leaves direct silent-turn checks quiet during the wait', async () => {
    const c = await fixture();
    const task = await c.task();
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    for (let n = 0; n < 3; n++) expect((await silentTurn(c.ctx, c.worker.id, await c.read(task.id))).wakes).toEqual([]);
    expect((await c.read(task.id)).silent).toBe(0);
    expect(await c.db.select().from(requests).where(eq(requests.taskId, task.id))).toEqual([]);
  });

  it('shows no program alarm for a task waiting for an external event', async () => {
    const c = await fixture();
    const task = await c.task();
    await c.wait(task.number, 'Images', new Date(Date.now() + 2 * 3_600_000).toISOString());
    const [job] = await c.db.insert(jobs).values({ companyId: c.company.id, subscriptionId: c.sub.id, agentId: c.worker.id, taskId: task.id, kind: 'conversation', prompt: 'Wait for images.', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    await checkSilentTurns(c.ctx, new Date(Date.now() + 31 * 60_000));
    expect(agentProgramState(c.ctx, job).alarm).toBeNull();
  });

  it('wakes once at the deadline across repeated sweeps and a new server context, then resumes ordinary rules', async () => {
    const c = await fixture();
    const task = await c.task();
    /* A minute ahead, so no machine is slow enough to pass it by itself; the sweeps below run at the times the test names,
       up to three minutes on, before the server takes a turn whose machine is away five minutes for lost. */
    const until = new Date(Date.now() + 60_000);
    await c.wait(task.number, 'Images', until.toISOString());
    const failed = (what: string) => (error: unknown) => { throw new Error(what, { cause: error }); };
    await minuteRound(c.ctx, new Date(until.getTime() - 1), failed);
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toEqual([]);
    await minuteRound(c.ctx, until, failed);
    const queued = await c.db.select().from(jobs).where(eq(jobs.taskId, task.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toBe(`#${task.number} "Publish images": the wait for "Images" ended; check and continue.`);
    expect(await c.read(task.id)).toMatchObject({ externalWait: null, silent: 0 });
    await minuteRound({ ...c.ctx }, new Date(until.getTime() + 60_000), failed);
    await minuteRound(c.ctx, new Date(until.getTime() + 120_000), failed);
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toHaveLength(1);
    const moved = await silentTurn(c.ctx, c.worker.id, await c.read(task.id));
    expect(moved.task.silent).toBe(1);
    expect(moved.wakes).toEqual([{ agentId: c.worker.id, taskId: task.id, why: 'reminder' }]);
  });

  it('does not take a timeout turn after its task closes or starts waiting again', async () => {
    const c = await fixture();
    const failed = (what: string) => (error: unknown) => { throw new Error(what, { cause: error }); };
    for (const action of ['close', 'wait again'] as const) {
      const task = await c.task();
      const until = new Date(Date.now() + 60_000);
      await c.wait(task.number, 'Images', until.toISOString());
      await minuteRound(c.ctx, until, failed);
      const [job] = await c.db.select().from(jobs).where(eq(jobs.taskId, task.id));
      expect(job).toBeDefined();
      if (action === 'close') await cancel(c.ctx, { agentId: c.head.id }, task.id, 'No longer needed.');
      else {
        await c.wait(task.number, 'Deployment', new Date(Date.now() + 3_600_000).toISOString());
        await (await c.tools(c.head.id)).callTool({ name: 'comment', arguments: { task: task.number, text: 'The deployment is ready.' } });
        expect((await c.read(task.id)).externalWait).toBeNull();
      }
      expect(await discardStaleTurn(c.db, job!)).toBe(true);
      expect((await c.db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ error: 'stale', startedAt: null });
    }
  });

  it('keeps the expected task version in the durable wake outbox', async () => {
    const c = await fixture();
    const task = await c.task();
    await keepWakes(c.db, c.company.id, [{ agentId: c.worker.id, taskId: task.id, why: 'assigned', version: task.version, text: '', note: '' }]);
    expect(await wakesLeft(c.db, new Date(Date.now() + 1000))).toContainEqual({ agentId: c.worker.id, taskId: task.id, why: 'assigned', version: task.version, text: '', note: '' });
  });

  it('refuses a versioned wake if the task changed before queueing', async () => {
    const c = await fixture();
    const task = await c.task();
    await updateTask(c.ctx, c.head.id, task.id, { title: 'A newer instruction' });
    await wakeAll(c.ctx, [{ agentId: c.worker.id, taskId: task.id, why: 'assigned', version: task.version }]);
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toEqual([]);
  });

  it('refuses a versioned queued wake if the task changed before take', async () => {
    const c = await fixture();
    const task = await c.task();
    await wakeAll(c.ctx, [{ agentId: c.worker.id, taskId: task.id, why: 'assigned', version: task.version }]);
    const [job] = await c.db.select().from(jobs).where(eq(jobs.taskId, task.id));
    expect(job).toBeDefined();
    await updateTask(c.ctx, c.head.id, task.id, { title: 'A newer instruction' });
    expect(await discardStaleTurn(c.db, job!)).toBe(true);
  });

  it.each(['person', 'head', 'orchestrator'] as const)('ends a wait and wakes its holder on a %s comment', async sender => {
    const c = await fixture();
    const task = await c.task();
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    if (sender === 'person') {
      const response = await c.app.inject({ method: 'POST', url: `/api/tasks/${task.id}/comments`, payload: { text: 'Images are ready.' }, ...as(c.owner) });
      expect(response.statusCode).toBe(201);
    } else {
      const result = await (await c.tools(c[sender].id)).callTool({ name: 'comment', arguments: { task: task.number, text: 'Images are ready.' } });
      expect(result.isError).toBeFalsy();
    }
    expect((await c.read(task.id)).externalWait).toBeNull();
    expect((await c.read(task.id)).silent).toBe(0);
    const turns = await c.db.select().from(jobs).where(eq(jobs.taskId, task.id));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain('Images are ready.');
  });

  it.each(['head', 'orchestrator'] as const)('ends only the named wait on a %s message with task', async sender => {
    const c = await messaging();
    const task = await c.task();
    const other = await c.task();
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    await c.wait(task.number, 'Images', deadline);
    await c.wait(other.number, 'Deployment', deadline);
    const client = await c.tools(c[sender].id);
    const result = await client.callTool({ name: 'message_employee', arguments: { employee: c.worker.id, task: task.number, text: 'Images are ready.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.read(task.id)).silent).toBe(0);
    expect((await c.read(task.id)).externalWait).toBeNull();
    expect((await c.read(other.id)).externalWait).toMatchObject({ reason: 'Deployment' });
    if (sender === 'head') expect(c.ctx.bus.channels(c.company.id)).toContainEqual(expect.objectContaining({
      from: { kind: 'agent', id: c.head.id, departmentId: c.department.id },
      to: { kind: 'agent', id: c.worker.id, departmentId: c.department.id },
    }));
    expect(c.ctx.bus.channels(c.company.id)).not.toContainEqual(expect.objectContaining({
      from: { kind: 'department', id: c.department.id }, to: { kind: 'department', id: c.department.id },
    }));
    const messages = await c.db.select().from(agentEvents).where(eq(agentEvents.agentId, c.worker.id));
    expect(messages.filter(e => e.kind === 'message').map(e => e.data)).toContainEqual(expect.objectContaining({ text: 'Images are ready.', task: { id: task.id, number: task.number } }));
  });

  it.each(['head', 'orchestrator'] as const)('keeps the wait on a %s message without task, even when its text names the task', async sender => {
    const c = await messaging();
    const task = await c.task();
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    const result = await (await c.tools(c[sender].id)).callTool({ name: 'message_employee', arguments: { employee: c.worker.id, text: `#${task.number}: another topic.` } });
    expect(result.isError).toBeFalsy();
    expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Images' });
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toEqual([]);
  });

  it.each(['head', 'orchestrator'] as const)('describes task binding and refuses a blank %s message without resuming work', async sender => {
    const c = await messaging();
    const task = await c.task();
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    const client = await c.tools(c[sender].id);
    const messageTool = (await client.listTools()).tools.find(t => t.name === 'message_employee')!;
    expect(messageTool.description).toContain('With task, the message concerns that task and ends its external wait.');
    expect(messageTool.inputSchema.properties?.text).toMatchObject({ type: 'string', minLength: 1 });
    const result = await client.callTool({ name: 'message_employee', arguments: { employee: c.worker.id, task: task.number, text: ' ' } });
    expect(result.isError).toBe(true);
    expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Images' });
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toEqual([]);
  });

  it('ends the wait when a person answers ask_person on the task', async () => {
    const c = await fixture();
    const task = await c.task();
    const result = await (await c.tools()).callTool({ name: 'ask_person', arguments: { task: task.number, question: 'May I publish?', topic: 'task' } });
    expect(result.isError).toBeFalsy();
    const another = await (await c.tools()).callTool({ name: 'ask_person', arguments: { task: task.number, question: 'Which region?', topic: 'task' } });
    expect(another.isError).toBeFalsy();
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    const [request] = await c.db.select().from(requests).where(eq(requests.taskId, task.id));
    const response = await c.app.inject({ method: 'POST', url: `/api/requests/${request!.id}`, payload: { answer: 'The images are ready.' }, ...as(c.owner) });
    expect(response.statusCode).toBe(200);
    expect(await c.read(task.id)).toMatchObject({ externalWait: null, silent: 0, status: 'waiting' });
    expect((await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).map(j => j.prompt)).toContainEqual(expect.stringContaining('The images are ready.'));
  });

  it('clears external waits in children when the parent task is cancelled', async () => {
    const c = await fixture();
    const parent = (await createTask(c.ctx, { agentId: c.orchestrator.id }, { title: 'Publish', brief: '', body: '', departmentId: c.department.id, assigneeAgentId: c.head.id })).task;
    const child = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Images', brief: '', body: '', departmentId: c.department.id, parentId: parent.id, assigneeAgentId: c.worker.id, executor: true })).task;
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    expect((await c.wait(parent.number, 'Registry', deadline, c.head.id)).isError).toBeFalsy();
    expect((await c.wait(child.number, 'Images', deadline)).isError).toBeFalsy();
    await cancel(c.ctx, { agentId: c.orchestrator.id }, parent.id, 'No longer needed.');
    expect(await c.read(parent.id)).toMatchObject({ status: 'cancelled', externalWait: null });
    expect(await c.read(child.id)).toMatchObject({ status: 'cancelled', externalWait: null });
  });

  it('keeps a queued task message current when work starts, but drops it after reassignment', async () => {
    const c = await fixture();
    const task = await c.task();
    const id = await insertTurn(c.ctx, { companyId: c.company.id, agentId: c.worker.id, taskId: task.id, prompt: 'Images are ready.', createdBy: null, message: { personId: null, text: 'Images are ready.', taskWake: await c.messageState(task) } });
    const [job] = await c.db.select().from(jobs).where(eq(jobs.id, id));
    await c.db.update(tasks).set({ status: 'working', version: sql`${tasks.version} + 1` }).where(eq(tasks.id, task.id));
    expect(await discardStaleTurn(c.db, job!)).toBe(false);
    await c.db.update(tasks).set({ assigneeAgentId: c.peer.id }).where(eq(tasks.id, task.id));
    expect(await discardStaleTurn(c.db, job!)).toBe(true);
  });

  it('refuses a new wait while an unread task message is queued', async () => {
    const c = await fixture();
    const task = await c.task();
    await insertTurn(c.ctx, { companyId: c.company.id, agentId: c.worker.id, taskId: task.id, prompt: 'Images are already ready.', createdBy: null, message: { personId: null, text: 'Images are already ready.', taskWake: await c.messageState(task) } });
    const result = await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('message');
    expect((await c.read(task.id)).externalWait).toBeNull();
  });

  it('accepts the exact two-hour boundary and refuses one millisecond more', async () => {
    const c = await fixture();
    const task = await c.task();
    const now = new Date();
    const until = new Date(now.getTime() + 2 * 3_600_000).toISOString();
    expect((await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until }, now)).task.externalWait).toMatchObject({ until });
    await expect(waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: new Date(Date.parse(until) + 1).toISOString() }, now)).rejects.toMatchObject({ reason: 'task_invalid' });
  });

  it('refuses a deadline equal to now and accepts one millisecond in the future', async () => {
    const c = await fixture();
    const task = await c.task();
    const now = new Date('2026-11-03T10:00:00.000Z');
    await expect(waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until: now.toISOString() }, now)).rejects.toMatchObject({ reason: 'task_invalid' });
    const until = new Date(now.getTime() + 1).toISOString();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until }, now);
    expect((await c.read(task.id)).externalWait).toMatchObject({ until });
  });

  it('leaves an orphaned due wait alone until a holder can receive its wake', async () => {
    const c = await fixture();
    const task = await c.task();
    await c.db.update(tasks).set({ assigneeAgentId: null, externalWait: { reason: 'Images', since: '2026-11-03T09:00:00.000Z', until: '2026-11-03T10:00:00.000Z' } }).where(eq(tasks.id, task.id));
    expect(await checkExternalWaits(c.ctx, new Date('2026-11-03T10:00:00.001Z'))).toBe(0);
    expect((await c.read(task.id)).externalWait?.reason).toBe('Images');
  });

  it('ends a wait once when two server sweeps race', async () => {
    const c = await fixture();
    const task = await c.task();
    const until = new Date(Date.now() + 60_000);
    await c.wait(task.number, 'Images', until.toISOString());
    const counts = await Promise.all([checkExternalWaits(c.ctx, until), checkExternalWaits({ ...c.ctx }, until)]);
    expect(counts.sort()).toEqual([0, 1]);
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toHaveLength(1);
  });

  it('keeps its own comment quiet while it waits', async () => {
    const c = await fixture();
    const task = await c.task();
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    const result = await (await c.tools()).callTool({ name: 'comment', arguments: { task: task.number, text: 'The registry is still working.' } });
    expect(result.isError).toBeFalsy();
    expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Images' });
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toEqual([]);
  });

  it.each(['head', 'orchestrator'] as const)('refuses invalid task bindings on a %s message without clearing another wait', async sender => {
    const c = await messaging();
    const task = await c.task();
    const closed = await c.task();
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, closed.id));
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    const client = await c.tools(c[sender].id);
    for (const input of [{ employee: c.worker.id, task: closed.number }, { employee: c.worker.id, task: 9999 }]) {
      const result = await client.callTool({ name: 'message_employee', arguments: { ...input, text: 'Images are ready.' } });
      expect(result.isError).toBe(true);
      expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Images' });
    }
    const unrelated = await (await c.tools(c.peer.id)).callTool({ name: 'message_employee', arguments: { employee: c.head.id, task: task.number, text: 'Images are ready.' } });
    expect(unrelated.isError).toBe(true);
    expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Images' });
    expect(await c.db.select().from(jobs).where(eq(jobs.taskId, task.id))).toEqual([]);
  });

  it('keeps a concurrent task message visible when wait_for races with it', async () => {
    const c = await messaging();
    const task = await c.task();
    const worker = await c.tools();
    const head = await c.tools(c.head.id);
    const [, sent] = await Promise.all([
      worker.callTool({ name: 'wait_for', arguments: { task: task.number, reason: 'Images', until: new Date(Date.now() + 3_600_000).toISOString() } }),
      head.callTool({ name: 'message_employee', arguments: { employee: c.worker.id, task: task.number, text: 'Images are ready.' } }),
    ]);
    expect(sent.isError).toBeFalsy();
    expect((await c.read(task.id)).externalWait).toBeNull();
    const messages = await c.db.select().from(agentEvents).where(eq(agentEvents.agentId, c.worker.id));
    expect(messages.filter(e => e.kind === 'message').map(e => e.data)).toContainEqual(expect.objectContaining({ text: 'Images are ready.', task: { id: task.id, number: task.number } }));
  });

  it('refuses a wait when a message on its task came into the turn after the call to wait did, and takes the next one', async () => {
    const c = await messaging();
    const task = await c.task();
    await c.tools();
    const heard = async () => (await c.db.select({ seq: sql<number>`coalesce(max(${agentEvents.seq}), 0)` }).from(agentEvents).where(eq(agentEvents.agentId, c.worker.id)))[0]!.seq;
    const called = await heard();
    const sent = await (await c.tools(c.head.id)).callTool({ name: 'message_employee', arguments: { employee: c.worker.id, task: task.number, text: 'Images are ready.' } });
    expect(sent.isError).toBeFalsy();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await expect(waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until }, undefined, called)).rejects.toMatchObject({ reason: 'task_invalid', message: expect.stringContaining(`A message on #${task.number} came`) });
    expect((await c.read(task.id)).externalWait).toBeNull();
    await waitFor(c.ctx, c.worker.id, task.id, { reason: 'Images', until });
    expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Images' });
  });

  it('lets a team worker doing a small subtask and its head both message each other with task', async () => {
    const c = await messaging();
    const [team] = await c.db.insert(teams).values({ companyId: c.company.id, departmentId: c.department.id, name: 'Urgent fixes' }).returning();
    const [robin] = await c.db
      .insert(agents)
      .values({ companyId: c.company.id, departmentId: c.department.id, teamId: team!.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Robin', model: 'claude-opus-5-5', subscriptionId: c.sub.id })
      .returning();
    const parent = (await createTask(c.ctx, { agentId: c.orchestrator.id }, { title: 'Urgent server fixes', brief: '', body: '', departmentId: c.department.id, assigneeAgentId: c.head.id })).task;

    const headTools = await c.tools(c.head.id);
    const created = (await headTools.callTool({
      name: 'create_task',
      arguments: { title: 'Fix task messages', brief: 'One small code result.', body: '', executor: robin!.id, parent: parent.number, small: true, paths: ['logic/totals.ts'] },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(created.isError).toBeFalsy();

    const robinTools = await c.tools(robin!.id);
    const listed = JSON.parse(((await robinTools.callTool({ name: 'tasks', arguments: {} })) as { content: { text: string }[] }).content[0]!.text) as { id: string; number: number; echelons: { stage: string }; assignee: { id: string } | null }[];
    const subtask = listed[0]!;
    expect(subtask).toMatchObject({ echelons: { stage: 'development' }, assignee: { id: robin!.id } });

    const toRobin = (await headTools.callTool({
      name: 'message_employee',
      arguments: { employee: robin!.id, task: subtask.number, text: 'Please check the edge cases too.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(toRobin.isError).toBeFalsy();

    /* The head's turn is over, so its next message starts a turn of its own instead of going into that one. */
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(and(eq(jobs.agentId, c.head.id), eq(jobs.status, 'running')));

    const toHead = (await robinTools.callTool({
      name: 'message_employee',
      arguments: { employee: c.head.id, task: subtask.number, text: 'Checked and ready to submit.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(toHead.isError, toHead.content[0]?.text).toBeFalsy();

    const headJobs = await c.db.select().from(jobs).where(eq(jobs.agentId, c.head.id));
    const headTurn = headJobs.find(j => j.taskId === subtask.id)!;
    expect(headTurn.prompt).toContain('Checked and ready to submit.');
    expect(await discardStaleTurn(c.db, headTurn)).toBe(false);

    const submitted = (await robinTools.callTool({
      name: 'submit',
      arguments: { task: subtask.number, summary: 'Fixed.', evidence: 'Tests pass.', review: { baseCommit: 'a'.repeat(40) } },
    })) as { isError?: boolean };
    expect(submitted.isError).toBeFalsy();
    expect(await discardStaleTurn(c.db, headTurn)).toBe(false);
  });

  it('allows the current owner and executor to forward task messages without granting an unassigned reviewer', async () => {
    const c = await messaging();
    const [rob, outsider] = await c.db
      .insert(agents)
      .values([
        { companyId: c.company.id, departmentId: c.department.id, kind: 'worker', roleKey: 'DEV-REV', name: 'Rob', model: '', subscriptionId: c.sub.id },
        { companyId: c.company.id, departmentId: c.department.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Oleg', model: '', subscriptionId: c.sub.id },
      ])
      .returning();

    const task = await c.task(c.worker.id);
    /* Naming a future reviewer does not make it the current owner. */
    const route = await routeOf(c.db, task);
    await c.db.update(taskRoutes).set({ state: { ...route.state, stages: route.state.stages.map(step => step.stage === 'review' ? { ...step, ownerAgentId: rob!.id } : step) } }).where(eq(taskRoutes.taskId, task.id));
    const beforeGate = (await (await c.tools(rob!.id)).callTool({
      name: 'message_employee',
      arguments: { employee: c.head.id, task: task.number, text: 'Not assigned this stage yet.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(beforeGate.isError).toBe(true);
    expect(beforeGate.content[0]!.text).toBe(`#${task.number} is not with you.\nNot delivered: reason task_not_yours, recipient ${c.head.id}, task #${task.number}.`);

    /* While the holder waits, its own message to the head keeps its external wait intact. */
    await c.wait(task.number, 'Images', new Date(Date.now() + 3_600_000).toISOString());
    const fromWaitingHolder = (await (await c.tools(c.worker.id)).callTool({
      name: 'message_employee',
      arguments: { employee: c.head.id, task: task.number, text: 'Registry still building.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(fromWaitingHolder.isError, fromWaitingHolder.content[0]?.text).toBeFalsy();
    expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Images' });
    const [waitingHeadTurn] = (await c.db.select().from(jobs).where(eq(jobs.agentId, c.head.id))).filter(j => j.taskId === task.id);
    expect(await discardStaleTurn(c.db, waitingHeadTurn!)).toBe(false);

    /* Review has one current owner; the original executor and head retain their own message rights. */
    await c.atReview(task);

    for (const [from, to] of [
      [outsider!.id, c.peer.id],
      [c.worker.id, c.head.id],
      [rob!.id, c.peer.id],
      [c.peer.id, outsider!.id],
      [c.head.id, outsider!.id],
    ] as const) {
      const res = (await (await c.tools(from)).callTool({
        name: 'message_employee',
        arguments: { employee: to, task: task.number, text: 'About the review.' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError, `${from} -> ${to}: ${res.content[0]?.text}`).toBeFalsy();
    }

    const unassigned = (await (await c.tools(rob!.id)).callTool({ name: 'message_employee', arguments: { employee: c.head.id, task: task.number, text: 'Not my current stage.' } })) as { isError?: boolean };
    expect(unassigned.isError).toBe(true);
    for (const to of [c.worker.id, rob!.id, c.head.id] as const) {
      const res = (await (await c.tools(outsider!.id)).callTool({
        name: 'message_employee',
        arguments: { employee: to, task: task.number, text: 'Unrelated.' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError, `outsider -> ${to}`).toBe(true);
      expect(res.content[0]!.text).toBe(`#${task.number} is not with you.\nNot delivered: reason task_not_yours, recipient ${to}, task #${task.number}.`);
    }
  });

  it('lets the orchestrator oversee any task and a department head oversee its department tasks without granting creators or others', async () => {
    const c = await messaging();
    const [ops] = await c.db.insert(departments).values({ companyId: c.company.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [robin, creator, opsHead] = await c.db
      .insert(agents)
      .values([
        { companyId: c.company.id, departmentId: c.department.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Robin', model: 'claude-opus-5-5', subscriptionId: c.sub.id },
        { companyId: c.company.id, departmentId: c.department.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Clara', model: '', subscriptionId: c.sub.id },
        { companyId: c.company.id, departmentId: ops!.id, kind: 'head', roleKey: 'OPS-HEAD', name: 'Wanda', model: '', skills: ['ops-task-watch'], subscriptionId: c.sub.id },
      ])
      .returning();

    /* The orchestrator laid out the task for Development and Robin does it. */
    const laidOut = (
      await createTask(c.ctx, { agentId: c.orchestrator.id }, {
        title: 'Access team fixes',
        brief: '',
        body: '',
        departmentId: c.department.id,
        assigneeAgentId: robin!.id,
        executor: true,
      })
    ).task;
    await c.wait(laidOut.number, 'Build check', new Date(Date.now() + 3_600_000).toISOString(), robin!.id);

    const orchTools = await c.tools(c.orchestrator.id);
    const toHead = (await orchTools.callTool({
      name: 'message_employee',
      arguments: { employee: c.head.id, task: laidOut.number, text: 'Check Robin on this task.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(toHead.isError, toHead.content[0]?.text).toBeFalsy();
    /* Messaging the head does not clear Robin's external wait on the task. */
    expect((await c.read(laidOut.id)).externalWait).toMatchObject({ reason: 'Build check' });
    const headTurn = (await c.db.select().from(jobs).where(eq(jobs.agentId, c.head.id))).find(j => j.taskId === laidOut.id)!;
    expect(headTurn.prompt).toContain('Check Robin on this task.');
    expect(await discardStaleTurn(c.db, headTurn)).toBe(false);

    /* Orchestrator and the department's own head may write about the task to anyone they may write to at all. */
    const orchToOps = (await orchTools.callTool({
      name: 'message_employee',
      arguments: { employee: opsHead!.id, task: laidOut.number, text: 'Watch this build.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(orchToOps.isError, orchToOps.content[0]?.text).toBeFalsy();

    const headTools = await c.tools(c.head.id);
    const headToPeer = (await headTools.callTool({
      name: 'message_employee',
      arguments: { employee: c.peer.id, task: laidOut.number, text: 'Pair with Robin if needed.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(headToPeer.isError, headToPeer.content[0]?.text).toBeFalsy();

    /* Ordinary creators stay out; another department's head and unrelated workers gain nothing. */
    await c.db.update(tasks).set({ createdByAgentId: creator!.id }).where(eq(tasks.id, laidOut.id));
    for (const [from, to] of [
      [creator!.id, c.head.id],
      [creator!.id, c.peer.id],
      [opsHead!.id, c.head.id],
      [opsHead!.id, c.peer.id],
      [c.peer.id, c.head.id],
    ] as const) {
      const res = (await (await c.tools(from)).callTool({
        name: 'message_employee',
        arguments: { employee: to, task: laidOut.number, text: 'Not mine to oversee.' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError, `${from} -> ${to}`).toBe(true);
      expect(res.content[0]!.text).toBe(`#${laidOut.number} is not with you.\nNot delivered: reason task_not_yours, recipient ${to}, task #${laidOut.number}.`);
    }

    /* A person writing through the HTTP endpoint also gains nothing on non-holders, while reaching the holder. */
    const personRefused = await c.app.inject({
      method: 'POST',
      url: `/api/agents/${c.head.id}/messages`,
      payload: { text: 'Any update?', task: laidOut.number },
      ...as(c.owner),
    });
    expect(personRefused.statusCode).toBe(403);
    expect(personRefused.json().error.message).toBe(`#${laidOut.number} is not with you.`);

    const personToHolder = await c.app.inject({
      method: 'POST',
      url: `/api/agents/${robin!.id}/messages`,
      payload: { text: 'Build check finished.', task: laidOut.number },
      ...as(c.owner),
    });
    expect(personToHolder.statusCode).toBe(202);
    expect((await c.read(laidOut.id)).externalWait).toBeNull();
  });

  it('delivers the executor message to another employee while the current Review owner waits externally', async () => {
    const c = await messaging();
    const [rob] = await c.db
      .insert(agents)
      .values({ companyId: c.company.id, departmentId: c.department.id, kind: 'worker', roleKey: 'DEV-REV', name: 'Rob', model: '', subscriptionId: c.sub.id })
      .returning();
    const task = await c.task(c.worker.id);
    await c.atReview(task);
    await c.wait(task.number, 'Staging deploy', new Date(Date.now() + 3_600_000).toISOString(), c.peer.id);

    const sent = (await (await c.tools(c.worker.id)).callTool({
      name: 'message_employee',
      arguments: { employee: rob!.id, task: task.number, text: 'The migration script is ready to check.' },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(sent.isError, sent.content[0]?.text).toBeFalsy();
    expect((await c.read(task.id)).externalWait).toMatchObject({ reason: 'Staging deploy' });

    const [p2Turn] = await c.db.select().from(jobs).where(eq(jobs.agentId, rob!.id));
    expect(p2Turn).toMatchObject({ taskId: task.id, status: 'running', error: null });
    let delivered = await c.node.next();
    while (delivered.type !== 'job.run' || delivered.jobId !== p2Turn!.id) delivered = await c.node.next();
    expect(delivered.prompt).toContain('The migration script is ready to check.');
  });
});
