import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { companies, departments, jobs, outboundCatalogRevisions, outboundContacts, outboundMessages, outboundPolicies, subscriptions } from '../src/db/schema.js';
import { unsubscribeToken } from '../src/modules/outbound/contacts.js';
import { as, mcp } from './helpers.js';
import { QUIET, world, type World } from './outbound-world.js';

type Tool = { content: { text: string }[]; isError?: boolean };
const JOB_TOKEN = 'outbound-job-token-0123456789abcdef0123456789';

/* A running job of this agent, whose token is all an agent has to go by. */
async function aJob(w: World, agentId: string, token = JOB_TOKEN, status: 'running' | 'done' = 'running') {
  const [sub] = await w.c.db.select().from(subscriptions);
  const finished = status === 'done' ? { finishedAt: new Date() } : {};
  const [job] = await w.c.db.insert(jobs).values({ companyId: w.c.companyId, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status, startedAt: new Date(), toolTokenHash: hashToken(token), ...finished }).returning();
  return job!;
}
const bearer = (token = JOB_TOKEN) => ({ headers: { authorization: `Bearer ${token}` } });
const post = (w: World, url: string, payload: object, token: string) => w.c.app.inject({ method: 'POST', url, payload, ...as(token) });
const CHANNEL = { name: 'Letters', adapter: 'smtp', purpose: 'first_contact', audience: 'direct' };
const aClaim = (text = 'We answer within a day.') => ({ kind: 'claim', locale: 'en', text });

const toolsOf = async (w: World, token = JOB_TOKEN) => mcp(w.c.app, token);
const said = (r: unknown) => JSON.parse((r as Tool).content[0]!.text);

