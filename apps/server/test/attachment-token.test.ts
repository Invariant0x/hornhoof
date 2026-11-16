import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { attachments, agentEvents, agents, jobs, machines, nodes, people, subscriptions } from '../src/db/schema.js';
import { builtinOf, nodeIdentity, type NodeIdentity } from '../src/modules/nodes/hub.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { BUILTIN } from './builtin.js';
import { failureCompany } from './failure-company.js';

async function company() {
  const c = await failureCompany();
  const task = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Review', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true })).task;
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.agent.id, subscriptionId: c.sub.id, taskId: task.id, kind: 'conversation', prompt: 'review', status: 'running', toolTokenHash: hashToken('headless-turn-token'), timeoutMs: 900000 }).returning();
  let ref = 0;
  const grant = async (agentKey = c.agent.id, node: NodeIdentity = BUILTIN) => {
    const id = `attachment-${++ref}`;
    await handleNodeMessage(c.ctx, node, { type: 'tools.call', agentKey, ref: id, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'attachments/token' }) });
    const answer = c.sent.mock.calls.map(([, m]) => m).find(m => m.type === 'tools.answer' && m.ref === id);
    if (answer?.type !== 'tools.answer') throw new Error('Missing attachment authorization response.');
    return JSON.parse(answer.body) as { result?: { token: string }; error?: unknown };
  };
  const send = (token: string, query = `task=${task.number}&name=review.md`) => c.app.inject({ method: 'POST', url: `/api/attachments?${query}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: Buffer.from('Review evidence') });
  return { ...c, task, job: job!, grant, send };
}

describe('attachment authorization over the node link', () => {
  it('attaches to the existing conversation without revealing its tool token or opening a new step', async () => {
    const c = await company();
    const granted = await c.grant();
    expect(typeof granted.result?.token).toBe('string');
    const token = granted.result!.token;
    expect(token === 'headless-turn-token').toBe(false);
    expect((await c.send(token)).statusCode).toBe(201);
    const [file] = await c.db.select().from(attachments);
    expect(file).toMatchObject({ agentId: c.agent.id, jobId: c.job.id, taskId: c.task.id, name: 'review.md' });
    expect((await c.db.select().from(jobs)).map(j => j.id)).toEqual([c.job.id]);
    expect(JSON.stringify(await c.db.select().from(agentEvents)).includes(token)).toBe(false);
    const mcp = await c.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(mcp.statusCode).toBe(401);
    const download = await c.app.inject({ url: `/api/attachments/file?task=${c.task.number}&file=review.md`, headers: { authorization: `Bearer ${token}` } });
    expect(download.statusCode).toBe(401);
  });

  it('refuses another agent, another node, and a program with no conversation', async () => {
    const c = await company();
    expect((await c.grant(c.watcher.id)).result).toBeUndefined();
    expect((await c.grant(c.agent.id, builtinOf('a'.repeat(64)))).result).toBeUndefined();
    await c.db.update(jobs).set({ taskId: null }).where(eq(jobs.id, c.job.id));
    expect((await c.grant()).result).toBeUndefined();
    await c.db.update(jobs).set({ taskId: c.task.id, kind: 'tools' }).where(eq(jobs.id, c.job.id));
    expect((await c.grant()).result).toBeUndefined();
    await c.db.delete(jobs).where(eq(jobs.id, c.job.id));
    expect((await c.grant()).result).toBeUndefined();
    expect(await c.db.select().from(attachments)).toEqual([]);
  });

  it.each(['done', 'cancelled'] as const)('refuses authorization and reuse after the conversation is %s', async state => {
    const c = await company();
    const granted = await c.grant();
    expect(typeof granted.result?.token).toBe('string');
    expect((await c.send(granted.result!.token)).statusCode).toBe(201);
    await c.db.update(jobs).set(state === 'done' ? { status: 'done' } : { error: 'cancelled' }).where(eq(jobs.id, c.job.id));
    expect((await c.grant()).result).toBeUndefined();
    expect((await c.send(granted.result!.token)).statusCode).toBe(401);
    expect(await c.db.select().from(attachments)).toHaveLength(1);
  });

  it('restricts the permission to this task, excludes chat and pictures, and rejects forgery', async () => {
    const c = await company();
    const other = (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Other', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.agent.id, executor: true })).task;
    const granted = await c.grant();
    expect(typeof granted.result?.token).toBe('string');
    const token = granted.result!.token;
    expect((await c.send(token, `task=${other.number}&name=review.md`)).statusCode).toBe(403);
    expect((await c.send(token, `task=${c.task.number}&chat=1&name=review.md`)).statusCode).toBe(403);
    expect((await c.send(token, 'name=review.md')).statusCode).toBe(403);
    expect((await c.send(`${token}forged`)).statusCode).toBe(401);
    expect(await c.db.select().from(attachments)).toEqual([]);
  });

  it('rejects an expired permission and a conversation moved to another node', async () => {
    const c = await company();
    const granted = await c.grant();
    expect(typeof granted.result?.token).toBe('string');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60_000);
      expect((await c.send(granted.result!.token)).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    await c.db.update(jobs).set({ builtinMachine: 'a'.repeat(64) }).where(eq(jobs.id, c.job.id));
    expect((await c.send(granted.result!.token)).statusCode).toBe(401);
  });

  it('does not authorize a different agent with a permission for the original one', async () => {
    const c = await company();
    const granted = await c.grant();
    expect(typeof granted.result?.token).toBe('string');
    await c.db.update(jobs).set({ agentId: c.watcher.id }).where(eq(jobs.id, c.job.id));
    expect((await c.send(granted.result!.token)).statusCode).toBe(401);
    expect(await c.db.select().from(attachments)).toEqual([]);
  });

  it('preserves the headless direct tool token', async () => {
    const c = await company();
    expect((await c.send('headless-turn-token')).statusCode).toBe(201);
  });

  it('authorizes Kimi on its personal plan node and refuses the built-in node for that turn', async () => {
    const c = await company();
    await c.db.update(subscriptions).set({ kind: 'personal', provider: 'kimi' }).where(eq(subscriptions.id, c.sub.id));
    const [owner] = await c.db.select({ id: people.id }).from(people).where(eq(people.isOwner, true));
    const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: owner!.id, machineKey: 'kimi-laptop' }).returning();
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, subscriptionId: c.sub.id, status: 'ready', keyHash: 'test-node-key-hash', version: '0.31.0' }).returning();
    await c.db.update(agents).set({ nodeId: node!.id }).where(eq(agents.id, c.agent.id));
    await c.db.update(jobs).set({ nodeId: node!.id }).where(eq(jobs.id, c.job.id));
    expect((await c.grant()).result).toBeUndefined();
    const granted = await c.grant(c.agent.id, nodeIdentity(node!.id));
    expect(typeof granted.result?.token).toBe('string');
    expect((await c.send(granted.result!.token)).statusCode).toBe(201);
  });
});
