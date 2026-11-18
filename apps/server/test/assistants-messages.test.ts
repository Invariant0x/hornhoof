import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, attachments, companies, departments, people, requests, taskEvents } from '../src/db/schema.js';
import { FILE_BYTES } from '../src/modules/tasks/attachments.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, nextOf, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;

/* A company with its orchestrator ready on the built-in node, Sales with its head and a worker on the company's key, and
   the CEO's row. */
async function company(beforeReady?: (app: FastifyInstance) => void) {
  const { app, db } = await testApp({ NODE_KEY });
  beforeReady?.(app);
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await state(app, ceo)).ready);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [acme] = await db.select().from(companies);
  const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const on = { companyId: acme!.id, subscriptionId: orchestrator!.subscriptionId, model: '' };
  const [head] = await db.insert(agents).values({ ...on, kind: 'head', name: 'Sasha', roleKey: 'SAL-HEAD', departmentId: sales!.id }).returning();
  const [worker] = await db.insert(agents).values({ ...on, kind: 'worker', name: 'Wendy', roleKey: 'SAL-SDR', departmentId: sales!.id }).returning();
  return { app, db, ceo, builtin, orchestrator: orchestrator!, owner: owner!, sales: sales!, head: head!, worker: worker! };
}

type Company = Awaited<ReturnType<typeof company>>;

async function assistantOf(c: Company, session: string, ownerId: string, name = 'Ava'): Promise<{ id: string; key: string }> {
  const { id } = (await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name, owner: ownerId, program: 'avaclone' }, ...as(session) })).json().person;
  return { id, key: (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(session) })).json().key };
}

const write = (c: Company, key: string, agentId: string, text: string) =>
  c.app.inject({ method: 'POST', url: '/api/assistant/messages', headers: { authorization: `Bearer ${key}` }, payload: { agentId, text } });

/* What a program sends: a file's bytes under the type it has for it, for the agent it writes to, in its owner's language. */
const upload = (c: Company, key: string, file: { name: string; type: string; bytes: Buffer }, agentId?: string, lang?: string) =>
  c.app.inject({
    method: 'POST',
    url: `/api/assistant/files?${new URLSearchParams({ name: file.name, ...(agentId ? { agentId } : {}) })}`,
    headers: { authorization: `Bearer ${key}`, 'content-type': file.type, ...(lang ? { 'accept-language': lang } : {}) },
    payload: file.bytes,
  });
const writeWith = (c: Company, key: string, payload: Record<string, unknown>, lang?: string) =>
  c.app.inject({ method: 'POST', url: '/api/assistant/messages', headers: { authorization: `Bearer ${key}`, ...(lang ? { 'accept-language': lang } : {}) }, payload });

