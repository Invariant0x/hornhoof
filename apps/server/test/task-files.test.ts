import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { attachments, agents, companies, departments, jobs, people, subscriptions, tasks, turns } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { dropOldFiles, FILE_BYTES, TASK_FILES_BYTES } from '../src/modules/tasks/attachments.js';
import { taskDetail } from '../src/modules/tasks/views.js';
import { setUpCompany, testApp } from './helpers.js';

async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp(env);
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
  const task = (await createTask(app.ctx, { agentId: head.id }, { title: 'Build', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
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
  /* A file put on the task without its bytes, only its size, so caps are reached without holding gigabytes. */
  const counted = async (taskId: string, size: number, at = new Date()) => {
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno.id, kind: 'conversation', prompt: 'go', timeoutMs: 900000, status: 'done' }).returning();
    return (await db.insert(attachments).values({ companyId, jobId: job!.id, agentId: bruno.id, taskId, name: `old-${size}.bin`, mediaType: 'application/octet-stream', bytes: Buffer.from('x'), size, createdAt: at }).returning())[0]!;
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

  it('is refused from an agent not on the task, past 50 MB, without a name, and for a task or file that is not there', async () => {
    const { bruno, sam, task, turn, attach, fetchFile } = await company();
    const token = await turn(bruno);
    expect((await attach(await turn(sam), `task=${task.number}&name=a.txt`, Buffer.from('x'))).statusCode).toBe(404);
    expect((await attach(token, `task=${task.number}&name=big.bin`, Buffer.alloc(FILE_BYTES + 1))).statusCode).toBe(413);
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
    const other = (await createTask(app.ctx, { agentId: head.id }, { title: 'Docs', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
    await counted(other.id, 3 * 1024 * 1024 - 10);
    const token = await turn(bruno);
    expect((await attach(token, `task=${task.number}&name=a.txt`, Buffer.alloc(10))).statusCode).toBe(201);
    const over = await attach(token, `task=${task.number}&name=b.txt`, Buffer.alloc(1));
    expect(over.statusCode).toBe(413);
    expect(over.json().error.message).toMatch(/company's task files .*3 MB/);
    const { app: plain } = await testApp();
    expect(plain.ctx.config.taskFilesBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it('lets go of the files of a turn closed 30 days ago, and keeps the rest', async () => {
    const { db, companyId, head, task, counted } = await company();
    const day = 24 * 60 * 60 * 1000;
    const now = new Date();
    const turn = async (number: number, status: 'open' | 'closed', closedAt: Date | null) =>
      (await db.insert(turns).values({ companyId, number, goal: 'g', status, closedAt, createdByAgentId: head.id }).returning())[0]!;
    const [old, recent, open] = [await turn(101, 'closed', new Date(now.getTime() - 31 * day)), await turn(102, 'closed', new Date(now.getTime() - 29 * day)), await turn(103, 'open', null)];
    const files = [];
    for (const t of [old, recent, open]) {
      const [copy] = await db.insert(tasks).values({ ...task, id: undefined, number: task.number + t.number, turnId: t.id }).returning();
      files.push(await counted(copy!.id, 10));
    }
    expect(await dropOldFiles(db, now)).toBe(1);
    expect((await db.select({ id: attachments.id }).from(attachments)).map(a => a.id).sort()).toEqual([files[1]!.id, files[2]!.id].sort());
  });
});
