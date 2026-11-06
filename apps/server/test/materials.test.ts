import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MaterialManifest } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { ApiError } from '../src/errors.js';
import { parseMaterialSubmission } from '../src/modules/tasks/request-materials.js';
import { agentChanges, agentEvents, agents, attachments, companies, departments, jobs, people, proposals, requestInternal, requests, taskEvents, tasks } from '../src/db/schema.js';
import { as, invitePerson, listen, mcp, openStream, ownPlan, setUpCompany, testApp, until } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]);
const PRIVATE = 'PRIVATE_MATERIAL_SOURCE_AND_RECIPIENTS';

describe('material submission metadata', () => {
  const link = { kind: 'link', name: 'Result', url: 'https://example.com/result' };

  it('does not invent a file for an action-only source', () => {
    expect(parseMaterialSubmission(undefined, 0, false)).toBeUndefined();
    const action = { presentation: 'action', common: [], options: [] };
    expect(parseMaterialSubmission(action, 0, false)).toEqual(action);
  });

  it('retains the exact source option order and each result material', () => {
    const input = { presentation: 'result', common: [], options: [[link], [{ ...link, name: 'Other result', url: 'https://example.com/other' }]] };
    expect(parseMaterialSubmission(input, 2, true)).toEqual(input);
  });

  it.each([
    [undefined, 0, true, 'materials_required'],
    [{ presentation: 'action', common: [], options: [] }, 0, true, 'materials_required'],
    [{ presentation: 'result', common: [], options: [] }, 0, false, 'materials_required'],
    [{ presentation: 'result', common: [link], options: [[], []] }, 2, true, 'materials_required'],
    [{ presentation: 'result', common: [], options: [[link]] }, 2, true, 'materials_invalid'],
    [{ presentation: 'result', common: [link], options: [], canRead: true }, 0, true, 'materials_invalid'],
    [{ presentation: 'result', common: [{ ...link, url: 'https://user:secret@example.com/' }], options: [] }, 0, true, 'materials_invalid'],
  ] as const)('refuses invalid source metadata case %# with an attachment hint', (input, options, required, reason) => {
    let error: unknown;
    try { parseMaterialSubmission(input, options, required); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ApiError);
    const failure = error as ApiError;
    expect(failure.reason).toBe(reason);
    expect(failure.message).toContain('hh-attach --task');
    expect(failure.message).not.toContain('secret');
  });
});

/* Existing immutable pictures, not a new unclassified question producer. */
async function legacy() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [author] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev, sales] = await db.insert(departments).values([
    { companyId: company!.id, templateKey: 'development', roleCode: 'DEV' },
    { companyId: company!.id, templateKey: 'sales', roleCode: 'SAL' },
  ]).returning();
  const [task] = await db.insert(tasks).values({ companyId: company!.id, number: 1, departmentId: dev!.id, createdByAgentId: author!.id, title: 'Original result', status: 'waiting' }).returning();
  const [job] = await db.insert(jobs).values({ companyId: company!.id, subscriptionId: author!.subscriptionId!, agentId: author!.id, kind: 'conversation', prompt: 'Original result', timeoutMs: 1000 }).returning();
  const [question] = await db.insert(requests).values({ companyId: company!.id, taskId: task!.id, agentId: author!.id, kind: 'choice', text: 'Choose a shape', options: [] }).returning();
  const put = async (requestId: string | null, name: string) => (await db.insert(attachments).values({ companyId: company!.id, jobId: job!.id, agentId: author!.id, requestId, name, mediaType: 'image/png', bytes: PNG, size: PNG.length }).returning())[0]!;
  const common = await put(question!.id, 'private-source-path.png');
  const round = await put(question!.id, 'private-round.png');
  const square = await put(question!.id, 'private-square.png');
  const loose = await put(null, 'not-shared.png');
  await db.update(requests).set({ options: [{ label: 'Round', image: round.id }, { label: 'Square', image: square.id }], link: 'https://example.com/result' }).where(eq(requests.id, question!.id));
  const url = `/api/requests/${question!.id}/materials`;
  return { app, db, ceo, company: company!, author: author!, task: task!, question: question!, dev: dev!, sales: sales!, common, round, square, loose, url };
}

async function manifest(f: Awaited<ReturnType<typeof legacy>>, token = f.ceo) {
  const response = await f.app.inject({ url: f.url, ...as(token) });
  expect(response.statusCode).toBe(200);
  return MaterialManifest.parse(response.json());
}

