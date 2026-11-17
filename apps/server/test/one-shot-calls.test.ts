import type { ServerMessage } from '@hornhoof/protocol';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { jobs, taskEvents } from '../src/db/schema.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { as, mcp, nextOf, until, type FakeNode } from './helpers.js';
import { company } from './test-runs-company.js';

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

  it('end at once, and the caller hears why, when no machine of its plan is online', async () => {
    const c = await company();
    const mac = await c.machine(c.ceo, 'dev-mac');
    const call = await callerOn(c, c.bruno, mac);
    mac.node.close();
    await until(() => !c.app.ctx.hub.isOnline(nodeIdentity(mac.nodeId)));
    expect(await call('start_calls', { brief: 'Count the words.' })).toEqual({ error: true, text: expect.stringMatching(/^No machine of your plan is online to run one-shot calls/) });
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
