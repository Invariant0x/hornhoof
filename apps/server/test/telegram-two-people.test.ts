import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, departments, jobs, people, telegramReplies } from '../src/db/schema.js';
import { fakeTelegram, type TelegramUser } from './fake-telegram.js';
import { as, connectNode, invitePerson, listen, nextOf, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const MAX: TelegramUser = { id: 5550001, first_name: 'Max', username: 'max_k', language_code: 'ru' };
const LUIZA: TelegramUser = { id: 5550002, first_name: 'Luiza', username: 'luiza_k', language_code: 'ru' };

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;
const setTelegram = (app: FastifyInstance, session: string, personId: string, telegram: string) =>
  app.inject({ method: 'PATCH', url: `/api/people/${personId}`, payload: { telegram }, ...as(session) });

/* Max (the CEO, named Ivan in Hornhoof) and Luiza, who has Marketing, both write to the bot of Marketing's head, on a node
   whose turns take words while they run. */
async function company() {
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
  await invitePerson(app, ceo, { name: 'Luiza', email: 'luiza@acme.com', access: { departments: [marketing!.id] } });
  const [luiza] = await db.select().from(people).where(eq(people.email, 'luiza@acme.com'));
  await setTelegram(app, ceo, owner!.id, '@max_k');
  await setTelegram(app, ceo, luiza!.id, '@luiza_k');
  expect((await app.inject({ method: 'PUT', url: `/api/agents/${head!.id}/telegram`, payload: { token: TOKEN }, ...as(ceo) })).statusCode).toBe(200);
  return { tg, app, db, ceo, builtin, owner: owner!, luiza: luiza! };
}

const say = (node: FakeNode, jobId: string, seq: number, text: string) => node.send({ type: 'job.event', jobId, seq, event: { kind: 'text', text } });
const sentTo = (tg: Awaited<ReturnType<typeof fakeTelegram>>, chat: number) => tg.sent.filter(s => s.chat_id === chat).map(s => s.text);

describe('two people who write to one head in Telegram', () => {
  it('each get their own turn and only the answers to their own words, while the same person still adds to their turn', async () => {
    const { tg, db, builtin, owner, luiza } = await company();
    tg.write(TOKEN, MAX, 'Сколько лидов за неделю?');
    const first = await nextOf(builtin, 'job.run');
    expect(first.prompt).toContain('Ivan wrote this in Telegram');
    expect(first.prompt).toContain("It goes to Ivan alone: answer Ivan's own words here.");
    builtin.send({ type: 'job.started', jobId: first.jobId });
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, first.jobId)))[0]!.status === 'running');
    await until(async () => (await db.select().from(telegramReplies)).length === 1);

    /* Luiza's question waits for a turn of its own instead of going into Max's. */
    tg.write(TOKEN, LUIZA, 'Пришли бриф по запуску.');
    await until(async () => (await db.select().from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')))).length === 1);
    const [queued] = await db.select().from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')));
    expect(queued!.createdBy).toBe(luiza.id);
    expect(queued!.prompt).toContain('Пришли бриф по запуску.');
    expect(queued!.prompt).toContain('Luiza wrote this in Telegram');

    /* Max's own follow-up still goes into his running turn. */
    tg.write(TOKEN, MAX, 'И по каналам тоже.');
    const typed = await nextOf(builtin, 'agent.say');
    expect(typed.text).toContain('И по каналам тоже.');
    builtin.send({ type: 'agent.said', ref: typed.ref, ok: true });

    say(builtin, first.jobId, 0, 'Лидов за неделю: 42, по каналам ниже.');
    await until(() => sentTo(tg, MAX.id).length === 1);
    builtin.send({ type: 'job.done', jobId: first.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });

    const second = await nextOf(builtin, 'job.run');
    expect(second.jobId).toBe(queued!.id);
    builtin.send({ type: 'job.started', jobId: second.jobId });
    say(builtin, second.jobId, 0, 'Бриф по запуску: в приложении.');
    await until(() => sentTo(tg, LUIZA.id).length === 1);
    builtin.send({ type: 'job.done', jobId: second.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => builtin.acks.includes(second.jobId));

    expect(sentTo(tg, MAX.id)).toEqual(['Лидов за неделю: 42, по каналам ниже.']);
    expect(sentTo(tg, LUIZA.id)).toEqual(['Бриф по запуску: в приложении.']);
    expect(owner.id).not.toBe(luiza.id);
  });

  it('keeps another person\'s words, from the window or Telegram, out of a turn that answers someone in Telegram', async () => {
    const { tg, db, builtin, luiza } = await company();
    tg.write(TOKEN, MAX, 'Что с бюджетом?');
    const first = await nextOf(builtin, 'job.run');
    builtin.send({ type: 'job.started', jobId: first.jobId });
    await until(async () => (await db.select().from(telegramReplies)).length === 1);
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, first.jobId)))[0]!.status === 'running');
    const [row] = await db.select().from(jobs).where(eq(jobs.id, first.jobId));
    expect(row!.createdBy).not.toBe(luiza.id);
    const { answersSomeoneElse } = await import('../src/modules/conversation/live.js');
    expect(await answersSomeoneElse({ db }, row!, { personId: luiza.id, data: { text: 'В окне' } })).toBe(true);
    expect(await answersSomeoneElse({ db }, row!, { personId: row!.createdBy, data: { text: 'В окне' } })).toBe(false);
    expect(await answersSomeoneElse({ db }, row!, { personId: null, data: { text: 'Отчет' } })).toBe(false);
    expect(await answersSomeoneElse({ db }, { id: '00000000-0000-4000-8000-000000000000', createdBy: luiza.id }, { personId: row!.createdBy, data: { text: 'В окне' } })).toBe(false);
    expect(await answersSomeoneElse({ db }, { id: '00000000-0000-4000-8000-000000000000', createdBy: luiza.id }, { personId: row!.createdBy, data: { channel: 'telegram' } })).toBe(true);
  });
});
