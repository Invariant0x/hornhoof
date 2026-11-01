import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { as, invitePerson, listen, setUpCompany, testApp } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = 'tool-token-orchestrator-metadata-012345';
const FROM = '2026-11-01T00:17:00.123456Z';
const TO = '2026-11-01T00:30:03.654321Z';
const QUERY = new URLSearchParams({ from: FROM, to: TO }).toString();

async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [target] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Target', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning();
  await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'round', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) });
  return { app, db, url, ceo, acme: acme!, sub: sub!, owner: owner!, orchestrator: orchestrator!, dev: dev!, target: target! };
}

async function mcp(app: FastifyInstance): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  onTestFinished(() => client.close());
  return client;
}

const metadataPath = (id: string, query = QUERY) => `/api/agents/${id}/job-metadata?${query}`;
const at = (time: string) => new Date(`2026-11-01T${time}Z`);

async function seed(c: Awaited<ReturnType<typeof company>>) {
  const { db, acme, sub, owner, orchestrator, target } = c;
  const [task] = await db.insert(tasks).values({ companyId: acme.id, number: 1, title: 'Target task' }).returning();
  const prompt = 'do not export this prompt';
  const definitions = [
    { key: 'predecessor', companyId: acme.id, subscriptionId: sub.id, agentId: target.id, kind: 'conversation', prompt: 'old', status: 'failed', error: 'cancelled', sessionId: 'session-old', createdAt: at('00:15:00'), startedAt: at('00:15:01'), finishedAt: at('00:16:59'), timeoutMs: 1000 },
    { key: 'conversation', companyId: acme.id, subscriptionId: sub.id, agentId: target.id, kind: 'conversation', prompt, status: 'running', error: null, sessionId: 'session-current', instructionsHash: 'hash-current', createdBy: owner.id, taskId: task!.id, createdAt: at('00:17:00.123456'), startedAt: at('00:17:01'), finishedAt: null, timeoutMs: 1000, result: 'do not export this result', tail: 'do not export this tail', toolTokenHash: hashToken('do not export this token') },
    { key: 'test', companyId: acme.id, subscriptionId: sub.id, agentId: target.id, kind: 'test', prompt: 'test', status: 'done', error: null, sessionId: null, createdAt: at('00:17:30'), startedAt: at('00:18:00'), finishedAt: at('00:18:01'), timeoutMs: 1000 },
    { key: 'empty', companyId: acme.id, subscriptionId: sub.id, agentId: target.id, kind: 'conversation', prompt: '', status: 'queued', error: null, sessionId: null, createdAt: at('00:19:00'), startedAt: null, finishedAt: null, timeoutMs: 1000 },
    { key: 'recovery', companyId: acme.id, subscriptionId: sub.id, agentId: target.id, kind: 'conversation', prompt: 'Earlier in this conversation, in another session you cannot see:\nold', status: 'failed', error: 'agent_failed', sessionId: 'session-recovery', createdAt: at('00:20:00'), startedAt: at('00:20:01'), finishedAt: at('00:30:03.654321'), timeoutMs: 1000 },
    { key: 'otherAgent', companyId: acme.id, subscriptionId: sub.id, agentId: orchestrator.id, kind: 'conversation', prompt: 'other', status: 'done', createdAt: at('00:21:00'), startedAt: at('00:21:01'), finishedAt: at('00:21:02'), timeoutMs: 1000 },
    { key: 'ineligible', companyId: acme.id, subscriptionId: sub.id, agentId: target.id, kind: 'conversation', prompt: 'broken', status: 'failed', error: 'agent_failed', sessionId: 'session-broken', createdAt: at('00:14:00'), startedAt: at('00:14:01'), finishedAt: at('00:16:58'), timeoutMs: 1000 },
    { key: 'after', companyId: acme.id, subscriptionId: sub.id, agentId: target.id, kind: 'conversation', prompt: 'after', status: 'done', createdAt: at('00:31:00'), startedAt: at('00:31:01'), finishedAt: at('00:31:02'), timeoutMs: 1000 },
  ] as const;
  const ids: Record<string, string> = {};
  for (const { key, ...values } of definitions) {
    const [row] = await db.insert(jobs).values(values).returning({ id: jobs.id });
    ids[key] = row!.id;
  }
  await db.execute(sql`update jobs set created_at = ${FROM}::timestamptz where id = ${ids.conversation}`);
  await db.execute(sql`update jobs set finished_at = ${TO}::timestamptz where id = ${ids.recovery}`);
  return { ids, prompt };
}

