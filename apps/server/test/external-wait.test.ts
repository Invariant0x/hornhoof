import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, subscriptions, tasks } from '../src/db/schema.js';
import { cancel, createTask } from '../src/modules/tasks/engine.js';
import { listen, mcp, setUpCompany, testApp } from './helpers.js';

async function fixture() {
  const { app, db } = await testApp();
  await listen(app);
  const owner = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [head, worker, peer] = await db.insert(agents).values([
    { companyId: company!.id, departmentId: department!.id, kind: 'head', roleKey: 'DEV-HEAD', name: 'Hana', model: '', subscriptionId: sub!.id },
    { companyId: company!.id, departmentId: department!.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Bruno', model: '', subscriptionId: sub!.id },
    { companyId: company!.id, departmentId: department!.id, kind: 'worker', roleKey: 'DEV-BE', name: 'Rita', model: '', subscriptionId: sub!.id },
  ]).returning();
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
  const task = async (holder = worker!.id) => (await createTask(app.ctx, { agentId: head!.id }, { title: 'Publish images', brief: '', body: '', departmentId: department!.id, assigneeAgentId: holder, executor: true, gates: [] })).task;
  const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const wait = async (ref: number | string, reason: string, until: string, agentId = worker!.id) => {
    const client = await tools(agentId);
    expect((await client.listTools()).tools.map(t => t.name)).toContain('wait_for');
    return await client.callTool({ name: 'wait_for', arguments: { task: ref, reason, until } }) as { isError?: boolean; content: { text: string }[] };
  };
  return { app, ctx: app.ctx, db, owner, company: company!, sub: sub!, orchestrator: orchestrator!, department: department!, head: head!, worker: worker!, peer: peer!, task, read, tools, wait };
}

describe('external task wait', () => {
  it('stores the holder wait for two hours without changing the workflow status', async () => {
    const c = await fixture();
    const task = await c.task();
    await c.db.update(tasks).set({ silent: 2 }).where(eq(tasks.id, task.id));
    const since = Date.now();
    const until = new Date(since + 2 * 3_600_000).toISOString();
    const result = await c.wait(task.number, '  Images on the registry  ', until);
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
      ['', future], ['First line\nSecond line', future], ['First line\rSecond line', future],
      ['Images', 'not a date'], ['Images', new Date(Date.now() - 1000).toISOString()],
      ['Images', new Date(Date.now() + 2 * 3_600_000 + 60_000).toISOString()],
    ];
    for (const [reason, until] of inputs) {
      const result = await c.wait(task.number, reason!, until!);
      expect(result.isError, `${reason} ${until}`).toBe(true);
      expect(await c.read(task.id)).toMatchObject({ externalWait: null, version: task.version, silent: 0 });
    }
  });

  it('refuses another holder and closed or planned tasks', async () => {
    const c = await fixture();
    const task = await c.task();
    const until = new Date(Date.now() + 60_000).toISOString();
    expect((await c.wait(task.number, 'Images', until, c.peer.id)).isError).toBe(true);
    for (const status of ['done', 'cancelled', 'planned'] as const) {
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
        const args = action === 'submit' ? { summary: 'Published.', evidence: 'Checked.' } : { why: 'The build needs a decision.' };
        const result = await client.callTool({ name: action, arguments: { task: task.number, ...args } });
        expect(result.isError).toBeFalsy();
      }
      expect((await c.read(task.id)).externalWait).toBeNull();
    }
  });
});
