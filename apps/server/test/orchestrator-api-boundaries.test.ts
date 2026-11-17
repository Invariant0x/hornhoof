import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { orchestratorDecisionHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, jobs, people, requests, subscriptions } from '../src/db/schema.js';
import { ask } from '../src/modules/tasks/engine.js';
import { as, mcp } from './helpers.js';
import { company } from './test-runs-company.js';

it('distinguishes a department head, the orchestrator and a person when showing who decided', async () => {
  const c = await company();
  const owner = (await c.app.inject({ url: '/api/me', ...as(c.ceo) })).json().person.id as string;
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const headTurn = await c.turn(c.head);
  await c.db.update(jobs).set({ createdBy: owner }).where(eq(jobs.id, headTurn.job.id));
  const question = async (text: string) => (await ask(c.app.ctx, c.bruno.id, c.task.id, { kind: 'question', text, topic: 'task' })).request;
  const head = await question('Head decision');
  const answered = await c.app.inject({ method: 'POST', url: `/api/requests/${head.id}`, payload: { answer: 'Head answer' }, headers: orchestratorDecisionHeaders({ personId: owner, agentId: c.head.id, jobId: headTurn.job.id, sourceSeq: null }) });
  expect(answered.statusCode).toBe(200);
  expect((await c.db.select().from(requests).where(eq(requests.id, head.id)))[0]!.answeredByAgentId).toBe(c.head.id);
  const detail = async () => (await c.app.inject({ url: `/api/tasks/${c.task.id}`, ...as(c.ceo) })).json().task as { requests: { id: string; byOrchestrator: boolean }[]; log: { text: string; by: { id: string; byOrchestrator?: boolean } }[] };
  expect((await detail()).requests.find(row => row.id === head.id)!.byOrchestrator).toBe(false);
  const own = await question('Orchestrator decision');
  const turn = await c.turn(orchestrator!);
  expect((await turn.call('api', { method: 'POST', path: `/api/requests/${own.id}`, body: { answer: 'Orchestrator answer' } })).error).toBe(false);
  const human = await question('Person decision');
  expect((await c.app.inject({ method: 'POST', url: `/api/requests/${human.id}`, payload: { answer: 'Person answer' }, ...as(c.ceo) })).statusCode).toBe(200);
  const view = await detail();
  expect(view.requests.find(row => row.id === own.id)!.byOrchestrator).toBe(true);
  expect(view.requests.find(row => row.id === human.id)!.byOrchestrator).toBe(false);
  expect(view.log.find(row => row.text === 'Orchestrator answer')!.by).toMatchObject({ id: owner, byOrchestrator: true });
  expect(view.log.find(row => row.text === 'Head answer')!.by).toMatchObject({ id: c.head.id });
});

it('refuses forged internal headers, including a same-character-length value with different byte length', async () => {
  const c = await company();
  const owner = (await c.app.inject({ url: '/api/me', ...as(c.ceo) })).json().person.id as string;
  const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  for (const secret of ['0'.repeat(64), '\u00e9'.repeat(64)]) {
    const response = await c.app.inject({ url: '/api/me', headers: { 'x-hornhoof-internal': secret, 'x-hornhoof-person': owner, 'x-hornhoof-agent': orchestrator!.id } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.reason).toBe('signed_out');
  }
});

it('keeps owner API and delegation off other agents and confines a foreign orchestrator to its own company', async () => {
  const c = await company();
  const localOwner = (await c.app.inject({ url: '/api/me', ...as(c.ceo) })).json().person.id as string;
  const clientFor = async (agent: typeof agents.$inferSelect, subscription: string) => {
    const token = `boundary-${randomUUID()}`;
    await c.db.insert(jobs).values({ companyId: agent.companyId, agentId: agent.id, subscriptionId: subscription, kind: 'conversation', prompt: 'recorded boundary check', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) });
    return mcp(c.app, token);
  };
  const refused = async (client: Awaited<ReturnType<typeof mcp>>, name: string, args: Record<string, unknown>) => {
    try {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/not found|unknown tool|not available/i);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/not found|unknown tool|not available/i);
    }
  };
  const payload = { method: 'PUT', path: `/api/people/${localOwner}/ceo-delegate`, body: { isCeoDelegate: true }, via: 'orchestrator', agentKind: 'orchestrator' };
  for (const agent of [c.bruno, c.head]) {
    const client = await clientFor(agent, agent.subscriptionId!);
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('api');
    await refused(client, 'api', payload);
    await refused(client, 'use_tool', { name: 'api', arguments: payload });
  }
  const [foreign] = await c.db.insert(companies).values({ name: 'Foreign fixture', singleton: false }).returning();
  const [foreignOwner] = await c.db.insert(people).values({ companyId: foreign!.id, name: 'Foreign owner', email: 'foreign-owner@example.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const [sub] = await c.db.insert(subscriptions).values({ companyId: foreign!.id, provider: 'claude', kind: 'personal', label: 'Foreign fixture plan', ownerPersonId: foreignOwner!.id, status: 'ready' }).returning();
  const [foreignAgent] = await c.db.insert(agents).values({ companyId: foreign!.id, kind: 'orchestrator', name: 'Foreign orchestrator', model: '', subscriptionId: sub!.id }).returning();
  const client = await clientFor(foreignAgent!, sub!.id);
  const response = await client.callTool({ name: 'api', arguments: { path: '/api/people' } });
  expect(response.isError).not.toBe(true);
  const text = response.content as { text: string }[];
  const listed = JSON.parse(text[0]!.text).people as { id: string }[];
  expect(listed.map(person => person.id)).toContain(foreignOwner!.id);
  expect(listed.map(person => person.id)).not.toContain(localOwner);
  const denied = await client.callTool({ name: 'api', arguments: payload });
  expect(denied.isError).toBe(true);
  expect((await c.db.select().from(people).where(eq(people.id, localOwner)))[0]!.isCeoDelegate).toBe(false);
});