describe('legacy scoped materials', () => {
  it('projects ordered pictures and links with stable opaque ids and no original file selectors', async () => {
    const f = await legacy();
    const first = await manifest(f);
    const second = await manifest(f);
    expect(second).toEqual(first);
    expect(first.common.map(m => m.kind)).toEqual(['image', 'link']);
    expect(first.options.map(o => o.materials.map(m => m.kind))).toEqual([['image'], ['image']]);
    const ids = [...first.common, ...first.options.flatMap(o => o.materials)].map(m => m.id);
    expect(new Set(ids).size).toBe(4);
    for (const value of [f.common.id, f.round.id, f.square.id, f.loose.id, 'private-source-path.png', f.author.id, f.task.id]) expect(JSON.stringify(first)).not.toContain(value);
  });

  it('streams exact original image bytes without answering or adding history', async () => {
    const f = await legacy();
    const before = await f.db.select().from(requests).where(eq(requests.id, f.question.id));
    const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id));
    const shown = await manifest(f);
    const image = shown.options[0]!.materials[0]!;
    expect(image.kind).toBe('image');
    if (image.kind !== 'image' || image.state !== 'available') throw new Error('The original image is unavailable.');
    const content = await f.app.inject({ url: image.contentUrl, ...as(f.ceo) });
    expect(content.statusCode).toBe(200);
    expect(content.rawPayload.equals(PNG)).toBe(true);
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['cache-control']).toContain('no-store');
    expect(content.headers['content-security-policy']).toBe("default-src 'none'");
    expect(await f.db.select().from(requests).where(eq(requests.id, f.question.id))).toEqual(before);
    expect(await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id))).toEqual(events);
  });

  it('downloads the same bytes and refuses raw attachment ids as material selectors', async () => {
    const f = await legacy();
    const shown = await manifest(f);
    const image = shown.common[0]!;
    if (image.kind !== 'image' || image.state !== 'available' || !image.downloadUrl) throw new Error('The original image is unavailable.');
    const download = await f.app.inject({ url: image.downloadUrl, ...as(f.ceo) });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PNG)).toBe(true);
    expect(download.headers['content-disposition']).toContain('attachment;');
    for (const id of [f.common.id, f.loose.id, randomUUID()]) expect((await f.app.inject({ url: `${f.url}/${id}/content`, ...as(f.ceo) })).statusCode).toBe(404);
  });

  it('rechecks the current question binding after a picture is removed from that question', async () => {
    const f = await legacy();
    const shown = await manifest(f);
    const image = shown.options[0]!.materials[0]!;
    if (image.kind !== 'image' || image.state !== 'available') throw new Error('The original image is unavailable.');
    await f.db.update(attachments).set({ requestId: null }).where(eq(attachments.id, f.round.id));
    expect((await f.app.inject({ url: image.contentUrl, ...as(f.ceo) })).statusCode).toBe(404);
    const current = await manifest(f);
    expect(current.options[0]!.materials[0]!.state).toBe('missing');
    expect(current.materialDigest).not.toBe(shown.materialDigest);
  });

  it('requires authentication and never lets a material id bypass another question', async () => {
    const f = await legacy();
    expect((await f.app.inject({ url: f.url })).statusCode).toBe(401);
    const shown = await manifest(f);
    const image = shown.common[0]!;
    if (image.kind !== 'image' || image.state !== 'available') throw new Error('The original image is unavailable.');
    const [other] = await f.db.insert(requests).values({ companyId: f.company.id, taskId: f.task.id, agentId: f.author.id, kind: 'question', text: 'Other source' }).returning();
    expect((await f.app.inject({ url: `/api/requests/${other!.id}/materials/${image.id}/content`, ...as(f.ceo) })).statusCode).toBe(404);
    const stranger = await invitePerson(f.app, f.ceo, { name: 'Sales', email: 'sales@acme.com', access: { departments: [f.sales.id] } });
    for (const url of [f.url, image.contentUrl, image.downloadUrl!]) expect([403, 404]).toContain((await f.app.inject({ url, ...as(stranger) })).statusCode);
  });

  it('allows preview to a current file reader who cannot answer, and revokes it with that access', async () => {
    const f = await legacy();
    const reader = await invitePerson(f.app, f.ceo, { name: 'Reader', email: 'reader@acme.com', access: { whole: true } });
    await ownPlan(f.db, 'reader@acme.com', f.author.id);
    const waiting = (await f.app.inject({ url: '/api/requests', ...as(reader) })).json().requests;
    expect(waiting.find((r: { id: string }) => r.id === f.question.id)?.canAnswer).toBe(false);
    const shown = await manifest(f, reader);
    const image = shown.common[0]!;
    if (image.kind !== 'image' || image.state !== 'available') throw new Error('The original image is unavailable.');
    expect((await f.app.inject({ url: image.contentUrl, ...as(reader) })).statusCode).toBe(200);
    const [person] = await f.db.select().from(people).where(eq(people.email, 'reader@acme.com'));
    await f.db.update(people).set({ status: 'disabled' }).where(eq(people.id, person!.id));
    expect((await f.app.inject({ url: image.contentUrl, ...as(reader) })).statusCode).toBe(401);
  });

  it('does not reveal hidden native or request snapshots through ordinary request JSON', async () => {
    const f = await legacy();
    await f.db.insert(requestInternal).values({ requestId: f.question.id, companyId: f.company.id, materialSnapshot: { schemaVersion: 1, versions: [] } });
    await f.db.insert(proposals).values({ companyId: f.company.id, agentId: f.author.id, brief: 'Public proposal', items: [], materialSnapshot: { schemaVersion: 1, versions: [] } });
    await f.db.execute(sql`update proposals set material_snapshot = ${JSON.stringify({ schemaVersion: 1, versions: [], private: PRIVATE })}::jsonb`);
    const response = await f.app.inject({ url: '/api/requests', ...as(f.ceo) });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(PRIVATE);
    expect(response.body).not.toContain('materialSnapshot');
    expect(response.body).not.toContain('material_snapshot');
    expect((await f.db.select().from(requestInternal)).length).toBe(1);
  });

  it.each(['private-staging', 'public-stamp'] as const)('refuses an unclassified private source instead of treating %s as legacy permission', async state => {
    const f = await legacy();
    if (state === 'private-staging') await f.db.insert(requestInternal).values({ requestId: f.question.id, companyId: f.company.id, materialSnapshot: { schemaVersion: 1, versions: [] } });
    else await f.db.update(requests).set({ materialRevision: 1, materialDigest: 'a'.repeat(64) }).where(eq(requests.id, f.question.id));
    const response = await f.app.inject({ url: f.url, ...as(f.ceo) });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.reason).toBe('source_producer_unavailable');
    expect(response.body).not.toContain(f.common.id);
    expect((await f.db.select().from(requests).where(eq(requests.id, f.question.id)))[0]!.status).toBe('open');
  });
});