describe("an assistant's message", () => {
  it("reaches the orchestrator as the CEO's own words, marked as the assistant's, with administration left to the CEO", async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    const sent = await write(c, ava.key, c.orchestrator.id, 'Plan the launch for next week.');
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toEqual({ message: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), agentId: c.orchestrator.id } });
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('From Ivan (CEO) through the assistant Ava to Orchestrator:');
    expect(run.prompt).toContain('Plan the launch for next week.');
    expect(run.prompt).toContain("Ava is the personal assistant of Ivan and wrote this for Ivan, at their request. Ivan is the company's owner (the CEO).");
    expect(run.prompt).toContain("Take these words as Ivan's own. Your answer in this window goes back to Ava for Ivan to read: write it as one person to another, in the language of these words");
    expect(run.prompt).toContain('To give Ivan a file, attach it with hh-attach --chat FILE: it goes with your answer.');
    expect(run.prompt).not.toContain('except for administration');
    expect(run.prompt).not.toContain('hiring or removing employees');
    const events = (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceo) })).json().events;
    expect(events[0]).toMatchObject({ kind: 'message', person: { id: c.owner.id }, data: { text: 'Plan the launch for next week.' }, message: { channel: 'assistant', assistant: { id: ava.id, name: 'Ava' } } });
  });

  it("tells a head that the person responsible for its department wrote through their assistant", async () => {
    const c = await company();
    await invitePerson(c.app, c.ceo, { name: 'Sara', email: 'sara@acme.com', access: { departments: [c.sales.id] } });
    const [sara] = await c.db.select().from(people).where(eq(people.email, 'sara@acme.com'));
    await c.db.update(departments).set({ ownerPersonId: sara!.id }).where(eq(departments.id, c.sales.id));
    const ava = await assistantOf(c, c.ceo, sara!.id, 'Max');
    expect((await write(c, ava.key, c.head.id, 'How are the leads?')).statusCode).toBe(202);
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('From Sara through the assistant Max to Sasha');
    expect(run.prompt).toContain("Max is the personal assistant of Sara and wrote this for Sara, at their request. Sara is responsible for your department.");
  });

  it('answers the questions its owner takes, one about administering the company too, recorded as the assistant\'s', async () => {
    const c = await company();
    const { task } = await createTask(c.app.ctx, { agentId: c.head.id }, { title: 'Leads', brief: '', body: 'Find leads.', departmentId: c.sales.id, assigneeAgentId: c.worker.id, executor: true });
    const work = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'Which region first?', topic: 'task' })).request;
    const machine = (await ask(c.app.ctx, c.worker.id, task.id, { kind: 'question', text: 'May I use the Mac mini?', topic: 'machines' })).request;
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await write(c, ava.key, c.worker.id, 'Start with Europe.')).statusCode).toBe(202);
    const [answered] = await c.db.select().from(requests).where(eq(requests.id, work.id));
    expect(answered).toMatchObject({ status: 'answered', answer: 'Start with Europe.', answeredBy: c.owner.id, answeredByAssistantId: ava.id });
    expect((await c.db.select().from(requests).where(eq(requests.id, machine.id)))[0]).toMatchObject({ status: 'answered', answeredBy: c.owner.id, answeredByAssistantId: ava.id });
    const lines = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'answered')));
    expect(lines.map(l => l.data)).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: work.id, assistantId: ava.id }), expect.objectContaining({ requestId: machine.id, assistantId: ava.id })]));
  });

  it('is refused while the agent cannot answer, and for no words', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await write(c, ava.key, c.head.id, '   ')).statusCode).toBe(400);
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.head.id));
    const refused = await write(c, ava.key, c.head.id, 'Hello?');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.reason).toBe('agent_not_ready');
  });
});