describe('an agent\'s way in', () => {
  it('is the same over MCP and HTTP, whichever name the task goes by', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const key = randomUUID();
    const tools = await toolsOf(w);
    const first = said(await tools.callTool({ name: 'outbound_submit', arguments: w.input({ idempotencyKey: key, task: w.c.task.number }) }));
    expect(first).toMatchObject({ status: 'scheduled' });
    const again = await w.c.app.inject({ method: 'POST', url: '/api/outbound/messages', payload: w.input({ idempotencyKey: key, task: w.c.task.id }), ...bearer() });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first);
    expect(await w.c.db.select().from(outboundMessages)).toHaveLength(1);
    expect((await w.c.db.select().from(outboundMessages))[0]!.authorJobId).toBeTruthy();
  });

  it('refuses without a job\'s token, a person\'s cookie included, and after the job ended', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id, 'finished-token-0123456789abcdef0123456789', 'done');
    const payload = w.input();
    expect((await w.c.app.inject({ method: 'POST', url: '/api/outbound/messages', payload })).statusCode).toBe(401);
    expect((await w.c.app.inject({ method: 'POST', url: '/api/outbound/messages', payload, ...as(w.c.ceoToken) })).statusCode).toBe(401);
    expect((await w.c.app.inject({ method: 'POST', url: '/api/outbound/messages', payload, ...bearer('finished-token-0123456789abcdef0123456789') })).statusCode).toBe(401);
    expect((await w.c.app.inject({ method: 'GET', url: `/api/outbound/messages/${randomUUID()}` })).statusCode).toBe(401);
    expect(await w.c.db.select().from(outboundMessages)).toEqual([]);
  });

  it.each([
    ['words of its own', { text: 'Pay now' }],
    ['a subject of its own', { subject: 'Pay now' }],
    ['a recipient of its own', { recipient: 'someone@else.example' }],
    ['a link of its own', { url: 'https://evil.example' }],
    ['an amount of its own', { amount: '1.00' }],
    ['a header of its own', { headers: { bcc: 'someone@else.example' } }],
    ['a flag that says it may go', { canSend: true }],
    ['another author', { authorAgentId: randomUUID() }],
    ['another company', { companyId: randomUUID() }],
  ])('has no field for %s', async (_name, extra) => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const refused = await w.c.app.inject({ method: 'POST', url: '/api/outbound/messages', payload: { ...w.input(), ...extra }, ...bearer() });
    expect(refused.statusCode).toBe(400);
    expect(await w.c.db.select().from(outboundMessages)).toEqual([]);
  });

  it('has no field in a document for anything but references', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const document = { ...w.document, blocks: [{ kind: 'claim', id: randomUUID(), revision: 1, text: 'Words' }] };
    expect((await w.c.app.inject({ method: 'POST', url: '/api/outbound/messages', payload: { ...w.input(), document }, ...bearer() })).statusCode).toBe(400);
    const tools = await toolsOf(w);
    expect(((await tools.callTool({ name: 'outbound_submit', arguments: { ...w.input(), document } })) as Tool).isError).toBe(true);
  });

  it('says why in codes when refused', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const answer = await w.c.app.inject({ method: 'POST', url: '/api/outbound/messages', payload: w.input({ bindingGeneration: 9 }), ...bearer() });
    expect(answer.statusCode).toBe(409);
    expect(answer.json().error).toMatchObject({ reason: 'outbound_conflict', details: { reasonCodes: ['stale_binding'] } });
    const tools = await toolsOf(w);
    const told = (await tools.callTool({ name: 'outbound_submit', arguments: w.input({ bindingGeneration: 9 }) })) as Tool;
    expect(told.isError).toBe(true);
    expect(told.content[0]!.text).toContain('stale_binding');
  });

  it('reads back through either path, and only for those who may', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    await aJob(w, w.c.seller.id, 'seller-token-0123456789abcdef0123456789');
    const { messageId } = await w.submit();
    const http = await w.c.app.inject({ method: 'GET', url: `/api/outbound/messages/${messageId}`, ...bearer() });
    expect(http.json()).toMatchObject({ messageId, status: 'scheduled' });
    const tools = await toolsOf(w);
    expect(said(await tools.callTool({ name: 'outbound_status', arguments: { messageId } }))).toEqual(http.json());
    expect((await w.c.app.inject({ method: 'GET', url: `/api/outbound/messages/${messageId}`, ...bearer('seller-token-0123456789abcdef0123456789') })).statusCode).toBe(404);
  });

  it.each(['/api/outbound/send', '/api/outbound/smtp', '/api/outbound/webhook', '/api/outbound/dispatch', '/api/outbound/attempts'])('has no way to a transport at %s', async url => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    expect((await w.c.app.inject({ method: 'POST', url, payload: {}, ...bearer() })).statusCode).toBe(404);
  });

  it('gives an agent the gateway\'s tools and no way to send around it', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const names = (await (await toolsOf(w)).listTools()).tools.map(t => t.name);
    expect(names.filter(n => n.startsWith('outbound_')).sort()).toEqual(['outbound_options', 'outbound_propose', 'outbound_status', 'outbound_submit']);
    /* The one tool that sends, and only to people of the agent's own company: send_telegram_file gives a file to an active
       person who connected Telegram and may see both the agent and the file, through the company's own bots, as a reply to
       a person goes there. It takes no outside address, so it is no way around the gateway to anyone outside. */
    const toCompanyPeople = ['send_telegram_file'];
    expect(names.filter(n => /send_|publish|smtp|webhook|mail/.test(n))).toEqual(toCompanyPeople);
  });

  it('shows an author what it may name, and nothing of contacts or accounts beyond that', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const options = said(await (await toolsOf(w)).callTool({ name: 'outbound_options', arguments: {} }));
    expect(options.channels).toMatchObject([{ channelId: w.channel.id, purpose: 'first_contact', audience: 'direct', status: 'active', accounts: [{ accountId: w.account.id, channelId: w.channel.id, available: true, bindingGeneration: 1 }] }]);
    expect(options.catalog.map((e: { entryId: string }) => e.entryId)).toContain(w.template.entryId);
    expect(options.contacts).toEqual([{ contactId: w.contact.id, kind: 'email', channelId: w.channel.id }]);
    const text = JSON.stringify(options);
    for (const secret of ['ann@shop.example', 'configEnc', 'addressEnc', 'addressHash', 'sealed']) expect(text).not.toContain(secret);
  });

  it('shows nothing to an author bound to nothing', async () => {
    const w = await world();
    await aJob(w, w.c.seller.id);
    expect(said(await (await toolsOf(w)).callTool({ name: 'outbound_options', arguments: {} }))).toEqual({ channels: [], catalog: [], contacts: [] });
  });

  it('leaves out what its channel may not use, and contacts who said no', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    await w.c.db.update(outboundCatalogRevisions).set({ status: 'revoked', revokedAt: new Date() }).where(eq(outboundCatalogRevisions.entryId, w.price.entryId));
    await w.c.db.update(outboundContacts).set({ doNotContact: true, suppressedAt: new Date() }).where(eq(outboundContacts.id, w.contact.id));
    const options = said(await (await toolsOf(w)).callTool({ name: 'outbound_options', arguments: {} }));
    expect(options.catalog.map((e: { entryId: string }) => e.entryId)).not.toContain(w.price.entryId);
    expect(options.contacts).toEqual([]);
  });

  it('lets an agent propose words but never publish them: a proposal is not usable', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const tools = await toolsOf(w);
    const proposed = said(await tools.callTool({ name: 'outbound_propose', arguments: { departmentId: w.c.dev.id, value: aClaim() } }));
    expect(proposed).toMatchObject({ revision: 1, status: 'proposed' });
    const [row] = await w.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, proposed.id));
    expect(row).toMatchObject({ createdByKind: 'agent', createdById: w.c.worker.id, publishedBy: null });
    const refused = await w.c.app.inject({ method: 'POST', url: `/api/outbound/catalog/${proposed.id}/publish`, ...bearer() });
    expect(refused.statusCode).toBe(401);
    expect((await w.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, proposed.id)))[0]!.status).toBe('proposed');
    expect((await tools.listTools()).tools.map(t => t.name)).not.toContain('outbound_publish');
  });

  it('refuses a proposal for a department that is not the agent\'s', async () => {
    const w = await world();
    await aJob(w, w.c.worker.id);
    const told = (await (await toolsOf(w)).callTool({ name: 'outbound_propose', arguments: { departmentId: w.c.sales.id, value: aClaim() } })) as Tool;
    expect(told.isError).toBe(true);
  });
});

