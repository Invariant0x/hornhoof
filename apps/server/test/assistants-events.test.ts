import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { agents, assistantEvents, companies, departments, people, requests } from '../src/db/schema.js';
import { storeEvent, sweepEvents } from '../src/modules/assistants/events.js';
import { cardPrincipal } from '../src/modules/conversation/decision-context.js';
import { FILE_BYTES } from '../src/modules/tasks/attachments.js';
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

async function assistantOf(c: Company, ownerId: string, name = 'Ava', eventsUrl?: string, program = 'avaclone') {
  const { id } = (await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name, owner: ownerId, program, eventsUrl }, ...as(c.ceo) })).json().person;
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
  const wakes: { body: string; signature: string | undefined; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      wakes.push({ body, signature: req.headers['x-hornhoof-signature'] as string | undefined, headers: req.headers });
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
    expect(first.events).toEqual([{ seq: expect.any(Number), kind: 'reply', at: expect.any(String), data: { messageId: sent.id, agent, byOwnAgent: false, text: 'On it.' } }]);
    expect(first.next).toBe(first.events[0].seq);
    c.builtin.send({ type: 'job.event', jobId: run.jobId, seq: 1, event: { kind: 'text', text: 'The plan is ready.' } });
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(async () => (await eventsOf(c, ava.key, first.next)).some(e => e.kind === 'reply_end'));
    const rest = await eventsOf(c, ava.key, first.next);
    expect(rest.map(e => [e.kind, e.data])).toEqual([
      ['reply', { messageId: sent.id, agent, byOwnAgent: false, text: 'The plan is ready.' }],
      ['reply_end', { messageId: sent.id, agent, byOwnAgent: false, answered: true, failed: false }],
    ]);
    expect(rest[0]!.seq).toBeLessThan(rest[1]!.seq);
  });

  it('carry the files the agent attached to its answer, which the assistant downloads for its owner', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.owner.id);
    const sent = (await write(c, ava.key, c.orchestrator.id, 'Send me the report.')).json().message;
    const run = await nextOf(c.builtin, 'job.run');
    c.builtin.send({ type: 'job.started', jobId: run.jobId });
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a]);
    /* What hh-attach --chat FILE sends from the turn. */
    const attached = await c.app.inject({ method: 'POST', url: '/api/attachments?chat=1&name=Report%20May.pdf', headers: { authorization: `Bearer ${run.toolToken}`, 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(attached.statusCode).toBe(201);
    const file = attached.json() as { id: string; name: string };
    c.builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'Here is the report.' } });
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(async () => (await eventsOf(c, ava.key)).some(e => e.kind === 'reply_end'));
    const agent = { id: c.orchestrator.id, name: c.orchestrator.name, kind: 'orchestrator' };
    expect((await eventsOf(c, ava.key)).map(e => [e.kind, e.data])).toEqual([
      ['reply', { messageId: sent.id, agent, byOwnAgent: false, text: '', files: [{ id: file.id, name: 'Report May.pdf', url: expect.stringMatching(`^${c.app.ctx.config.publicUrl}/api/files/`) }] }],
      ['reply', { messageId: sent.id, agent, byOwnAgent: false, text: 'Here is the report.' }],
      ['reply_end', { messageId: sent.id, agent, byOwnAgent: false, answered: true, failed: false }],
    ]);
    const got = await c.app.inject({ url: `/api/assistant/attachments/${file.id}`, ...bearer(ava.key) });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(bytes)).toBe(true);
    /* The link opens on the owner's phone, with no key. */
    const linked = (await eventsOf(c, ava.key))[0]!.data as { files: { url: string }[] };
    const opened = await c.app.inject({ url: new URL(linked.files[0]!.url).pathname });
    expect(opened.statusCode).toBe(200);
    expect(opened.rawPayload.equals(bytes)).toBe(true);
  });

  it('mark a file over 50 MB as big, and its link downloads it from the disk of the machine that took it', async () => {
    const c = await company();
    const dir = mkdtempSync(join(tmpdir(), 'hh-files-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    c.app.ctx.config.filesDir = dir;
    const ava = await assistantOf(c, c.owner.id);
    await write(c, ava.key, c.orchestrator.id, 'Send me the archive.');
    const run = await nextOf(c.builtin, 'job.run');
    c.builtin.send({ type: 'job.started', jobId: run.jobId });
    const bytes = Buffer.alloc(FILE_BYTES + 1, 4);
    const attached = await c.app.inject({ method: 'POST', url: '/api/attachments?chat=1&name=archive.zip', headers: { authorization: `Bearer ${run.toolToken}`, 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(attached.statusCode).toBe(201);
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(async () => (await eventsOf(c, ava.key)).some(e => e.kind === 'reply_end'));
    const reply = (await eventsOf(c, ava.key))[0]!.data as { files: { id: string; name: string; url: string; big?: true }[] };
    expect(reply.files).toEqual([{ id: attached.json().id, name: 'archive.zip', url: expect.any(String), big: true }]);
    const opened = await c.app.inject({ url: new URL(reply.files[0]!.url).pathname });
    expect(opened.headers['content-length']).toBe(String(FILE_BYTES + 1));
    expect(opened.rawPayload.equals(bytes)).toBe(true);
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
    expect((await eventsOf(c, ava.key)).map(e => [e.kind, e.data])).toEqual([['reply_end', { messageId: sent.id, agent: expect.objectContaining({ id: c.orchestrator.id }), byOwnAgent: false, answered: false, failed: true }]]);
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

  it('show a request about administering the company, which the assistant answers as its owner would', async () => {
    const c = await company();
    const task = await aTask(c);
    const asked = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'May I use the Mac mini?', topic: 'machines' })).request;
    const ava = await assistantOf(c, c.owner.id);
    await until(async () => (await eventsOf(c, ava.key)).length > 0);
    expect((await eventsOf(c, ava.key))[0]!.data).toMatchObject({ request: { id: asked.id, topic: 'machines', answerable: true } });
    const answered = await c.app.inject({ method: 'POST', url: `/api/assistant/requests/${asked.id}/answer`, payload: { answer: 'Yes.' }, ...bearer(ava.key) });
    expect(answered.statusCode).toBe(200);
    expect((await c.db.select().from(requests).where(eq(requests.id, asked.id)))[0]).toMatchObject({ status: 'answered', answeredBy: c.owner.id, answeredByAssistantId: ava.id });
    /* The machine's card goes by the owner's answer, as when they gave it themselves. */
    expect(await cardPrincipal(c.db, c.acme.id, asked.id)).toBe(c.owner.id);
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

  it("goes to OpenClaw's wake hook with the signing secret as its token, once an answer is over, from before its first word", async () => {
    const c = await company();
    const address = await standIn([]);
    const ava = await assistantOf(c, c.owner.id, 'Ava', address.url, 'openclaw');
    await write(c, ava.key, c.orchestrator.id, 'Plan the launch.');
    const run = await nextOf(c.builtin, 'job.run');
    c.builtin.send({ type: 'job.started', jobId: run.jobId });
    c.builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'On it.' } });
    await until(async () => (await eventsOf(c, ava.key)).length === 1);
    /* A moment for a wake that would go for a word alone; none does. */
    await new Promise(done => setTimeout(done, 100));
    expect(address.wakes).toEqual([]);
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => address.wakes.length === 1);
    const [word, end] = await eventsOf(c, ava.key);
    expect(end!.kind).toBe('reply_end');
    const [wake] = address.wakes;
    expect(wake!.headers).toMatchObject({ authorization: `Bearer ${ava.secret}`, 'content-type': 'application/json' });
    expect(wake!.signature).toBeUndefined();
    const after = word!.seq - 1;
    expect(JSON.parse(wake!.body)).toEqual({ text: `New events wait for you in Hornhoof after number ${after}. Read them with the Hornhoof tool read_events, with after ${after}, and tell your owner what they need to know.`, mode: 'now' });
  });

  it('goes to a Hermes webhook signed as Hermes checks it, and a request that waits no more joins the next wake', async () => {
    const c = await company();
    const address = await standIn([]);
    const ava = await assistantOf(c, c.owner.id, 'Ava', address.url, 'hermes');
    const task = await aTask(c);
    const asked = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which region first?', topic: 'task' })).request;
    await until(() => address.wakes.length === 1);
    const [told] = await eventsOf(c, ava.key);
    const [wake] = address.wakes;
    expect(JSON.parse(wake!.body)).toEqual({ type: 'wake', after: told!.seq - 1 });
    const stamp = wake!.headers['x-webhook-timestamp'] as string;
    expect(Math.abs(Number(stamp) - Date.now() / 1000)).toBeLessThan(60);
    expect(wake!.headers['x-webhook-signature-v2']).toBe(createHmac('sha256', ava.secret).update(`${stamp}.${wake!.body}`).digest('hex'));
    expect(wake!.headers['x-request-id']).toBe(`hornhoof-${ava.id}-${told!.seq - 1}`);
    expect(wake!.signature).toBeUndefined();

    await c.app.inject({ method: 'POST', url: `/api/assistant/requests/${asked.id}/answer`, payload: { answer: 'Europe.' }, headers: { authorization: `Bearer ${ava.key}` } });
    await until(async () => (await eventsOf(c, ava.key, told!.seq)).length === 1);
    await new Promise(done => setTimeout(done, 100));
    expect(address.wakes).toHaveLength(1);
    const [closed] = await eventsOf(c, ava.key, told!.seq);
    await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which city then?', topic: 'task' });
    await until(() => address.wakes.length === 2);
    expect(JSON.parse(address.wakes[1]!.body)).toEqual({ type: 'wake', after: closed!.seq - 1 });
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

describe('the work for assistants, stopped and started again as a server gets and loses the lead', () => {
  it('lets its long polls go at a stop, sends nothing while stopped, and carries events and wakes again after a new start', async () => {
    const c = await company();
    const service = c.app.ctx.assistants;
    /* A long poll here waits until it hears an event or is let go, never for a time. */
    let waiting = 0;
    service.pause = (_ms, signal) => {
      waiting += 1;
      return new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
    };
    const address = await standIn([]);
    const ava = await assistantOf(c, c.owner.id, 'Ava', address.url);
    const task = await aTask(c);
    const question = (text: string) => ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text, topic: 'task' });
    const texts = (events: Event[]) => events.map(e => (e.data.request as { text: string }).text);

    await question('Which region first?');
    await until(() => address.wakes.length === 1);
    const [first] = await eventsOf(c, ava.key);
    const letGo = read(c, ava.key, first!.seq, 50);
    await until(() => waiting === 1);
    await service.stop();
    expect((await letGo).json()).toEqual({ events: [], next: first!.seq });

    /* While stopped, a new request is told to nobody and wakes nobody; a long poll waits for the next start. */
    await question('Which city then?');
    service.collect(c.acme.id);
    const meanwhile = read(c, ava.key, first!.seq, 50);
    await until(() => waiting === 2);
    /* A moment for anything that would still go, so that it shows here; nothing does. */
    await new Promise(done => setTimeout(done, 100));
    expect(await eventsOf(c, ava.key, first!.seq)).toEqual([]);
    expect(address.wakes).toHaveLength(1);

    await service.start();
    const heard = (await meanwhile).json();
    expect(texts(heard.events)).toEqual(['Which city then?']);
    await until(() => address.wakes.length === 2);
    expect(JSON.parse(address.wakes[1]!.body)).toEqual({ type: 'wake', after: heard.events[0].seq - 1 });

    const next = read(c, ava.key, heard.next, 50);
    await until(() => waiting === 3);
    await question('Which shop first?');
    const later = (await next).json();
    expect(texts(later.events)).toEqual(['Which shop first?']);
    await until(() => address.wakes.length === 3);
    expect(JSON.parse(address.wakes[2]!.body)).toEqual({ type: 'wake', after: later.events[0].seq - 1 });
  });
});