describe('files an assistant sends', () => {
  /* Files a phone gives: a photo, an archive and a video, each a type Hornhoof lists nowhere. */
  const FILES = [
    { name: 'IMG_0042.heic', type: 'image/heic', bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.from([0xff, 0x00, 0x80])]) },
    { name: 'Site.zip', type: 'application/zip', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0xfe]) },
    { name: 'Clip.mov', type: 'video/quicktime', bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.from([0x0d, 0x0a, 0x00])]) },
  ];

  it('lands a .heic, a .zip and a .mov with the message where it was sent, for the agent to open with their exact bytes', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    const kept: { id: string; name: string }[] = [];
    for (const file of FILES) {
      const got = await upload(c, ava.key, file, c.head.id);
      expect(got.statusCode).toBe(201);
      expect(got.json()).toEqual({ file: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: file.name } });
      kept.push(got.json().file);
    }
    const sent = await writeWith(c, ava.key, { agentId: c.head.id, text: 'Photos and the cut for the launch.', files: kept.map(f => f.id) });
    expect(sent.statusCode).toBe(202);
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain('Photos and the cut for the launch.');
    for (const file of kept) expect(run.prompt).toContain(`${file.name}: hh-fetch message ${file.id}`);
    const events = (await c.app.inject({ url: `/api/agents/${c.head.id}/events`, ...as(c.ceo) })).json().events;
    expect(events.find((e: { kind: string }) => e.kind === 'message')).toMatchObject({
      data: { text: 'Photos and the cut for the launch.', pictures: kept.map(f => ({ ...f, file: true })) },
      message: { channel: 'assistant', assistant: { id: ava.id } },
    });
    for (const [i, file] of kept.entries()) {
      const fetched = await c.app.inject({ url: `/api/attachments/file?task=message&file=${file.id}`, headers: { authorization: `Bearer ${run.toolToken}` } });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.rawPayload.equals(FILES[i]!.bytes)).toBe(true);
      expect((await c.app.inject({ url: `/api/attachments/${file.id}`, ...as(c.ceo) })).rawPayload.equals(FILES[i]!.bytes)).toBe(true);
    }
  });

  it('sends a file with no words, which the agent reads by its name', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    const file = (await upload(c, ava.key, FILES[2]!, c.orchestrator.id)).json().file;
    expect((await writeWith(c, ava.key, { agentId: c.orchestrator.id, files: [file.id] })).statusCode).toBe(202);
    const run = await nextOf(c.builtin, 'job.run');
    expect(run.prompt).toContain(`Clip.mov: hh-fetch message ${file.id}`);
    expect((await writeWith(c, ava.key, { agentId: c.orchestrator.id })).statusCode).toBe(400);
  });

  it("says in its owner's words why a file did not come, and keeps nothing of it", async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    const refused = async (got: Awaited<ReturnType<typeof upload>>, status: number, reason: string, words: string) => {
      expect(got.statusCode).toBe(status);
      expect(got.json().error).toMatchObject({ reason, message: words });
    };
    await refused(await upload(c, ava.key, { name: 'empty.heic', type: 'image/heic', bytes: Buffer.alloc(0) }, c.head.id, 'ru-RU,ru;q=0.9'), 400, 'file_empty',
      'файл пустой.');
    await refused(await upload(c, ava.key, { name: 'film.mov', type: 'video/quicktime', bytes: Buffer.alloc(FILE_BYTES + 1) }, c.head.id, 'ru'), 413, 'file_too_big',
      'файл больше 50 МБ.');
    await refused(await upload(c, ava.key, { name: 'film.mov', type: 'video/quicktime', bytes: Buffer.alloc(FILE_BYTES + 1) }, c.head.id), 413, 'file_too_big',
      'the file is bigger than 50 MB.');
    c.app.ctx.config.taskFilesBytes = 4;
    await refused(await upload(c, ava.key, FILES[1]!, c.head.id, 'ru'), 413, 'attachment_invalid',
      'в Hornhoof закончилось место для файлов компании.');
    expect(await c.db.select().from(attachments)).toEqual([]);
    await refused(await writeWith(c, ava.key, { agentId: c.head.id, text: 'See the file', files: [randomUUID()] }, 'ru'), 404, 'attachment_unknown',
      'такого файла в Hornhoof нет, его удалили через 30 дней, или вам его там не открыть.');
    await refused(await upload(c, ava.key, FILES[0]!, randomUUID(), 'ru'), 404, 'agent_unknown',
      'в Hornhoof нет такого сотрудника, или его убрали.');
  });

  it.each([8, FILE_BYTES + 1])('stops a chunked assistant file at its %i byte quota and removes any partial file', async limit => {
    let issued = 0;
    const body = Object.assign(new Readable({ read() {} }), {
      async *[Symbol.asyncIterator]() {
        try { for (const size of [limit, 4, 4]) { issued += size; yield Buffer.alloc(size, 1); } }
        finally { body.destroy(); }
      },
    });
    const c = await company(app => app.addHook('preParsing', async (req, _reply, payload) => req.url.startsWith('/api/assistant/files?') ? body : payload));
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    const dir = mkdtempSync(join(tmpdir(), 'hh-assistant-quota-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    c.app.ctx.config.filesDir = dir;
    c.app.ctx.config.taskFilesBytes = limit;
    const sent = await c.app.inject({ method: 'POST', url: `/api/assistant/files?agentId=${c.head.id}&name=stream.bin`, headers: { authorization: `Bearer ${ava.key}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    expect(sent.statusCode).toBe(413);
    expect(sent.json().error).toMatchObject({ reason: 'attachment_invalid', message: "Hornhoof has no room left for the company's files." });
    expect(issued).toBe(limit + 4);
    expect(readdirSync(dir)).toEqual([]);
    expect(await c.db.select().from(attachments)).toEqual([]);
  });

  it('accepts a chunked assistant file exactly at the eight byte quota', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    c.app.ctx.config.taskFilesBytes = 8;
    const sent = await c.app.inject({ method: 'POST', url: `/api/assistant/files?agentId=${c.head.id}&name=exact.txt`, payload: Readable.from([Buffer.from('1234'), Buffer.from('5678')]), headers: { authorization: `Bearer ${ava.key}`, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } });
    expect(sent.statusCode).toBe(201);
    const [kept] = await c.db.select().from(attachments);
    expect(kept!.size).toBe(8);
    expect(Buffer.from(kept!.bytes).toString()).toBe('12345678');
  });

  it('keeps a file over 50 MB on the disk of the machine that took it and out of the database, for the agent and the owner alike, and says plainly when it is not there', async () => {
    const c = await company();
    const dir = mkdtempSync(join(tmpdir(), 'hh-files-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    c.app.ctx.config.filesDir = dir;
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    const bytes = Buffer.alloc(FILE_BYTES + 1, 7);
    bytes[0] = 1;
    bytes[FILE_BYTES] = 9;
    c.app.ctx.config.taskFilesBytes = FILE_BYTES;
    const full = await upload(c, ava.key, { name: 'Site.zip', type: 'application/zip', bytes }, c.head.id, 'ru');
    expect(full.json().error).toMatchObject({ reason: 'attachment_invalid', message: 'в Hornhoof закончилось место для файлов компании.' });
    expect(readdirSync(dir)).toEqual([]);
    c.app.ctx.config.taskFilesBytes = 2 * FILE_BYTES;
    const got = await upload(c, ava.key, { name: 'Site.zip', type: 'application/zip', bytes }, c.head.id);
    expect(got.statusCode).toBe(201);
    const file = got.json().file as { id: string; name: string };
    expect(readFileSync(join(dir, file.id)).equals(bytes)).toBe(true);
    expect(await c.db.select({ size: attachments.size, held: sql<number>`octet_length(${attachments.bytes})`.mapWith(Number) }).from(attachments)).toEqual([{ size: FILE_BYTES + 1, held: 0 }]);
    expect((await writeWith(c, ava.key, { agentId: c.head.id, files: [file.id] })).statusCode).toBe(202);
    const run = await nextOf(c.builtin, 'job.run');
    const events = (await c.app.inject({ url: `/api/agents/${c.head.id}/events`, ...as(c.ceo) })).json().events;
    expect(events.find((e: { kind: string }) => e.kind === 'message').data.pictures).toEqual([{ ...file, file: true, big: true }]);
    const fetched = await c.app.inject({ url: `/api/attachments/file?task=message&file=${file.id}`, headers: { authorization: `Bearer ${run.toolToken}` } });
    expect(fetched.headers['content-length']).toBe(String(FILE_BYTES + 1));
    expect(fetched.rawPayload.equals(bytes)).toBe(true);
    expect((await c.app.inject({ url: `/api/attachments/${file.id}`, ...as(c.ceo) })).rawPayload.equals(bytes)).toBe(true);
    rmSync(join(dir, file.id));
    const lost = await c.app.inject({ url: `/api/assistant/attachments/${file.id}`, headers: { authorization: `Bearer ${ava.key}`, 'accept-language': 'ru' } });
    expect(lost.statusCode).toBe(410);
    expect(lost.json().error).toEqual({ code: 'gone', reason: 'file_lost', message: 'большой файл хранится только на машине, которая его приняла, и сейчас Hornhoof не может его оттуда взять.' });
    expect((await c.app.inject({ url: `/api/attachments/${file.id}`, ...as(c.ceo) })).json().error.reason).toBe('file_lost');
  });
});
