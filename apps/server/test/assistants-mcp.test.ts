import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, companies, departments, people, requests } from '../src/db/schema.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, nextOf, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

/* A company with its orchestrator ready on the built-in node, Sales with its head and a worker, and the CEO's row. Answers
   end as soon as their turn does. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], skillFiles: true });
  await until(async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().state.ready);
  app.ctx.assistants.replyGraceMs = 0;
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [acme] = await db.select().from(companies);
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const on = { companyId: acme!.id, subscriptionId: orchestrator!.subscriptionId, model: '' };
  const [head] = await db.insert(agents).values({ ...on, kind: 'head', name: 'Sasha', roleKey: 'SAL-HEAD', departmentId: sales!.id }).returning();
  const [worker] = await db.insert(agents).values({ ...on, kind: 'worker', name: 'Wendy', roleKey: 'SAL-SDR', departmentId: sales!.id }).returning();
  return { app, db, ceo, builtin, acme: acme!, orchestrator: orchestrator!, owner: owner!, sales: sales!, head: head!, worker: worker! };
}

type Company = Awaited<ReturnType<typeof company>>;

async function assistantOf(c: Company, ownerId: string, name = 'Ava') {
  const { id } = (await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name, owner: ownerId, program: 'openclaw' }, ...as(c.ceo) })).json().person;
  const made = (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(c.ceo) })).json();
  return { id: id as string, key: made.key as string };
}

/* The assistant's program as an MCP client of Hornhoof, over Streamable HTTP with its key. */
async function mcp(c: Company, key?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(c.app.server.address() as AddressInfo).port}/api/assistant/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} } }));
  onTestFinished(() => client.close());
  return client;
}

type Said = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const said = (await client.callTool({ name, arguments: args })) as Said;
  return { json: JSON.parse(said.content[0]!.text), isError: said.isError ?? false };
};
/* A tool's refusal of what does not fit its input, before any call: words for the model. */
const misfit = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Said;
const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

async function aTask(c: Company) {
  return (await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'Leads', brief: '', body: 'Find leads.', departmentId: c.sales.id, assigneeAgentId: c.worker.id, executor: true })).task;
}

describe("the assistant's MCP server", () => {
  it('opens only with a key, and answers GET and DELETE with 405', async () => {
    const c = await company();
    await expect(mcp(c)).rejects.toThrow();
    await expect(mcp(c, `hha_${'x'.repeat(43)}`)).rejects.toThrow();
    const refused = await c.app.inject({ method: 'POST', url: '/api/assistant/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.reason).toBe('assistant_key_invalid');
    expect((await c.app.inject({ method: 'GET', url: '/api/assistant/mcp' })).statusCode).toBe(405);
    expect((await c.app.inject({ method: 'DELETE', url: '/api/assistant/mcp' })).statusCode).toBe(405);
  });

  it('offers the calls of the assistant API as tools, each with plain words for the model', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.owner.id);
    const { tools } = await (await mcp(c, ava.key)).listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['answer_request', 'list_agents', 'list_requests', 'read_events', 'send_message', 'who_am_i']);
    for (const tool of tools) expect(tool.description, tool.name).toMatch(/\w{4,}/);
  });

  it('tells who the assistant is and whom it may write to, as the calls of the API do', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.owner.id);
    const client = await mcp(c, ava.key);
    expect((await call(client, 'who_am_i')).json).toEqual((await c.app.inject({ url: '/api/assistant/me', ...bearer(ava.key) })).json());
    expect((await call(client, 'list_agents')).json).toEqual((await c.app.inject({ url: '/api/assistant/agents', ...bearer(ava.key) })).json());
  });

  it("writes to an agent as the owner, gives the number to read its answer after, and reads the answer as it comes", async () => {
    const c = await company();
    const ava = await assistantOf(c, c.owner.id);
    const client = await mcp(c, ava.key);
    const sent = await call(client, 'send_message', { agentId: c.orchestrator.id, text: 'Plan the launch.' });
    expect(sent).toEqual({ json: { message: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), agentId: c.orchestrator.id }, next: 0 }, isError: false });
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('From Ivan (CEO) through the assistant Ava to Orchestrator:');
    const waiting = call(client, 'read_events', { after: sent.json.next, wait: 50 });
    c.builtin.send({ type: 'job.started', jobId: run.jobId });
    c.builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'On it.' } });
    const first = (await waiting).json;
    expect(first.events).toEqual([{ seq: expect.any(Number), kind: 'reply', at: expect.any(String), data: { messageId: sent.json.message.id, agent: { id: c.orchestrator.id, name: c.orchestrator.name, kind: 'orchestrator' }, byOwnAgent: false, text: 'On it.' } }]);
    expect(first.next).toBe(first.events[0].seq);

    const again = await call(client, 'send_message', { agentId: c.orchestrator.id, text: 'And the budget?' });
    expect(again.json.next).toBe(first.next);
  });

  it("refuses what the owner may not do, with the API's error for the model to read", async () => {
    const c = await company();
    await invitePerson(c.app, c.ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [c.sales.id] } });
    const [ann] = await c.db.select().from(people).where(eq(people.email, 'ann@acme.com'));
    const max = await assistantOf(c, ann!.id, 'Max');
    const client = await mcp(c, max.key);
    const [support] = await c.db.insert(departments).values({ companyId: c.acme.id, templateKey: 'support', roleCode: 'SUP' }).returning();
    const [head] = await c.db.insert(agents).values({ companyId: c.acme.id, kind: 'head', name: 'Tanya', model: '', departmentId: support!.id }).returning();
    expect((await call(client, 'send_message', { agentId: c.orchestrator.id, text: 'Plan the launch.' })).isError).toBe(false);
    const refused = await call(client, 'send_message', { agentId: head!.id, text: 'Plan the launch.' });
    expect(refused).toEqual({ json: { error: { code: 'forbidden', message: expect.any(String), reason: 'assistant_agent_refused' } }, isError: true });
    const blank = await misfit(client, 'send_message', { agentId: c.head.id, text: '   ' });
    expect(blank).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('text') }] });
    const long = await misfit(client, 'read_events', { wait: 51 });
    expect(long).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('wait') }] });
  });

  it('lists what waits for the owner and answers it for them, recorded as through the assistant', async () => {
    const c = await company();
    const task = await aTask(c);
    const asked = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'choice', text: 'Which provider?', options: [{ label: 'Stripe', image: null }, { label: 'PayPal', image: null }], topic: 'task' })).request;
    const ava = await assistantOf(c, c.owner.id);
    const client = await mcp(c, ava.key);
    const listed = (await call(client, 'list_requests')).json;
    expect(listed).toEqual((await c.app.inject({ url: '/api/assistant/requests', ...bearer(ava.key) })).json());
    expect(listed.requests).toMatchObject([{ id: asked.id, kind: 'choice', options: ['Stripe', 'PayPal'], answerable: true }]);

    expect((await call(client, 'answer_request', { requestId: asked.id, approve: true })).json.error.reason).toBe('task_invalid');
    const answered = await call(client, 'answer_request', { requestId: asked.id, pick: 0 });
    expect(answered).toMatchObject({ json: { request: { id: asked.id, status: 'answered', picked: 0 } }, isError: false });
    expect((await c.db.select().from(requests).where(eq(requests.id, asked.id)))[0]).toMatchObject({ answeredBy: c.owner.id, answeredByAssistantId: ava.id });
    expect((await call(client, 'answer_request', { requestId: asked.id, answer: 'Stripe.' })).json.error.reason).toBe('request_closed');
  });
});
