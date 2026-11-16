import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, attachments, companies, departments, jobs, people, requests, sessions, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { ask, comment, createTask, note, submit } from '../src/modules/tasks/engine.js';
import { dropOldFiles } from '../src/modules/tasks/attachments.js';
import { as, listen, mcp, setUpCompany, testApp, echelonsTurn } from './helpers.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';

const WORDS = ('Full text: права и данные 🌿.\n' + 'Keep every word and its author.\n'.repeat(500)).slice(0, 11999) + '!';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Ref = { field: 'text' | 'evidence'; id: string; name: string; size: number; sha256: string };

async function fixture() {
  const { app, db } = await testApp();
  await listen(app);
  const session = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, roleKey: string) => (await db.insert(agents).values({ companyId: company!.id, departmentId: dev!.id, subscriptionId: sub!.id, name, kind: roleKey === 'DEV-HEAD' ? 'head' : 'worker', roleKey, model: 'claude-opus-5-5', skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(skill => skill.on).map(skill => skill.id) ?? [] }).returning())[0]!;
  const head = await hire('Hana', 'DEV-HEAD');
  const worker = await hire('Bruno', 'DEV-BE');
  const reviewer = await hire('Rita', 'DEV-REV');
  await echelonsTurn(db, company!.id);
  const make = () => createTask(app.ctx, { agentId: head.id }, { title: 'Full report', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: worker.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: reviewer.id });
  app.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha: HEAD });
  app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const task = (await make()).task;
  const token = 'storage-tool-fixture-0123456789abcdef';
  await db.insert(jobs).values({ companyId: company!.id, subscriptionId: sub!.id, agentId: worker.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) });
  const client = await mcp(app, token);
  const events = (kind: 'comment' | 'submitted') => db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, kind)));
  const files = () => db.select().from(attachments).where(eq(attachments.taskId, task.id));
  const post = (text: string) => app.inject({ method: 'POST', url: `/api/tasks/${task.id}/comments`, payload: { text }, ...as(session) });
  return { app, db, session, company: company!, ceo: ceo!, worker, reviewer, task, make, client, token, events, files, post };
}

it('archives a person comment as a complete UTF-8 task file with the actual author', async () => {
  const c = await fixture();
  const response = await c.post(WORDS);
  expect(response.statusCode, response.body).toBe(201);
  const event = (await c.events('comment'))[0]!;
  const refs = event.data.fullTexts as Ref[];
  expect(refs).toHaveLength(1);
  const ref = refs[0]!;
  expect(ref).toMatchObject({ field: 'text', size: Buffer.byteLength(WORDS), sha256: sha(WORDS) });
  expect(event.text.length).toBeLessThanOrEqual(4000);
  expect(event.text).not.toBe(WORDS);
  expect(event.personId).toBe(c.ceo.id);
  expect(response.json().task.files).toContainEqual(expect.objectContaining({ id: ref.id, name: ref.name, by: { id: c.ceo.id, name: c.ceo.name } }));
  const downloaded = await c.app.inject({ url: `/api/attachments/${ref.id}`, ...as(c.session) });
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.headers['content-type']).toContain('text/plain');
  expect(downloaded.headers['content-type']).toContain('charset=utf-8');
  expect(downloaded.headers['x-content-type-options']).toBe('nosniff');
  expect(downloaded.headers['content-security-policy']).toBe("default-src 'none'");
  expect(downloaded.rawPayload.equals(Buffer.from(WORDS))).toBe(true);
  expect(sha(downloaded.rawPayload)).toBe(ref.sha256);
});

