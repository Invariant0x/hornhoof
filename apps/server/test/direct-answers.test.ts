import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { personColumns, type Person } from '../src/auth/session.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, people, requests, subscriptions, taskEvents } from '../src/db/schema.js';
import { writeToAgent } from '../src/modules/conversation/routes.js';
import { appendEvent } from '../src/modules/events/store.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { answerDirectly, ask, createTask } from '../src/modules/tasks/engine.js';
import { BUILTIN } from './builtin.js';
import { as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until } from './helpers.js';

/* A person's words to an agent close one of its questions only when it is clear which: the only one that person may answer,
   or the one the words name. Otherwise they reach the agent as its message, and the agent records which question they
   answered, citing the person's own words. Seen 23.11 in a company on Hornhoof: one answer about a site closed the cards
   about a deck and a legal table too, and the agent asked them again. */

const NODE_KEY = 'd'.repeat(40);
type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;

/* Acme with Development, its head Hana and Bruno; the CEO Ivan, and Zed, who sees the whole company but takes no decision of
   Development's. Bruno's node is up, so a window takes words for him. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
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
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, departmentId: dev!.id, subscriptionId: sub!.id, name, kind, roleKey, model: '' }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const zed = await invitePerson(app, ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
  const ids = Object.fromEntries((await db.select().from(people)).map(p => [p.name.toLowerCase(), p.id])) as Record<'ivan' | 'zed', string>;
  const asked = async (title: string, question: string) => {
    const { task } = await createTask(app.ctx, { agentId: hana.id }, { title, brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true });
    return { task, request: (await ask(app.ctx, bruno.id, task.id, { kind: 'question', text: question, topic: 'task' })).request };
  };
  /* What Bruno asked the CEO on three tasks of his. */
  const three = async () => ({
    site: await asked('Site', 'When does the site go live?'),
    deck: await asked('Deck', 'Is the deck ready for Monday?'),
    legal: await asked('Legal', 'Which law firm keeps the table?'),
  });
  const saved = async (id: string) => (await db.select().from(requests).where(eq(requests.id, id)))[0]!;
  const open = async (...asks: { request: { id: string } }[]) => Promise.all(asks.map(async a => (await saved(a.request.id)).status === 'open'));
  const wrote = (token: string, text: string, agentId = bruno.id) => app.inject({ method: 'POST', url: `/api/agents/${agentId}/messages`, payload: { text }, ...as(token) });
  /* The newest message a person wrote to Bruno, as his window keeps it. */
  const lastMessage = async () => (await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, bruno.id), eq(agentEvents.kind, 'message'))).orderBy(desc(agentEvents.seq)).limit(1))[0]!;
  let tokens = 0;
  const client = async (agent: { id: string }) => {
    const token = `direct-answers-${++tokens}-0123456789abcdef`;
    const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) }).returning();
    return { client: await mcp(app, token), job: job! };
  };
  const person = async (id: string): Promise<Person> => (await db.select(personColumns).from(people).where(eq(people.id, id)))[0]!;
  return { app, db, ctx: app.ctx, acme: acme!, dev: dev!, hana, bruno, tokens: { ceo, zed }, ids, asked, three, saved, open, wrote, lastMessage, client, person };
}

