import { randomUUID } from 'node:crypto';
import { parseNodeMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, jobs } from '../src/db/schema.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { as, setUpCompany, testApp } from './helpers.js';

afterEach(() => vi.useRealTimers());
async function company(running = true) {
  const logs: string[] = [];
  const c = await testApp({}, { level: 'warn', stream: { write: (line: string) => void logs.push(line) } });
  const ceo = await setUpCompany(c.app);
  const [agent] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const job = running ? (await c.db.insert(jobs).values({ companyId: agent!.companyId, subscriptionId: agent!.subscriptionId!, agentId: agent!.id, kind: 'conversation', status: 'running', prompt: 'Work', timeoutMs: 60000 }).returning())[0]! : null;
  const msg = { type: 'agent.hook_rejected' as const, agentKey: agent!.id, event: 'stop', reason: 'owner check failed' };
  return { ...c, agent: agent!, job, msg, logs, ceo };
}

describe('hook refusal diagnostics from a node', () => {
  it('accepts the wire message and records it on the running turn', async () => {
    const c = await company();
    expect(parseNodeMessage(JSON.stringify(c.msg))).toEqual(c.msg);
    await handleNodeMessage(c.app.ctx, BUILTIN, c.msg);
    expect(await c.db.select().from(agentEvents)).toMatchObject([{ agentId: c.agent.id, jobId: c.job!.id, kind: 'hook_rejected', data: { event: 'stop', reason: 'owner check failed' } }]);
  });

  it('records only the assigned personal node, not another authenticated node', async () => {
    const c = await company(false);
    const connected = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(c.ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'hook-test-machine', hostname: 'hook-test', os: 'linux', arch: 'x86_64' } });
    const [owner, other] = joined.json().nodes;
    await c.db.update(agents).set({ subscriptionId: owner.subscriptionId, nodeId: owner.nodeId }).where(eq(agents.id, c.agent.id));
    const [job] = await c.db.insert(jobs).values({ companyId: c.agent.companyId, subscriptionId: owner.subscriptionId, nodeId: owner.nodeId, agentId: c.agent.id, kind: 'conversation', status: 'running', prompt: 'Work', timeoutMs: 60000 }).returning();
    await handleNodeMessage(c.app.ctx, { kind: 'node', nodeId: other.nodeId }, c.msg);
    expect(await c.db.select().from(agentEvents)).toEqual([]);
    await handleNodeMessage(c.app.ctx, { kind: 'node', nodeId: owner.nodeId }, c.msg);
    expect(await c.db.select().from(agentEvents)).toMatchObject([{ jobId: job!.id, kind: 'hook_rejected', data: { reason: 'owner check failed' } }]);
    const view = await c.app.inject({ url: `/api/agents/${c.agent.id}/events`, ...as(c.ceo) });
    expect(view.json().events).toContainEqual(expect.objectContaining({ kind: 'hook_rejected', jobId: job!.id }));
  });

  it('ignores a refusal reported by another node', async () => {
    const c = await company();
    await handleNodeMessage(c.app.ctx, { kind: 'node', nodeId: randomUUID() }, c.msg);
    expect(await c.db.select().from(agentEvents)).toEqual([]);
    expect(c.logs.join('\n')).not.toContain('owner check failed');
  });

  it('logs the agent and reason on the server when no turn is running', async () => {
    const c = await company(false);
    await handleNodeMessage(c.app.ctx, BUILTIN, c.msg);
    expect(await c.db.select().from(agentEvents)).toEqual([]);
    const logs = c.logs.join('\n');
    expect(logs).toContain(c.agent.id);
    expect(logs).toContain('owner check failed');
    expect(logs).toContain('stop');
  });

  it.each(['1970-01-01T00:00:00Z', '2026-11-03T11:00:00Z'])('folds each cause for a minute from %s', async start => {
    const c = await company();
    const time = new Date(start).getTime();
    vi.useFakeTimers({ toFake: ['Date'] });vi.setSystemTime(time);
    await handleNodeMessage(c.app.ctx, BUILTIN, c.msg);
    await handleNodeMessage(c.app.ctx, BUILTIN, c.msg);
    expect(await c.db.select().from(agentEvents)).toHaveLength(1);
    vi.setSystemTime(time + 30_000);
    await handleNodeMessage(c.app.ctx, BUILTIN, { ...c.msg, reason: 'hook handler failed' });
    await handleNodeMessage(c.app.ctx, BUILTIN, c.msg);
    expect(await c.db.select().from(agentEvents)).toHaveLength(2);
    vi.setSystemTime(time + 60_000);
    await handleNodeMessage(c.app.ctx, BUILTIN, c.msg);
    expect(await c.db.select().from(agentEvents)).toHaveLength(3);
  });
});