describe('a channel and its policy', () => {
  it('the CEO and everyone given the department set them up, and nobody else', async () => {
    const w = await world();
    const body = { ...CHANNEL, departmentId: w.c.dev.id };
    expect((await post(w, '/api/outbound/channels', body, w.c.samToken)).statusCode).toBe(403);
    expect((await post(w, '/api/outbound/channels', body, w.c.wholeToken)).statusCode).toBe(403);
    const made = await post(w, '/api/outbound/channels', body, w.c.ceoToken);
    expect(made.statusCode).toBe(200);
    expect(made.json()).toMatchObject({ channelId: expect.any(String), status: 'new', generation: 1 });
    expect((await post(w, '/api/outbound/channels', { ...body, name: 'Theirs' }, w.c.danaToken)).statusCode).toBe(200);
  });

  it('a new channel starts new, whatever it asks for', async () => {
    const w = await world();
    expect((await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: w.c.dev.id, status: 'active' }, w.c.ceoToken)).statusCode).toBe(400);
  });

  it('a channel belongs to a department and maybe its product, and to nothing else', async () => {
    const w = await world();
    expect((await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: randomUUID() }, w.c.ceoToken)).statusCode).toBe(404);
    expect((await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: w.c.product.id }, w.c.ceoToken)).statusCode).toBe(400);
    expect((await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: w.c.sales.id, productId: w.c.product.id }, w.c.ceoToken)).statusCode).toBe(404);
    expect((await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: w.c.dev.id, productId: w.c.product.id }, w.c.ceoToken)).statusCode).toBe(200);
    expect((await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: w.c.dev.id, name: 'Mail' }, w.c.ceoToken)).statusCode).toBe(409);
  });

  it('a policy names all its limits; each change is the next revision', async () => {
    const w = await world();
    const url = `/api/outbound/channels/${w.channel.id}/policies`;
    expect((await post(w, url, { ...QUIET, accountDailyLimit: 0 }, w.c.ceoToken)).statusCode).toBe(400);
    expect((await post(w, url, { timezone: 'Europe/Lisbon' }, w.c.ceoToken)).statusCode).toBe(400);
    expect((await post(w, url, { ...QUIET, timezone: 'Mars/Olympus' }, w.c.ceoToken)).statusCode).toBe(400);
    expect((await post(w, url, QUIET, w.c.samToken)).statusCode).toBe(403);
    const next = await post(w, url, { ...QUIET, accountDailyLimit: 7 }, w.c.ceoToken);
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ revision: 2, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await w.c.db.select().from(outboundPolicies).where(eq(outboundPolicies.channelId, w.channel.id)))).toHaveLength(2);
  });

  it('a person stops it at once, and reopens it when its check holds', async () => {
    const w = await world();
    const stop = `/api/outbound/channels/${w.channel.id}/stop`;
    expect((await post(w, stop, {}, w.c.samToken)).statusCode).toBe(403);
    expect((await post(w, stop, {}, w.c.ceoToken)).json()).toMatchObject({ status: 'stopped', generation: 2 });
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['channel_stopped'] });
    const reopen = `/api/outbound/channels/${w.channel.id}/reopen`;
    expect((await post(w, reopen, {}, w.c.samToken)).statusCode).toBe(403);
    expect((await post(w, reopen, {}, w.c.ceoToken)).statusCode).toBe(409);
  });

  it('knows no channel of another company', async () => {
    const w = await world();
    const [other] = await w.c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [theirs] = await w.c.db.insert(departments).values({ companyId: other!.id, roleCode: 'SAL' }).returning();
    const url = '/api/outbound/channels';
    expect((await post(w, url, { ...CHANNEL, departmentId: theirs!.id }, w.c.ceoToken)).statusCode).toBe(404);
    expect((await post(w, `${url}/${randomUUID()}/policies`, QUIET, w.c.ceoToken)).statusCode).toBe(404);
    expect((await post(w, `${url}/${randomUUID()}/stop`, {}, w.c.ceoToken)).statusCode).toBe(404);
  });
});

