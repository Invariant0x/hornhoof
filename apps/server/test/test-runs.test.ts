import type { ServerMessage } from '@hornhoof/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, attachments, companies, departments, jobs, subscriptions, tasks, testParts } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { checkTestTimes } from '../src/modules/testruns/runs.js';
import { as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const GIB = 1024 ** 3;
const NODE_KEY = 'builtin-node-key-0123456789abcdef';
const idle = (over: object = {}) => ({ cpus: 8, load: 0.5, memFree: 12 * GIB, memTotal: 16 * GIB, tests: 0, jobs: 0, ...over });
type Res = { content: { text: string }[]; isError?: boolean };
type TestsRun = Extract<ServerMessage, { type: 'tests.run' }>;

/* A company whose development department has a repository, with Bruno at work on #1 there. */
async function company() {
  const { app, db } = await testApp({ NODE_PING_MS: '50', NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1, repoUrl: 'https://github.com/acme/shop.git', repoTokenEnc: encryptSecret('ghp_shop0123456789', app.ctx.config.secret), repoTokenLast4: '6789' },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const [sub] = await db.select().from(subscriptions);
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
  const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
  let n = 0;
  /* A running turn of the agent on a task, and its tools. */
  const turn = async (agent: { id: string }, taskId: string | null = task.id) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    const [job] = await db
      .insert(jobs)
      .values({ companyId, subscriptionId: sub!.id, agentId: agent.id, taskId, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(Date.now() - 1000), toolTokenHash: hashToken(token) })
      .returning();
    const client = await mcp(app, token);
    const call = async (name: string, args: object = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as Res;
      return { text: res.content[0]!.text, error: res.isError === true };
    };
    return { job: job!, call };
  };
  /* A machine of a person with one node, online with this load. */
  const machine = async (token: string, hostname: string, load: object = idle()) => {
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(token) });
    const code = connected.json().command.split('--join ')[1];
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: `${hostname}-0001-abcd`, hostname, os: 'linux', arch: 'x86_64' } })).json();
    const [{ nodeId, subscriptionId, key }] = joined.nodes;
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [] });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(nodeId)) !== null);
    return { node, subscriptionId: subscriptionId as string, machineId: joined.machine.id as string };
  };
  /* A machine of a person that joined without a plan, online with this load. */
  const planless = async (token: string, hostname: string, load: object = idle()) => {
    const code = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command.split('--join ')[1];
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: `${hostname}-0001-abcd`, hostname, os: 'linux', arch: 'x86_64' } })).json();
    const [{ nodeId, key }] = joined.nodes;
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [] });
    await until(() => app.ctx.hub.loadOf(nodeIdentity(nodeId)) !== null);
    return { node, nodeId: nodeId as string, machineId: joined.machine.id as string };
  };
  const ann = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [dev!.id] } });
  const bob = await invitePerson(app, ceo, { name: 'Bob', email: 'bob@acme.com', access: { departments: [sales!.id] } });
  /* The agent's newest turn waiting on the task. */
  const wokeWith = async (agentId: string, taskId = task.id) =>
    (await db.select().from(jobs).where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt))).pop()?.prompt ?? null;
  const filesOn = async (taskId = task.id) =>
    (await db.select({ name: attachments.name, bytes: attachments.bytes }).from(attachments).where(eq(attachments.taskId, taskId)).orderBy(asc(attachments.name))).map(f => ({ name: f.name, text: Buffer.from(f.bytes).toString('utf8') }));
  /* The built-in node, online with this load. */
  const builtin = async (load: object = idle()) => {
    const node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: load as ReturnType<typeof idle>, tests: [] });
    await until(() => app.ctx.hub.loadOf({ kind: 'builtin' }) !== null);
    return node;
  };
  return { app, db, url, ceo, ann, bob, builtin, dev: dev!, sales: sales!, head, bruno, sam, task, turn, machine, planless, wokeWith, filesOn };
}

