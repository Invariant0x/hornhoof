import { randomUUID } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, telegramBots, telegramReplies } from '../src/db/schema.js';
import { pump } from '../src/modules/conversation/queue.js';
import { splitForTelegram } from '../src/modules/telegram/api.js';
import { fakeTelegram, type FakeTelegram, type TelegramUser } from './fake-telegram.js';
import { appOn, as, connectNode, invitePerson, listen, nextOf, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const SECOND = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const IVAN: TelegramUser = { id: 5550001, first_name: 'Ivan', username: 'Ivan_K', language_code: 'en' };

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;
const connectBot = (app: FastifyInstance, session: string, agent: string, token: string) =>
  app.inject({ method: 'PUT', url: `/api/agents/${agent}/telegram`, payload: { token }, ...as(session) });
const setTelegram = (app: FastifyInstance, session: string, personId: string, telegram: string | null) =>
  app.inject({ method: 'PATCH', url: `/api/people/${personId}`, payload: { telegram }, ...as(session) });

/* One more poll of the bot ends, with a message it does not take, so the pass after it may close what ended. */
async function pollOnce(tg: FakeTelegram, token: string): Promise<void> {
  const polls = tg.offsets.get(token)?.length ?? 0;
  tg.write(token, IVAN, 'In a group.', { id: -100200, type: 'group' });
  await until(() => (tg.offsets.get(token)?.length ?? 0) > polls);
}

/* Everything the server sent the node before has come, and what the node said before is handled. */
async function quiet(node: FakeNode): Promise<number> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
  return node.queued();
}

/* A company with its orchestrator ready on the built-in node, a Telegram that knows two bots, and the CEO's row. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const tg = await fakeTelegram();
  tg.bots.set(TOKEN, { id: 123456789, username: 'acme_ceo_bot', first_name: 'Acme' });
  tg.bots.set(SECOND, { id: 987654321, username: 'acme_sales_bot', first_name: 'Acme sales' });
  const settings = { NODE_KEY, TELEGRAM_API_URL: tg.url, ...env };
  const { app, db } = await testApp(settings);
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await state(app, ceo)).ready);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  return { tg, app, db, url, ceo, builtin, orchestrator: orchestrator!, owner: owner!, settings };
}

/* A Sales department with its head on the company's key. */
async function salesHead(c: Awaited<ReturnType<typeof company>>) {
  const [acme] = await c.db.select().from(companies);
  const [sales] = await c.db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const on = { companyId: acme!.id, subscriptionId: c.orchestrator.subscriptionId, model: '' };
  const [head] = await c.db.insert(agents).values({ ...on, kind: 'head', name: 'Sasha', roleKey: 'SAL-HEAD', departmentId: sales!.id }).returning();
  const [worker] = await c.db.insert(agents).values({ ...on, kind: 'worker', name: 'Wendy', roleKey: 'SAL-SDR', departmentId: sales!.id }).returning();
  return { sales: sales!, head: head!, worker: worker! };
}

