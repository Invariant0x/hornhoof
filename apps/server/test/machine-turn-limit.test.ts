import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments, jobs, machines, nodes, people, programOperatorCases, taskEvents, tasks, waitNotices } from '../src/db/schema.js';
import { startProgram, windowNode } from '../src/modules/conversation/queue.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { checkOperatorHealth } from '../src/modules/program-operator/health.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { as, connectNode, echelonsTurn, invitePerson, listen, nextOf, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

type Run = { type: 'job.run'; jobId: string; prompt: string };

const GIB = 1024 ** 3;
const HOUR = 3_600_000;
const MAC = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
const codeOf = (command: string) => command.split('--join ')[1]!;
/* A machine with room to spare: plenty of free memory, idle processors, and no word of which programs run there, so only
   the limit of turns holds a turn on it. */
const HELLO = { type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [], load: { cpus: 10, load: 1, memFree: 8 * GIB, memTotal: 12 * GIB, tests: 0, jobs: 0 } };

/* The CEO's Claude plan on dev-mac, which is the CEO's, and employees of Development and Operations on it. The clock
   moves only where a test hands a later time to what it calls. */
async function planOnOneMachine() {
  const { app, db } = await testApp();
  onTestFinished(() => app.close());
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
  const plan = connected.subscriptions[0].id as string;
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...MAC } })).json();
  const mac = await connectNode(url, joined.nodes[0].key as string);
  const [acme] = await db.select().from(companies);
  const [box] = await db.select().from(machines);
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [ops] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
  const hire = async (name: string, departmentId = ops!.id, kind: 'worker' | 'head' = 'worker', roleKey = 'OPS-WATCH') =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId, model: '', subscriptionId: plan }).returning())[0]!;
  const state = async (id: string) => (await app.inject({ url: `/api/agents/${id}/events`, ...as(ceo) })).json().state;
  const bruno = await hire('Bruno');
  mac.send(HELLO);
  await until(async () => (await state(bruno.id)).ready);
  const write = async (id: string, text: string) =>
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, payload: { text }, ...as(ceo) })).statusCode).toBeLessThan(300);
  const limit = (value: number | null, token = ceo) => app.inject({ method: 'PUT', url: `/api/machines/${box!.id}/turn-limit`, payload: { limit: value }, ...as(token) });
  const statusOf = async (jobId: string) => (await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)))[0]?.status;
  /* A turn ends as its node tells: done, or broken by its program. */
  const end = async (run: Run, ok = true) => {
    mac.send(ok ? { type: 'job.done', jobId: run.jobId, ok: true, sessionId: 'session', result: 'Done.', tail: '', error: null } : { type: 'job.done', jobId: run.jobId, ok: false, sessionId: 'session', result: '', tail: 'Broke.', error: 'agent_failed' });
    await until(async () => (await statusOf(run.jobId)) !== 'running');
  };
  return { app, db, ctx: app.ctx, ceo, mac, box: box!, companyId: acme!.id, dev: dev!, ops: ops!, hire, bruno, state, write, limit, end, statusOf };
}

async function nextRun(node: FakeNode): Promise<Run> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as Run;
}

/* No message waits at the node: nothing more went out to it. */
const nothingSent = (node: FakeNode) => expect(node.queued()).toBe(0);

const runningOn = async (c: Awaited<ReturnType<typeof planOnOneMachine>>) =>
  (await c.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'running')))).length;