describe('native material boundaries', () => {
  async function native(kind: 'structure' | 'staff', state: 'legacy' | 'private-staging' | 'public-stamp') {
    const f = await legacy();
    await listen(f.app);
    const items = kind === 'structure' ? [{ template: 'finance', note: 'Proposed department' }] : [{ role: 'DEV-DEV', name: 'New employee', model: 'default', subscription: f.author.subscriptionId, skills: [] }];
    const [proposal] = await f.db.insert(proposals).values({
      companyId: f.company.id, agentId: f.author.id, kind, departmentId: kind === 'staff' ? f.dev.id : null,
      brief: 'Review the original proposal', items,
      ...(state === 'private-staging' ? { materialSnapshot: { schemaVersion: 1 as const, versions: [] } } : {}),
      ...(state === 'public-stamp' ? { materialRevision: 1, materialDigest: 'a'.repeat(64) } : {}),
    }).returning();
    const url = `/api/proposals/${proposal!.id}/materials`;
    const applyUrl = kind === 'structure' ? '/api/departments/build' : `/api/departments/${f.dev.id}/staff`;
    const payload = { proposalId: proposal!.id, ...(kind === 'structure' ? { items } : { people: items }) };
    const stateOf = async () => ({
      proposal: await f.db.select().from(proposals),
      company: await f.db.select().from(companies),
      departments: await f.db.select().from(departments),
      agents: await f.db.select().from(agents),
      changes: await f.db.select().from(agentChanges),
      outgoing: await f.db.select().from(agentEvents),
      jobs: await f.db.select().from(jobs),
    });
    return { ...f, proposal: proposal!, url, applyUrl, payload, stateOf };
  }

  it.each(['structure', 'staff'] as const)('reports the missing real %s material producer without inventing a snapshot', async kind => {
    const f = await native(kind, 'legacy');
    const before = await f.stateOf();
    for (const url of [f.url, `${f.url}/${randomUUID()}/content`, `${f.url}/${randomUUID()}/download`]) {
      const response = await f.app.inject({ url, ...as(f.ceo) });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.reason).toBe('source_producer_unavailable');
      expect(response.body).not.toContain(f.author.id);
      expect(response.body).not.toContain('items');
    }
    expect(await f.stateOf()).toEqual(before);
  });

  it.each(['structure', 'staff'] as const)('requires current source visibility before returning the %s producer state', async kind => {
    const f = await native(kind, 'private-staging');
    expect((await f.app.inject({ url: f.url })).statusCode).toBe(401);
    const stranger = await invitePerson(f.app, f.ceo, { name: 'Sales reader', email: 'native-reader@acme.com', access: { departments: [f.sales.id] } });
    for (const url of [f.url, `${f.url}/${randomUUID()}/content`]) expect((await f.app.inject({ url, ...as(stranger) })).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/proposals/${randomUUID()}/materials`, ...as(f.ceo) })).statusCode).toBe(404);
  });

  it.each([
    ['structure', 'private-staging'], ['structure', 'public-stamp'],
    ['staff', 'private-staging'], ['staff', 'public-stamp'],
  ] as const)('does not apply an unclassified %s card with %s evidence', async (kind, state) => {
    const f = await native(kind, state);
    const before = await f.stateOf();
    const stream = await openStream(f.app, f.ceo);
    const response = await f.app.inject({ method: 'POST', url: f.applyUrl, payload: f.payload, ...as(f.ceo) });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.reason).toBe('source_producer_unavailable');
    expect(await f.stateOf()).toEqual(before);
    f.app.ctx.bus.publish(f.company.id, { type: 'working', working: 123 });
    await until(() => stream.messages.some(m => m.type === 'working' && m.working === 123));
    expect(stream.messages.filter(m => m.type !== 'working')).toEqual([]);
  });
});

type ToolReply = { content: { text: string }[]; isError?: boolean };
const askTool = async (client: Client, args: Record<string, unknown>): Promise<ToolReply> =>
  await client.callTool({ name: 'ask_person', arguments: args }) as ToolReply;

async function intake() {
  const f = await legacy();
  await listen(f.app);
  await f.db.update(tasks).set({ assigneeAgentId: f.author.id }).where(eq(tasks.id, f.task.id));
  const token = `material-intake-${randomUUID()}`;
  await f.db.insert(jobs).values({ companyId: f.company.id, subscriptionId: f.author.subscriptionId!, agentId: f.author.id, kind: 'conversation', prompt: 'Ask', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
  const client = await mcp(f.app, token);
  const state = async () => ({
    task: await f.db.select().from(tasks).where(eq(tasks.id, f.task.id)),
    requests: await f.db.select().from(requests).where(eq(requests.taskId, f.task.id)),
    events: await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.task.id)),
    outgoing: await f.db.select().from(agentEvents).where(eq(agentEvents.companyId, f.company.id)),
    jobs: await f.db.select().from(jobs).where(eq(jobs.companyId, f.company.id)),
    private: await f.db.select().from(requestInternal),
  });
  return { ...f, client, state };
}

describe('material intake through the real tool', () => {
  it.each([
    ['an exact commit without materials', { commit: 'a'.repeat(40) }],
    ['an exact commit labelled action', { commit: 'a'.repeat(40), materials: { presentation: 'action', common: [], options: [] } }],
    ['a result without material', { materials: { presentation: 'result', common: [], options: [] } }],
    ['an uncovered result choice', { options: [{ label: 'A' }, { label: 'B' }], materials: { presentation: 'result', common: [{ kind: 'link', name: 'Context', url: 'https://example.com/context' }], options: [[], []] } }],
  ] as const)('rejects %s without creating a request, wait or history', async (_name, input) => {
    const f = await intake();
    const before = await f.state();
    const result = await askTool(f.client, { task: f.task.number, question: 'Review this result', ...input });
    expect(result.isError).toBe(true);
    expect(result.content.map(c => c.text).join('\n')).toContain('materials_required');
    expect(await f.state()).toEqual(before);
  });

  it('refuses a positional mismatch without changing the canonical source', async () => {
    const f = await intake();
    const before = await f.state();
    const result = await askTool(f.client, { task: f.task.number, question: 'Which result?', options: [{ label: 'A' }, { label: 'B' }], materials: { presentation: 'result', common: [], options: [[{ kind: 'link', name: 'Only A', url: 'https://example.com/a' }]] } });
    expect(result.isError).toBe(true);
    expect(result.content.map(c => c.text).join('\n')).toContain('materials_invalid');
    expect(await f.state()).toEqual(before);
  });

  it('does not activate a private result producer or send SSE while its real authority port is unavailable', async () => {
    const f = await intake();
    const stream = await openStream(f.app, f.ceo);
    expect(stream.res.status).toBe(200);
    const before = await f.state();
    const result = await askTool(f.client, { task: f.task.number, question: 'Review the result', materials: { presentation: 'result', common: [{ kind: 'link', name: 'Result', url: 'https://example.com/result' }], options: [] } });
    expect(result.isError).toBe(true);
    expect(result.content.map(c => c.text).join('\n')).toContain('not available');
    expect(await f.state()).toEqual(before);
    f.app.ctx.bus.publish(f.company.id, { type: 'working', working: 123 });
    await until(() => stream.messages.some(m => m.type === 'working' && m.working === 123));
    expect(stream.messages.filter(m => m.type !== 'working')).toEqual([]);
  });
});