it('archives summary and evidence in the same successful move and rejects a duplicate move', async () => {
  const c = await fixture();
  const evidence = WORDS + '\nEvidence.';
  await submit(c.app.ctx, c.worker.id, c.task.id, { summary: WORDS, evidence, review: { baseCommit: BASE } });
  const [event] = await c.events('submitted');
  const refs = event!.data.fullTexts as Ref[];
  expect(refs).toHaveLength(2);
  expect(refs.map(ref => ref.field).sort()).toEqual(['evidence', 'text']);
  for (const ref of refs) {
    const expected = ref.field === 'text' ? WORDS : evidence;
    const downloaded = await c.app.inject({ url: `/api/attachments/${ref.id}`, ...as(c.session) });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.equals(Buffer.from(expected))).toBe(true);
    expect(ref.sha256).toBe(sha(expected));
  }
  const detail = CallToolResultSchema.parse(await c.client.callTool({ name: 'task', arguments: { task: c.task.number } }));
  const text = detail.content.find(item => item.type === 'text');
  expect(text?.type).toBe('text');
  if (text?.type !== 'text') throw Error('Missing task readback');
  const view = JSON.parse(text.text);
  expect(view.log.find((e: { kind: string }) => e.kind === 'submitted').data.fullTexts).toEqual(refs);
  expect(view.files).toHaveLength(2);
  const before = (await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!;
  await expect(submit(c.app.ctx, c.worker.id, c.task.id, { summary: WORDS, evidence, review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 403 });
  expect(await c.events('submitted')).toHaveLength(1);
  expect(await c.files()).toHaveLength(2);
  expect((await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!.version).toBe(before.version);
});

it('rolls a state move back if its full text cannot fit, then permits one retry', async () => {
  const c = await fixture();
  const before = (await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!;
  const beforeRoute = await routeOf(c.db, c.task);
  const limited = { ...c.app.ctx, config: { ...c.app.ctx.config, taskFilesBytes: Buffer.byteLength(WORDS) + 4 } };
  await expect(submit(limited, c.worker.id, c.task.id, { summary: WORDS, evidence: WORDS + ' Evidence.', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 413, reason: 'attachment_invalid' });
  expect(await c.events('submitted')).toEqual([]);
  expect(await c.files()).toEqual([]);
  const unchanged = (await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!;
  expect(unchanged).toMatchObject({ version: before.version, status: before.status, assigneeAgentId: before.assigneeAgentId });
  expect(await routeOf(c.db, c.task)).toEqual(beforeRoute);
  await submit(c.app.ctx, c.worker.id, c.task.id, { summary: WORDS, evidence: WORDS + ' Evidence.', review: { baseCommit: BASE } });
  expect(await c.events('submitted')).toHaveLength(1);
  expect(await c.files()).toHaveLength(2);
});

it('keeps full files scoped to their company and named task on both download paths', async () => {
  const c = await fixture();
  await comment(c.app.ctx, { agentId: c.worker.id }, c.task.id, WORDS);
  const [file] = await c.files();
  expect(file).toBeDefined();
  const [other] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
  const [owner] = await c.db.insert(people).values({ companyId: other!.id, name: 'Other owner', email: 'other@long-text.invalid', status: 'active', isOwner: true, scopeKind: 'company' }).returning();
  const token = 'other-long-text-session';
  await c.db.insert(sessions).values({ personId: owner!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) });
  const url = `/api/attachments/${file!.id}`;
  expect((await c.app.inject({ url })).statusCode).toBe(401);
  expect((await c.app.inject({ url, ...as(token) })).statusCode).toBe(404);
  const [viewer] = await c.db.insert(people).values({ companyId: c.company.id, name: 'No access', email: 'viewer@long-text.invalid', status: 'active', scopeKind: 'listed' }).returning();
  const viewerToken = 'viewer-long-text-session';
  await c.db.insert(sessions).values({ personId: viewer!.id, tokenHash: hashToken(viewerToken), expiresAt: new Date(Date.now() + 60_000) });
  expect((await c.app.inject({ url, ...as(viewerToken) })).statusCode).toBe(404);
  const named = `/api/attachments/file?task=${c.task.number}&file=${file!.id}`;
  const fetched = await c.app.inject({ url: named, headers: { authorization: `Bearer ${c.token}` } });
  expect(fetched.statusCode, fetched.body).toBe(200);
  expect(fetched.rawPayload.equals(Buffer.from(WORDS))).toBe(true);
  const another = (await c.make()).task;
  expect((await c.app.inject({ url: `/api/attachments/file?task=${another.number}&file=${file!.id}`, headers: { authorization: `Bearer ${c.token}` } })).statusCode).toBe(404);
});

it('leaves no full text file when a long unauthorized HTTP comment is rejected', async () => {
  const c = await fixture();
  const [viewer] = await c.db.insert(people).values({ companyId: c.company.id, name: 'No access', email: 'no-access@long-text.invalid', status: 'active', scopeKind: 'listed' }).returning();
  const token = 'no-access-long-text-session';
  await c.db.insert(sessions).values({ personId: viewer!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60_000) });
  const result = await c.app.inject({ method: 'POST', url: `/api/tasks/${c.task.id}/comments`, payload: { text: WORDS }, ...as(token) });
  expect(result.statusCode).toBe(403);
  expect(await c.files()).toEqual([]);
  expect(await c.events('comment')).toEqual([]);
});

it('keeps valid Unicode in the preview while retaining the complete original bytes', async () => {
  const c = await fixture();
  const words = 'x'.repeat(2999) + '🌿' + ' more words'.repeat(1000);
  expect((await c.post(words)).statusCode).toBe(201);
  const [event] = await c.events('comment');
  const refs = event!.data.fullTexts as Ref[];
  expect(refs).toHaveLength(1);
  expect(event!.text.length).toBeLessThanOrEqual(4000);
  expect(event!.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  const downloaded = await c.app.inject({ url: `/api/attachments/${refs[0]!.id}`, ...as(c.session) });
  expect(downloaded.rawPayload.equals(Buffer.from(words))).toBe(true);
});

it('retains a person task file while its task stays open, and expires only the old message picture', async () => {
  const c = await fixture();
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  const values = { companyId: c.company.id, agentId: c.worker.id, personId: c.ceo.id, bytes: Buffer.from('Full text.'), size: 10, createdAt: old };
  const [file] = await c.db.insert(attachments).values({ ...values, taskId: c.task.id, name: 'person-report.txt', mediaType: 'text/plain' }).returning();
  await c.db.insert(attachments).values({ ...values, mediaType: 'image/png' });
  expect(await dropOldFiles(c.db, new Date())).toBe(1);
  expect(await c.files()).toHaveLength(1);
  expect((await c.files())[0]!.id).toBe(file!.id);
});

it('keeps lightweight engine callers complete inline and leaves short comments unchanged', async () => {
  const c = await fixture();
  await note(c.db, c.task, { kind: 'comment', actor: { agentId: c.worker.id }, text: WORDS });
  expect((await c.events('comment'))[0]!.text).toBe(WORDS);
  await comment(c.app.ctx, { personId: c.ceo.id }, c.task.id, 'A short note.');
  const [short] = (await c.events('comment')).filter(e => e.text === 'A short note.');
  expect(short!.data.fullTexts).toBeUndefined();
  expect(await c.files()).toEqual([]);
});

it('records one long answer and one full file when requests race', async () => {
  const c = await fixture();
  const request = (await ask(c.app.ctx, c.worker.id, c.task.id, { kind: 'question', text: 'Please reply.' })).request;
  const reply = () => c.app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { answer: WORDS }, ...as(c.session) });
  const replies = await Promise.all([reply(), reply()]);
  expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]);
  const events = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.task.id), eq(taskEvents.kind, 'answered')));
  expect(events).toHaveLength(1);
  expect(await c.files()).toHaveLength(1);
  expect((await c.db.select().from(requests).where(eq(requests.id, request.id)))[0]!.answer).toBe(WORDS);
});