describe('a limit of turns at once on a machine', () => {
  it('lets two of three turns run under a limit of 2; the third waits, says so, and starts once the first ends', async () => {
    const c = await planOnOneMachine();
    const vera = await c.hire('Vera');
    const ida = await c.hire('Ida');
    expect((await c.limit(2)).json()).toEqual({ turnLimit: 2 });
    await c.write(c.bruno.id, 'First');
    const first = await nextRun(c.mac);
    await c.write(vera.id, 'Second');
    expect((await nextRun(c.mac)).prompt).toContain('Second');
    await c.write(ida.id, 'Third');
    expect(await c.state(ida.id)).toMatchObject({ ready: true, reason: null, queued: 1, slotWait: true, memoryWait: false });
    nothingSent(c.mac);
    await c.end(first);
    expect((await nextRun(c.mac)).prompt).toContain('Third');
    expect((await c.state(ida.id)).slotWait).toBe(false);
    expect(await runningOn(c)).toBe(2);
  });

  it('frees the place of a turn that broke, and of one a person stopped, so the waiting turns start by themselves', async () => {
    const c = await planOnOneMachine();
    const vera = await c.hire('Vera');
    const ida = await c.hire('Ida');
    await c.limit(1);
    await c.write(c.bruno.id, 'Breaks');
    const broken = await nextRun(c.mac);
    await c.write(vera.id, 'Stopped by a person');
    await c.write(ida.id, 'Last');
    nothingSent(c.mac);
    await c.end(broken, false);
    const stopped = await nextRun(c.mac);
    expect(stopped.prompt).toContain('Stopped by a person');
    expect((await c.app.inject({ method: 'POST', url: `/api/agents/${vera.id}/stop`, ...as(c.ceo) })).statusCode).toBe(202);
    await nextOf(c.mac, 'job.cancel');
    c.mac.send({ type: 'job.done', jobId: stopped.jobId, ok: false, sessionId: 'session', result: 'Stopped.', tail: '', error: 'cancelled' });
    expect((await nextRun(c.mac)).prompt).toContain('Last');
  });

  it('stops no running turn when the limit goes down, holds new turns until fewer run, and starts the waiting ones at once when it goes up', async () => {
    const c = await planOnOneMachine();
    const crew = [c.bruno, await c.hire('Vera'), await c.hire('Ida')];
    const runs: Run[] = [];
    for (const agent of crew) {
      await c.write(agent.id, `Work of ${agent.name}`);
      runs.push(await nextRun(c.mac));
    }
    expect((await c.limit(1)).statusCode).toBe(200);
    nothingSent(c.mac);
    expect(await runningOn(c)).toBe(3);
    const max = await c.hire('Max');
    const lea = await c.hire('Lea');
    await c.write(max.id, 'Waits for fewer');
    await c.write(lea.id, 'Waits too');
    await c.end(runs[0]!);
    await c.end(runs[1]!);
    expect(await c.state(max.id)).toMatchObject({ queued: 1, slotWait: true });
    nothingSent(c.mac);
    await c.end(runs[2]!);
    expect((await nextRun(c.mac)).prompt).toContain('Waits for fewer');
    nothingSent(c.mac);
    expect((await c.state(lea.id)).slotWait).toBe(true);
    await c.limit(2);
    expect((await nextRun(c.mac)).prompt).toContain('Waits too');
  });

  it('opens the program for a person who opens a window at once, past the limit, and counts that start as no turn', async () => {
    const c = await planOnOneMachine();
    const vera = await c.hire('Vera');
    const ida = await c.hire('Ida');
    await c.limit(1);
    await c.write(c.bruno.id, 'Holds the place');
    const first = await nextRun(c.mac);
    /* Her window puts her program on the machine, as opening it in Hornhoof does, whatever its places. */
    const window = await windowNode(c.ctx, vera.id);
    const [node] = await c.db.select({ id: nodes.id }).from(nodes);
    expect(window?.node).toEqual(nodeIdentity(node!.id));
    await startProgram(c.ctx, window!.node, vera.id);
    const opened = await nextRun(c.mac);
    expect(opened.prompt).toBe('');
    expect((await c.state(vera.id)).slotWait).toBe(false);
    await c.write(ida.id, 'Waits for Bruno alone');
    expect((await c.state(ida.id)).slotWait).toBe(true);
    nothingSent(c.mac);
    await c.end(first);
    expect((await nextRun(c.mac)).prompt).toContain('Waits for Bruno alone');
  });

  it('starts waiting turns first come, first served, an urgent task\'s ahead of the rest', async () => {
    const c = await planOnOneMachine();
    const vera = await c.hire('Vera');
    const ida = await c.hire('Ida');
    const head = await c.hire('Hana', c.dev.id, 'head', 'DEV-HEAD');
    const max = await c.hire('Max', c.dev.id, 'worker', 'DEV-BE');
    await c.limit(1);
    await c.write(c.bruno.id, 'Runs first');
    const first = await nextRun(c.mac);
    await c.write(vera.id, 'Came second');
    await c.write(ida.id, 'Came third');
    const { task } = await createTask(c.ctx, { agentId: head.id }, { title: 'Hotfix', brief: '', body: 'Fix it now', departmentId: c.dev.id, assigneeAgentId: max.id, executor: true, resultKind: 'code' });
    await c.db.update(tasks).set({ urgent: true }).where(eq(tasks.id, task.id));
    await wakeAll(c.ctx, [{ agentId: max.id, taskId: task.id, why: 'assigned' }]);
    expect((await c.state(max.id)).slotWait).toBe(true);
    nothingSent(c.mac);
    await c.end(first);
    const urgent = await nextRun(c.mac);
    expect(urgent.prompt).toContain('Hotfix');
    await c.end(urgent);
    const second = await nextRun(c.mac);
    expect(second.prompt).toContain('Came second');
    await c.end(second);
    expect((await nextRun(c.mac)).prompt).toContain('Came third');
  });

  it('is set only by the machine\'s owner, the CEO or the orchestrator, as a whole number of 1 or more, or nothing for no limit', async () => {
    const c = await planOnOneMachine();
    const wide = await invitePerson(c.app, c.ceo, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const devPerson = await invitePerson(c.app, c.ceo, { name: 'Dora', email: 'dora@acme.com', access: { departments: [c.dev.id], teams: [] } });
    for (const token of [wide, devPerson]) {
      const refused = await c.limit(3, token);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.reason).toBe('turn_limit_not_yours');
    }
    expect((await c.db.select({ limit: machines.turnLimit }).from(machines))[0]!.limit).toBeNull();
    for (const wrong of [0, -1, 1.5, '2']) expect((await c.app.inject({ method: 'PUT', url: `/api/machines/${c.box.id}/turn-limit`, payload: { limit: wrong }, ...as(c.ceo) })).statusCode).toBe(400);
    expect((await c.limit(3)).json()).toEqual({ turnLimit: 3 });
    const listed = (await c.app.inject({ url: '/api/machines', ...as(c.ceo) })).json();
    expect(listed.machines.find((m: { id: string }) => m.id === c.box.id)).toMatchObject({ turnLimit: 3 });
    expect((await c.limit(null)).json()).toEqual({ turnLimit: null });
    /* Once the machine is Wes's own he sets it; the CEO's machine stays out of his reach. */
    const [owner] = await c.db.select({ personId: machines.personId }).from(machines);
    const [wes] = await c.db.select({ id: people.id }).from(people).where(eq(people.email, 'wes@acme.com'));
    await c.db.update(machines).set({ personId: wes!.id }).where(eq(machines.id, c.box.id));
    expect((await c.limit(4, wide)).json()).toEqual({ turnLimit: 4 });
    await c.db.update(machines).set({ personId: owner!.personId }).where(eq(machines.id, c.box.id));
    expect((await c.limit(5, wide)).statusCode).toBe(403);
    /* The orchestrator sets it as the CEO; a head that calls the same route as the CEO is refused. */
    const head = await c.hire('Hana', c.dev.id, 'head', 'DEV-HEAD');
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const inside = (agentId: string, limit: number) => c.app.inject({ method: 'PUT', url: `/api/machines/${c.box.id}/turn-limit`, payload: { limit }, headers: orchestratorHeaders(owner!.personId, agentId) });
    const byHead = await inside(head.id, 6);
    expect([byHead.statusCode, byHead.json().error.reason]).toEqual([403, 'turn_limit_not_yours']);
    expect((await inside(orchestrator!.id, 7)).json()).toEqual({ turnLimit: 7 });
  });

  it('is not taken for a hang: the task watchers, the quiet-department notice and the program operator leave a waiting turn alone', async () => {
    const c = await planOnOneMachine();
    await echelonsTurn(c.db, c.companyId);
    const head = await c.hire('Hana', c.dev.id, 'head', 'DEV-HEAD');
    const max = await c.hire('Max', c.dev.id, 'worker', 'DEV-BE');
    await c.limit(1);
    await c.write(c.bruno.id, 'Holds the place');
    await nextRun(c.mac);
    const { task } = await createTask(c.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: 'Work', departmentId: c.dev.id, assigneeAgentId: max.id, executor: true, resultKind: 'code' });
    await wakeAll(c.ctx, [{ agentId: max.id, taskId: task.id, why: 'assigned' }]);
    expect((await c.state(max.id)).slotWait).toBe(true);
    const [waiting] = await c.db.select().from(jobs).where(and(eq(jobs.agentId, max.id), eq(jobs.status, 'queued')));
    for (const later of [HOUR, 3 * HOUR]) {
      const now = new Date(Date.now() + later);
      await reconcile(c.ctx, now);
      await checkWaitHealth(c.ctx, now);
      await checkOperatorHealth(c.ctx, now);
    }
    expect(await c.statusOf(waiting!.id)).toBe('queued');
    expect(await c.db.select().from(jobs).where(eq(jobs.agentId, max.id))).toHaveLength(1);
    expect(await c.db.select().from(waitNotices)).toEqual([]);
    expect(await c.db.select().from(programOperatorCases)).toEqual([]);
    expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), inArray(taskEvents.kind, ['reminded', 'stuck'])))).toEqual([]);
    nothingSent(c.mac);
  });
});