describe('the catalog', () => {
  const propose = (w: World, value: object, token: string, extra: object = {}) => post(w, '/api/outbound/catalog', { departmentId: w.c.dev.id, value, ...extra }, token);

  it('takes a revision that only a person publishes, and only the CEO or someone given the department', async () => {
    const w = await world();
    const made = await propose(w, aClaim(), w.c.ceoToken);
    expect(made.statusCode).toBe(200);
    expect(made.json()).toMatchObject({ revision: 1, status: 'proposed' });
    const { id } = made.json();
    expect((await post(w, `/api/outbound/catalog/${id}/publish`, {}, w.c.samToken)).statusCode).toBe(403);
    expect((await post(w, `/api/outbound/catalog/${id}/publish`, {}, w.c.ceoToken)).json()).toMatchObject({ status: 'published' });
    expect((await post(w, `/api/outbound/catalog/${id}/publish`, {}, w.c.ceoToken)).statusCode).toBe(409);
    const [row] = await w.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, id));
    expect(row).toMatchObject({ publishedBy: w.c.ids.ceo, createdByKind: 'person' });
  });

  it('lets the orchestrator publish for the owner, as the owner does', async () => {
    const w = await world();
    const { id } = (await propose(w, aClaim(), w.c.ceoToken)).json();
    const published = await w.c.app.inject({ method: 'POST', url: `/api/outbound/catalog/${id}/publish`, payload: {}, headers: orchestratorHeaders(w.c.ids.ceo, w.c.orchestrator.id) });
    expect(published.json()).toMatchObject({ status: 'published' });
  });

  it('a person takes back what was published; what was only proposed has nothing to take back', async () => {
    const w = await world();
    const { id } = (await propose(w, aClaim(), w.c.ceoToken)).json();
    expect((await post(w, `/api/outbound/catalog/${id}/revoke`, {}, w.c.ceoToken)).statusCode).toBe(409);
    await post(w, `/api/outbound/catalog/${id}/publish`, {}, w.c.ceoToken);
    expect((await post(w, `/api/outbound/catalog/${id}/revoke`, {}, w.c.samToken)).statusCode).toBe(403);
    expect((await post(w, `/api/outbound/catalog/${id}/revoke`, {}, w.c.ceoToken)).json()).toMatchObject({ status: 'revoked' });
  });

  it('the next revision of an entry is of the same kind and place', async () => {
    const w = await world();
    const { entryId } = (await propose(w, aClaim(), w.c.ceoToken)).json();
    const next = await propose(w, aClaim('We answer within an hour.'), w.c.ceoToken, { entryId });
    expect(next.json()).toMatchObject({ entryId, revision: 2 });
    expect((await propose(w, { kind: 'link', url: 'https://shop.example/' }, w.c.ceoToken, { entryId })).statusCode).toBe(409);
    expect((await propose(w, aClaim(), w.c.ceoToken, { entryId, channelId: w.channel.id })).statusCode).toBe(409);
  });

  it.each<[string, object, string]>([
    ['a link in a claim', aClaim('See https://evil.example now'), 'link_unapproved'],
    ['markup in a claim', aClaim('<b>Now</b>'), 'template_unapproved'],
    ['a secret in a claim', aClaim('AKIAABCDEFGHIJKLMNOP'), 'secret_forbidden'],
    ['someone\'s address in a claim', aClaim('Ask ann@shop.example'), 'pii_forbidden'],
    ['a link that leads on', { kind: 'link', url: 'https://shop.example/r?to=https://evil.example' }, 'link_unapproved'],
    ['an audience that leads on', { kind: 'audience', name: 'Blog', destination: 'https://blog.example/r?to=https://evil.example' }, 'link_unapproved'],
    ['a template with a link in its words', { kind: 'template', locale: 'en', subject: null, parts: [{ kind: 'text', text: 'See evil.example now' }] }, 'link_unapproved'],
    ['a template with a link in its subject', { kind: 'template', locale: 'en', subject: 'See evil.example', parts: [{ kind: 'text', text: 'Hello' }] }, 'link_unapproved'],
    ['words for stopping messages with a link', { kind: 'unsubscribe', locale: 'en', text: 'Go to https://evil.example' }, 'link_unapproved'],
    ['terms with markup', { kind: 'terms', locale: 'en', text: '<i>Net 30</i>' }, 'template_unapproved'],
    ['knowledge with a secret', { kind: 'knowledge', locale: 'en', text: 'AKIAABCDEFGHIJKLMNOP' }, 'secret_forbidden'],
  ])('refuses %s, in codes', async (_name, value, code) => {
    const w = await world();
    const refused = await propose(w, value, w.c.ceoToken);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.reasonCodes).toContain(code);
  });

  it.each([
    ['no such kind', { kind: 'html', text: 'Hi' }],
    ['a price with the wrong scale', { kind: 'price', amount: '10.0', currency: 'USD', scale: 2, rounding: 'half_up', discountId: null, termsId: null, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null }],
    ['a link not on https', { kind: 'link', url: 'http://shop.example/' }],
    ['a value with more fields', { kind: 'claim', locale: 'en', text: 'Hi', extra: 1 }],
  ])('refuses %s as invalid', async (_name, value) => {
    const w = await world();
    expect((await propose(w, value, w.c.ceoToken)).statusCode).toBe(400);
  });

  it('a revision takes its time limits from its price, or from what the person says', async () => {
    const w = await world();
    const until = '2036-01-01T00:00:00.000Z';
    const priced = (await propose(w, { kind: 'price', amount: '10.00', currency: 'USD', scale: 2, rounding: 'down', discountId: null, termsId: null, validFrom: '2026-02-01T00:00:00.000Z', validUntil: until }, w.c.ceoToken)).json();
    const [row] = await w.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, priced.id));
    expect(row!.validFrom.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(row!.validUntil!.toISOString()).toBe(until);
    const worded = (await propose(w, aClaim(), w.c.ceoToken, { validFrom: '2026-03-01T00:00:00.000Z', validUntil: until })).json();
    const [other] = await w.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, worded.id));
    expect(other!.validFrom.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('a person with no right over the department proposes nothing, and a channel must be of the department', async () => {
    const w = await world();
    expect((await propose(w, aClaim(), w.c.samToken)).statusCode).toBe(403);
    expect((await propose(w, aClaim(), w.c.ceoToken, { channelId: randomUUID() })).statusCode).toBe(404);
    expect((await propose(w, aClaim(), w.c.ceoToken, { productId: randomUUID() })).statusCode).toBe(404);
  });

  it('knows no revision it was not given', async () => {
    const w = await world();
    expect((await post(w, `/api/outbound/catalog/${randomUUID()}/publish`, {}, w.c.ceoToken)).statusCode).toBe(404);
    expect((await post(w, `/api/outbound/catalog/${randomUUID()}/revoke`, {}, w.c.ceoToken)).statusCode).toBe(404);
  });

  it('what a person publishes through the routes is what a message may use', async () => {
    const w = await world();
    const { entryId, id, revision } = (await propose(w, { kind: 'link', url: 'https://shop.example/other' }, w.c.ceoToken)).json();
    const blocks = w.document.blocks.map(b => (b.kind === 'link' ? { ...b, id: entryId, revision } : b));
    const document = { ...w.document, blocks };
    expect(await w.submit({ document })).toMatchObject({ status: 'rejected', reasonCodes: ['link_unapproved'] });
    await post(w, `/api/outbound/catalog/${id}/publish`, {}, w.c.ceoToken);
    expect((await w.submit({ document })).status).toBe('scheduled');
    await post(w, `/api/outbound/catalog/${id}/revoke`, {}, w.c.ceoToken);
    expect(await w.submit({ document })).toMatchObject({ status: 'rejected', reasonCodes: ['link_unapproved'] });
  });
});