it('reuses the same complete file for repeated comments by the same actual author', async () => {
  const c = await fixture();
  const tight = { ...c.app.ctx, config: { ...c.app.ctx.config, taskFilesBytes: Buffer.byteLength(WORDS) } };
  await comment(tight, { personId: c.ceo.id }, c.task.id, WORDS);
  await comment(tight, { personId: c.ceo.id }, c.task.id, WORDS);
  expect(await c.events('comment')).toHaveLength(2);
  expect(await c.files()).toHaveLength(1);
});

it('keeps a report bigger than the MCP log budget available through its file', async () => {
  const c = await fixture();
  const words = WORDS.repeat(5);
  await comment(c.app.ctx, { agentId: c.worker.id }, c.task.id, words);
  const result = CallToolResultSchema.parse(await c.client.callTool({ name: 'task', arguments: { task: c.task.number } }));
  const text = result.content.find(item => item.type === 'text');
  if (text?.type !== 'text') throw Error('Missing task readback');
  const view = JSON.parse(text.text);
  expect(text.text.length).toBeLessThan(40000);
  expect(view.files).toHaveLength(1);
  const fetched = await c.app.inject({ url: `/api/attachments/file?task=${c.task.number}&file=${view.files[0].name}`, headers: { authorization: `Bearer ${c.token}` } });
  expect(fetched.statusCode).toBe(200);
  expect(fetched.rawPayload.equals(Buffer.from(words))).toBe(true);
});

