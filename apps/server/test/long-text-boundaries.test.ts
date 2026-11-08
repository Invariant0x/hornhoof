import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, attachments, jobs, people, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { ask, answerDirectly, createTask } from '../src/modules/tasks/engine.js';
import { waitFor } from '../src/modules/tasks/external-wait.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { as, connectNode, listen, mcp, setUpCompany, testApp, until } from './helpers.js';

const WORDS = ('Полный текст 🌿.\n' + 'Finding: keep every word and its author.\n'.repeat(400)).slice(0, 11999) + '!';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const NODE_KEY = 'k'.repeat(40);

async function fixture() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const session = await setUpCompany(app);
  const node = await connectNode(url, NODE_KEY);
  onTestFinished(() => node.close());
  node.ws.on('message', data => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.type === 'agent.say') node.send({ type: 'agent.said', ref: message.ref, ok: true });
  });
  node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], terminals: true });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [company] = await db.select().from(companies);
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null)!));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) => (await db.insert(agents).values({ companyId: company!.id, departmentId: dev!.id, subscriptionId: sub!.id, name, kind, roleKey, model: '' }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const worker = await hire('Bruno', 'worker', 'DEV-BE');
  const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Full text', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: worker.id, executor: true })).task;
  let count = 0;
  const client = async (agent: { id: string }) => {
    const token = `long-text-fixture-${++count}-0123456789abcdef`;
    await db.insert(jobs).values({ companyId: company!.id, subscriptionId: sub!.id, agentId: agent.id, createdBy: ceo!.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const saved = async (id: string) => (await db.select().from(requests).where(eq(requests.id, id)))[0]!;
  return { app, db, session, company: company!, ceo: ceo!, sub: sub!, dev: dev!, orchestrator: orchestrator!, head, worker, task, client, saved };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const call = async (client: Client, name: string, args: Record<string, unknown>) => await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
async function deliveredMessages(c: Fixture, recipient: string) {
  const rows = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, recipient), eq(agentEvents.kind, 'message')));
  return rows.filter(row => {
    const data = row.data as { text?: string; notification?: unknown };
    return data.text === WORDS && data.notification === undefined;
  });
}
async function message(c: Fixture, recipient: string) {
  return (await deliveredMessages(c, recipient))[0];
}

it('accepts a long HTTP comment and reads its full text', async () => {
  const c = await fixture();
  const response = await c.app.inject({ method: 'POST', url: `/api/tasks/${c.task.id}/comments`, payload: { text: WORDS }, ...as(c.session) });
  expect(response.statusCode, response.body).toBe(201);
  const event = response.json().task.log.find((e: { kind: string }) => e.kind === 'comment');
  const ref = event.data.fullTexts?.find((f: { field: string }) => f.field === 'text');
  const bytes = ref ? (await c.app.inject({ url: `/api/attachments/${ref.id}`, ...as(c.session) })).rawPayload : Buffer.from(event.text);
  expect(bytes.equals(Buffer.from(WORDS))).toBe(true);
  expect(sha(bytes)).toBe(sha(WORDS));
  expect(event.by.id).toBe(c.ceo.id);
});

it.each(['question', 'choice', 'approval'] as const)('keeps a long HTTP %s answer in full', async kind => {
  const c = await fixture();
  const request = (await ask(c.app.ctx, c.worker.id, c.task.id, { kind, text: 'Please reply.', ...(kind === 'choice' ? { options: [{ label: 'One', image: null }, { label: 'Two', image: null }] } : {}), ...(kind === 'approval' ? { commit: 'a'.repeat(40) } : {}) })).request;
  const response = await c.app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { answer: WORDS, ...(kind === 'approval' ? { approve: true } : {}) }, ...as(c.session) });
  expect(response.statusCode, response.body).toBe(200);
  expect(await c.saved(request.id)).toMatchObject({ answer: WORDS, picked: null, answeredBy: c.ceo.id });
  const detail = await c.app.inject({ url: `/api/tasks/${c.task.id}`, ...as(c.session) });
  expect(detail.json().task.requests[0].answer).toBe(WORDS);
});

it('keeps an answer from the person window intact without answerDirectly truncation', async () => {
  const c = await fixture();
  const request = (await ask(c.app.ctx, c.worker.id, c.task.id, { kind: 'question', text: 'Please reply.' })).request;
  await answerDirectly(c.app.ctx, c.ceo.id, c.worker.id, WORDS);
  expect((await c.saved(request.id)).answer).toBe(WORDS);
});