describe('contacts', () => {
  const NEW = (w: World) => ({ channelId: w.channel.id, kind: 'email', address: 'bob@shop.example', source: 'form', evidence: 'form 12' });

  it('are added by the CEO or someone given the department for a channel, and the address never comes back', async () => {
    const w = await world();
    expect((await post(w, '/api/outbound/contacts', NEW(w), w.c.samToken)).statusCode).toBe(403);
    expect((await post(w, '/api/outbound/contacts', { ...NEW(w), address: 'cy@shop.example' }, w.c.danaToken)).statusCode).toBe(200);
    const added = await post(w, '/api/outbound/contacts', NEW(w), w.c.ceoToken);
    expect(added.statusCode).toBe(200);
    expect(added.body).not.toContain('bob@');
    expect(added.json()).toMatchObject({ contactId: expect.any(String), permissionId: expect.any(String) });
    expect((await w.submit({ target: { kind: 'contact', contactId: added.json().contactId } })).status).toBe('scheduled');
  });

  it('a channel unknown is refused', async () => {
    const w = await world();
    expect((await post(w, '/api/outbound/contacts', { ...NEW(w), channelId: randomUUID() }, w.c.ceoToken)).statusCode).toBe(404);
  });

  it('a person marks do not contact, for good', async () => {
    const w = await world();
    const url = `/api/outbound/contacts/${w.contact.id}/suppress`;
    expect((await post(w, url, { evidence: 'by phone' }, w.c.wholeToken)).statusCode).toBe(403);
    expect((await post(w, url, { evidence: 'by phone' }, w.c.ceoToken)).statusCode).toBe(200);
    expect((await w.submit()).reasonCodes).toEqual(['contact_suppressed']);
    expect((await post(w, `/api/outbound/contacts/${randomUUID()}/suppress`, { evidence: 'by phone' }, w.c.ceoToken)).statusCode).toBe(404);
  });

  it('an owner of the department marks it too', async () => {
    const w = await world();
    await w.c.setOwner(w.c.ceoToken, w.c.dev.id, w.c.ids.dana);
    expect((await post(w, `/api/outbound/contacts/${w.contact.id}/suppress`, { evidence: 'by phone' }, w.c.danaToken)).statusCode).toBe(200);
  });

  it('a permission is taken back through the department it belongs to', async () => {
    const w = await world();
    const url = `/api/outbound/permissions/${w.permission.id}/revoke`;
    expect((await post(w, url, {}, w.c.samToken)).statusCode).toBe(403);
    expect((await post(w, url, {}, w.c.ceoToken)).statusCode).toBe(200);
    expect((await w.submit()).reasonCodes).toEqual(['consent_missing']);
    expect((await post(w, `/api/outbound/permissions/${randomUUID()}/revoke`, {}, w.c.ceoToken)).statusCode).toBe(404);
  });
});