describe('a Telegram bot of a head', () => {
  it('is checked with Telegram, kept encrypted and shown on the card only by its name', async () => {
    const { app, db, ceo, tg } = await company();
    const res = await connectBot(app, ceo, 'orchestrator', TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ telegram: { username: 'acme_ceo_bot' } });
    expect(tg.calls).toContain('getMe');
    const card = await app.inject({ url: '/api/agents/orchestrator', ...as(ceo) });
    expect(card.json().telegram).toEqual({ username: 'acme_ceo_bot' });
    expect(card.body).not.toContain(TOKEN.split(':')[1]);
    const [row] = await db.select().from(telegramBots);
    expect(row).toMatchObject({ botUserId: 123456789, username: 'acme_ceo_bot', updateOffset: 0 });
    expect(row!.tokenEnc).not.toContain(TOKEN.split(':')[1]);
  });

  it('refuses a token Telegram does not take, and says so when Telegram cannot be reached', async () => {
    const { app, ceo, tg } = await company();
    const refused = await connectBot(app, ceo, 'orchestrator', '111111111:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.reason).toBe('telegram_token');
    expect((await connectBot(app, ceo, 'orchestrator', 'not a token')).statusCode).toBe(400);
    tg.down = true;
    const away = await connectBot(app, ceo, 'orchestrator', TOKEN);
    expect(away.statusCode).toBe(503);
    expect(away.json().error.reason).toBe('telegram_unreachable');
    expect(away.body).not.toContain(TOKEN.split(':')[1]);
  });

  it('takes off a webhook the bot had before, keeping what waits for it, or is not kept when that fails', async () => {
    const { app, db, ceo, owner, tg, builtin } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    tg.webhooks.add(TOKEN);
    tg.write(TOKEN, IVAN, 'Written while the webhook was on.');
    tg.broken.add('deleteWebhook');
    const away = await connectBot(app, ceo, 'orchestrator', TOKEN);
    expect(away.statusCode).toBe(503);
    expect(away.json().error.reason).toBe('telegram_unreachable');
    expect(await db.select().from(telegramBots)).toEqual([]);
    tg.broken.clear();
    expect((await connectBot(app, ceo, 'orchestrator', TOKEN)).statusCode).toBe(200);
    expect(tg.webhooks.has(TOKEN)).toBe(false);
    expect((await nextOf(builtin, 'job.run')).prompt).toContain('Written while the webhook was on.');
    expect(tg.calls.filter(c => c === 'getUpdates').length).toBeGreaterThan(0);
  });

  it('belongs to one head only, and only heads and the orchestrator have one', async () => {
    const c = await company();
    const { head, worker } = await salesHead(c);
    expect((await connectBot(c.app, c.ceo, 'orchestrator', TOKEN)).statusCode).toBe(200);
    const taken = await connectBot(c.app, c.ceo, head.id, TOKEN);
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.reason).toBe('telegram_taken');
    expect((await connectBot(c.app, c.ceo, head.id, SECOND)).statusCode).toBe(200);
    const notHead = await connectBot(c.app, c.ceo, worker.id, '555555555:CCHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    expect(notHead.statusCode).toBe(409);
    expect(notHead.json().error.reason).toBe('telegram_heads_only');
  });

  it('is set by people with the whole company and by everyone given the head\'s department, by no one else', async () => {
    const c = await company();
    const { sales, head } = await salesHead(c);
    const [acme] = await c.db.select().from(companies);
    const [support] = await c.db.insert(departments).values({ companyId: acme!.id, templateKey: 'support', roleCode: 'SUP' }).returning();
    const ann = await invitePerson(c.app, c.ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [sales.id] } });
    const bob = await invitePerson(c.app, c.ceo, { name: 'Bob', email: 'bob@acme.com', access: { departments: [support!.id] } });
    const [bobRow] = await c.db.select().from(people).where(eq(people.email, 'bob@acme.com'));
    await c.db.update(departments).set({ ownerPersonId: bobRow!.id }).where(eq(departments.id, support!.id));
    expect((await connectBot(c.app, bob, head.id, SECOND)).statusCode).toBe(403);
    expect((await connectBot(c.app, bob, c.orchestrator.id, SECOND)).statusCode).toBe(403);
    expect((await connectBot(c.app, ann, c.orchestrator.id, SECOND)).statusCode).toBe(403);
    const own = await connectBot(c.app, ann, head.id, SECOND);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ telegram: { username: 'acme_sales_bot' } });
    expect((await c.app.inject({ method: 'DELETE', url: `/api/agents/${head.id}/telegram`, ...as(ann) })).statusCode).toBeLessThan(300);
  });

  it('stops listening when it is taken off, and when its head leaves the company', async () => {
    const c = await company();
    const { head } = await salesHead(c);
    await connectBot(c.app, c.ceo, 'orchestrator', TOKEN);
    await connectBot(c.app, c.ceo, head.id, SECOND);
    await until(() => c.tg.polling(TOKEN) === 1 && c.tg.polling(SECOND) === 1);
    const off = await c.app.inject({ method: 'DELETE', url: '/api/agents/orchestrator/telegram', ...as(c.ceo) });
    expect(off.statusCode).toBe(204);
    await until(() => c.tg.polling(TOKEN) === 0);
    expect((await c.app.inject({ url: '/api/agents/orchestrator', ...as(c.ceo) })).json().telegram).toBeNull();
    expect((await c.app.inject({ method: 'DELETE', url: `/api/agents/${head.id}`, ...as(c.ceo) })).statusCode).toBe(204);
    await until(() => c.tg.polling(SECOND) === 0);
    expect(await c.db.select().from(telegramBots)).toEqual([]);
  });
});