it('accepts a long HTTP conversation and keeps its author and every byte', async () => {
  const c = await fixture();
  const response = await c.app.inject({ method: 'POST', url: `/api/agents/${c.worker.id}/messages`, payload: { text: WORDS }, ...as(c.session) });
  expect(response.statusCode, response.body).toBe(202);
  const event = await message(c, c.worker.id);
  expect(event?.personId).toBe(c.ceo.id);
  expect(sha((event!.data as { text: string }).text)).toBe(sha(WORDS));
});

it.each(['worker', 'orchestrator'] as const)('accepts the long %s message_employee path', async who => {
  const c = await fixture();
  const sender = who === 'worker' ? c.worker : c.orchestrator;
  const result = await call(await c.client(sender), 'message_employee', { employee: c.head.id, text: WORDS });
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  const event = await message(c, c.head.id);
  expect(event).toBeDefined();
  expect(sha((event!.data as { text: string }).text)).toBe(sha(WORDS));
});

it('accepts the long head tell_orchestrator path', async () => {
  const c = await fixture();
  const result = await call(await c.client(c.head), 'tell_orchestrator', { text: WORDS });
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  const event = await message(c, c.orchestrator.id);
  expect(event).toBeDefined();
  expect(sha((event!.data as { text: string }).text)).toBe(sha(WORDS));
});

it('accepts a long delegated answer_request without changing its principal', async () => {
  const c = await fixture();
  const request = (await ask(c.app.ctx, c.worker.id, c.task.id, { kind: 'question', text: 'Please reply.' })).request;
  const result = await call(await c.client(c.orchestrator), 'answer_request', { request: request.id, answer: WORDS });
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  expect(await c.saved(request.id)).toMatchObject({ answer: WORDS, answeredBy: c.ceo.id, answeredByAgentId: c.orchestrator.id });
});

it('keeps the transport limit and explains the supported file step', async () => {
  const c = await fixture();
  const response = await c.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'comment', arguments: { task: c.task.number, text: 'x'.repeat(1024 * 1024 + 1) } } } });
  expect(response.statusCode).toBe(413);
  expect(response.json().error.message).toContain('hh-attach');
  expect(response.json().error.message).toContain('file');
  expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'comment')))).toEqual([]);
});

it('does not fail an already delivered person message when implicit answer files have no room', async () => {
  const c = await fixture();
  const request = (await ask(c.app.ctx, c.worker.id, c.task.id, { kind: 'question', text: 'Please reply.' })).request;
  c.app.ctx.config.taskFilesBytes = 0;
  const response = await c.app.inject({ method: 'POST', url: `/api/agents/${c.worker.id}/messages`, payload: { text: WORDS }, ...as(c.session) });
  expect(response.statusCode, response.body).toBe(202);
  expect(await c.saved(request.id)).toMatchObject({ status: 'answered', answer: WORDS });
  const events = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'answered')));
  expect(events).toHaveLength(1);
  expect(events[0]!.text).toBe(WORDS);
  expect(await deliveredMessages(c, c.worker.id)).toHaveLength(1);
  expect(await c.db.select().from(attachments).where(eq(attachments.taskId, c.task.id))).toEqual([]);
  const duplicate = await c.app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { answer: WORDS }, ...as(c.session) });
  expect(duplicate.statusCode).toBe(409);
  expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'answered')))).toHaveLength(1);
});

it('ends a task-bound message wait once even when full-text file quota is exhausted', async () => {
  const c = await fixture();
  await c.db.update(tasks).set({ status: 'working' }).where(eq(tasks.id, c.task.id));
  await waitFor(c.app.ctx, c.worker.id, c.task.id, { reason: 'Waiting for the report.', until: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
  const [before] = await c.db.select().from(tasks).where(eq(tasks.id, c.task.id));
  c.app.ctx.config.taskFilesBytes = 0;
  const result = await call(await c.client(c.head), 'message_employee', { employee: c.worker.id, task: c.task.number, text: WORDS });
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  const [after] = await c.db.select().from(tasks).where(eq(tasks.id, c.task.id));
  expect(after!.externalWait).toBeNull();
  expect(after!.version).toBe(before!.version + 1);
  expect(await deliveredMessages(c, c.worker.id)).toHaveLength(1);
  const events = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'comment')));
  expect(events).toHaveLength(1);
  expect(events[0]!.text).toBe(WORDS);
  expect(await c.db.select().from(attachments).where(eq(attachments.taskId, c.task.id))).toEqual([]);
});
