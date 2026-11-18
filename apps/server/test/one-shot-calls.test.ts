import type { ServerMessage } from '@hornhoof/protocol';
import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { jobs, oneShotCalls, taskEvents, taskRoutes, tasks } from '../src/db/schema.js';
import { callEnded, retryCallBatches, startCalls } from '../src/modules/calls/calls.js';
import { keepWakes } from '../src/modules/tasks/outbox.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { as, mcp, nextOf, until, type FakeNode } from './helpers.js';
import { ownDatabases } from './helpers-db.js';
import { company } from './test-runs-company.js';

/* One test adds a constraint to see a failed wake kept; a truncate does not undo that, so this file has its own databases. */
ownDatabases();

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
type Company = Awaited<ReturnType<typeof company>>;

/* A running turn of the agent on #1, on the plan of this machine's node, and its tools. */
async function callerOn(c: Company, agent: { id: string }, machine: { nodeId: string; subscriptionId: string }) {
  const token = `tool-token-caller-${agent.id}-0123456789abcdef`;
  await c.db.insert(jobs).values({ companyId: c.task.companyId, subscriptionId: machine.subscriptionId, nodeId: machine.nodeId, agentId: agent.id, taskId: c.task.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
  const client = await mcp(c.app, token);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content[0]!.text, error: res.isError === true };
  };
}

/* The node runs a call and answers with this result. */
function answer(node: FakeNode, run: JobRun, result: string, ok = true) {
  node.send({ type: 'job.started', jobId: run.jobId });
  node.send({ type: 'job.done', jobId: run.jobId, ok, sessionId: null, result, tail: ok ? '' : result, error: ok ? null : 'agent_failed' });
}

const callLines = (c: Company) => c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'call'))).orderBy(asc(taskEvents.id));