describe('job metadata export', () => {
  it('reads only bounded metadata through the company route and the real orchestrator view without changing state', async () => {
    const c = await company();
    const { ids, prompt } = await seed(c);
    const state = async () => c.db.select().from(jobs).orderBy(asc(jobs.id));
    const before = await state();
    const path = metadataPath(c.target.id);
    const response = await c.app.inject({ url: path, ...as(c.ceo) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.complete).toBe(true);
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual([ids.predecessor, ids.conversation, ids.test, ids.empty, ids.recovery]);
    expect(body.jobs[0]).toMatchObject({ predecessor_before_window: true, session_id: 'session-old' });
    expect(body.jobs[1]).toMatchObject({
      kind: 'conversation',
      subscription_id: c.sub.id,
      session_id: 'session-current',
      instructions_hash: 'hash-current',
      created_by: c.owner.id,
      task_id: body.jobs[1].task_id,
      created_at: FROM,
      prompt_characters: prompt.length,
      prompt_md5: createHash('md5').update(prompt).digest('hex'),
      empty_start: false,
      recovery_prefix: false,
      predecessor_before_window: false,
    });
    expect(body.jobs[1].task_id).toEqual(expect.any(String));
    expect(body.jobs[2]).toMatchObject({ kind: 'test', session_id: null });
    expect(body.jobs[3]).toMatchObject({ kind: 'conversation', started_at: null, session_id: null, empty_start: true });
    expect(body.jobs[4]).toMatchObject({ finished_at: TO, recovery_prefix: true });
    const fields = ['created_at', 'created_by', 'empty_start', 'error', 'finished_at', 'id', 'instructions_hash', 'kind', 'predecessor_before_window', 'prompt_characters', 'prompt_md5', 'recovery_prefix', 'session_id', 'started_at', 'status', 'subscription_id', 'task_id'];
    for (const job of body.jobs) expect(Object.keys(job).sort()).toEqual(fields);
    expect(response.body).not.toContain(prompt);
    expect(response.body).not.toContain('do not export this result');
    expect(response.body).not.toContain('do not export this tail');
    expect(response.body).not.toContain('do not export this token');
    const viewed = await (await mcp(c.app)).callTool({ name: 'view', arguments: { path } });
    expect(viewed.isError).toBeFalsy();
    expect(JSON.parse((viewed as { content: { text: string }[] }).content[0]!.text)).toEqual(body);
    expect((await c.app.inject({ url: path, ...as(c.ceo) })).json()).toEqual(body);
    expect(await state()).toEqual(before);
  });

  it('refuses unauthenticated, node, department and foreign-company readers', async () => {
    const c = await company();
    const path = metadataPath(c.target.id);
    expect((await c.app.inject({ url: path })).statusCode).toBe(401);
    expect((await c.app.inject({ url: path, headers: { authorization: `Bearer ${NODE_KEY}` } })).statusCode).toBe(401);
    await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.target.id, kind: 'conversation', prompt: 'employee', status: 'running', timeoutMs: 900000, toolTokenHash: hashToken('employee-tool-token') });
    expect((await c.app.inject({ url: path, headers: { authorization: 'Bearer employee-tool-token' } })).statusCode).toBe(401);
    const dana = await invitePerson(c.app, c.ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [c.dev.id] } });
    expect((await c.app.inject({ url: path, ...as(dana) })).statusCode).toBe(403);
    const [otherCompany] = await c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [foreign] = await c.db.insert(agents).values({ companyId: otherCompany!.id, kind: 'worker', name: 'Foreign', model: '', subscriptionId: c.sub.id }).returning();
    expect((await c.app.inject({ url: metadataPath(foreign!.id), ...as(c.ceo) })).statusCode).toBe(404);
  });

  it('rejects invalid ids, non-UTC dates, reversed ranges and large windows', async () => {
    const c = await company();
    const paths = [
      metadataPath('not-a-uuid'),
      metadataPath(c.target.id, new URLSearchParams({ to: TO }).toString()),
      metadataPath(c.target.id, new URLSearchParams({ from: 'not-a-date', to: TO }).toString()),
      metadataPath(c.target.id, new URLSearchParams({ from: '2026-11-01T00:17:00+00:00', to: TO }).toString()),
      metadataPath(c.target.id, new URLSearchParams({ from: TO, to: FROM }).toString()),
      metadataPath(c.target.id, new URLSearchParams({ from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:16:00Z' }).toString()),
      metadataPath(c.target.id, new URLSearchParams({ from: '2026-11-01T00:17:00.1234567Z', to: TO }).toString()),
      metadataPath(c.target.id, new URLSearchParams({ from: '2026-02-30T00:00:00Z', to: TO }).toString()),
    ];
    for (const path of paths) expect((await c.app.inject({ url: path, ...as(c.ceo) })).statusCode).toBe(400);
  });

  it('allows instant and exactly fifteen minute inclusive windows', async () => {
    const c = await company();
    const instant = new URLSearchParams({ from: FROM, to: FROM }).toString();
    const exact = new URLSearchParams({ from: FROM, to: '2026-11-01T00:32:00.123456Z' }).toString();
    for (const query of [instant, exact]) expect((await c.app.inject({ url: metadataPath(c.target.id, query), ...as(c.ceo) })).statusCode).toBe(200);
  });

  it('rejects a window over fifteen minutes by one microsecond', async () => {
    const c = await company();
    const fractional = new URLSearchParams({ from: FROM, to: '2026-11-01T00:32:00.123457Z' }).toString();
    const wholeSecond = new URLSearchParams({ from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:15:00.000001Z' }).toString();
    for (const query of [fractional, wholeSecond]) expect((await c.app.inject({ url: metadataPath(c.target.id, query), ...as(c.ceo) })).statusCode).toBe(400);
  });

  it('marks empty start only for conversations', async () => {
    const c = await company();
    await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.target.id, kind: 'test', prompt: '', status: 'queued', createdAt: new Date(Date.parse(FROM) + 1000), timeoutMs: 1000 });
    const response = await c.app.inject({ url: metadataPath(c.target.id), ...as(c.ceo) });
    expect(response.statusCode).toBe(200);
    expect(response.json().jobs).toHaveLength(1);
    expect(response.json().jobs[0]).toMatchObject({ kind: 'test', empty_start: false });
  });

  it('allows exactly forty rows', async () => {
    const c = await company();
    await c.db.insert(jobs).values(Array.from({ length: 40 }, (_, i) => ({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.target.id, kind: 'conversation' as const, prompt: 'hidden', status: 'queued' as const, createdAt: new Date(Date.parse(FROM) + 1000 + i * 1000), timeoutMs: 1000 })));
    const response = await c.app.inject({ url: metadataPath(c.target.id), ...as(c.ceo) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ complete: true });
    expect(response.json().jobs).toHaveLength(40);
  });

  it('allows a response of exactly 28000 characters', async () => {
    const c = await company();
    const [job] = await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.target.id, kind: 'conversation', prompt: 'hidden', status: 'queued', instructionsHash: '', createdAt: new Date(Date.parse(FROM) + 1000), timeoutMs: 1000 }).returning();
    const baseline = await c.app.inject({ url: metadataPath(c.target.id), ...as(c.ceo) });
    const missing = 28_000 - baseline.body.length;
    await c.db.update(jobs).set({ instructionsHash: 'x'.repeat(missing) }).where(eq(jobs.id, job!.id));
    const response = await c.app.inject({ url: metadataPath(c.target.id), ...as(c.ceo) });
    expect(response.statusCode).toBe(200);
    expect(response.body).toHaveLength(28_000);
  });

  it('refuses instead of truncating more than forty rows', async () => {
    const c = await company();
    await c.db.insert(jobs).values(Array.from({ length: 41 }, (_, i) => ({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.target.id, kind: 'conversation' as const, prompt: 'hidden', status: 'queued' as const, createdAt: new Date(Date.parse(FROM) + 1000 + i * 1000), timeoutMs: 1000 })));
    const response = await c.app.inject({ url: metadataPath(c.target.id), ...as(c.ceo) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { reason: 'job_metadata_overflow' } });
    expect(response.body).not.toContain('hidden');
  });

  it('refuses a response that would exceed the safe body size', async () => {
    const c = await company();
    await c.db.insert(jobs).values({ companyId: c.acme.id, subscriptionId: c.sub.id, agentId: c.target.id, kind: 'conversation', prompt: 'hidden', status: 'queued', instructionsHash: 'x'.repeat(30_000), createdAt: new Date(Date.parse(FROM) + 1000), timeoutMs: 1000 });
    const response = await c.app.inject({ url: metadataPath(c.target.id), ...as(c.ceo) });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { reason: 'job_metadata_overflow' } });
    expect(response.body).not.toContain('x'.repeat(100));
  });

});
