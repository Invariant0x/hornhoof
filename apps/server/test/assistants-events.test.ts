import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { agents, assistantEvents, companies, departments, people, requests } from '../src/db/schema.js';
import { storeEvent, sweepEvents } from '../src/modules/assistants/events.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, nextOf, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
type Event = { seq: number; kind: string; at: string; data: Record<string, unknown> };

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

async function assistantOf(c: Company, ownerId: string, name = 'Ava', eventsUrl?: string) {
  const { id } = (await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name, owner: ownerId, program: 'avaclone', eventsUrl }, ...as(c.ceo) })).json().person;
  const made = (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(c.ceo) })).json();
  return { id: id as string, key: made.key as string, secret: made.signingSecret as string };
}

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });
const read = (c: Company, key: string, after = 0, wait = 0) => c.app.inject({ url: `/api/assistant/events?after=${after}&wait=${wait}`, ...bearer(key) });
const eventsOf = async (c: Company, key: string, after = 0): Promise<Event[]> => (await read(c, key, after)).json().events;
const write = (c: Company, key: string, agentId: string, text: string) => c.app.inject({ method: 'POST', url: '/api/assistant/messages', payload: { agentId, text }, ...bearer(key) });

async function aTask(c: Company) {
  return (await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'Leads', brief: '', body: 'Find leads.', departmentId: c.sales.id, assigneeAgentId: c.worker.id, executor: true })).task;
}

/* A stand-in for an assistant's events address: it keeps every wake as it came, and answers with the next status given. */
async function standIn(statuses: number[]) {
  const wakes: { body: string; signature: string | undefined }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      wakes.push({ body, signature: req.headers['x-hornhoof-signature'] as string | undefined });
      res.writeHead(statuses.shift() ?? 200).end();
    });
  });
  const port = await listenIn(server);
  onTestFinished(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  return { url: `http://127.0.0.1:${port}/hornhoof`, wakes };
}

