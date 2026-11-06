import { randomUUID } from 'node:crypto';
import { MaterialManifest } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, attachments, companies, departments, jobs, people, proposals, requestInternal, requests, taskEvents, tasks } from '../src/db/schema.js';
import { as, invitePerson, ownPlan, setUpCompany, testApp } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 1)]);
const PRIVATE = 'PRIVATE_MATERIAL_SOURCE_AND_RECIPIENTS';

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
  const [task] = await db.insert(tasks).values({ companyId: company!.id, number: 1, departmentId: dev!.id, title: 'Original result', status: 'waiting' }).returning();
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
});
