import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { assistants, attachments, agents, companies, departments, jobs, machines, nodes, people, programInstances, programOperatorCases, subscriptions, tasks, turns } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { ask, comment, createTask } from '../src/modules/tasks/engine.js';
import { checkPictureRoom, dropOldFiles, FILE_BYTES, PICTURE_BYTES, TASK_FILES_BYTES } from '../src/modules/tasks/attachments.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { rememberPrivateTurn } from '../src/modules/tools/private-turns.js';
import { setUpCompany, testApp } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { filesUnder, sha256Of, stored } from './files-fixture.js';

await prepareSharedDatabase();

async function company(env: NodeJS.ProcessEnv = {}, beforeReady?: (app: FastifyInstance) => void) {
  const { app, db } = await testApp(env);
  beforeReady?.(app);
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId = dev!.id) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const head = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const sam = await hire('Sam', 'worker', 'SAL-AE', sales!.id);
  const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Build', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true })).task;
  let n = 0;
  /* A running turn of the agent and its token. */
  const turn = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return token;
  };
  const attach = (token: string, query: string, body: Buffer) =>
    app.inject({ method: 'POST', url: `/api/attachments?${query}`, payload: body, headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` } });
  const fetchFile = (token: string, query: string) => app.inject({ method: 'GET', url: `/api/attachments/file?${query}`, headers: { authorization: `Bearer ${token}` } });
  /* A file put on the task without its bytes, only its size, as a row from before the store is, so caps are reached
     without holding gigabytes. */
  const counted = async (taskId: string, size: number, at = new Date()) => {
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'done' }).returning();
    return (await db.insert(attachments).values({ companyId, jobId: job!.id, agentId: bruno.id, taskId, name: `old-${size}.bin`, mediaType: 'application/octet-stream', size, createdAt: at }).returning())[0]!;
  };
  return { app, db, companyId, ceo: ceo!, dev: dev!, head, bruno, sam, task, turn, attach, fetchFile, counted };
}

describe('a task file', () => {
  it('is attached by an agent on the task and downloaded by any agent of the company by its name or id', async () => {
    const { app, bruno, sam, task, turn, attach, fetchFile } = await company();
    const bytes = randomBytes(200_000);
    const sent = await attach(await turn(bruno), `task=${task.number}&name=build.tar.gz`, bytes);
    expect(sent.statusCode).toBe(201);
    const { id, name } = sent.json();
    expect(name).toBe('build.tar.gz');
    const other = await turn(sam);
    for (const file of ['build.tar.gz', id]) {
      const got = await fetchFile(other, `task=${task.number}&file=${encodeURIComponent(file)}`);
      expect(got.statusCode).toBe(200);
      expect(got.headers['content-type']).toBe('application/octet-stream');
      expect(got.headers['x-file-name']).toBe('build.tar.gz');
      expect(Buffer.compare(got.rawPayload, bytes)).toBe(0);
    }
    const detail = await taskDetail(app.ctx, (await app.ctx.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!, () => true);
    expect(detail.files).toEqual([{ id, name: 'build.tar.gz', size: 200_000, by: { id: bruno.id, name: 'Bruno' }, fromPerson: false, at: expect.any(String) }]);
  });

  it('keeps the newest of two files with one name, and only the name, never a folder', async () => {
    const { bruno, task, turn, attach, fetchFile } = await company();
    const token = await turn(bruno);
    await attach(token, `task=${task.number}&name=notes.txt`, Buffer.from('first'));
    expect((await attach(token, `task=${task.number}&name=${encodeURIComponent('../../etc/notes.txt')}`, Buffer.from('second'))).json().name).toBe('notes.txt');
    expect((await fetchFile(token, `task=${task.number}&file=notes.txt`)).payload).toBe('second');
  });

  /* A task file has no limit of its own past the task's and the company's room: one over 50 MB, which a request may not
     bring whole, is kept as any other. */
  it('is refused from an agent not on the task, without a name, and for a task or file that is not there, and kept past 50 MB', async () => {
    const { bruno, sam, task, turn, attach, fetchFile } = await company();
    const token = await turn(bruno);
    expect((await attach(await turn(sam), `task=${task.number}&name=a.txt`, Buffer.from('x'))).statusCode).toBe(404);
    expect((await attach(token, `task=${task.number}&name=big.bin`, Buffer.alloc(FILE_BYTES + 1))).statusCode).toBe(201);
    expect((await attach(token, `task=${task.number}&name=`, Buffer.from('x'))).statusCode).toBe(400);
    expect((await attach(token, 'task=999&name=a.txt', Buffer.from('x'))).statusCode).toBe(404);
    expect((await fetchFile(token, `task=${task.number}&file=missing.txt`)).statusCode).toBe(404);
    expect(FILE_BYTES).toBe(50 * 1024 * 1024);
  });

  it('still takes only pictures, up to 3 MB, without a task', async () => {
    const { bruno, turn, attach } = await company();
    const token = await turn(bruno);
    expect((await attach(token, '', Buffer.from('plain text'))).statusCode).toBe(400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3 * 1024 * 1024)]);
    expect((await attach(token, '', png)).statusCode).toBe(413);
  });

  it('downloads a file of several megabytes whole', async () => {
    const { bruno, task, turn, attach, fetchFile } = await company();
    const token = await turn(bruno);
    const bytes = randomBytes(5 * 1024 * 1024 + 123);
    expect((await attach(token, `task=${task.number}&name=big.bin`, bytes)).statusCode).toBe(201);
    const got = await fetchFile(token, `task=${task.number}&file=big.bin`);
    expect(got.headers['content-length']).toBe(String(bytes.length));
    expect(Buffer.compare(got.rawPayload, bytes)).toBe(0);
  });
});

describe('an employee chat file', () => {
  it('is readable by its sender, while another employee still cannot fetch it', async () => {
    const { bruno, sam, turn, attach, fetchFile } = await company();
    const token = await turn(bruno);
    const bytes = Buffer.from('Owned report');
    const uploaded = await attach(token, 'chat=1&name=report.txt', bytes);
    expect(uploaded.statusCode).toBe(201);
    const query = `task=message&file=${uploaded.json().id}`;
    const own = await fetchFile(token, query);
    expect(own.statusCode).toBe(200);
    expect(own.rawPayload).toEqual(bytes);
    expect((await fetchFile(await turn(sam), query)).statusCode).toBe(404);
  });
});

/* Replace only the HTTP transport: each iterator step is a chunk requested by the upload handler. */
function countedUpload(chunks: Buffer[]) {
  let issued = 0;
  const body = Object.assign(new Readable({ read() {} }), {
    async *[Symbol.asyncIterator]() {
      try { for (const chunk of chunks) { issued += chunk.length; yield chunk; } }
      finally { body.destroy(); }
    },
  });
  return {
    install: (app: FastifyInstance) => app.addHook('preParsing', async (req, _reply, payload) => req.url.split('?')[0] === '/api/attachments' ? body : payload),
    issued: () => issued,
  };
}

describe('chunked task files', () => {
  it.each(['company', 'task', 'chat', 'private'] as const)('stops at the first chunk past the remaining %s room', async kind => {
    const input = countedUpload(Array.from({ length: 8 }, () => Buffer.alloc(4, 1)));
    const c = await company({}, input.install);
    const dir = mkdtempSync(join(tmpdir(), 'hh-quota-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    c.app.ctx.config.filesDir = dir;
    if (kind === 'task') await c.counted(c.task.id, TASK_FILES_BYTES - 8);
    else c.app.ctx.config.taskFilesBytes = 8;
    const before = await c.db.select(idOnly(attachments)).from(attachments);
    const token = await c.turn(c.bruno);
    if (kind === 'private') {
      const [job] = await c.db.select(idOnly(jobs)).from(jobs).where(eq(jobs.toolTokenHash, hashToken(token)));
      rememberPrivateTurn(c.db, job!.id).values.remember('quota-test-private-value');
    }
    const query = kind === 'chat' ? 'chat=1&name=stream.bin' : `task=${c.task.number}&name=stream.bin`;
    const declared = await c.attach(token, query, Buffer.alloc(9));
    const sent = await c.app.inject({ method: 'POST', url: `/api/attachments?${query}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    expect(sent.statusCode).toBe(413);
    expect(sent.json()).toEqual(declared.json());
    expect(input.issued()).toBe(12);
    expect(filesUnder(dir)).toEqual([]);
    expect(await c.db.select(idOnly(attachments)).from(attachments)).toEqual(before);
  });

  /* A task file has no limit of its own: the store keeps one of any size the task's and the company's room allow. */
  it('also stops at the single picture limit', async () => {
    const limit = PICTURE_BYTES;
    const input = countedUpload([Buffer.alloc(limit), Buffer.alloc(4), Buffer.alloc(4)]);
    const c = await company({}, input.install);
    const token = await c.turn(c.bruno);
    const sent = await c.app.inject({ method: 'POST', url: '/api/attachments?', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    expect(sent.statusCode).toBe(413);
    expect(sent.json().error.reason).toBe('attachment_invalid');
    expect(input.issued()).toBe(limit + 4);
    expect(await c.db.select(idOnly(attachments)).from(attachments)).toEqual([]);
  });

  it('accepts exactly eight bytes when eight bytes remain', async () => {
    const input = countedUpload([Buffer.from('1234'), Buffer.from('5678')]);
    const c = await company({}, input.install);
    c.app.ctx.config.taskFilesBytes = 8;
    const token = await c.turn(c.bruno);
    const sent = await c.app.inject({ method: 'POST', url: `/api/attachments?task=${c.task.number}&name=exact.txt`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    expect(sent.statusCode).toBe(201);
    expect(input.issued()).toBe(8);
    expect((await c.fetchFile(token, `task=${c.task.number}&file=exact.txt`)).payload).toBe('12345678');
  });

  it("removes the store's partial file without asking for the tail", async () => {
    const input = countedUpload([Buffer.alloc(FILE_BYTES + 1), Buffer.alloc(4), Buffer.alloc(4)]);
    const c = await company({}, input.install);
    const dir = mkdtempSync(join(tmpdir(), 'hh-quota-disk-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    c.app.ctx.config.filesDir = dir;
    c.app.ctx.config.taskFilesBytes = FILE_BYTES + 1;
    const token = await c.turn(c.bruno);
    const sent = await c.app.inject({ method: 'POST', url: `/api/attachments?task=${c.task.number}&name=large.bin`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    expect(sent.statusCode).toBe(413);
    expect(input.issued()).toBe(FILE_BYTES + 5);
    expect(filesUnder(dir)).toEqual([]);
    expect(await c.db.select(idOnly(attachments)).from(attachments)).toEqual([]);
  });
});

describe('the room for task files', () => {
  it('holds 500 MB on one task and says so plainly past it', async () => {
    const { bruno, task, turn, attach, counted } = await company();
    const token = await turn(bruno);
    await counted(task.id, TASK_FILES_BYTES - 100);
    expect((await attach(token, `task=${task.number}&name=fits.txt`, Buffer.alloc(100))).statusCode).toBe(201);
    const over = await attach(token, `task=${task.number}&name=more.txt`, Buffer.alloc(1));
    expect(over.statusCode).toBe(413);
    expect(over.json().error.message).toMatch(new RegExp(`Task ${task.number} holds .*500 MB`));
    expect(TASK_FILES_BYTES).toBe(500 * 1024 * 1024);
  });

  it("holds the company's setting across its tasks, 2 GB unless TASK_FILES_MB says otherwise", async () => {
    const { app, bruno, head, dev, task, turn, attach, counted } = await company({ TASK_FILES_MB: '3' });
    expect(app.ctx.config.taskFilesBytes).toBe(3 * 1024 * 1024);
    const other = (await createTask(app.ctx, { agentId: head.id }, { title: 'Docs', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true })).task;
    await counted(other.id, 3 * 1024 * 1024 - 10);
    const token = await turn(bruno);
    expect((await attach(token, `task=${task.number}&name=a.txt`, Buffer.alloc(10))).statusCode).toBe(201);
    const over = await attach(token, `task=${task.number}&name=b.txt`, Buffer.alloc(1));
    expect(over.statusCode).toBe(413);
    expect(over.json().error.message).toMatch(/company's task files .*3 MB/);
    const { app: plain } = await testApp();
    expect(plain.ctx.config.taskFilesBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it("gives a person's first picture the company's whole room, and counts each content once", async () => {
    const { app, companyId, task, counted } = await company({ TASK_FILES_MB: '3' });
    const limit = 3 * 1024 * 1024;
    expect((await checkPictureRoom(app.ctx, companyId, 10)).bytes).toBe(limit);
    await counted(task.id, 1000);
    expect((await checkPictureRoom(app.ctx, companyId, 10)).bytes).toBe(limit - 1000);
  });

  it('lets go of the files of a turn closed 30 days ago, and keeps the rest', async () => {
    const { app, db, companyId, head, task, counted } = await company();
    const day = 24 * 60 * 60 * 1000;
    const now = new Date();
    const turn = async (number: number, status: 'open' | 'closed', closedAt: Date | null) =>
      (await db.insert(turns).values({ companyId, departmentId: task.departmentId, number, goal: 'g', status, closedAt, createdByAgentId: head.id }).returning())[0]!;
    const [old, recent, open] = [await turn(101, 'closed', new Date(now.getTime() - 31 * day)), await turn(102, 'closed', new Date(now.getTime() - 29 * day)), await turn(103, 'open', null)];
    const files = [];
    for (const t of [old, recent, open]) {
      const [copy] = await db.insert(tasks).values({ ...task, id: undefined, number: task.number + t.number, turnId: t.id }).returning();
      files.push(await counted(copy!.id, 10));
    }
    expect(await dropOldFiles(app.ctx, now)).toBe(1);
    expect((await db.select(idOnly(attachments)).from(attachments)).map(a => a.id).sort()).toEqual([files[1]!.id, files[2]!.id].sort());
  });
});

describe('a task file fetched again', () => {
  it('answers its hash as its version, and 304 with no bytes to one who has them already', async () => {
    const { app, bruno, sam, task, turn, attach, fetchFile } = await company();
    const bytes = Buffer.from('a report');
    expect((await attach(await turn(bruno), `task=${task.number}&name=report.txt`, bytes)).statusCode).toBe(201);
    const token = await turn(sam);
    const etag = `"${sha256Of(bytes)}"`;
    const first = await fetchFile(token, `task=${task.number}&file=report.txt`);
    expect([first.statusCode, first.headers.etag, first.payload]).toEqual([200, etag, 'a report']);
    const asked = (tag: string) => app.inject({ method: 'GET', url: `/api/attachments/file?task=${task.number}&file=report.txt`, headers: { authorization: `Bearer ${token}`, 'if-none-match': tag } });
    const same = await asked(etag);
    expect([same.statusCode, same.payload, same.headers['x-file-name']]).toEqual([304, '', 'report.txt']);
    const other = await asked(`"${sha256Of('other bytes')}"`);
    expect([other.statusCode, other.payload]).toEqual([200, 'a report']);
  });
});

describe('a task file over 50 MB', () => {
  it("goes into the company's store as any file does, sealed under its hash, for any agent to fetch, and stays while its task is open", async () => {
    const { app, db, bruno, sam, task, turn, attach, fetchFile } = await company();
    const dir = mkdtempSync(join(tmpdir(), 'hh-files-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    app.ctx.config.filesDir = dir;
    const bytes = Buffer.alloc(FILE_BYTES + 1, 5);
    const sent = await attach(await turn(bruno), `task=${task.number}&name=dump.tar`, bytes);
    expect(sent.statusCode).toBe(201);
    const { id } = sent.json();
    const sha256 = sha256Of(bytes);
    expect(filesUnder(dir)).toEqual([sha256]);
    expect(readFileSync(join(dir, 'store', sha256.slice(0, 2), sha256)).includes(bytes.subarray(0, 64))).toBe(false);
    expect((await db.select({ sha256: attachments.sha256 }).from(attachments).where(eq(attachments.id, id)))).toEqual([{ sha256 }]);
    const got = await fetchFile(await turn(sam), `task=${task.number}&file=dump.tar`);
    expect(got.headers['content-length']).toBe(String(FILE_BYTES + 1));
    expect(got.rawPayload.equals(bytes)).toBe(true);
    const detail = await taskDetail(app.ctx, (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!, () => true);
    expect(detail.files).toEqual([expect.objectContaining({ id, name: 'dump.tar', size: FILE_BYTES + 1 })]);
    expect(detail.files[0]).not.toHaveProperty('big');
    const day = 24 * 60 * 60 * 1000;
    expect(await dropOldFiles(app.ctx, new Date(Date.now() + 31 * day))).toBe(0);
    expect(filesUnder(dir)).toEqual([sha256]);
  });
});

describe('cross-department hh-fetch and attachment boundaries', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('design-mockup-bytes')]);
  const AUDIT = `${'Design review finding and layout notes.\n'.repeat(140)}End of audit.`;

  it('lets Development and Design employees read each other task files, full-text reviews and request pictures via hh-fetch', async () => {
    const { app, db, companyId, head, bruno, task: devTask, turn, attach, fetchFile } = await company();
    const [sub] = await db.select().from(subscriptions);
    const [design] = await db.insert(departments).values({ companyId, templateKey: 'design', roleCode: 'DES', position: 3 }).returning();
    const [designHead, designer] = await db
      .insert(agents)
      .values([
        { companyId, kind: 'head', name: 'Dina', roleKey: 'DES-HEAD', departmentId: design!.id, model: '', subscriptionId: sub!.id },
        { companyId, kind: 'worker', name: 'Daria', roleKey: 'DES-UI', departmentId: design!.id, model: '', subscriptionId: sub!.id },
      ])
      .returning();
    const designTask = (await createTask(app.ctx, { agentId: designHead!.id }, { title: 'Settings layout', brief: '', body: '', departmentId: design!.id, assigneeAgentId: designer!.id, executor: true })).task;

    const designerToken = await turn(designer!);
    const specFile = await attach(designerToken, `task=${designTask.number}&name=tokens.json`, Buffer.from('{"spacing":16}'));
    expect(specFile.statusCode).toBe(201);
    const optionShot = await app.inject({ method: 'POST', url: '/api/attachments', payload: PNG, headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${designerToken}` } });
    expect(optionShot.statusCode).toBe(201);
    const shotId = optionShot.json().id as string;
    const unlinkedShot = await app.inject({ method: 'POST', url: '/api/attachments', payload: PNG, headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${designerToken}` } });
    expect(unlinkedShot.statusCode).toBe(201);
    await comment(app.ctx, { agentId: designer!.id }, designTask.id, AUDIT);
    await ask(app.ctx, designer!.id, designTask.id, { kind: 'choice', text: 'Pick layout', options: [{ label: 'Variant A', image: shotId }, { label: 'Variant B', image: null }] });

    const [auditFile] = (await db.select().from(attachments).where(eq(attachments.taskId, designTask.id))).filter(a => a.mediaType === 'text/plain');
    expect(auditFile).toBeDefined();

    for (const reader of [bruno, head]) {
      const token = await turn(reader);
      const gotSpec = await fetchFile(token, `task=${designTask.number}&file=tokens.json`);
      expect(gotSpec.statusCode).toBe(200);
      expect(gotSpec.payload).toBe('{"spacing":16}');

      const gotAudit = await fetchFile(token, `task=${designTask.number}&file=${encodeURIComponent(auditFile!.name!)}`);
      expect(gotAudit.statusCode).toBe(200);
      expect(gotAudit.rawPayload.equals(Buffer.from(AUDIT))).toBe(true);

      const gotAuditById = await fetchFile(token, `task=${designTask.number}&file=${auditFile!.id}`);
      expect(gotAuditById.statusCode).toBe(200);
      expect(gotAuditById.rawPayload.equals(Buffer.from(AUDIT))).toBe(true);

      const gotShot = await fetchFile(token, `task=${designTask.number}&file=${shotId}`);
      expect(gotShot.statusCode).toBe(200);
      expect(gotShot.rawPayload.equals(PNG)).toBe(true);
      expect(decodeURIComponent(String(gotShot.headers['x-file-name']))).toBe(`${shotId}.png`);

      /* Loose unshown pictures never leak through task hh-fetch. */
      expect((await fetchFile(token, `task=${designTask.number}&file=${unlinkedShot.json().id}`)).statusCode).toBe(404);
    }

    /* Design also reads Development screenshot archives directly from the Development task. */
    const devToken = await turn(bruno);
    const archive = Buffer.from('screens-archive-tar-gz');
    expect((await attach(devToken, `task=${devTask.number}&name=screens.tar.gz`, archive)).statusCode).toBe(201);
    const gotArchive = await fetchFile(designerToken, `task=${devTask.number}&file=screens.tar.gz`);
    expect(gotArchive.statusCode).toBe(200);
    expect(gotArchive.rawPayload.equals(archive)).toBe(true);
  });

  it('refuses another company, personal assistants, private secrets, message pictures, cross-department writes and deletes, and empty uploads', async () => {
    const { app, db, companyId, ceo, bruno, sam, task, turn, attach, fetchFile } = await company();
    const [sub] = await db.select().from(subscriptions);
    const brunoToken = await turn(bruno);

    /* Empty file upload check stays enforced on task and chat attachments. */
    const emptyTask = await attach(brunoToken, `task=${task.number}&name=empty.txt`, Buffer.alloc(0));
    expect([emptyTask.statusCode, emptyTask.json().error.reason]).toEqual([400, 'file_empty']);
    const emptyChat = await attach(brunoToken, 'chat=1&name=empty.txt', Buffer.alloc(0));
    expect([emptyChat.statusCode, emptyChat.json().error.reason]).toEqual([400, 'file_empty']);
    /* Nor is a body of a type no file comes under. */
    const asText = await app.inject({ method: 'POST', url: `/api/attachments?task=${task.number}&name=notes.txt`, headers: { authorization: `Bearer ${brunoToken}`, 'content-type': 'text/plain' }, payload: 'notes' });
    expect([asText.statusCode, asText.json().error.reason]).toEqual([400, 'file_empty']);

    const shared = await attach(brunoToken, `task=${task.number}&name=spec.pdf`, Buffer.from('company-spec'));
    expect(shared.statusCode).toBe(201);
    await comment(app.ctx, { agentId: bruno.id }, task.id, AUDIT);
    const [fullText] = (await db.select().from(attachments).where(eq(attachments.taskId, task.id))).filter(a => a.mediaType === 'text/plain');
    const shotRes = await app.inject({ method: 'POST', url: '/api/attachments', payload: PNG, headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${brunoToken}` } });
    const shotId = shotRes.json().id as string;
    await ask(app.ctx, bruno.id, task.id, { kind: 'question', text: 'Check shot', images: [shotId] });

    /* 1. Cross-department write/overwrite and delete stay refused. */
    const samToken = await turn(sam);
    expect((await attach(samToken, `task=${task.number}&name=spec.pdf`, Buffer.from('overwritten'))).statusCode).toBe(404);
    expect((await attach(samToken, `task=${task.number}&name=new.txt`, Buffer.from('new'))).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/attachments/file?task=${task.number}&file=spec.pdf`, headers: { authorization: `Bearer ${samToken}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/attachments/${shared.json().id}`, headers: { authorization: `Bearer ${samToken}` } })).statusCode).toBe(404);
    expect((await fetchFile(samToken, `task=${task.number}&file=spec.pdf`)).payload).toBe('company-spec');

    /* 2. Foreign company agent cannot read or write any attachment of this company. */
    const [foreign] = await db.insert(companies).values({ name: 'Foreign', singleton: false }).returning();
    const [foreignPerson] = await db.insert(people).values({ companyId: foreign!.id, name: 'Foreign CEO', email: 'ceo@foreign.test', status: 'active', isOwner: true, scopeKind: 'company' }).returning();
    const [foreignSub] = await db.insert(subscriptions).values({ companyId: foreign!.id, ownerPersonId: foreignPerson!.id, provider: 'claude', kind: 'personal', label: 'Foreign', status: 'ready' }).returning();
    const [foreignAgent] = await db.insert(agents).values({ companyId: foreign!.id, kind: 'orchestrator', name: 'Foreign Orch', model: '', subscriptionId: foreignSub!.id }).returning();
    const foreignToken = 'foreign-tool-token-0123456789abcdef';
    await db.insert(jobs).values({ companyId: foreign!.id, subscriptionId: foreignSub!.id, agentId: foreignAgent!.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(foreignToken) });
    for (const ref of [String(task.number), task.id]) {
      for (const file of ['spec.pdf', shared.json().id as string, fullText!.id, shotId]) {
        expect((await fetchFile(foreignToken, `task=${encodeURIComponent(ref)}&file=${encodeURIComponent(file)}`)).statusCode).toBe(404);
      }
      expect((await attach(foreignToken, `task=${encodeURIComponent(ref)}&name=leak.txt`, Buffer.from('no'))).statusCode).toBe(404);
    }

    /* 3. Personal assistant cannot read or write company task attachments, and employees cannot read assistant data. */
    const [assistantPerson] = await db.insert(people).values({ companyId, name: 'Ava', status: 'active', isAgent: true, assistantOf: ceo.id, scopeKind: 'company' }).returning();
    const [assistantAgent] = await db.insert(agents).values({ companyId, kind: 'assistant', name: 'Ava', model: '', subscriptionId: sub!.id }).returning();
    await db.insert(assistants).values({ personId: assistantPerson!.id, companyId, program: 'avaclone', agentId: assistantAgent!.id });
    const assistantToken = await turn(assistantAgent!);
    for (const file of ['spec.pdf', shared.json().id as string, fullText!.id, shotId]) {
      expect((await fetchFile(assistantToken, `task=${task.number}&file=${encodeURIComponent(file)}`)).statusCode).toBe(404);
    }
    expect((await attach(assistantToken, `task=${task.number}&name=from-assistant.txt`, Buffer.from('no'))).statusCode).toBe(404);

    /* Assistant's own chat file and owner message picture stay inaccessible to company employees. */
    const assistantChat = await attach(assistantToken, 'chat=1&name=private-notes.txt', Buffer.from('owner-private'));
    expect(assistantChat.statusCode).toBe(201);
    const [assistantMsgPic] = await db.insert(attachments).values({ companyId, agentId: assistantAgent!.id, personId: ceo.id, name: 'id-card.png', mediaType: 'image/png', sha256: await stored(db, PNG, app.ctx.config), size: PNG.length }).returning();
    const [spoofedAssistantTaskFile] = await db.insert(attachments).values({ companyId, agentId: assistantAgent!.id, taskId: task.id, name: 'assistant-secret.txt', mediaType: 'application/octet-stream', sha256: await stored(db, Buffer.from('secret'), app.ctx.config), size: 6 }).returning();
    const [assistantTask] = await db.insert(tasks).values({ ...task, id: undefined, number: task.number + 50, assigneeAgentId: assistantAgent!.id, executorAgentId: assistantAgent!.id }).returning();
    await db.insert(attachments).values({ companyId, agentId: bruno.id, taskId: assistantTask!.id, name: 'personal-plan.txt', mediaType: 'application/octet-stream', sha256: await stored(db, Buffer.from('plan'), app.ctx.config), size: 4 });
    for (const readerToken of [brunoToken, samToken]) {
      expect((await fetchFile(readerToken, `task=${task.number}&file=${assistantChat.json().id}`)).statusCode).toBe(404);
      expect((await fetchFile(readerToken, `task=message&file=${assistantMsgPic!.id}`)).statusCode).toBe(404);
      expect((await fetchFile(readerToken, `task=${task.number}&file=${assistantMsgPic!.id}`)).statusCode).toBe(404);
      expect((await fetchFile(readerToken, 'task=' + String(task.number) + '&file=assistant-secret.txt')).statusCode).toBe(404);
      expect((await fetchFile(readerToken, `task=${task.number}&file=${spoofedAssistantTaskFile!.id}`)).statusCode).toBe(404);
      expect((await fetchFile(readerToken, `task=${assistantTask!.number}&file=personal-plan.txt`)).statusCode).toBe(404);
    }
    /* The assistant itself still reads only the message picture sent to it. */
    expect((await fetchFile(assistantToken, `task=message&file=${assistantMsgPic!.id}`)).statusCode).toBe(200);

    /* 4. Private message picture to another employee and Program Operator case screenshot stay refused. */
    const [brunoMsgPic] = await db.insert(attachments).values({ companyId, agentId: bruno.id, personId: ceo.id, name: 'key.png', mediaType: 'image/png', sha256: await stored(db, PNG, app.ctx.config), size: PNG.length }).returning();
    expect((await fetchFile(samToken, `task=message&file=${brunoMsgPic!.id}`)).statusCode).toBe(404);
    expect((await fetchFile(samToken, `task=${task.number}&file=${brunoMsgPic!.id}`)).statusCode).toBe(404);

    const [machine] = await db.insert(machines).values({ companyId, personId: ceo.id, machineKey: 'machine-1' }).returning();
    const [node] = await db.insert(nodes).values({ companyId, machineId: machine!.id, keyHash: hashToken('node-key') }).returning();
    const [jobRow] = await db.select().from(jobs).where(eq(jobs.agentId, bruno.id));
    const [instance] = await db.insert(programInstances).values({ id: randomUUID(), companyId, agentId: bruno.id, nodeId: node!.id }).returning();
    const [incident] = await db.insert(programOperatorCases).values({ companyId, agentId: bruno.id, jobId: jobRow!.id, nodeId: node!.id, instance: instance!.id, reason: 'assignment_unrecorded', evidenceKey: randomUUID(), capability: randomUUID(), deadlineAt: new Date(Date.now() + 60000) }).returning();
    const [casePic] = await db.insert(attachments).values({ companyId, agentId: bruno.id, jobId: jobRow!.id, taskId: task.id, operatorCaseId: incident!.id, name: 'terminal.png', mediaType: 'image/png', sha256: await stored(db, PNG, app.ctx.config), size: PNG.length }).returning();
    for (const readerToken of [brunoToken, samToken, assistantToken]) {
      expect((await fetchFile(readerToken, `task=operator-case:${incident!.id}&file=${casePic!.id}`)).statusCode).toBe(404);
      expect((await fetchFile(readerToken, `task=${task.number}&file=${casePic!.id}`)).statusCode).toBe(404);
      expect((await fetchFile(readerToken, `task=${task.number}&file=terminal.png`)).statusCode).toBe(404);
    }
  });
});