describe("an assistant's events", () => {
  it("carry the agent's answer to its message, word by word and then its end, to a long poll that waits", async () => {
    const c = await company();
    const ava = await assistantOf(c, c.owner.id);
    const sent = (await write(c, ava.key, c.orchestrator.id, 'Plan the launch.')).json().message;
    const waiting = read(c, ava.key, 0, 50);
    const run = await nextOf(c.builtin, 'job.run');
    c.builtin.send({ type: 'job.started', jobId: run.jobId });
    c.builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'On it.' } });
    const first = (await waiting).json();
    const agent = { id: c.orchestrator.id, name: c.orchestrator.name, kind: 'orchestrator' };
    expect(first.events).toEqual([{ seq: expect.any(Number), kind: 'reply', at: expect.any(String), data: { messageId: sent.id, agent, text: 'On it.' } }]);
    expect(first.next).toBe(first.events[0].seq);
    c.builtin.send({ type: 'job.event', jobId: run.jobId, seq: 1, event: { kind: 'text', text: 'The plan is ready.' } });
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(async () => (await eventsOf(c, ava.key, first.next)).some(e => e.kind === 'reply_end'));
    const rest = await eventsOf(c, ava.key, first.next);
    expect(rest.map(e => [e.kind, e.data])).toEqual([
      ['reply', { messageId: sent.id, agent, text: 'The plan is ready.' }],
      ['reply_end', { messageId: sent.id, agent, answered: true, failed: false }],
    ]);
    expect(rest[0]!.seq).toBeLessThan(rest[1]!.seq);
  });

  it('end with a failed turn as failed, and a long poll that hears nothing ends empty', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.owner.id);
    const waits: number[] = [];
    c.app.ctx.assistants.pause = async ms => void waits.push(ms);
    expect((await read(c, ava.key, 0, 50)).json()).toEqual({ events: [], next: 0 });
    expect(waits).toEqual([50_000]);
    expect((await read(c, ava.key, 0, 51)).statusCode).toBe(400);
    expect((await read(c, ava.key, -1)).statusCode).toBe(400);
    const sent = (await write(c, ava.key, c.orchestrator.id, 'Hello?')).json().message;
    const run = await nextOf(c.builtin, 'job.run');
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: false, sessionId: null, result: '', tail: 'boom', error: 'agent_failed' });
    await until(async () => (await eventsOf(c, ava.key)).length > 0);
    expect((await eventsOf(c, ava.key)).map(e => [e.kind, e.data])).toEqual([['reply_end', { messageId: sent.id, agent: expect.objectContaining({ id: c.orchestrator.id }), answered: false, failed: true }]]);
  });

  it('tell of a request that waits for the owner, from before the key too, and of its end once the assistant answers it', async () => {
    const c = await company();
    const task = await aTask(c);
    const asked = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which region first?', topic: 'task' })).request;
    const ava = await assistantOf(c, c.owner.id);
    await until(async () => (await eventsOf(c, ava.key)).length > 0);
    const [told] = await eventsOf(c, ava.key);
    expect(told).toMatchObject({ kind: 'request', data: { request: { id: asked.id, kind: 'question', topic: 'task', text: 'Which region first?', options: [], answerable: true, task: { id: task.id, number: task.number, title: 'Leads' }, agent: { id: c.worker.id, name: 'Wendy' } } } });
    expect((await c.app.inject({ url: '/api/assistant/requests', ...bearer(ava.key) })).json().requests).toEqual([told!.data.request]);

    const answered = await c.app.inject({ method: 'POST', url: `/api/assistant/requests/${asked.id}/answer`, payload: { answer: 'Europe.' }, ...bearer(ava.key) });
    expect(answered.statusCode).toBe(200);
    expect(answered.json().request).toMatchObject({ id: asked.id, status: 'answered', answer: 'Europe.' });
    expect((await c.db.select().from(requests).where(eq(requests.id, asked.id)))[0]).toMatchObject({ answeredBy: c.owner.id, answeredByAssistantId: ava.id });
    await until(async () => (await eventsOf(c, ava.key, told!.seq)).length > 0);
    expect((await eventsOf(c, ava.key, told!.seq)).map(e => [e.kind, e.data])).toEqual([['request_closed', { requestId: asked.id, status: 'answered' }]]);
    expect((await c.app.inject({ url: '/api/assistant/requests', ...bearer(ava.key) })).json().requests).toEqual([]);
  });

  it('show a request about administering the company, which only the owner answers', async () => {
    const c = await company();
    const task = await aTask(c);
    const asked = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'May I use the Mac mini?', topic: 'machines' })).request;
    const ava = await assistantOf(c, c.owner.id);
    await until(async () => (await eventsOf(c, ava.key)).length > 0);
    expect((await eventsOf(c, ava.key))[0]!.data).toMatchObject({ request: { id: asked.id, topic: 'machines', answerable: false } });
    const refused = await c.app.inject({ method: 'POST', url: `/api/assistant/requests/${asked.id}/answer`, payload: { answer: 'Yes.' }, ...bearer(ava.key) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('assistant_not_allowed');
    expect((await c.db.select().from(requests).where(eq(requests.id, asked.id)))[0]!.status).toBe('open');
  });

  it('go to their own assistant alone, and a request only to the assistant of the person it waits for', async () => {
    const c = await company();
    await invitePerson(c.app, c.ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [c.sales.id] } });
    const [ann] = await c.db.select().from(people).where(eq(people.email, 'ann@acme.com'));
    const ava = await assistantOf(c, c.owner.id);
    const max = await assistantOf(c, ann!.id, 'Max');
    await ask(c.app.ctx, c.worker.id, (await aTask(c)).id, { kind: 'question', text: 'Which region first?', topic: 'task' });
    await write(c, ava.key, c.orchestrator.id, 'Plan the launch.');
    const run = await nextOf(c.builtin, 'job.run');
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(async () => (await eventsOf(c, ava.key)).length === 1 && (await eventsOf(c, max.key)).length === 1);
    expect((await eventsOf(c, ava.key)).map(e => e.kind)).toEqual(['reply_end']);
    expect((await eventsOf(c, max.key)).map(e => e.kind)).toEqual(['request']);
    expect((await c.app.inject({ url: '/api/assistant/requests', ...bearer(ava.key) })).json().requests).toEqual([]);
  });

  it("answer only what the owner may answer: a request of a department the owner does not reach is refused", async () => {
    const c = await company();
    const [design] = await c.db.insert(departments).values({ companyId: c.acme.id, templateKey: 'design', roleCode: 'DES' }).returning();
    await invitePerson(c.app, c.ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [c.sales.id] } });
    await invitePerson(c.app, c.ceo, { name: 'Bob', email: 'bob@acme.com', access: { departments: [design!.id] } });
    const [ann] = await c.db.select().from(people).where(eq(people.email, 'ann@acme.com'));
    const [bob] = await c.db.select().from(people).where(eq(people.email, 'bob@acme.com'));
    const max = await assistantOf(c, ann!.id, 'Max');
    const rex = await assistantOf(c, bob!.id, 'Rex');
    const asked = (await ask(c.app.ctx, c.worker.id, (await aTask(c)).id, { kind: 'question', text: 'Which region first?', topic: 'task' })).request;
    const answer = (key: string) => c.app.inject({ method: 'POST', url: `/api/assistant/requests/${asked.id}/answer`, payload: { answer: 'Europe.' }, ...bearer(key) });
    const refused = await answer(rex.key);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('decision_not_allowed');
    expect((await answer(max.key)).statusCode).toBe(200);
    expect((await c.db.select().from(requests).where(eq(requests.id, asked.id)))[0]).toMatchObject({ status: 'answered', answeredBy: ann!.id, answeredByAssistantId: max.id });
  });

  it('older than thirty days go', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.owner.id);
    const old = await storeEvent(c.db, { companyId: c.acme.id, assistantId: ava.id, kind: 'request_closed', data: { requestId: 'x', status: 'answered' } });
    const kept = await storeEvent(c.db, { companyId: c.acme.id, assistantId: ava.id, kind: 'request_closed', data: { requestId: 'y', status: 'answered' } });
    const now = new Date('2026-11-11T12:00:00Z');
    await c.db.update(assistantEvents).set({ createdAt: new Date('2026-10-12T11:59:00Z') }).where(eq(assistantEvents.seq, old));
    await c.db.update(assistantEvents).set({ createdAt: new Date('2026-10-12T12:01:00Z') }).where(eq(assistantEvents.seq, kept));
    await sweepEvents(c.db, now);
    expect((await c.db.select({ seq: assistantEvents.seq }).from(assistantEvents)).map(e => e.seq)).toEqual([kept]);
  });
});

