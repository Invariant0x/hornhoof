import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, people, requests, subscriptions, taskEvents } from '../src/db/schema.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { BUILTIN } from './builtin.js';
import { fakeTelegram, type TelegramUser } from './fake-telegram.js';
import { as, connectNode, invitePerson, listen, mcp, nextOf, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'r'.repeat(40);
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const IVAN_TG: TelegramUser = { id: 5550001, first_name: 'Ivan', username: 'Ivan_K', language_code: 'en' };

type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as Result;

async function setUp(withTelegram = false) {
  const tg = withTelegram ? await fakeTelegram() : null;
  if (tg) tg.bots.set(BOT_TOKEN, { id: 123456789, username: 'acme_ceo_bot', first_name: 'Acme' });
  const { app, db } = await testApp({ NODE_KEY, ...(tg ? { TELEGRAM_API_URL: tg.url } : {}) });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const node = await connectNode(url, NODE_KEY);
  onTestFinished(() => node.close());
  node.ws.on('message', data => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.type === 'agent.say') node.send({ type: 'agent.said', ref: message.ref, ok: true });
  });
  node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], terminals: true });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null, null, BUILTIN)!));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, departmentId: dev!.id, subscriptionId: sub!.id, name, kind, roleKey, model: '' }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  let tokens = 0;
  const client = async (agent: { id: string }, taskId: string | null = null) => {
    const token = `chat-replies-${++tokens}-0123456789abcdef`;
    const [job] = await db
      .insert(jobs)
      .values({
        companyId: acme!.id,
        subscriptionId: sub!.id,
        agentId: agent.id,
        taskId,
        kind: 'conversation',
        prompt: '',
        timeoutMs: 900000,
        status: 'running',
        startedAt: new Date(),
        toolTokenHash: hashToken(token),
      })
      .returning();
    return { client: await mcp(app, token), job: job! };
  };
  return { app, db, tg, ceo, node, acme: acme!, sub: sub!, owner: owner!, orchestrator: orchestrator!, dev: dev!, hana, bruno, client };
}

const eventsOf = async (app: FastifyInstance, token: string, agent: string, query = '') =>
  (await app.inject({ url: `/api/agents/${agent}/events${query}`, ...as(token) })).json().events as Array<{
    seq: number;
    number?: number;
    kind: string;
    data: { text?: string };
    task?: { id: string; number: number };
    replyTo?: { number: number; seq: number; sender: { id: string | null; name: string; kind: string }; excerpt: string; task?: { id: string; number: number }; requestId?: string };
  }>;

describe('stable chat message numbers and task markers', () => {
  it('assigns sequential numbers per chat with or without tasks, skips work steps, backfills older rows on read, and stays identical across reloads', async () => {
    const c = await setUp();
    /* Pre-existing rows written before message numbers existed get numbered deterministically on first read. */
    await c.db.insert(agentEvents).values([
      { companyId: c.acme.id, agentId: c.bruno.id, personId: c.owner.id, kind: 'message', data: { text: 'Legacy first note.' } },
      { companyId: c.acme.id, agentId: c.bruno.id, kind: 'tool', data: { name: 'hornhoof.company', input: '{}' } },
      { companyId: c.acme.id, agentId: c.bruno.id, kind: 'text', data: { text: 'Legacy reply.' } },
    ]);

    const firstRead = await eventsOf(c.app, c.ceo, c.bruno.id);
    expect(firstRead.map(e => [e.kind, e.number ?? null])).toEqual([
      ['message', 1],
      ['tool', null],
      ['text', 2],
    ]);

    /* A chat without a task continues numbering cleanly, and another agent's chat starts at #1 independently. */
    const sent = await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/messages`, payload: { text: 'Check the schema.' }, ...as(c.ceo) });
    expect(sent.statusCode).toBe(202);
    const run = await nextOf(c.node, 'job.run');
    c.node.send({ type: 'job.started', jobId: run.jobId });
    c.node.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'tool', name: 'hornhoof.tasks', input: '{}' } });
    c.node.send({ type: 'job.event', jobId: run.jobId, seq: 1, event: { kind: 'text', text: 'Schema checked.' } });
    c.node.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: 'Done', tail: '', error: null });
    await until(() => c.node.acks.includes(run.jobId));

    const { task } = await createTask(c.app.ctx, { agentId: c.hana.id }, { title: 'Checkout', brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true });
    await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/messages`, payload: { text: 'Ship this on Friday.', task: task.number }, ...as(c.ceo) });

    /* Separate chat starts from #1. */
    await c.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'Hello orchestrator.' }, ...as(c.ceo) });

    const reloadA = await eventsOf(c.app, c.ceo, c.bruno.id, '?last=300');
    const reloadB = await eventsOf(c.app, c.ceo, c.bruno.id);
    expect(reloadA.filter(e => e.number !== undefined).map(e => ({ n: e.number, text: e.data.text, task: e.task?.number ?? null }))).toEqual([
      { n: 1, text: 'Legacy first note.', task: null },
      { n: 2, text: 'Legacy reply.', task: null },
      { n: 3, text: 'Check the schema.', task: null },
      { n: 4, text: 'Schema checked.', task: null },
      { n: 5, text: 'Ship this on Friday.', task: task.number },
    ]);
    expect(reloadB.map(e => e.number ?? null)).toEqual(reloadA.map(e => e.number ?? null));

    const orchEvents = await eventsOf(c.app, c.ceo, 'orchestrator');
    expect(orchEvents.find(e => e.data.text === 'Hello orchestrator.')?.number).toBe(1);
  });
});

