import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agentEvents, agents, assistants, attachments, jobs, people, telegramReplies } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { FILE_BYTES } from '../src/modules/tasks/attachments.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { KEEP_IN_REPOSITORY } from '../src/modules/conversation/pictures.js';
import { appendEvent } from '../src/modules/events/store.js';
import { albums } from '../src/modules/telegram/bots.js';
import { whatCame } from '../src/modules/telegram/inbox.js';
import { fakeTelegram, type TelegramUser } from './fake-telegram.js';
import { as, connectNode, listen, mcp, nextOf, setUpCompany, testApp, until } from './helpers.js';
import { stored } from './files-fixture.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const IVAN: TelegramUser = { id: 5550001, first_name: 'Ivan', username: 'Ivan_K', language_code: 'ru' };
const ZIP = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(128, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(32, 3)]);
const OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(64, 4)]);

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;

/* A stand-in speech-to-text service, as OpenAI's /v1/audio/transcriptions answers. */
async function fakeSpeech(text: string) {
  const heard: { auth: string | undefined; size: number }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      heard.push({ auth: req.headers.authorization, size: Buffer.concat(chunks).length });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text }));
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  onTestFinished(() => new Promise<void>(done => server.close(() => done())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/audio/transcriptions`, heard };
}

/* A company with its orchestrator ready, its bot connected and the CEO's Telegram on his row. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const tg = await fakeTelegram();
  tg.bots.set(TOKEN, { id: 123456789, username: 'acme_ceo_bot', first_name: 'Acme' });
  const { app, db } = await testApp({ NODE_KEY, TELEGRAM_API_URL: tg.url, ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await state(app, ceo)).ready);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  await app.inject({ method: 'PATCH', url: `/api/people/${owner!.id}`, payload: { telegram: '@Ivan_K' }, ...as(ceo) });
  expect((await app.inject({ method: 'PUT', url: '/api/agents/orchestrator/telegram', payload: { token: TOKEN }, ...as(ceo) })).statusCode).toBe(200);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { tg, app, db, builtin, orchestrator: orchestrator! };
}

describe('a file sent to a head through its Telegram bot', () => {
  it('reaches the agent as a file it downloads and keeps in its repository, with the words under it', async () => {
    const { tg, db, builtin, orchestrator } = await company();
    tg.files.set('zip-1', ZIP);
    tg.send(TOKEN, IVAN, { document: { file_id: 'zip-1', file_name: 'brief.zip', file_size: ZIP.length, mime_type: 'application/zip' }, caption: 'Материалы к запуску' });
    const run = await nextOf(builtin, 'job.run');
    const [kept] = await db.select().from(attachments).where(eq(attachments.agentId, orchestrator.id));
    expect(kept).toMatchObject({ name: 'brief.zip', mediaType: 'application/octet-stream', size: ZIP.length });
    expect(Buffer.from(kept!.bytes!)).toEqual(ZIP);
    expect(run.prompt).toContain('Материалы к запуску');
    expect(run.prompt).toContain(`brief.zip: hh-fetch message ${kept!.id}`);
    expect(run.prompt).toContain('A file came with this message');
    expect(run.prompt).toContain(KEEP_IN_REPOSITORY);
    expect(run.prompt).toContain('writing to you directly in Telegram');
    expect(tg.sent).toEqual([]);
    const [event] = await db.select().from(agentEvents).where(eq(agentEvents.jobId, run.jobId));
    expect(event).toMatchObject({ data: { text: 'Материалы к запуску', channel: 'telegram', pictures: [{ id: kept!.id, name: 'brief.zip', file: true }] } });
  });

  it('takes the photos of one album as one message', async () => {
    const { tg, db, builtin } = await company();
    tg.files.set('p-1', JPEG);
    tg.files.set('p-2', JPEG);
    const small = { file_id: 'small', file_size: 10 };
    tg.send(TOKEN, IVAN, { media_group_id: 'a1', photo: [small, { file_id: 'p-1', file_size: JPEG.length }], caption: 'Два макета' });
    tg.send(TOKEN, IVAN, { media_group_id: 'a1', photo: [small, { file_id: 'p-2', file_size: JPEG.length }] });
    const run = await nextOf(builtin, 'job.run');
    expect(run.prompt).toContain('Два макета');
    expect(run.prompt).toContain('Pictures came with this message');
    expect(run.prompt.match(/photo\.jpg: hh-fetch message/g)).toHaveLength(2);
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'conversation'))).toHaveLength(1);
  });

  it('gives a voice message its words when the server has speech recognition, and its recording always', async () => {
    const speech = await fakeSpeech('Подготовь план на неделю');
    const { tg, db, builtin } = await company({ TRANSCRIBE_URL: speech.url, TRANSCRIBE_KEY: 'sk-test' });
    tg.files.set('v-1', OGG);
    tg.send(TOKEN, IVAN, { voice: { file_id: 'v-1', file_size: OGG.length, duration: 4, mime_type: 'audio/ogg' } });
    const run = await nextOf(builtin, 'job.run');
    expect(run.prompt).toContain('A voice message, 4 s. Its words, as speech recognition heard them: Подготовь план на неделю');
    expect(run.prompt).toContain('voice.ogg: hh-fetch message');
    expect(speech.heard).toHaveLength(1);
    expect(speech.heard[0]!.auth).toBe('Bearer sk-test');
    expect(speech.heard[0]!.size).toBeGreaterThan(OGG.length);
    expect(await db.select().from(attachments)).toHaveLength(1);
  });

  it('gives a voice message as its recording when the server has no speech recognition', async () => {
    const { tg, builtin } = await company();
    tg.files.set('v-1', OGG);
    tg.send(TOKEN, IVAN, { voice: { file_id: 'v-1', file_size: OGG.length, duration: 2 } });
    const run = await nextOf(builtin, 'job.run');
    expect(run.prompt).toContain('A voice message, 2 s, with no transcript');
    expect(run.prompt).toContain('voice.ogg: hh-fetch message');
    expect(run.prompt).toContain('Write it directly to them in Russian when their message does not establish a language.');
  });

  it('keeps the language of the person\'s earlier text for a voice message without a transcript', async () => {
    const { tg, db, builtin } = await company();
    const user = { ...IVAN, language_code: 'en' };
    tg.write(TOKEN, user, 'Посмотри видео.');
    const first = await nextOf(builtin, 'job.run');
    builtin.send({ type: 'job.done', jobId: first.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => builtin.acks.includes(first.jobId));
    tg.files.set('v-1', OGG);
    tg.send(TOKEN, user, { voice: { file_id: 'v-1', file_size: OGG.length, duration: 33 } });
    const voice = await nextOf(builtin, 'job.run');
    expect(voice.prompt).toContain('A voice message, 33 s, with no transcript');
    expect(voice.prompt).toContain('Write it directly to them in Russian when their message does not establish a language.');
    const forVoice = () => db.select().from(telegramReplies).where(eq(telegramReplies.jobId, voice.jobId));
    await until(async () => (await forVoice()).length === 1);
    const [reply] = await forVoice();
    expect(reply!.lang).toBe('ru');
  });

  it('reads a sticker as what it shows, and keeps a still one as a picture', async () => {
    const { tg, builtin } = await company();
    tg.files.set('s-1', WEBP);
    tg.send(TOKEN, IVAN, { sticker: { file_id: 's-1', file_size: WEBP.length, emoji: '👍', set_name: 'Hornhoof', is_animated: false, is_video: false } });
    const run = await nextOf(builtin, 'job.run');
    expect(run.prompt).toContain('[A sticker 👍 from the set Hornhoof.]');
    expect(run.prompt).toContain('sticker.webp: hh-fetch message');
  });

  it('tells the person when a file is over what Telegram gives a bot, and still passes the words on', async () => {
    const { tg, builtin, db } = await company();
    tg.send(TOKEN, { ...IVAN, language_code: 'en' }, { document: { file_id: 'big', file_name: 'video.mov', file_size: 50 * 1024 * 1024 }, caption: 'Смотри видео' });
    const run = await nextOf(builtin, 'job.run');
    expect(run.prompt).toContain('Смотри видео');
    expect(run.prompt).toContain('[video.mov (50 MB) did not come: Telegram gives a bot files of up to 20 MB.]');
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.text).toContain('video.mov');
    expect(tg.sent[0]!.text).toMatch(/20 МБ/);
    expect(await db.select().from(attachments)).toEqual([]);
  });

  it('says what it takes for a message it cannot read, and sends nothing to the agent', async () => {
    const { tg, db } = await company();
    tg.send(TOKEN, IVAN, { dice: { emoji: '🎲', value: 3 } });
    await until(() => tg.sent.length === 1);
    expect(tg.sent[0]!.text).toBe('Такое сообщение я прочитать не могу. Пришлите текст, файл, фото, видео или голосовое.');
    expect(tg.sent[0]!.text).not.toContain('только текстовые');
    expect(await db.select().from(jobs).where(eq(jobs.kind, 'conversation'))).toEqual([]);
  });
});

describe('what a Telegram message carries', () => {
  it('names each kind of file and what cannot go as one', () => {
    const f = (id: string) => ({ file_id: id });
    const came = whatCame({
      message_id: 1,
      chat: { id: 1, type: 'private' },
      document: { ...f('d'), file_name: 'table.xlsx' },
      audio: f('a'),
      video: f('v'),
      video_note: { ...f('n'), duration: 5 },
      sticker: { ...f('s'), emoji: '🔥', is_animated: true },
      contact: { phone_number: '+100', first_name: 'Ann', last_name: 'Lee' },
      location: { latitude: 1.5, longitude: 2.5 },
      poll: { question: 'Когда?', options: [{ text: 'Сегодня' }, { text: 'Завтра' }] },
      forward_origin: { type: 'user' },
    });
    expect(came.files.map(x => x.name)).toEqual(['table.xlsx', 'audio.mp3', 'video.mp4', 'video-note.mp4']);
    expect(came.notes).toEqual([
      '[This message is forwarded from someone else.]',
      '[A round video message, 5 s.]',
      '[A sticker 🔥.]',
      '[A contact: Ann Lee, +100.]',
      '[A location: 1.5, 2.5.]',
      '[A poll: Когда? Options: Сегодня; Завтра.]',
    ]);
  });

  it('groups only the updates of one album in one chat, in turn', () => {
    const u = (id: number, group?: string, chat = 1) => ({ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, ...(group ? { media_group_id: group } : {}) } });
    expect(albums([u(1), u(2, 'a'), u(3, 'a'), u(4, 'a', 2), u(5, 'b'), u(6)]).map(g => g.map(x => x.update_id))).toEqual([[1], [2, 3], [4], [5], [6]]);
  });
});

it('shows typing and carries earlier attachments once with the final answer', async () => {
  const { app, db, tg, builtin, orchestrator } = await company();
  tg.write(TOKEN, IVAN, 'Пришли отчет.');
  const run = await nextOf(builtin, 'job.run');
  const [file] = await db.insert(attachments).values({
    companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: run.jobId,
    name: 'report.zip', mediaType: 'application/octet-stream', sha256: await stored(db, ZIP, app.ctx.config), size: ZIP.length,
  }).returning();
  const event = { companyId: orchestrator.companyId, agentId: orchestrator.id, jobId: run.jobId, kind: 'text' as const };
  const pictures = [{ id: file!.id, name: file!.name }];
  await appendEvent(app.ctx, { ...event, data: { text: 'Собираю отчет.', pictures } });
  await appendEvent(app.ctx, { ...event, data: { text: 'Ваш отчет готов.' } });
  await appendEvent(app.ctx, { ...event, data: { text: '', pictures } });
  await until(() => tg.calls.includes('sendChatAction'));
  const calls = tg.calls.filter(call => call === 'getUpdates').length;
  tg.write(TOKEN, IVAN, 'In a group.', { id: -100200, type: 'group' });
  await until(() => tg.calls.filter(call => call === 'getUpdates').length > calls);
  expect(tg.sent).toEqual([]);
  expect(tg.sentDocuments).toEqual([]);

  builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
  await until(() => builtin.acks.includes(run.jobId));
  await until(async () => (await db.select().from(telegramReplies)).length === 0);
  expect(tg.sent.map(s => s.text)).toEqual(['Ваш отчет готов.']);
  expect(tg.sentDocuments).toMatchObject([{ chat_id: IVAN.id, file_name: 'report.zip', bytes: ZIP }]);
});

describe('the sender of a Telegram file', () => {
  async function sender() {
    const c = await company();
    const companyId = c.orchestrator.companyId;
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    await c.db.update(people).set({ telegramUserId: IVAN.id }).where(eq(people.id, ceo!.id));
    const [worker] = await c.db.insert(agents).values({ companyId, kind: 'worker', name: 'Developer', model: '', subscriptionId: c.orchestrator.subscriptionId }).returning();
    const token = 'telegram-file-sender-1214';
    await c.db.insert(jobs).values({ companyId, agentId: worker!.id, subscriptionId: worker!.subscriptionId!, kind: 'conversation', prompt: 'Send a file', status: 'running', startedAt: new Date(), timeoutMs: 900000, toolTokenHash: hashToken(token) });
    const client = await mcp(c.app, token);
    const send = (id: string) => client.callTool({ name: 'send_telegram_file', arguments: { person: ceo!.id, attachment: id } });
    return { ...c, companyId, ceo: ceo!, worker: worker!, token, send };
  }

  it.each(['small', 'big'] as const)('refuses a %s private assistant file exactly like an absent file before sharing it', async size => {
    const c = await sender();
    const [person] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Personal assistant', status: 'active', isAgent: true, assistantOf: c.ceo.id, scopeKind: 'company' }).returning();
    const [assistant] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'assistant', name: 'Personal assistant', model: '', subscriptionId: c.orchestrator.subscriptionId }).returning();
    await c.db.insert(assistants).values({ personId: person!.id, companyId: c.companyId, program: 'avaclone', agentId: assistant!.id });
    /* A row that says it is over 50 MB exercises the link branch without transferring 50 MB through a bot. */
    const [file] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: assistant!.id, name: 'private.bin', mediaType: 'application/octet-stream', sha256: await stored(c.db, ZIP, c.app.ctx.config), size: size === 'big' ? FILE_BYTES + 1 : ZIP.length }).returning();
    const read = await c.app.inject({ url: `/api/attachments/file?task=message&file=${file!.id}`, headers: { authorization: `Bearer ${c.token}` } });
    expect(read.statusCode).toBe(404);
    const absent = await c.send('12140000-0000-4000-8000-000000000000');
    const refused = await c.send(file!.id);
    expect.soft(refused).toEqual(absent);
    expect.soft(JSON.stringify(refused)).not.toContain('/api/files/');
    expect(c.tg.sentDocuments).toEqual([]);
  });

  it('never lets its own file, named after another file of the task, vouch for that file', async () => {
    const c = await sender();
    const { task } = await createTask(c.app.ctx, { agentId: c.orchestrator.id }, { title: 'Share file', brief: '', body: '', departmentId: null, assigneeAgentId: c.worker.id, executor: true });
    /* A file an assistant left on the task, such as its archived text: hh-fetch gives it to no other agent. */
    const [person] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Personal assistant', status: 'active', isAgent: true, assistantOf: c.ceo.id, scopeKind: 'company' }).returning();
    const [assistant] = await c.db.insert(agents).values({ companyId: c.companyId, kind: 'assistant', name: 'Personal assistant', model: '', subscriptionId: c.orchestrator.subscriptionId }).returning();
    await c.db.insert(assistants).values({ personId: person!.id, companyId: c.companyId, program: 'avaclone', agentId: assistant!.id });
    const [theirs] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: assistant!.id, taskId: task.id, name: 'assistant.bin', mediaType: 'application/octet-stream', sha256: await stored(c.db, ZIP, c.app.ctx.config), size: ZIP.length }).returning();
    const read = await c.app.inject({ url: `/api/attachments/file?task=${task.number}&file=${theirs!.id}`, headers: { authorization: `Bearer ${c.token}` } });
    expect(read.statusCode).toBe(404);
    await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.worker.id, taskId: task.id, name: theirs!.id, mediaType: 'application/octet-stream', sha256: await stored(c.db, Buffer.from('mine'), c.app.ctx.config), size: 4 });
    const absent = await c.send('12140000-0000-4000-8000-000000000000');
    expect(await c.send(theirs!.id)).toEqual(absent);
    expect(c.tg.sentDocuments).toEqual([]);
  });

  it.each(['small', 'big'] as const)('still shares a %s company task file that the sender may read', async size => {
    const c = await sender();
    const { task } = await createTask(c.app.ctx, { agentId: c.orchestrator.id }, { title: 'Share file', brief: '', body: '', departmentId: null, assigneeAgentId: c.worker.id, executor: true });
    const [file] = await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.worker.id, taskId: task.id, name: 'report.bin', mediaType: 'application/octet-stream', sha256: await stored(c.db, ZIP, c.app.ctx.config), size: size === 'big' ? FILE_BYTES + 1 : ZIP.length }).returning();
    const result = await c.send(file!.id);
    if (size === 'big') {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain('/api/files/');
      expect(c.tg.sentDocuments).toEqual([]);
    } else {
      expect(result.isError).toBeFalsy();
      expect(c.tg.sentDocuments).toHaveLength(1);
      expect(c.tg.sentDocuments[0]!.bytes).toEqual(ZIP);
    }
  });
});