describe('one-shot calls', () => {
  it("run on the caller's own plan and machine, one per input, and wake the caller on the task with every result once all have ended", async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    const started = await call('start_calls', { brief: 'Look for unsafe SQL in this file.', inputs: ['src/orders.ts', 'src/users.ts'] });
    expect(started).toMatchObject({ error: false, text: expect.stringMatching(/^Started 2 one-shot calls on #1 in batch [0-9a-f-]{36}\./) });
    const first = await nextOf(mac.node, 'job.run'), second = await nextOf(mac.node, 'job.run');
    for (const run of [first, second]) {
      expect(run).toMatchObject({ call: true, subscriptionId: mac.subscriptionId, provider: 'claude', sessionId: null, toolToken: null, instructions: null });
      expect(run.prompt).toContain('Look for unsafe SQL in this file.');
    }
    expect(first.prompt).toContain('src/orders.ts');
    expect(second.prompt).toContain('src/users.ts');
    answer(mac.node, first, 'No unsafe SQL.');
    await until(async () => (await callLines(c)).length === 1);
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    answer(mac.node, second, 'Line 12 builds SQL from a string.');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const woke = (await c.wokeWith(c.bruno.id))!;
    expect(woke).toMatch(/^The one-shot calls you started on #1 "Checkout" ended/);
    expect(woke).toMatch(/Call 1 is done[\s\S]*src\/orders\.ts[\s\S]*No unsafe SQL\./);
    expect(woke).toMatch(/Call 2 is done[\s\S]*src\/users\.ts[\s\S]*Line 12 builds SQL from a string\./);
    const lines = await callLines(c);
    expect(lines.map(l => l.data)).toEqual([
      expect.objectContaining({ number: 1, brief: 'Look for unsafe SQL in this file.', input: 'src/orders.ts', status: 'done', result: 'No unsafe SQL.', startedAt: expect.any(String), finishedAt: expect.any(String) }),
      expect.objectContaining({ number: 2, input: 'src/users.ts', status: 'done', result: 'Line 12 builds SQL from a string.' }),
    ]);
  });

  it('leaves a batch unclaimed if its durable wake fails and delivers it on retry', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    await call('start_calls', { brief: 'Check the status.' });
    const { jobId } = await nextOf(mac.node, 'job.run');
    await c.db.update(jobs).set({ status: 'done', result: 'All clear.' }).where(eq(jobs.id, jobId));
    await c.db.execute(sql.raw("ALTER TABLE pending_wakes ADD CONSTRAINT reject_calls_wake CHECK (why <> 'calls')"));
    try {
      await callEnded(c.app.ctx, jobId);
      expect((await c.db.select().from(oneShotCalls).where(eq(oneShotCalls.jobId, jobId)))[0]!.told).toBe(false);
      expect(await c.wokeWith(c.bruno.id)).toBeNull();
    } finally {
      await c.db.execute(sql.raw('ALTER TABLE pending_wakes DROP CONSTRAINT reject_calls_wake'));
    }
    await retryCallBatches(c.app.ctx);
    expect(await c.wokeWith(c.bruno.id)).toContain('All clear.');
  });

  it.each([false, true])('delivers to the waiting caller or its task if it stopped waiting (%s)', async stopped => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    await callerOn(c, c.bruno, mac);
    const [caller] = await c.db.select().from(jobs).where(eq(jobs.agentId, c.bruno.id));
    const stop = new AbortController();
    const waiting = startCalls(c.app.ctx, {
      id: caller!.id, companyId: c.bruno.companyId, agentId: c.bruno.id, agentKind: c.bruno.kind,
      roleKey: c.bruno.roleKey, departmentId: c.bruno.departmentId, skills: c.bruno.skills,
    }, { brief: 'Check the links.', wait: true }, stop.signal);
    const { jobId } = await nextOf(mac.node, 'job.run');
    if (stopped) stop.abort();
    await c.db.update(jobs).set({ status: 'done', result: 'The links work.' }).where(eq(jobs.id, jobId));
    await callEnded(c.app.ctx, jobId);
    expect(await waiting).toContain(stopped ? 'You stopped waiting' : 'The links work.');
    const woke = await c.wokeWith(c.bruno.id);
    if (stopped) expect(woke).toContain('The links work.');
    else expect(woke).toBeNull();
  });

  it('runs calls and their judge untimed by default and carries an explicit caller deadline', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    await call('start_calls', { brief: 'Check one link.', judge: 'Read its answer.' });
    const run = await nextOf(mac.node, 'job.run');
    expect(run.timeoutMs).toBe(0);
    answer(mac.node, run, 'It works.');
    expect((await nextOf(mac.node, 'job.run')).timeoutMs).toBe(0);
    expect((await call('start_calls', { brief: 'Check another link.', minutes: 121 })).error).toBe(false);
    expect((await nextOf(mac.node, 'job.run')).timeoutMs).toBe(121 * 60_000);
  });

  it('take any count in one start_calls, each going to the machine at once', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    expect((await call('start_calls', { brief: 'Translate this string.', inputs: Array.from({ length: 150 }, (_, i) => `string ${i + 1}`) })).text).toMatch(/^Started 150 one-shot calls on #1 /);
    for (let i = 0; i < 150; i += 1) await nextOf(mac.node, 'job.run');
    expect((await call('start_calls', { brief: 'Try a name for the product.', count: 120 })).text).toMatch(/^Started 120 one-shot calls on #1 /);
  });

  it('clone the branch they name into a fresh folder of each call', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    expect((await call('start_calls', { brief: 'Read the README and list what is missing.', branch: 'task-1' })).error).toBe(false);
    const run = await nextOf(mac.node, 'job.run');
    expect(run.workspace).toMatchObject({ key: run.jobId, repo: { url: 'https://github.com/acme/shop.git', branch: 'task-1', token: 'ghp_shop0123456789' } });
    expect(run.prompt).toContain('a fresh clone of https://github.com/acme/shop.git at branch task-1, in ./shop');
  });

  it('ask each call for a verdict, then hand every answer to one judge call, and wake the caller with its verdict', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    await call('start_calls', { brief: 'Review the change for bugs.', count: 2, verdict: true, judge: 'Keep only the findings that are real.' });
    const one = await nextOf(mac.node, 'job.run'), two = await nextOf(mac.node, 'job.run');
    expect(one.prompt).toContain('VERDICT: {"pass": true or false');
    answer(mac.node, one, 'A null check is missing.\nVERDICT: {"pass": false, "reason": "a null check is missing"}');
    answer(mac.node, two, 'Looks fine.\nVERDICT: {"pass": true, "reason": "nothing found"}');
    const judge = await nextOf(mac.node, 'job.run');
    expect(judge).toMatchObject({ call: true });
    expect(judge.prompt).toContain('Keep only the findings that are real.');
    expect(judge.prompt).toContain('A null check is missing.');
    expect(judge.prompt).toContain('Looks fine.');
    expect(await c.wokeWith(c.bruno.id)).toBeNull();
    answer(mac.node, judge, 'The null check finding is real.\nVERDICT: {"pass": false, "reason": "the null check is missing"}');
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    const woke = (await c.wokeWith(c.bruno.id))!;
    expect(woke).toMatch(/The judge's verdict: did not pass: the null check is missing\./);
    expect(woke).toMatch(/Call 1 is done, verdict: did not pass: a null check is missing\./);
    expect(woke).toMatch(/Call 2 is done, verdict: passed: nothing found\./);
    expect((await callLines(c)).map(l => l.data.judge)).toEqual([false, false, true]);
  });

  it('can be read later with calls, and a failed one says how it failed', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    const batch = /batch ([0-9a-f-]{36})/.exec((await call('start_calls', { brief: 'Translate into French.', inputs: ['Hello'] })).text)![1]!;
    expect(JSON.parse((await call('calls', { batch })).text)).toMatchObject({ batch, task: 1, calls: [{ number: 1, input: 'Hello', status: 'queued' }] });
    const run = await nextOf(mac.node, 'job.run');
    answer(mac.node, run, 'Kimi Code has no mode that runs one call and exits, so it takes no one-shot calls.', false);
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Call 1 failed[\s\S]*has no mode that runs one call and exits/);
    expect(JSON.parse((await call('calls', { batch })).text)).toMatchObject({ calls: [{ number: 1, status: 'failed', error: 'agent_failed', startedAt: expect.any(String), finishedAt: expect.any(String) }] });
  });

  it('stop with stop_calls, both one that runs and one that has not started yet, and the caller hears it', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    const batch = /batch ([0-9a-f-]{36})/.exec((await call('start_calls', { brief: 'Check the links.', count: 2 })).text)![1]!;
    const one = await nextOf(mac.node, 'job.run'), two = await nextOf(mac.node, 'job.run');
    mac.node.send({ type: 'job.started', jobId: one.jobId });
    await until(async () => (await c.db.select().from(jobs).where(eq(jobs.id, one.jobId)))[0]!.status === 'running');
    expect(await call('stop_calls', { batch })).toEqual({ error: false, text: `Stopping 2 calls of batch ${batch}.` });
    const stopped = [(await nextOf(mac.node, 'job.cancel')).jobId, (await nextOf(mac.node, 'job.cancel')).jobId];
    expect(stopped.sort()).toEqual([one.jobId, two.jobId].sort());
    mac.node.send({ type: 'job.done', jobId: one.jobId, ok: false, sessionId: null, result: '', tail: 'Stopped.', error: 'cancelled' });
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/Call 1 failed \(cancelled\)[\s\S]*Call 2 failed \(cancelled\)/);
  });

  it('end at once, and the caller hears why, when no machine of its plan is online', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    mac.node.close();
    await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(mac.nodeId)));
    expect(await call('start_calls', { brief: 'Count the words.' })).toEqual({ error: true, text: expect.stringMatching(/^No machine of your plan is online to run one-shot calls/) });
  });

  it('run a one-shot stage of the echelons: its owner hears so, and start_calls takes its fan-out and judge', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const [route] = await c.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, c.task.id));
    const stages = route!.state.stages.map(s => (s.stage === 'review' ? { ...s, status: 'active' as const, ownerAgentId: c.bruno.id } : s.stage === 'development' ? { ...s, status: 'complete' as const } : s));
    const oneShot = { review: { fanOut: 3, judge: 'Keep only the findings that are real.' } };
    await c.db.update(taskRoutes).set({ state: { ...route!.state, stage: 'review', stages, oneShot } }).where(eq(taskRoutes.taskId, c.task.id));
    await c.db.update(tasks).set({ status: 'review', assigneeAgentId: c.bruno.id }).where(eq(tasks.id, c.task.id));
    const wakes = [{ agentId: c.bruno.id, taskId: c.task.id, why: 'review' as const }];
    await keepWakes(c.db, c.task.companyId, wakes);
    await wakeAll(c.app.ctx, wakes);
    await until(async () => (await c.wokeWith(c.bruno.id)) !== null);
    expect(await c.wokeWith(c.bruno.id)).toMatch(/This stage of #1 is one-shot: start_calls runs it as 3 calls of your plan on your brief, then a judge call that reads every answer\./);
    const call = await callerOn(c, c.bruno, mac);
    expect((await call('start_calls', { brief: 'Review the change on branch task-1 for bugs.' })).text).toMatch(/^Started 3 one-shot calls on #1 [\s\S]*a judge call reads every answer/);
    const runs = [await nextOf(mac.node, 'job.run'), await nextOf(mac.node, 'job.run'), await nextOf(mac.node, 'job.run')];
    for (const run of runs) answer(mac.node, run, 'Nothing found.');
    expect((await nextOf(mac.node, 'job.run')).prompt).toContain('Keep only the findings that are real.');
    expect((await callLines(c)).map(l => l.data.stage)).toEqual(['review', 'review', 'review']);
  });

  it('show on the map in their department while they run, and leave it when they end', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    await call('start_calls', { brief: 'Check the links.', count: 2 });
    const org = async () => (await c.app.inject({ url: '/api/org', ...as(c.ceo) })).json();
    const dev = async () => (await org()).departments.find((d: { id: string }) => d.id === c.dev.id);
    expect((await dev()).calls).toEqual([
      expect.objectContaining({ number: 1, judge: false, task: 1, by: c.bruno.id }),
      expect.objectContaining({ number: 2, judge: false, task: 1, by: c.bruno.id }),
    ]);
    const one = await nextOf(mac.node, 'job.run'), two = await nextOf(mac.node, 'job.run');
    answer(mac.node, one, 'ok');
    answer(mac.node, two, 'ok');
    await until(async () => (await dev()).calls.length === 0);
  });
});