describe("a person's words to an agent directly", () => {
  it('close none of three open questions, and reach the agent as its message', async () => {
    const c = await company();
    const { site, deck, legal } = await c.three();
    expect((await c.wrote(c.tokens.ceo, 'The site goes live on Friday.')).statusCode).toBe(202);
    expect(await c.open(site, deck, legal)).toEqual([true, true, true]);
    expect(await c.lastMessage()).toMatchObject({ personId: c.ids.ivan, data: expect.objectContaining({ text: 'The site goes live on Friday.' }) });
  });

  it('still close the only open question that person may answer', async () => {
    const c = await company();
    const { request } = await c.asked('Site', 'When does the site go live?');
    expect((await c.wrote(c.tokens.ceo, 'On Friday.')).statusCode).toBe(202);
    expect(await c.saved(request.id)).toMatchObject({ status: 'answered', answer: 'On Friday.', answeredBy: c.ids.ivan });
  });

  it('close the one question whose task they name, link or quote, and no other', async () => {
    const c = await company();
    const { site, deck, legal } = await c.three();
    await c.wrote(c.tokens.ceo, `#${deck.task.number}: yes, it is ready.`);
    expect(await c.open(site, deck, legal)).toEqual([true, false, true]);
    await c.wrote(c.tokens.ceo, '> Which law firm keeps the table?\nAcme Legal.');
    expect(await c.open(site, legal)).toEqual([true, false]);
    expect((await c.saved(legal.request.id)).answer).toBe('> Which law firm keeps the table?\nAcme Legal.');
    const two = await c.asked('Shop', 'Which bank takes the cards?');
    await c.wrote(c.tokens.ceo, `Friday, see https://hornhoof.example/tasks/${site.task.id}`);
    expect(await c.open(site, two)).toEqual([false, true]);
  });

  it('go by Telegram and by the person\'s assistant the same way', async () => {
    const c = await company();
    const { site, deck, legal } = await c.three();
    const me = await c.person(c.ids.ivan);
    await writeToAgent(c.ctx, me, c.bruno, { text: 'The site goes live on Friday.', pictures: [], telegram: { bot: randomUUID(), chat: 1, update: 1, lang: 'en' } });
    expect(await c.open(site, deck, legal)).toEqual([true, true, true]);
    await writeToAgent(c.ctx, { ...me, assistant: { id: randomUUID(), name: 'Assistant' } }, c.bruno, { text: 'The deck is ready.', pictures: [], assistant: { message: randomUUID() } });
    expect(await c.open(site, deck, legal)).toEqual([true, true, true]);
    await writeToAgent(c.ctx, me, c.bruno, { text: 'Acme Legal keeps it.', pictures: [], task: legal.task.number });
    expect(await c.open(site, deck, legal)).toEqual([true, true, false]);
  });

  it('typed in the terminal close none of several open questions either', async () => {
    const c = await company();
    const { site, deck } = await c.three();
    await answerDirectly(c.ctx, c.ids.ivan, c.bruno.id, 'Friday, and yes.');
    expect(await c.open(site, deck)).toEqual([true, true]);
  });
});

