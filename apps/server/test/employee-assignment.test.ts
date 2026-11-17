import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { listen, setUpCompany, testApp } from './helpers.js';

async function fixture() {
  const { app, db } = await testApp();
  await listen(app);
  await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [subscription] = await db.select().from(subscriptions);
  const [dev, sales] = await db.insert(departments).values([
    { companyId: company!.id, templateKey: 'development', roleCode: 'DEV' },
    { companyId: company!.id, templateKey: 'sales', roleCode: 'SAL' },
  ]).returning();
  const hire = async (kind: 'head' | 'worker', departmentId = dev!.id) => (await db.insert(agents).values({
    companyId: company!.id, kind, departmentId, name: kind, model: 'unchanged-model',
    skills: ['dev-tdd'], overrides: { skills: { 'dev-tdd': 'Saved custom method.' } }, effort: 'high',
  }).returning())[0]!;
  const head = await hire('head');
  const worker = await hire('worker');
  const other = await hire('worker', sales!.id);
  const connect = async (agentId: string) => {
    const token = `assignment-test-${agentId}`;
    await db.insert(jobs).values({ companyId: company!.id, subscriptionId: subscription!.id, agentId, kind: 'conversation', prompt: 'work', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) });
    const client = new Client({ name: 'assignment-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    onTestFinished(() => client.close());
    return client;
  };
  return { app, db, company: company!, head, worker, other, connect };
}

describe('employee assignment authority', () => {
  it('lets a head change the assignment of its own worker on its own and records the change', async () => {
    const { db, head, worker, connect } = await fixture();
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const client = await connect(head.id);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('set_employee_assignment');
    const assignment = 'Close named orders end to end.\nKeep explicit deadlines.';
    const result = await client.callTool({ name: 'set_employee_assignment', arguments: { employee: worker.id, assignment } });
    expect(result.isError).toBeFalsy();
    const [after] = await db.select().from(agents).where(eq(agents.id, worker.id));
    expect(after).toEqual({ ...worker, overrides: { ...worker.overrides, base: assignment } });
    expect(await db.select().from(agentChanges).where(eq(agentChanges.agentId, worker.id))).toMatchObject([{ field: 'prompt', personId: owner!.id, actingAgentId: head.id, after: { base: assignment } }]);
    expect(await db.select().from(agentEvents).where(eq(agentEvents.agentId, head.id))).toMatchObject([{ kind: 'applied', data: { action: 'set_employee_assignment', employee: worker.id } }]);
    expect((await client.callTool({ name: 'set_employee_assignment', arguments: { employee: worker.id, assignment: null } })).isError).toBeFalsy();
    const [cleared] = await db.select().from(agents).where(eq(agents.id, worker.id));
    expect(cleared!.overrides).toEqual(worker.overrides);
  });

  it('saves the full text of a long assignment from a head', async () => {
    const { db, head, worker, connect } = await fixture();
    const client = await connect(head.id);
    const assignment = 'Own the order queue.\n'.repeat(13_000);
    expect((await client.callTool({ name: 'set_employee_assignment', arguments: { employee: worker.id, assignment } })).isError).toBeFalsy();
    const [after] = await db.select().from(agents).where(eq(agents.id, worker.id));
    expect(after!.overrides.base).toBe(assignment);
  });

  it('refuses other departments, other companies, heads, removed employees and unrelated patch fields', async () => {
    const { db, company, head, worker, other, connect } = await fixture();
    const [foreignCompany] = await db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [foreign] = await db.insert(agents).values({ companyId: foreignCompany!.id, kind: 'worker', name: 'Foreign', model: '' }).returning();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [removed] = await db.insert(agents).values({ ...worker, id: undefined, name: 'Removed', removedAt: new Date() }).returning();
    const client = await connect(head.id);
    for (const employee of [other.id, foreign!.id, head.id, orchestrator!.id, removed!.id]) {
      const result = await client.callTool({ name: 'set_employee_assignment', arguments: { employee, assignment: 'Forbidden' } });
      expect(result.isError, employee).toBe(true);
    }
    const refused = await client.callTool({ name: 'set_employee_assignment', arguments: { employee: worker.id, assignment: 'Forbidden', model: 'new-model' } });
    expect(refused.isError).toBe(true);
    expect(await db.select().from(agentChanges).where(eq(agentChanges.companyId, company.id))).toEqual([]);
    expect((await db.select().from(agents).where(eq(agents.id, worker.id)))[0]).toEqual(worker);
  });

  it('does not expose assignment editing to workers or trust an earlier head role after reassignment', async () => {
    const { db, head, worker, connect } = await fixture();
    const member = await connect(worker.id);
    expect((await member.listTools()).tools.map(t => t.name)).not.toContain('set_employee_assignment');
    const client = await connect(head.id);
    await db.update(agents).set({ kind: 'worker' }).where(eq(agents.id, head.id));
    expect((await client.callTool({ name: 'set_employee_assignment', arguments: { employee: worker.id, assignment: 'Forbidden' } })).isError).toBe(true);
    expect((await db.select().from(agents).where(eq(agents.id, worker.id)))[0]).toEqual(worker);
  });
});