describe('a person\'s Telegram', () => {
  it('is set by the person as a username or a number, and cleared', async () => {
    const { app, ceo, owner } = await company();
    const named = await setTelegram(app, ceo, owner.id, '@Ivan_K');
    expect(named.statusCode).toBe(200);
    expect(named.json().person.telegram).toEqual({ username: 'ivan_k', id: null });
    expect((await setTelegram(app, ceo, owner.id, '5550001')).json().person.telegram).toEqual({ username: null, id: 5550001 });
    expect((await setTelegram(app, ceo, owner.id, '')).json().person.telegram).toBeNull();
    const wrong = await setTelegram(app, ceo, owner.id, 'not a name!');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.reason).toBe('telegram_invalid');
  });

  it('belongs to one person, and only the CEO sets the CEO\'s', async () => {
    const { app, db, ceo, owner } = await company();
    const wes = await invitePerson(app, ceo, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const [wesRow] = await db.select().from(people).where(eq(people.email, 'wes@acme.com'));
    expect((await setTelegram(app, wes, owner.id, '@wes_own')).statusCode).toBe(403);
    expect((await setTelegram(app, ceo, wesRow!.id, '@wes_k')).statusCode).toBe(200);
    const taken = await setTelegram(app, ceo, owner.id, '@Wes_K');
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.reason).toBe('telegram_person_taken');
    expect((await app.inject({ url: '/api/people', ...as(wes) })).json().people.find((p: { id: string }) => p.id === wesRow!.id).telegram).toEqual({ username: 'wes_k', id: null });
  });
});

