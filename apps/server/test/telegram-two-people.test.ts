import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, people, telegramReplies } from '../src/db/schema.js';
import { fakeTelegram, type TelegramUser } from './fake-telegram.js';
import { as, connectNode, invitePerson, listen, nextOf, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const MAX: TelegramUser = { id: 5550001, first_name: 'Max', username: 'max_k', language_code: 'ru' };
const CLARA: TelegramUser = { id: 5550002, first_name: 'Clara', username: 'clara_k', language_code: 'ru' };

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;
const setTelegram = (app: FastifyInstance, session: string, personId: string, telegram: string) =>
  app.inject({ method: 'PATCH', url: `/api/people/${personId}`, payload: { telegram }, ...as(session) });

/* The CEO (Telegram name Max, named Ivan in the company) and Clara, who has Marketing, both write to the bot of Marketing's head,
   on a node whose turns take words while they run. */
async function company(orchestratorBot = false) {
  const tg = await fakeTelegram();
  tg.bots.set(TOKEN, { id: 123456789, username: 'acme_marketing_bot', first_name: 'Acme marketing' });
  const { app, db } = await testApp({ NODE_KEY, TELEGRAM_API_URL: tg.url });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
  await until(async () => (await state(app, ceo)).ready);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [marketing] = await db.insert(departments).values({ companyId: orchestrator!.companyId, templateKey: 'marketing', roleCode: 'MKT' }).returning();
  const [head] = await db
    .insert(agents)
    .values({ companyId: orchestrator!.companyId, subscriptionId: orchestrator!.subscriptionId, model: '', kind: 'head', name: 'Mira', roleKey: 'MKT-HEAD', departmentId: marketing!.id })
    .returning();
  await invitePerson(app, ceo, { name: 'Clara', email: 'clara@acme.com', access: { departments: [marketing!.id] } });
  const [clara] = await db.select().from(people).where(eq(people.email, 'clara@acme.com'));
  await setTelegram(app, ceo, owner!.id, '@max_k');
  await setTelegram(app, ceo, clara!.id, '@clara_k');
  expect((await app.inject({ method: 'PUT', url: `/api/agents/${orchestratorBot ? orchestrator!.id : head!.id}/telegram`, payload: { token: TOKEN }, ...as(ceo) })).statusCode).toBe(200);
  return { tg, app, db, ceo, builtin, owner: owner!, clara: clara! };
}

const say = (node: FakeNode, jobId: string, seq: number, text: string) => node.send({ type: 'job.event', jobId, seq, event: { kind: 'text', text } });
const sentTo = (tg: Awaited<ReturnType<typeof fakeTelegram>>, chat: number) => tg.sent.filter(s => s.chat_id === chat).map(s => s.text);

it('lets a linked invited person write to the company bot and get their own answer', async () => {
  const { tg, db, builtin } = await company(true);
  tg.write(TOKEN, CLARA, 'Проверь домашние устройства');
  await until(() => builtin.queued() > 0 || sentTo(tg, CLARA.id).length > 0);
  expect(builtin.queued()).toBe(1);
  const run = await nextOf(builtin, 'job.run');
  expect(run.prompt).toContain('This is Clara writing to you directly in Telegram.');
  builtin.send({ type: 'job.started', jobId: run.jobId });
  await until(async () => (await db.select().from(telegramReplies)).some(reply => reply.jobId === run.jobId));
  say(builtin, run.jobId, 0, 'С какого устройства начнем?');
  builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
  await until(() => sentTo(tg, CLARA.id).length > 0);
  expect(sentTo(tg, CLARA.id)).toEqual(['С какого устройства начнем?']);
});

describe('two people who write to one head in Telegram', () => {
  it.each([
    { from: MAX, original: { text: 'Website copy for task #41' } },
    { from: CLARA, original: { caption: 'Website copy for task #41' } },
  ] as const)('keeps the message being answered in the agent prompt for $from.first_name', async ({ from, original }) => {
    const { tg, builtin } = await company();
    tg.send(TOKEN, from, {
      text: 'Send this to the editor',
      quote: { text: 'Website copy' },
      reply_to_message: { message_id: 17, chat: { id: from.id, type: 'private' }, ...original },
    });
    const run = await nextOf(builtin, 'job.run');
    expect(run.prompt).toContain('Send this to the editor');
    expect(run.prompt).toContain('Website copy for task #41');
    expect(run.prompt).toContain('[Reply to Telegram message 17]');
  });

  it('each get their own turn and only the answers to their own words, while the same person still adds to their turn', async () => {
    const { tg, db, builtin, owner, clara } = await company();
    tg.write(TOKEN, MAX, 'Сколько лидов за неделю?');
    const first = await nextOf(builtin, 'job.run');
    expect(first.prompt).toContain('This is Ivan writing to you directly in Telegram.');
    expect(first.prompt).toContain('This answer goes to Ivan alone.');
    builtin.send({ type: 'job.started', jobId: first.jobId });
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, first.jobId)))[0]!.status === 'running');
    await until(async () => (await db.select().from(telegramReplies)).length === 1);

    /* Clara's question waits for a turn of its own instead of going into Max's. */
    tg.write(TOKEN, CLARA, 'Пришли бриф по запуску.');
    await until(async () => (await db.select().from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')))).length === 1);
    const [queued] = await db.select().from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')));
    expect(queued!.createdBy).toBe(clara.id);
    expect(queued!.prompt).toContain('Пришли бриф по запуску.');
    expect(queued!.prompt).toContain('This is Clara writing to you directly in Telegram.');

    /* Max's own follow-up still goes into his running turn. */
    tg.write(TOKEN, MAX, 'И по каналам тоже.');
    const typed = await nextOf(builtin, 'agent.say');
    expect(typed.text).toContain('И по каналам тоже.');
    expect(typed.text).toContain('Write task titles, briefs and questions for Ivan in Russian.');
    expect(typed.text).toContain('Use the language of their own words. Write it directly to them in Russian when their message does not establish a language.');
    builtin.send({ type: 'agent.said', ref: typed.ref, ok: true });

    say(builtin, first.jobId, 0, 'Лидов за неделю: 42, по каналам ниже.');
    builtin.send({ type: 'job.done', jobId: first.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });

    const second = await nextOf(builtin, 'job.run');
    expect(second.jobId).toBe(queued!.id);
    builtin.send({ type: 'job.started', jobId: second.jobId });
    say(builtin, second.jobId, 0, 'Бриф по запуску: в приложении.');
    builtin.send({ type: 'job.done', jobId: second.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => builtin.acks.includes(second.jobId));
    await until(() => sentTo(tg, MAX.id).length > 0 && sentTo(tg, CLARA.id).length > 0);

    expect(sentTo(tg, MAX.id)).toEqual(['Лидов за неделю: 42, по каналам ниже.']);
    expect(sentTo(tg, CLARA.id)).toEqual(['Бриф по запуску: в приложении.']);
    expect(owner.id).not.toBe(clara.id);
  });

  it('keeps another person\'s words, from the window or Telegram, out of a turn that answers someone in Telegram', async () => {
    const { tg, db, builtin, clara } = await company();
    tg.write(TOKEN, MAX, 'Что с бюджетом?');
    const first = await nextOf(builtin, 'job.run');
    builtin.send({ type: 'job.started', jobId: first.jobId });
    await until(async () => (await db.select().from(telegramReplies)).length === 1);
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, first.jobId)))[0]!.status === 'running');
    const [row] = await db.select().from(jobs).where(eq(jobs.id, first.jobId));
    expect(row!.createdBy).not.toBe(clara.id);
    const { answersSomeoneElse } = await import('../src/modules/conversation/live.js');
    expect(await answersSomeoneElse({ db }, row!, { personId: clara.id, data: { text: 'В окне' } })).toBe(true);
    expect(await answersSomeoneElse({ db }, row!, { personId: row!.createdBy, data: { text: 'В окне' } })).toBe(false);
    expect(await answersSomeoneElse({ db }, row!, { personId: null, data: { text: 'Отчет' } })).toBe(false);
    expect(await answersSomeoneElse({ db }, { id: '00000000-0000-4000-8000-000000000000', createdBy: clara.id }, { personId: row!.createdBy, data: { text: 'В окне' } })).toBe(false);
    expect(await answersSomeoneElse({ db }, { id: '00000000-0000-4000-8000-000000000000', createdBy: clara.id }, { personId: row!.createdBy, data: { channel: 'telegram' } })).toBe(true);
  });
});