describe('reply with quote as structured context and masked parties', () => {
  it('delivers quoted number, sender and excerpt to the agent without pasting into message text, and masks hidden employees', async () => {
    const c = await setUp();
    await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/messages`, payload: { text: 'Compare Stripe and Adyen fees.' }, ...as(c.ceo) });
    const first = await nextOf(c.node, 'job.run');
    c.node.send({ type: 'job.started', jobId: first.jobId });
    c.node.send({ type: 'job.event', jobId: first.jobId, seq: 0, event: { kind: 'text', text: 'Stripe is 2.9% + 30c; Adyen is interchange++.' } });
    c.node.send({ type: 'job.done', jobId: first.jobId, ok: true, sessionId: 's-bruno', result: '', tail: '', error: null });
    await until(() => c.node.acks.includes(first.jobId));

    const missing = await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/messages`, payload: { text: 'Pick the first.', replyTo: 99 }, ...as(c.ceo) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.reason).toBe('message_unknown');

    const replyRes = await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/messages`, payload: { text: 'Use Adyen for EU.', replyTo: 2 }, ...as(c.ceo) });
    expect(replyRes.statusCode).toBe(202);
    const second = await nextOf(c.node, 'job.run');
    c.node.send({ type: 'job.done', jobId: second.jobId, ok: true, sessionId: 's-bruno', result: '', tail: '', error: null });
    await until(() => c.node.acks.includes(second.jobId));

    /* Prompt carries structured reply context above the person's own words, while stored data.text stays pure. */
    expect(second.prompt).toContain('Replying to message #2 from Bruno');
    expect(second.prompt).toContain('> Stripe is 2.9% + 30c; Adyen is interchange++.');
    expect(second.prompt).toContain('Ivan (CEO): Use Adyen for EU.');

    const events = await eventsOf(c.app, c.ceo, c.bruno.id);
    const third = events.find(e => e.number === 3)!;
    expect(third.data.text).toBe('Use Adyen for EU.');
    expect(third.replyTo).toMatchObject({
      number: 2,
      sender: { kind: 'agent', id: c.bruno.id, name: 'Bruno' },
      excerpt: 'Stripe is 2.9% + 30c; Adyen is interchange++.',
    });

    /* If a quoted message came from an employee another viewer cannot see, maskEvent hides the employee's name. */
    const [sales] = await c.db.insert(departments).values({ companyId: c.acme.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const [secretWorker] = await c.db.insert(agents).values({ companyId: c.acme.id, departmentId: sales!.id, subscriptionId: c.sub.id, name: 'Cipher', kind: 'worker', roleKey: 'SAL-SDR', model: '' }).returning();
    const [danaPlan] = await c.db.insert(subscriptions).values({ companyId: c.acme.id, provider: 'codex', kind: 'personal', label: 'Dana plan', ownerPersonId: c.owner.id, status: 'ready' }).returning();
    const dana = await invitePerson(c.app, c.ceo, { name: 'Dana', email: 'dana@acme.com', access: { departments: [c.dev.id] } });
    const [danaRow] = await c.db.select().from(people).where(eq(people.email, 'dana@acme.com'));
    await c.db.update(subscriptions).set({ ownerPersonId: danaRow!.id }).where(eq(subscriptions.id, danaPlan!.id));
    const [danaWorker] = await c.db.insert(agents).values({ companyId: c.acme.id, departmentId: c.dev.id, subscriptionId: danaPlan!.id, name: 'Dora', kind: 'worker', roleKey: 'DEV-BE', model: '' }).returning();

    await c.db.insert(agentEvents).values({
      companyId: c.acme.id,
      agentId: danaWorker!.id,
      kind: 'message',
      data: { from: 'agent', by: secretWorker!.id, name: 'Cipher', text: 'Internal sales figures.' },
    });
    const doraInitial = await eventsOf(c.app, c.ceo, danaWorker!.id);
    expect(doraInitial[0]?.number).toBe(1);
    await c.app.inject({ method: 'POST', url: `/api/agents/${danaWorker!.id}/messages`, payload: { text: 'Noted.', replyTo: 1 }, ...as(c.ceo) });

    const asDana = await eventsOf(c.app, dana, danaWorker!.id);
    const danaReply = asDana.find(e => e.number === 2)!;
    expect(danaReply.replyTo?.sender).toMatchObject({ kind: 'agent', id: null, name: 'Employee' });
  });
});

describe('question-closing rule (#1966) and record_answer with message numbers', () => {
  it('closes only the exact question whose message is replied to, and lets record_answer and task cite message numbers', async () => {
    const c = await setUp();
    const makeTask = async (title: string) =>
      (await createTask(c.app.ctx, { agentId: c.hana.id }, { title, brief: '', body: '', departmentId: c.dev.id, assigneeAgentId: c.bruno.id, executor: true })).task;
    const site = await makeTask('Site');
    const deck = await makeTask('Deck');
    const legal = await makeTask('Legal');

    const { client } = await c.client(c.bruno);
    expect((await call(client, 'ask_person', { task: site.number, question: 'When does the site go live?', topic: 'task' })).isError).toBeFalsy();
    expect((await call(client, 'ask_person', { task: deck.number, question: 'Is the deck ready for Monday?', topic: 'task' })).isError).toBeFalsy();
    expect((await call(client, 'ask_person', { task: legal.number, question: 'Which law firm keeps the table?', topic: 'task' })).isError).toBeFalsy();

    const chat = await eventsOf(c.app, c.ceo, c.bruno.id);
    expect(chat.map(e => ({ n: e.number, task: e.task?.number }))).toEqual([
      { n: 1, task: site.number },
      { n: 2, task: deck.number },
      { n: 3, task: legal.number },
    ]);

    /* Replying to message #2 ("Is the deck ready for Monday?") with plain "Yes." closes ONLY deck's question! */
    const res = await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/messages`, payload: { text: 'Yes.', replyTo: 2 }, ...as(c.ceo) });
    expect(res.statusCode).toBe(202);

    const allRequests = await c.db.select().from(requests).orderBy(requests.createdAt);
    expect(allRequests.map(r => [r.taskId, r.status, r.answer])).toEqual([
      [site.id, 'open', null],
      [deck.id, 'answered', 'Yes.'],
      [legal.id, 'open', null],
    ]);

    const deckTaskView = JSON.parse((await call(client, 'task', { task: deck.number })).content[0]!.text) as {
      requests: Array<{ messageNumber?: number; answerMessage?: { number: number; replyTo?: number } }>;
    };
    expect(deckTaskView.requests[0]).toMatchObject({
      messageNumber: 2,
      answerMessage: { number: 4, replyTo: 2 },
    });

    /* A general message answering another question can be recorded by its chat message number (#5) via record_answer. */
    await c.app.inject({ method: 'POST', url: `/api/agents/${c.bruno.id}/messages`, payload: { text: 'Friday morning; legal waits.' }, ...as(c.ceo) });
    const siteReq = allRequests.find(r => r.taskId === site.id)!;
    const legalReq = allRequests.find(r => r.taskId === legal.id)!;

    const recorded = await call(client, 'record_answer', { request: siteReq.id, message: 5 });
    expect(recorded.isError, recorded.content[0]?.text).toBeFalsy();

    const [updatedSite] = await c.db.select().from(requests).where(eq(requests.id, siteReq.id));
    const [updatedLegal] = await c.db.select().from(requests).where(eq(requests.id, legalReq.id));
    expect(updatedSite).toMatchObject({ status: 'answered', answer: 'Friday morning; legal waits.', answeredBy: c.owner.id });
    expect(updatedLegal?.status).toBe('open');

    const [answeredEvent] = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, site.id), eq(taskEvents.kind, 'answered'))).orderBy(desc(taskEvents.id)).limit(1);
    expect(answeredEvent?.data).toMatchObject({
      requestId: siteReq.id,
      message: expect.objectContaining({ agentId: c.bruno.id, number: 5 }),
    });
  });
});