describe('a message through the bot', () => {
  it('reaches the orchestrator as the CEO\'s own words, and his answer goes back to the same chat as plain text', async () => {
    const { app, db, ceo, owner, tg, builtin } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    tg.write(TOKEN, IVAN, 'Hire a designer.');
    const run = await nextOf(builtin, 'job.run');
    expect(run.prompt).toContain('From Ivan (CEO) via Telegram to Orchestrator:');
    expect(run.prompt).toContain('Hire a designer.');
    expect(run.prompt).toContain("This is Ivan writing to you directly in Telegram. Ivan is the company's owner (the CEO).");
    expect(run.prompt).toContain('Use the language of their own words. Write it directly to them in English when their message does not establish a language.');
    await until(async () => (await db.select().from(people).where(eq(people.id, owner.id)))[0]!.telegramUserId === IVAN.id);
    builtin.send({ type: 'job.started', jobId: run.jobId });
    builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'Looking for candidates.' } });
    builtin.send({ type: 'job.event', jobId: run.jobId, seq: 1, event: { kind: 'text', text: 'On it: *one* designer_ <b>.' } });
    builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: 'On it.', tail: '', error: null });
    await until(() => builtin.acks.includes(run.jobId));
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]).toEqual({ token: TOKEN, chat_id: IVAN.id, text: 'On it: *one* designer_ <b>.' });
    const events = (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().events;
    expect(events[0]).toMatchObject({ kind: 'message', person: { id: owner.id }, data: { text: 'Hire a designer.' }, message: { channel: 'telegram' } });
  });

  it('finds the person by the number once known, even after the username moved on', async () => {
    const { app, db, ceo, owner, tg, builtin } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    tg.write(TOKEN, IVAN, 'First.');
    const first = await nextOf(builtin, 'job.run');
    builtin.send({ type: 'job.done', jobId: first.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => builtin.acks.includes(first.jobId));
    await until(async () => (await db.select().from(people).where(eq(people.id, owner.id)))[0]!.telegramUserId === IVAN.id);
    tg.write(TOKEN, { ...IVAN, username: 'ivan_new' }, 'Second.');
    expect((await nextOf(builtin, 'job.run')).prompt).toContain('From Ivan (CEO) via Telegram to Orchestrator:');
    tg.write(TOKEN, { id: 7770007, first_name: 'Someone', username: 'Ivan_K', language_code: 'en' }, 'I am Ivan too.');
    await until(() => tg.sent.some(s => s.chat_id === 7770007));
    expect(await quiet(builtin)).toBe(0);
  });

  it('tells an unknown sender their id and username for the owner, in their language', async () => {
    const { app, ceo, tg, builtin } = await company();
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    tg.write(TOKEN, { id: 8880008, first_name: 'Petr', username: 'petr_p', language_code: 'ru' }, 'Привет');
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]!.chat_id).toBe(8880008);
    expect(tg.sent[0]!.text).toContain('8880008');
    expect(tg.sent[0]!.text).toContain('@petr_p');
    expect(tg.sent[0]!.text).toMatch(/[а-я]/);
    expect(tg.sent[0]!.text).not.toContain('—');
    expect(tg.sent[0]!.parse_mode).toBeUndefined();
    tg.write(TOKEN, { id: 8880009, first_name: 'Ann', language_code: 'en' }, 'Hello');
    await until(() => tg.sent.length === 2);
    expect(tg.sent[1]!.text).toContain('8880009');
    expect(tg.sent[1]!.text).toMatch(/^[\x20-\x7e\n]+$/);
    expect(await quiet(builtin)).toBe(0);
  });

  it('uses the latest written language for bot words in that chat alone', async () => {
    const c = await company();
    const { app, ceo, tg } = c;
    const { head } = await salesHead(c);
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    await connectBot(app, ceo, head.id, SECOND);
    const guest = { id: 8880010, first_name: 'Lena', language_code: 'en' };
    const voice = { voice: { file_id: 'v-1', duration: 33 } };
    tg.write(TOKEN, guest, 'Здравствуйте.');
    tg.send(TOKEN, guest, voice);
    await until(() => tg.sent.length === 2);
    expect.soft(tg.sent.map(s => s.text)).toEqual([
      expect.stringContaining('Я вас пока не знаю.'),
      expect.stringContaining('Я вас пока не знаю.'),
    ]);
    tg.send(SECOND, guest, voice);
    await until(() => tg.sent.length === 3);
    expect(tg.sent[2]!.text).toContain('I do not know you yet.');
    const russianApp = { ...guest, language_code: 'ru' };
    tg.write(TOKEN, russianApp, 'Hello again.');
    tg.send(TOKEN, russianApp, voice);
    await until(() => tg.sent.length === 5);
    expect(tg.sent.slice(3).map(s => s.text)).toEqual([
      expect.stringContaining('I do not know you yet.'),
      expect.stringContaining('I do not know you yet.'),
    ]);
  });

  it('finds the written language in older Telegram messages even after a voice note', async () => {
    const { app, db, ceo, owner, tg, orchestrator } = await company();
    await setTelegram(app, ceo, owner.id, String(IVAN.id));
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    const [bot] = await db.select().from(telegramBots);
    await db.insert(agentEvents).values([
      { companyId: owner.companyId, personId: owner.id, agentId: orchestrator.id, kind: 'message', data: { channel: 'telegram', text: 'Посмотри видео.', telegram: { bot: bot!.id, chat: IVAN.id, update: 2 } } },
      { companyId: owner.companyId, personId: owner.id, agentId: orchestrator.id, kind: 'message', data: { channel: 'telegram', text: '[A voice message, 33 s, with no transcript: its recording is the file voice.ogg below.]', telegram: { bot: bot!.id, chat: IVAN.id, update: 3 } } },
    ]);
    tg.send(TOKEN, IVAN, { dice: { emoji: '🎲', value: 3 } });
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]!.text).toContain('Такое сообщение я прочитать не могу.');
  });

  it('addresses the person directly in the first prompt and the prompt after tools were lost', async () => {
    const c = await company();
    const { sales, head } = await salesHead(c);
    await invitePerson(c.app, c.ceo, { name: 'Lena', email: 'lena@acme.com', access: { departments: [sales.id] } });
    const [lena] = await c.db.select().from(people).where(eq(people.email, 'lena@acme.com'));
    expect((await setTelegram(c.app, c.ceo, lena!.id, '8880010')).statusCode).toBe(200);
    await connectBot(c.app, c.ceo, head.id, SECOND);
    c.tg.write(SECOND, { id: 8880010, first_name: 'Lena', language_code: 'en' }, 'Как идут продажи?');
    await until(() => c.builtin.queued() > 0 || c.tg.sent.length > 0);
    expect(c.tg.sent).toEqual([]);
    const first = await nextOf(c.builtin, 'job.run');
    c.builtin.send({ type: 'job.event', jobId: first.jobId, seq: 0, event: { kind: 'text', text: 'I am looking into it.' } });
    c.builtin.send({ type: 'job.done', jobId: first.jobId, ok: false, sessionId: 's1', result: '', tail: '', error: 'agent_failed', failure: { kind: 'tools', retryable: true, text: 'Connection to tools lost.' } });
    await until(() => c.builtin.acks.includes(first.jobId));
    const [retry] = await c.db.select().from(jobs).where(eq(jobs.continueOf, first.jobId));
    expect(retry).toMatchObject({ notBefore: expect.any(Date) });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(+retry!.notBefore!);
    onTestFinished(() => clock.mockRestore());
    await pump(c.app.ctx, head.id);
    const next = await nextOf(c.builtin, 'job.run');
    expect(next.prompt).toContain('turn ended before the work');
    c.builtin.send({ type: 'job.event', jobId: next.jobId, seq: 0, event: { kind: 'text', text: 'Ваш отчет готов.' } });
    c.builtin.send({ type: 'job.done', jobId: next.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => c.tg.sent.length > 0);
    expect(c.tg.sent.map(s => s.text)).toEqual(['Ваш отчет готов.']);
    for (const { prompt } of [first, next]) {
      expect.soft(prompt).toContain('This is Lena writing to you directly in Telegram.');
      expect.soft(prompt).toContain('Your last message of this turn goes to Lena as your answer.');
      expect.soft(prompt).toContain('Use the language of their own words. Write it directly to them in Russian when their message does not establish a language. Keep it short and use plain text.');
    }
  });

  it('says plainly when the person may not write to this agent in Hornhoof, and sends nothing to it', async () => {
    const c = await company();
    const { app, db, ceo, tg, builtin } = c;
    const { head } = await salesHead(c);
    const [support] = await db.insert(departments).values({ companyId: head.companyId, templateKey: 'support', roleCode: 'SUP' }).returning();
    await invitePerson(app, ceo, { name: 'Wes', email: 'wes@acme.com', access: { departments: [support!.id] } });
    const [wes] = await db.select().from(people).where(eq(people.email, 'wes@acme.com'));
    await setTelegram(app, ceo, wes!.id, '6660006');
    await connectBot(app, ceo, head.id, SECOND);
    tg.write(SECOND, { id: 6660006, first_name: 'Wes', language_code: 'en' }, 'Show me sales.');
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]!.text).toContain(head.name);
    expect(await quiet(builtin)).toBe(0);
    expect(await db.select().from(jobs).where(eq(jobs.agentId, head.id))).toEqual([]);
  });

  it('does not listen to a disabled person, nor to a group chat', async () => {
    const { app, db, ceo, owner, tg, builtin } = await company();
    await invitePerson(app, ceo, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const [wes] = await db.select().from(people).where(eq(people.email, 'wes@acme.com'));
    await setTelegram(app, ceo, wes!.id, '6660006');
    await app.inject({ method: 'PATCH', url: `/api/people/${wes!.id}`, payload: { status: 'disabled' }, ...as(ceo) });
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    tg.write(TOKEN, IVAN, 'In a group.', { id: -100200, type: 'group' });
    tg.write(TOKEN, { id: 6660006, first_name: 'Wes', language_code: 'en' }, 'Still here.');
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]!.chat_id).toBe(6660006);
    expect(await quiet(builtin)).toBe(0);
  });

  it('carries a head\'s answer back, cut under Telegram\'s limit without losing a character', async () => {
    const c = await company();
    const { head } = await salesHead(c);
    await setTelegram(c.app, c.ceo, c.owner.id, String(IVAN.id));
    await connectBot(c.app, c.ceo, head.id, SECOND);
    c.tg.write(SECOND, IVAN, 'How are sales?');
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('From Ivan (CEO) via Telegram to Sasha');
    const long = `${'Sales are fine. '.repeat(300)}\nThe end.`;
    c.builtin.send({ type: 'job.started', jobId: run.jobId });
    c.builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: long } });
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => c.tg.sent.length === 2);
    expect(c.tg.sent.every(s => s.token === SECOND && s.chat_id === IVAN.id && s.text.length <= 4096)).toBe(true);
    expect(c.tg.sent.map(s => s.text).join('')).toBe(long);
  });

  it('tells a head who wrote: the CEO\'s delegate who is responsible for its department', async () => {
    const c = await company();
    const { sales, head } = await salesHead(c);
    await invitePerson(c.app, c.ceo, { name: 'Wes', email: 'wes@acme.com', access: { whole: true } });
    const [wes] = await c.db.select().from(people).where(eq(people.email, 'wes@acme.com'));
    await c.app.inject({ method: 'PUT', url: `/api/people/${wes!.id}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(c.ceo) });
    await c.db.update(departments).set({ ownerPersonId: wes!.id }).where(eq(departments.id, sales.id));
    await setTelegram(c.app, c.ceo, wes!.id, '6660006');
    await connectBot(c.app, c.ceo, head.id, SECOND);
    c.tg.write(SECOND, { id: 6660006, first_name: 'Wes', language_code: 'en' }, 'Drop the cold calls.');
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain("This is Wes writing to you directly in Telegram. Wes is the CEO's delegate and responsible for your department.");
  });

  it('recovers the original Telegram job after a saved message loses its acknowledgement', async () => {
    const { app, db, ceo, owner, tg, builtin } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    const update = tg.write(TOKEN, IVAN, 'Deliver this only once.');
    const run = await nextOf(builtin, 'job.run');
    await until(async () => (await db.select().from(telegramReplies)).some(r => r.jobId === run.jobId));
    const [bot] = await db.select().from(telegramBots);
    const repeated = { update_id: update, message: { message_id: 1, date: 1, chat: { id: IVAN.id, type: 'private' as const }, from: { ...IVAN, is_bot: false }, text: 'Deliver this only once.' } };
    const { receive } = await import('../src/modules/telegram/inbox.js');
    await receive(app.ctx, bot!, repeated, async () => {}, async () => Buffer.alloc(0));
    const events = (await db.select().from(agentEvents)).filter(e => (e.data as { telegram?: { update: number } }).telegram?.update === update);
    expect(events.map(e => e.jobId)).toEqual([run.jobId]);
    expect((await db.select().from(telegramReplies)).map(r => r.jobId)).toEqual([run.jobId]);
  });

  it('keeps an offline message across a restart and delivers it once when the node reconnects', async () => {
    const { app, db, ceo, owner, tg, builtin, settings } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    builtin.close();
    await until(async () => (await state(app, ceo)).reason === 'machine_offline');
    const update = tg.write(TOKEN, IVAN, 'Keep this message until I reconnect.');
    await until(async () => (await db.select().from(telegramBots))[0]!.updateOffset === update + 1);
    await expect.poll(async () => {
      if (tg.sent.some(m => /write.*again|offline|did not go through/i.test(m.text))) return 'discarded';
      const rows = await db.execute(sql`SELECT attempts, payload_enc FROM telegram_incoming WHERE update_id = ${update}`);
      const row = (rows as { rows: { attempts: number; payload_enc: string }[] }).rows[0];
      return row && row.attempts > 0 && !row.payload_enc.includes('Keep this message') ? 'stored' : 'waiting';
    }, { timeout: 10_000 }).toBe('stored');
    await app.close();
    expect(tg.sent.map(m => m.text)).not.toContainEqual(expect.stringMatching(/write.*again|offline|did not go through/i));
    const { $client } = db as unknown as { $client: PGlite };
    const reopened = await appOn($client, settings);
    const url = await listen(reopened.app);
    const node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
    await expect.poll(() => node.queued(), { timeout: 10_000 }).toBeGreaterThan(0);
    const run = await nextOf(node, 'job.run');
    expect(run.prompt).toContain('Keep this message until I reconnect.');
    const events = (await db.select().from(agentEvents)).filter(e => (e.data as {telegram?: {update: number}}).telegram?.update === update);
    expect(events).toHaveLength(1);
    expect(events[0]!.jobId).toBe(run.jobId);
    node.close();
  });

  it.each([
    ['agent_failed', undefined, 'Orchestrator could not answer this time. Open Hornhoof to see why, or write again.'],
    ['cancelled', undefined, 'Orchestrator could not answer this time. Open Hornhoof to see why, or write again.'],
    ['agent_failed', 'usage_limit', 'Orchestrator has reached the usage limit for its plan. Try again when the limit resets.'],
    ['agent_failed', 'rate_limited', 'Orchestrator is receiving too many requests. Try again later.'],
    ['agent_failed', 'tools', 'Orchestrator could not connect to the tools it needs in Hornhoof. Ask the machine owner to check the connection.'],
  ] as const)('sends only the failure words when a turn ends with %s/%s after progress', async (error, kind, expected) => {
    const { app, db, ceo, owner, tg, builtin } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    tg.write(TOKEN, IVAN, 'Hello.');
    const run = await nextOf(builtin, 'job.run');
    await until(async () => (await db.select().from(telegramReplies)).length === 1);
    builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'I am looking into it.' } });
    builtin.send({ type: 'job.done', jobId: run.jobId, ok: false, sessionId: null, result: '', tail: 'boom', error });
    await until(() => builtin.acks.includes(run.jobId));
    if (kind) await db.update(jobs).set({ failure: { kind, text: 'private diagnostic', retryable: false } }).where(eq(jobs.id, run.jobId));
    await pollOnce(tg, TOKEN);
    await pollOnce(tg, TOKEN);
    await until(async () => (await db.select().from(telegramReplies)).length === 0);
    expect(tg.sent.map(s => s.text)).toEqual([expected]);
  });

  it('keeps where it read up to, so a restart neither loses nor repeats a message', async () => {
    const { app, db, ceo, owner, tg, builtin, settings } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    const id = tg.write(TOKEN, IVAN, 'Once.');
    const run = await nextOf(builtin, 'job.run');
    builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(async () => (await db.select().from(telegramBots))[0]!.updateOffset === id + 1);
    await until(() => tg.polling(TOKEN) === 1);
    builtin.close();
    await app.close();
    await until(() => tg.polling(TOKEN) === 0);
    const { $client } = db as unknown as { $client: PGlite };
    const again = await appOn($client, settings);
    await again.app.ready();
    await until(() => tg.polling(TOKEN) === 1);
    expect(tg.offsets.get(TOKEN)!.at(-1)).toBe(id + 1);
    expect((await db.select().from(jobs)).filter(j => j.prompt.includes('Once.')).map(j => j.id)).toEqual([run.jobId]);
  });

  it('goes on listening after Telegram was away', async () => {
    const { app, ceo, owner, tg, builtin } = await company();
    await setTelegram(app, ceo, owner.id, '@Ivan_K');
    await connectBot(app, ceo, 'orchestrator', TOKEN);
    await until(() => tg.polling(TOKEN) === 1);
    const before = tg.calls.length;
    tg.goDown();
    tg.write(TOKEN, IVAN, 'Are you there?');
    await until(() => tg.calls.length >= before + 2);
    tg.down = false;
    expect((await nextOf(builtin, 'job.run')).prompt).toContain('Are you there?');
  });
});

describe('a reply cut for Telegram', () => {
  it('keeps every piece under the limit, on a line break where it can, and never splits a character', () => {
    expect(splitForTelegram('short')).toEqual(['short']);
    const lines = splitForTelegram(`${'a'.repeat(4000)}\n${'b'.repeat(200)}`);
    expect(lines).toEqual([`${'a'.repeat(4000)}\n`, 'b'.repeat(200)]);
    const emoji = splitForTelegram('😀'.repeat(3000));
    expect(emoji.every(p => p.length <= 4096 && !/^[\udc00-\udfff]/.test(p) && !/[\ud800-\udbff]$/.test(p))).toBe(true);
    expect(emoji.join('')).toBe('😀'.repeat(3000));
    expect(splitForTelegram('')).toEqual([]);
  });
});