describe('a wake at the events address', () => {
  it('is signed with the secret over its exact body, and tried again after a growing pause until it gets through', async () => {
    const c = await company();
    const pauses: number[] = [];
    c.app.ctx.assistants.wakes.delay = async ms => void pauses.push(ms);
    const address = await standIn([500, 503]);
    const ava = await assistantOf(c, c.owner.id, 'Ava', address.url);
    await ask(c.app.ctx, c.worker.id, (await aTask(c)).id, { kind: 'question', text: 'Which region first?', topic: 'task' });
    await until(() => address.wakes.length === 3);
    const [told] = await eventsOf(c, ava.key);
    expect(pauses).toEqual([1000, 2000]);
    for (const wake of address.wakes) {
      expect(JSON.parse(wake.body)).toEqual({ type: 'wake', after: told!.seq - 1 });
      expect(wake.signature).toBe(`sha256=${createHmac('sha256', ava.secret).update(wake.body).digest('hex')}`);
    }
  });

  it('holds up nothing while it waits to be tried again', async () => {
    const c = await company();
    c.app.ctx.assistants.wakes.delay = () => new Promise<void>(() => {});
    const address = await standIn([500]);
    const ava = await assistantOf(c, c.owner.id, 'Ava', address.url);
    const task = await aTask(c);
    await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which region first?', topic: 'task' });
    await until(() => address.wakes.length === 1);
    await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which city then?', topic: 'task' });
    await until(async () => (await eventsOf(c, ava.key)).length === 2);
    expect(address.wakes).toHaveLength(1);
  });
});
