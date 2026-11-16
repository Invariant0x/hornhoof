import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, outboundPermissions, people } from '../src/db/schema.js';
import { company } from './department-owner-fixture.js';
import { appFixture, as, invitePerson } from './helpers.js';

/* A person given several departments but not the whole company, as people are given Marketing, Sales, Support and
   Business development: they run the messages of each of them, its named owner among them, and of no other. On their own
   department they read its channels, publish and take back its catalog and add the addresses that agreed; on Development,
   which they were not given, every one of these moves is refused. Everything is synthetic. */

type Answer = { statusCode: number; body: string; json(): Record<string, unknown> };
type Overview = { channels: { id: string; departmentId: string; name: string; canManage?: boolean }[]; departments: { id: string }[] };

const B2C = { name: 'B2C Email Outreach', adapter: 'smtp', purpose: 'newsletter', audience: 'direct' };
const TEMPLATE = { kind: 'template', locale: 'en', subject: 'Spring', parts: [{ kind: 'text', text: 'Hello from the spring sale.' }] };

async function fourDepartments() {
  const c = await company();
  const made = await appFixture(c.app, 'outbound department access', async () => {
    const [mkt, support, biz] = await c.db
      .insert(departments)
      .values([
        { companyId: c.companyId, templateKey: 'marketing', roleCode: 'MKT', position: 4 },
        { companyId: c.companyId, templateKey: 'support', roleCode: 'SUP', position: 5 },
        { companyId: c.companyId, name: 'Business development', roleCode: 'BIZ', position: 6 },
      ])
      .returning();
    const given = { departments: [mkt!.id, c.sales.id, support!.id, biz!.id] };
    const maxToken = await invitePerson(c.app, c.ceoToken, { name: 'Max', email: 'max@acme.com', access: given });
    const louiseToken = await invitePerson(c.app, c.ceoToken, { name: 'Louise', email: 'louise@acme.com', access: given });
    const [max] = await c.db.select({ id: people.id }).from(people).where(eq(people.email, 'max@acme.com'));
    expect((await c.setOwner(c.ceoToken, mkt!.id, max!.id)).statusCode).toBe(200);
    const post = (url: string, payload: object, token: string) => c.app.inject({ method: 'POST', url, payload, ...as(token) });
    const channel = (await post('/api/outbound/channels', { departmentId: mkt!.id, ...B2C }, c.ceoToken)).json() as { channelId: string };
    const devChannel = (await post('/api/outbound/channels', { departmentId: c.dev.id, ...B2C, name: 'Developer letters' }, c.ceoToken)).json() as { channelId: string };
    const devRevision = (await post('/api/outbound/catalog', { departmentId: c.dev.id, value: TEMPLATE }, c.ceoToken)).json() as { id: string };
    return { mkt: mkt!, support: support!, biz: biz!, maxToken, louiseToken, channelId: channel.channelId, devChannelId: devChannel.channelId, devRevisionId: devRevision.id };
  });
  const get = (url: string, token = made.maxToken): Promise<Answer> => c.app.inject({ method: 'GET', url, ...as(token) });
  const post = (url: string, payload: object, token = made.maxToken): Promise<Answer> => c.app.inject({ method: 'POST', url, payload, ...as(token) });
  return { c, ...made, get, post };
}

const reasonOf = (a: Answer) => (a.json() as { error?: { reason?: string } }).error?.reason;

describe('a person given several departments, not the whole company, runs the messages of each of them', () => {
  it('reads the channel of the department they own and of every department they were given, and of no other', async () => {
    const m = await fourDepartments();
    const own = await m.get(`/api/outbound?department=${m.mkt.id}`);
    expect(own.statusCode, own.body).toBe(200);
    const overview = own.json() as unknown as Overview;
    expect(overview.departments.map(d => d.id)).toEqual([m.mkt.id]);
    expect(overview.channels.map(ch => [ch.name, ch.departmentId, ch.canManage])).toEqual([['B2C Email Outreach', m.mkt.id, true]]);
    const every = (await m.get('/api/outbound', m.louiseToken)).json() as unknown as Overview;
    expect(every.departments.map(d => d.id).sort()).toEqual([m.mkt.id, m.c.sales.id, m.support.id, m.biz.id].sort());
    expect(every.channels.map(ch => ch.name)).toEqual(['B2C Email Outreach']);
    expect((await m.get(`/api/outbound?department=${m.c.dev.id}`)).statusCode).toBe(404);
  }, 60_000);

  it('publishes and takes back a template of their own department\'s catalog, and is refused on another department', async () => {
    const m = await fourDepartments();
    const proposed = await m.post('/api/outbound/catalog', { departmentId: m.mkt.id, channelId: m.channelId, value: TEMPLATE });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const revisionId = proposed.json()['id'] as string;
    const published = await m.post(`/api/outbound/catalog/${revisionId}/publish`, {});
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json()).toMatchObject({ status: 'published' });
    const catalog = await m.get(`/api/outbound/catalog?department=${m.mkt.id}`);
    expect(catalog.statusCode, catalog.body).toBe(200);
    const taken = await m.post(`/api/outbound/catalog/${revisionId}/revoke`, {});
    expect(taken.statusCode, taken.body).toBe(200);
    expect(taken.json()).toMatchObject({ status: 'revoked' });

    const refusals = [
      await m.get(`/api/outbound/catalog?department=${m.c.dev.id}`),
      await m.get(`/api/outbound/setup-log?department=${m.c.dev.id}`),
      await m.post('/api/outbound/catalog', { departmentId: m.c.dev.id, value: TEMPLATE }),
      await m.post(`/api/outbound/catalog/${m.devRevisionId}/publish`, {}),
      await m.post(`/api/outbound/catalog/${m.devRevisionId}/revoke`, {}),
    ];
    expect(refusals.map(a => [a.statusCode, reasonOf(a)])).toEqual(Array(5).fill([403, 'outbound_not_allowed']));
  }, 60_000);

  it('adds a test address with the consent and purpose of the channel, and no address to another department\'s channel', async () => {
    const m = await fourDepartments();
    const added = await m.post('/api/outbound/contacts', { channelId: m.channelId, kind: 'email', address: 'Max.Test@Acme.example', source: 'Test address of the team', evidence: 'Max\'s own address, for trying the letters' });
    expect(added.statusCode, added.body).toBe(200);
    const permissionId = added.json()['permissionId'] as string;
    const [permission] = await m.c.db.select().from(outboundPermissions).where(eq(outboundPermissions.id, permissionId));
    expect(permission).toMatchObject({ channelId: m.channelId, purpose: 'newsletter', source: 'Test address of the team', status: 'granted' });

    const refused = await m.post('/api/outbound/contacts', { channelId: m.devChannelId, kind: 'email', address: 'dev.test@acme.example', source: 'Test address of the team', evidence: 'Max\'s own address' });
    expect([refused.statusCode, reasonOf(refused)]).toEqual([403, 'outbound_not_allowed']);
    expect(await m.c.db.select().from(outboundPermissions).where(eq(outboundPermissions.channelId, m.devChannelId))).toEqual([]);
  }, 60_000);
});