describe('the page for stopping messages', () => {
  const tokenOf = (w: World) => unsubscribeToken(w.ctx.config.secret, { companyId: w.c.companyId, contactId: w.contact.id, channelId: w.channel.id, purpose: 'first_contact' });
  const suppressed = async (w: World) => (await w.c.db.select().from(outboundContacts).where(eq(outboundContacts.id, w.contact.id)))[0]!.doNotContact;

  it('asks first, in two languages, and looking at it changes nothing, as mail programs look at every link', async () => {
    const w = await world();
    const page = await w.c.app.inject({ method: 'GET', url: `/api/outbound/unsubscribe/${tokenOf(w)}` });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<form method="post">');
    expect(page.body).toContain('Stop these messages');
    expect(page.body).toContain('Больше не присылать');
    expect(page.body).not.toContain('ann@');
    expect(await suppressed(w)).toBe(false);
  });

  it('stops them when the person says so', async () => {
    const w = await world();
    const done = await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${tokenOf(w)}` });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('You will get no more messages');
    expect(done.body).toContain('Сообщений больше не будет');
    expect(await suppressed(w)).toBe(true);
  });

  it('takes what a browser and a mail program really send', async () => {
    const w = await world();
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    /* The page asks for no referrer, so a browser names no site for its form: "null". */
    const fromPage = await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${tokenOf(w)}`, headers: { ...form, origin: 'null' }, payload: '' });
    expect(fromPage.statusCode).toBe(200);
    expect(await suppressed(w)).toBe(true);
    const oneClick = await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${tokenOf(w)}`, headers: form, payload: 'List-Unsubscribe=One-Click' });
    expect(oneClick.statusCode).toBe(200);
    const asParts = await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${tokenOf(w)}`, headers: { 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--x--\r\n' });
    expect(asParts.statusCode).toBe(200);
  });

  it('still refuses a page of another site, and a page that names none anywhere else', async () => {
    const w = await world();
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    const foreign = await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${tokenOf(w)}`, headers: { ...form, origin: 'https://other.example' }, payload: '' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.reason).toBe('cross_site');
    expect(await suppressed(w)).toBe(false);
    const elsewhere = await w.c.app.inject({ method: 'POST', url: `/api/outbound/contacts/${w.contact.id}/suppress`, ...as(w.c.ceoToken), headers: { origin: 'null' }, payload: { evidence: 'said so' } });
    expect(elsewhere.statusCode).toBe(403);
    expect(elsewhere.json().error.reason).toBe('cross_site');
    expect(await suppressed(w)).toBe(false);
  });

  it('keeps its address to itself and stays out of frames', async () => {
    const w = await world();
    const page = await w.c.app.inject({ method: 'GET', url: `/api/outbound/unsubscribe/${tokenOf(w)}` });
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('knows no forged link either way, and says nothing about whom it would be for', async () => {
    const w = await world();
    const forged = `${tokenOf(w).split('.')[0]}.AAAA`;
    expect((await w.c.app.inject({ method: 'GET', url: `/api/outbound/unsubscribe/${forged}` })).statusCode).toBe(404);
    expect((await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${forged}` })).statusCode).toBe(404);
    expect(await suppressed(w)).toBe(false);
  });

  it('a link whose contact is gone from this company does nothing', async () => {
    const w = await world();
    const stranger = unsubscribeToken(w.ctx.config.secret, { companyId: randomUUID(), contactId: w.contact.id, channelId: w.channel.id, purpose: 'first_contact' });
    expect((await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${stranger}` })).statusCode).toBe(404);
    expect(await suppressed(w)).toBe(false);
  });

  it('is not moved from another site\'s page', async () => {
    const w = await world();
    const refused = await w.c.app.inject({ method: 'POST', url: `/api/outbound/unsubscribe/${tokenOf(w)}`, headers: { origin: 'https://evil.example' } });
    expect(refused.statusCode).toBe(403);
    expect(await suppressed(w)).toBe(false);
  });
});

describe('what the orchestrator may do for a person', () => {
  const control = async (w: World, createdBy: string | null) => w.c.tools(w.c.orchestrator, createdBy);

  it('what the owner may, as the owner, in a turn that answers nobody', async () => {
    const w = await world();
    const tools = await control(w, null);
    expect(said(await tools.callTool({ name: 'outbound_channel_stop', arguments: { channel: w.channel.id } }))).toMatchObject({ status: 'stopped' });
  });

  it('what that person may, as that person', async () => {
    const w = await world();
    const tools = await control(w, w.c.ids.ceo);
    const made = said(await tools.callTool({ name: 'outbound_channel_create', arguments: { department: w.c.dev.id, name: 'Letters', adapter: 'smtp', purpose: 'first_contact', audience: 'direct' } }));
    expect(made).toMatchObject({ status: 'new', generation: 1 });
    expect(said(await tools.callTool({ name: 'outbound_policy_set', arguments: { channel: made.channelId, value: QUIET } }))).toMatchObject({ revision: 1 });
    expect((await w.c.db.select().from(outboundPolicies).where(eq(outboundPolicies.channelId, made.channelId)))[0]!.createdBy).toBe(w.c.ids.ceo);
    expect(said(await tools.callTool({ name: 'outbound_channel_stop', arguments: { channel: w.channel.id } }))).toMatchObject({ status: 'stopped', generation: 2 });
    const told = (await tools.callTool({ name: 'outbound_channel_reopen', arguments: { channel: w.channel.id } })) as Tool;
    expect(told.isError).toBe(true);
    expect(told.content[0]!.text).toContain('not certified');
    expect((await tools.callTool({ name: 'outbound_contact_suppress', arguments: { contact: w.contact.id, evidence: 'by phone' } }) as Tool).isError).toBeUndefined();
    expect((await w.c.db.select().from(outboundContacts).where(eq(outboundContacts.id, w.contact.id)))[0]!.doNotContact).toBe(true);
  });

  it('what the owner may, as the owner, for a person who may not', async () => {
    const w = await world();
    expect(said(await (await control(w, w.c.ids.sam)).callTool({ name: 'outbound_channel_stop', arguments: { channel: w.channel.id } }))).toMatchObject({ status: 'stopped' });
  });

  it('has no tool that publishes, adds a contact\'s address or reads one, and connects an account only with settings the company has', async () => {
    const w = await world();
    const names = (await (await control(w, null)).listTools()).tools.map(t => t.name).filter(n => n.startsWith('outbound_')).sort();
    expect(names).toEqual(['outbound_account_add', 'outbound_account_bind', 'outbound_channel_create', 'outbound_channel_reopen', 'outbound_channel_stop', 'outbound_contact_suppress', 'outbound_options', 'outbound_policy_set', 'outbound_propose', 'outbound_status', 'outbound_submit']);
  });
});

describe('removing a department', () => {
  const anEmptyOne = async (w: World) => (await w.c.db.insert(departments).values({ companyId: w.c.companyId, name: 'Empty', roleCode: 'SAL', position: 9 }).returning())[0]!;
  const remove = (w: World, department: string) => w.c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ department, note: '', remove: true }] }, ...as(w.c.ceoToken) });
  const aRefusal = (answer: { statusCode: number; json: () => { error: { reason: string; message: string } } }) => {
    expect(answer.statusCode).toBe(400);
    expect(answer.json().error.reason).toBe('structure_invalid');
    expect(answer.json().error.message).toContain('outbound');
  };

  it('goes through when it holds nothing of the gateway', async () => {
    const w = await world();
    expect((await remove(w, (await anEmptyOne(w)).id)).statusCode).toBe(201);
  });

  it('is refused while it has a channel, whose history stays', async () => {
    const w = await world();
    const empty = await anEmptyOne(w);
    await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: empty.id }, w.c.ceoToken);
    aRefusal(await remove(w, empty.id));
    expect(await w.c.db.select().from(departments).where(eq(departments.id, empty.id))).toHaveLength(1);
  });

  it('is refused while it has words in the catalog', async () => {
    const w = await world();
    const empty = await anEmptyOne(w);
    await post(w, '/api/outbound/catalog', { departmentId: empty.id, value: aClaim() }, w.c.ceoToken);
    aRefusal(await remove(w, empty.id));
  });

  it('is refused for what a product of it holds', async () => {
    const w = await world();
    const empty = await anEmptyOne(w);
    const [product] = await w.c.db.insert(departments).values({ companyId: w.c.companyId, name: 'Inside', roleCode: 'SAL', parentId: empty.id, position: 10 }).returning();
    await post(w, '/api/outbound/channels', { ...CHANNEL, departmentId: empty.id, productId: product!.id }, w.c.ceoToken);
    aRefusal(await remove(w, empty.id));
    aRefusal(await remove(w, product!.id));
  });
});