/* The next message of one kind a node gets, past the others. */
async function nextOf<T extends ServerMessage['type']>(node: FakeNode, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const msg = await node.next();
    if (msg.type === type) return msg as Extract<ServerMessage, { type: T }>;
  }
}

/* Whether a node got a message of this kind within a short wait; what came meanwhile is taken. */
async function gets(node: FakeNode, type: ServerMessage['type'], ms = 300): Promise<boolean> {
  await new Promise(r => setTimeout(r, ms));
  let got = false;
  for (let n = node.queued(); n > 0; n--) if ((await node.next()).type === type) got = true;
  return got;
}

const done = (run: TestsRun, over: object = {}) => ({ type: 'tests.done' as const, partId: run.partId, ok: true, exitCode: 0, error: null, commit: 'a'.repeat(40), log: `part ${run.part} ok\n`, ...over });

describe('a test run', () => {
  it('runs on a machine that joined without a plan, as on any machine of the company', async () => {
    const c = await company();
    const box = await c.planless(c.ceo, 'build-box');
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'npm test' })).error).toBe(false);
    const run = await nextOf(box.node, 'tests.run');
    expect(run).toMatchObject({ command: 'npm test', part: 1, parts: 1 });
    expect((await c.db.select().from(testParts))[0]).toMatchObject({ status: 'running', nodeId: box.nodeId, machineId: box.machineId, machineName: 'build-box' });
    box.node.send(done(run));
    await nextOf(box.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/part 1 of 1 passed on build-box|passed on build-box/i);
  });

  it('splits into parts across the freest machines, puts each log on the task and wakes the agent with the result', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 6 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    const started = await call('run_tests', { command: 'npm test -- --shard={part}/{parts}', parts: 2 });
    expect(started.error).toBe(false);
    expect(started.text).toContain('Test run 1');
    const first = await nextOf(ann.node, 'tests.run');
    const second = await nextOf(ivan.node, 'tests.run');
    expect(first).toMatchObject({ repo: { url: 'https://github.com/acme/shop.git', token: 'ghp_shop0123456789' }, branch: null, task: c.task.number, command: 'npm test -- --shard=1/2', part: 1, parts: 2, timeoutMs: 30 * 60_000 });
    expect(second).toMatchObject({ command: 'npm test -- --shard=2/2', part: 2, parts: 2 });
    ann.node.send({ type: 'tests.started', partId: first.partId });
    ann.node.send(done(first, { log: 'ok 12 tests\n' }));
    expect(await nextOf(ann.node, 'tests.ack')).toEqual({ type: 'tests.ack', partId: first.partId });
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
    ivan.node.send(done(second, { ok: false, exitCode: 1, error: 'failed', log: `${lines}\nFAIL cart.test.ts: expected 2, got 3\n` }));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toContain('Test run 1 failed');
    expect(prompt).toMatch(/part 1 of 2 passed on ann-pc/i);
    expect(prompt).toMatch(/part 2 of 2 failed on ivan-mac/i);
    expect(prompt).toContain('> FAIL cart.test.ts: expected 2, got 3');
    expect(prompt).not.toContain('line 1\n');
    expect(prompt).toContain('tests-1-2.log');
    expect(await c.filesOn()).toEqual([
      { name: 'tests-1-1.log', text: 'ok 12 tests\n' },
      { name: 'tests-1-2.log', text: `${lines}\nFAIL cart.test.ts: expected 2, got 3\n` },
    ]);
    const state = JSON.parse((await call('test_run', { run: 1 })).text);
    expect(state).toMatchObject({ run: 1, task: c.task.number, status: 'failed', parts: [{ part: 1, status: 'passed', machine: 'ann-pc', log: 'tests-1-1.log' }, { part: 2, status: 'failed', machine: 'ivan-mac', exitCode: 1 }] });
  });

  it('runs one part at a time on a machine, and a part that finds none free waits for the first that frees up', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', branch: 'task-1-checkout' });
    const one = await nextOf(ivan.node, 'tests.run');
    expect(one.branch).toBe('task-1-checkout');
    const waits = await call('run_tests', { command: 'make test', branch: 'task-1-checkout' });
    expect(waits.text).toMatch(/waits for a free machine/);
    expect(JSON.parse((await call('test_run', { run: 2 })).text)).toMatchObject({ status: 'running', parts: [{ part: 1, status: 'queued', machine: null }] });
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send(done(one));
    const two = await nextOf(ivan.node, 'tests.run');
    expect(two.partId).not.toBe(one.partId);
  });

  it('waits while no machine has the free memory its repository needs', async () => {
    const c = await company();
    await c.db.update(departments).set({ repoTestMemoryGb: 8 }).where(eq(departments.id, c.dev.id));
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ memFree: 6 * GIB }));
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/waits for a free machine/);
    expect(await gets(ivan.node, 'tests.run')).toBe(false);
    ivan.node.send({ type: 'load', ...idle({ memFree: 9 * GIB }) });
    expect((await nextOf(ivan.node, 'tests.run')).command).toBe('make test');
  });

  it('leaves out a machine its owner took back, and one whose owner does not reach the repository', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac', idle({ load: 7 }));
    const ann = await c.machine(c.ann, 'ann-pc');
    const bob = await c.machine(c.bob, 'bob-pc');
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: false }, ...as(c.ann) })).statusCode).toBe(200);
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 3 });
    expect((await nextOf(ivan.node, 'tests.run')).part).toBe(1);
    expect(await gets(ann.node, 'tests.run')).toBe(false);
    expect(await gets(bob.node, 'tests.run')).toBe(false);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/machines/${ann.machineId}`, payload: { lendsTests: true }, ...as(c.ann) })).statusCode).toBe(200);
    expect((await nextOf(ann.node, 'tests.run')).part).toBe(2);
  });

  it('fails a part that runs past its time, and tells its node to stop it', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test', minutes: 5 });
    const run = await nextOf(ivan.node, 'tests.run');
    expect(run.timeoutMs).toBe(5 * 60_000);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 4 * 60_000));
    expect(await gets(ivan.node, 'tests.cancel')).toBe(false);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 15 * 60_000));
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*did not end within 5 min/);
  });

  it('stops on stop_tests: its parts end, their nodes stop them, and nobody is woken', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    const run = await nextOf(ivan.node, 'tests.run');
    const stopped = await call('stop_tests', { run: 1 });
    expect(stopped).toEqual({ text: 'Test run 1 is stopped.', error: false });
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
    expect(JSON.parse((await call('test_run', { run: 1 })).text)).toMatchObject({ status: 'stopped', parts: [{ status: 'stopped' }, { status: 'stopped' }] });
    ivan.node.send(done(run, { ok: false, error: 'cancelled', exitCode: null, log: 'Stopped.\n' }));
    await nextOf(ivan.node, 'tests.ack');
    expect(await c.filesOn()).toEqual([{ name: 'tests-1-1.log', text: 'Stopped.\n' }]);
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    expect((await call('stop_tests', { run: 1 })).error).toBe(true);
    /* Sales sees nothing of development's runs. */
    expect((await (await c.turn(c.sam, null)).call('stop_tests', { run: 1 })).text).toMatch(/no test run 1/i);
  });

  it('wakes its agent when another one stopped it', async () => {
    const c = await company();
    await c.machine(c.ceo, 'ivan-mac');
    await (await c.turn(c.bruno)).call('run_tests', { command: 'make test' });
    expect((await (await c.turn(c.head, null)).call('stop_tests', { run: 1 })).error).toBe(false);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 was stopped by Hana/);
  });

  it('fails a part its machine lost when it restarted, and stops one Hornhoof ended meanwhile', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const run = await nextOf(ivan.node, 'tests.run');
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [] });
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*restarted/);
    ivan.node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], load: idle(), tests: [run.partId] });
    expect(await nextOf(ivan.node, 'tests.cancel')).toEqual({ type: 'tests.cancel', partId: run.partId });
  });

  it("does not count a turn that ended while its test run goes on as standing still", async () => {
    const c = await company();
    await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job.id));
    await afterJob(c.app.ctx, job.id);
    expect((await c.db.select({ silent: tasks.silent }).from(tasks).where(eq(tasks.id, c.task.id)))[0]).toEqual({ silent: 0 });
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
  });

  it('goes to the built-in node too, which reaches every repository', async () => {
    const c = await company();
    const node = await c.builtin();
    await (await c.turn(c.bruno)).call('run_tests', { command: 'make test' });
    const run = await nextOf(node, 'tests.run');
    node.send(done(run));
    await nextOf(node, 'tests.ack');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 passed[\s\S]*Part 1 of 1 passed on the built-in node/);
  });

  it('ends a part that found no free machine within 2 hours', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect((await call('run_tests', { command: 'make test' })).text).toMatch(/No machine that may take it is online now/);
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    await checkTestTimes(c.app.ctx, new Date(Date.now() + 3 * 60 * 60_000));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Test run 1 failed[\s\S]*no machine was free for it within 120 min/);
  });

  it('fails the parts of a machine disconnected from the company, and of a subscription removed', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const ann = await c.machine(c.ann, 'ann-pc');
    const { call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test -- {part}', parts: 2 });
    await nextOf(ivan.node, 'tests.run');
    await nextOf(ann.node, 'tests.run');
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${ivan.machineId}/disconnect`, ...as(c.ceo) })).statusCode).toBe(204);
    expect((await c.app.inject({ method: 'DELETE', url: `/api/subscriptions/${ann.subscriptionId}`, ...as(c.ann) })).statusCode).toBe(204);
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const prompt = (await c.wokeWith(c.bruno.id))!;
    expect(prompt).toMatch(/disconnected from the company/);
    expect(prompt).toMatch(/subscription whose node ran it was removed/);
  });

  it('brings its result into the turn that already waits on the task', async () => {
    const c = await company();
    const ivan = await c.machine(c.ceo, 'ivan-mac');
    const { job, call } = await c.turn(c.bruno);
    await call('run_tests', { command: 'make test' });
    const run = await nextOf(ivan.node, 'tests.run');
    await c.db.insert(jobs).values({ companyId: job.companyId, subscriptionId: job.subscriptionId, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Rita sent it back.', timeoutMs: 900000 });
    ivan.node.send(done(run));
    await nextOf(ivan.node, 'tests.ack');
    await until(async () => /Test run 1 passed/.test((await c.wokeWith(c.bruno.id)) ?? ''));
    expect(await c.wokeWith(c.bruno.id)).toMatch(/^Rita sent it back\.\n\nThe tests you ran on #1/);
    expect((await c.db.select().from(jobs).where(and(eq(jobs.agentId, c.bruno.id), eq(jobs.status, 'queued')))).length).toBe(1);
  });

  it('is refused without a repository, without {part} in a split command, past 3 open runs, and without a task', async () => {
    const c = await company();
    const { call } = await c.turn(c.bruno);
    expect(await call('run_tests', { command: 'make test', parts: 2 })).toMatchObject({ error: true, text: expect.stringContaining('{part}') });
    for (let i = 0; i < 3; i++) expect((await call('run_tests', { command: 'make test' })).error).toBe(false);
    expect(await call('run_tests', { command: 'make test' })).toMatchObject({ error: true, text: expect.stringContaining('3') });
    expect((await (await c.turn(c.sam, null)).call('run_tests', { command: 'make test' })).text).toMatch(/task/);
    const [own] = await c.db.insert(tasks).values({ companyId: c.task.companyId, number: 99, title: 'Pitch', brief: '', body: '', departmentId: c.sales.id, assigneeAgentId: c.sam.id, status: 'working' }).returning();
    expect((await (await c.turn(c.sam, own!.id)).call('run_tests', { command: 'make test' })).text).toMatch(/repository/);
  });
});