describe('Telegram two-way reply mapping', () => {
  it('maps Telegram replies to Hornhoof message numbers and bridges window replies from person and agent back as Telegram replies', async () => {
    const c = await setUp(true);
    const tg = c.tg!;
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.owner.id}`, payload: { telegram: '@Ivan_K' }, ...as(c.ceo) });
    expect((await c.app.inject({ method: 'PUT', url: '/api/agents/orchestrator/telegram', payload: { token: BOT_TOKEN }, ...as(c.ceo) })).statusCode).toBe(200);

    /* 1. Ordinary message in Telegram (#1, tg message_id 1) and ordinary answer (#2, tg message_id 2). */
    tg.write(BOT_TOKEN, IVAN_TG, 'Draft the launch note.');
    const run1 = await nextOf(c.node, 'job.run');
    c.node.send({ type: 'job.started', jobId: run1.jobId });
    c.node.send({ type: 'job.event', jobId: run1.jobId, seq: 0, event: { kind: 'text', text: 'Launch note v1 is ready.' } });
    c.node.send({ type: 'job.done', jobId: run1.jobId, ok: true, sessionId: 'tg-1', result: '', tail: '', error: null });
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]).toEqual({ token: BOT_TOKEN, chat_id: IVAN_TG.id, text: 'Launch note v1 is ready.' });

    /* 2. Person replies in Telegram to the agent's answer (tg message_id 2 -> Hornhoof #2). */
    tg.send(BOT_TOKEN, IVAN_TG, { text: 'Shorten the second paragraph.', reply_to_message: { message_id: 2, text: 'Launch note v1 is ready.' } });
    const run2 = await nextOf(c.node, 'job.run');
    expect(run2.prompt).toContain('Replying to message #2 from Orchestrator');
    expect(run2.prompt).toContain('> Launch note v1 is ready.');
    c.node.send({ type: 'job.started', jobId: run2.jobId });
    c.node.send({ type: 'job.event', jobId: run2.jobId, seq: 0, event: { kind: 'text', text: 'Shortened in v2.' } });
    c.node.send({ type: 'job.done', jobId: run2.jobId, ok: true, sessionId: 'tg-1', result: '', tail: '', error: null });
    await until(() => tg.sent.length === 2);
    /* Agent's answer to that Telegram reply carries reply_to_message_id: 3 on Telegram! */
    expect(tg.sent[1]).toEqual({ token: BOT_TOKEN, chat_id: IVAN_TG.id, text: 'Shortened in v2.', reply_to_message_id: 3 });

    const afterTgReply = await eventsOf(c.app, c.ceo, 'orchestrator');
    expect(afterTgReply.find(e => e.number === 3)?.replyTo).toMatchObject({
      number: 2,
      excerpt: 'Launch note v1 is ready.',
    });

    /* 3. Person replies in the Hornhoof window to bridged message #1 (tg message_id 1): bridged to Telegram as a reply, and the agent's answer replies too. */
    const winReply = await c.app.inject({
      method: 'POST',
      url: '/api/agents/orchestrator/messages',
      payload: { text: 'Keep the original headline.', replyTo: 1 },
      ...as(c.ceo),
    });
    expect(winReply.statusCode).toBe(202);
    const run3 = await nextOf(c.node, 'job.run');
    await until(() => tg.sent.length === 3);
    expect(tg.sent[2]).toMatchObject({
      token: BOT_TOKEN,
      chat_id: IVAN_TG.id,
      reply_to_message_id: 1,
    });
    expect(tg.sent[2]!.text).toContain('Keep the original headline.');

    c.node.send({ type: 'job.started', jobId: run3.jobId });
    c.node.send({ type: 'job.event', jobId: run3.jobId, seq: 0, event: { kind: 'text', text: 'Headline restored.' } });
    c.node.send({ type: 'job.done', jobId: run3.jobId, ok: true, sessionId: 'tg-1', result: '', tail: '', error: null });
    await until(() => tg.sent.length === 4);
    expect(tg.sent[3]).toEqual({
      token: BOT_TOKEN,
      chat_id: IVAN_TG.id,
      text: 'Headline restored.',
      reply_to_message_id: 5,
    });
  });
});