describe('record_answer', () => {
  it("records the person's whole message as their answer on the question it quotes, linked to the message, and closes no other", async () => {
    const c = await company();
    const { site, deck, legal } = await c.three();
    const { client } = await c.client(c.bruno);
    await c.wrote(c.tokens.ceo, 'Site: Friday.\nDeck: not before Tuesday.');
    const message = await c.lastMessage();
    const recorded = await call(client, 'record_answer', { request: site.request.id, words: 'Site: Friday.' });
    expect(recorded.isError, recorded.content[0]?.text).toBeFalsy();
    expect(await c.saved(site.request.id)).toMatchObject({ status: 'answered', answer: 'Site: Friday.\nDeck: not before Tuesday.', answeredBy: c.ids.ivan, answeredByAgentId: c.bruno.id, answerJobId: message.jobId, answerSourceSeq: message.seq });
    expect(await c.open(deck, legal)).toEqual([true, true]);
    const [note] = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, site.task.id), eq(taskEvents.kind, 'answered')));
    expect(note).toMatchObject({ personId: c.ids.ivan, data: expect.objectContaining({ requestId: site.request.id, message: { agentId: c.bruno.id, seq: message.seq, number: 1 }, recordedBy: c.bruno.id }) });
    expect((await call(client, 'record_answer', { request: deck.request.id, words: 'Deck:   not before\nTuesday.' })).isError).toBeFalsy();
    expect(await c.saved(deck.request.id)).toMatchObject({ answer: 'Site: Friday.\nDeck: not before Tuesday.', answeredBy: c.ids.ivan });
    expect(await c.open(deck, legal)).toEqual([false, true]);
  });

  /* Of "I do not want the deck", no quote makes an answer the person did not give. */
  it('keeps the meaning of the message whatever part the agent quotes', async () => {
    const c = await company();
    const { deck } = await c.three();
    const { client } = await c.client(c.bruno);
    await c.wrote(c.tokens.ceo, 'I do not want the deck yet.');
    expect((await call(client, 'record_answer', { request: deck.request.id, words: 'want the deck' })).isError).toBeFalsy();
    expect((await c.saved(deck.request.id)).answer).toBe('I do not want the deck yet.');
  });

  it('takes words a person typed in the terminal', async () => {
    const c = await company();
    const { legal } = await c.three();
    const { client, job } = await c.client(c.bruno);
    await appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.bruno.id, jobId: job.id, kind: 'typed', personId: c.ids.ivan, data: { text: 'Acme Legal keeps the table.' } });
    expect((await call(client, 'record_answer', { request: legal.request.id, words: 'Acme Legal keeps the table.' })).isError).toBeFalsy();
    expect(await c.saved(legal.request.id)).toMatchObject({ status: 'answered', answeredBy: c.ids.ivan });
  });

  /* A message the program never took goes again with its next turn: the copy is the same message, not a second one. */
  it('takes a message repeated into the next turn as the one message it is', async () => {
    const c = await company();
    const { legal } = await c.three();
    const { client, job } = await c.client(c.bruno);
    await c.wrote(c.tokens.ceo, 'Acme Legal keeps the table.');
    const message = await c.lastMessage();
    await appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.bruno.id, jobId: job.id, kind: 'typed', personId: c.ids.ivan, data: { ...(message.data as object), queuedEvent: message.seq } });
    await appendEvent(c.ctx, { companyId: c.acme.id, agentId: c.bruno.id, jobId: job.id, kind: 'typed', personId: c.ids.ivan, data: { ...(message.data as object), unheardFrom: message.jobId } });
    const recorded = await call(client, 'record_answer', { request: legal.request.id, words: 'Acme Legal keeps' });
    expect(recorded.isError, recorded.content[0]?.text).toBeFalsy();
    expect(await c.saved(legal.request.id)).toMatchObject({ status: 'answered', answeredBy: c.ids.ivan, answerSourceSeq: message.seq });
  });

  it("refuses words nobody wrote, words from before the question, a person who may not answer, words of two messages, and another agent's question", async () => {
    const c = await company();
    /* His turn runs, so each message reaches it, and his window, at once. */
    const { client } = await c.client(c.bruno);
    expect((await c.wrote(c.tokens.ceo, 'Acme Legal keeps the table.')).statusCode).toBe(202);
    const { site, deck, legal } = await c.three();
    const refused = async (args: Record<string, unknown>, by = client) => {
      const r = await call(by, 'record_answer', args);
      expect(r.isError, r.content[0]?.text).toBe(true);
      return r.content[0]!.text;
    };
    expect(await refused({ request: site.request.id, words: 'Site: Friday.' })).toMatch(/No person wrote these words/);
    expect(await refused({ request: legal.request.id, words: 'Acme Legal keeps the table.' })).toMatch(/No person wrote these words/);
    /* Bruno asked Zed alone, and only Zed answers it: the CEO's words are no answer of his. */
    const zeds = (await ask(c.ctx, c.bruno.id, site.task.id, { kind: 'question', text: 'Which domain do we keep?', topic: 'task', recipientPersonId: c.ids.zed })).request;
    expect((await c.wrote(c.tokens.ceo, 'Domain: acme.example.')).statusCode).toBe(202);
    expect(await refused({ request: zeds.id, words: 'Domain: acme.example.' })).toMatch(/may not answer/);
    expect((await c.saved(zeds.id)).status).toBe('open');
    await c.wrote(c.tokens.ceo, 'Deck: ready.');
    await c.wrote(c.tokens.ceo, 'Deck: ready, and the site waits.');
    expect(await refused({ request: deck.request.id, words: 'Deck: ready' })).toMatch(/More than one message/);
    const hana = await c.client(c.hana);
    expect(await refused({ request: deck.request.id, words: 'Deck: ready.' }, hana.client)).toMatch(/no such question/);
    expect(await c.open(site, deck, legal)).toEqual([true, true, true]);
  });
});