it('retains the person author after a closed task has no remaining agent recipient', async () => {
  const c = await fixture();
  await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, executorAgentId: null, createdByAgentId: null, createdByPersonId: c.ceo.id }).where(eq(tasks.id, c.task.id));
  expect((await c.post(WORDS)).statusCode).toBe(201);
  const [file] = await c.files();
  const [orchestrator] = await c.db.select().from(agents).where(and(eq(agents.companyId, c.company.id), eq(agents.kind, 'orchestrator')));
  expect(file).toMatchObject({ personId: c.ceo.id, agentId: orchestrator!.id });
  const downloaded = await c.app.inject({ url: `/api/attachments/${file!.id}`, ...as(c.session) });
  expect(downloaded.statusCode).toBe(200);
  expect(downloaded.rawPayload.equals(Buffer.from(WORDS))).toBe(true);
});

it('lets working employees of another department read full-text task files while refusing personal assistants', async () => {
  const c = await fixture();
  await comment(c.app.ctx, { agentId: c.worker.id }, c.task.id, WORDS);
  const [file] = await c.files();
  const [sales] = await c.db.insert(departments).values({ companyId: c.company.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const [colleague] = await c.db.insert(agents).values({ companyId: c.company.id, departmentId: sales!.id, name: 'Sam', kind: 'worker', roleKey: 'SAL-AE', model: '' }).returning();
  const [assistant] = await c.db.insert(agents).values({ companyId: c.company.id, name: 'Ava', kind: 'assistant', model: '' }).returning();
  const [sub] = await c.db.select().from(subscriptions);
  const token = 'another-department-full-text-fixture';
  const assistantToken = 'assistant-full-text-fixture';
  await c.db.insert(jobs).values([
    { companyId: c.company.id, subscriptionId: sub!.id, agentId: colleague!.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) },
    { companyId: c.company.id, subscriptionId: sub!.id, agentId: assistant!.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(assistantToken) },
  ]);
  const fetched = await c.app.inject({ url: `/api/attachments/file?task=${c.task.number}&file=${file!.id}`, headers: { authorization: `Bearer ${token}` } });
  expect(fetched.statusCode).toBe(200);
  expect(fetched.rawPayload.equals(Buffer.from(WORDS))).toBe(true);
  expect((await c.app.inject({ url: `/api/attachments/file?task=${c.task.number}&file=${file!.id}`, headers: { authorization: `Bearer ${assistantToken}` } })).statusCode).toBe(404);
  const shared = await c.app.inject({ method: 'POST', url: `/api/attachments?task=${c.task.number}&name=shared.txt`, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/octet-stream' }, payload: Buffer.from('An ordinary shared file.') });
  expect(shared.statusCode).toBe(201);
  const ordinary = await c.app.inject({ url: `/api/attachments/file?task=${c.task.number}&file=shared.txt`, headers: { authorization: `Bearer ${token}` } });
  expect(ordinary.statusCode).toBe(200);
  expect(ordinary.body).toBe('An ordinary shared file.');
  expect((await c.app.inject({ url: `/api/attachments/file?task=${c.task.number}&file=shared.txt`, headers: { authorization: `Bearer ${assistantToken}` } })).statusCode).toBe(404);
});
