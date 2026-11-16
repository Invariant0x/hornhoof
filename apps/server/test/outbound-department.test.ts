import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OutboundPolicyValue } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorDecisionHeaders } from '../src/auth/internal.js';
import { agents, departments, jobs, modelChecks, outboundCatalogRevisions, outboundMessages, outboundPolicies, people, requests } from '../src/db/schema.js';
import { recordReview, reserveDispatch } from '../src/modules/outbound/core.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { company } from './department-owner-fixture.js';
import { appFixture, as, invitePerson } from './helpers.js';
import { sha } from './outbound-fixture.js';
import { PASSWORD } from './outbound-receivers.js';
import { QUIET, reviewReceipt } from './outbound-world.js';

/* A department runs its own messages: a person who runs Marketing, who is not the CEO, connects its mail account on their
   screen, and its head does the rest with its own tools, as that person, with no orchestrator and no CEO. Nothing of
   another department is reached, and no setting comes back to anyone. Everything is synthetic. */

type Res = { content: { type: string; text: string }[]; isError?: boolean };
type Answer = { statusCode: number; body: string; json(): Record<string, unknown> & { error?: { reason?: string } } };
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const ok = (r: Res) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r).split('\n')[0]!) as Record<string, unknown> & { id: string; channelId: string; entryId: string };
};
const refused = (r: Res) => {
  expect(r.isError, text(r)).toBe(true);
  return text(r);
};

const SMTP = { host: 'smtp.mkt.example', port: 465, security: 'tls', username: 'letters@mkt.example', password: PASSWORD, from: 'letters@mkt.example' };
const AUTO: OutboundPolicyValue = { ...QUIET, accountDailyLimit: 2, autoSend: true };
const LETTERS = { name: 'Letters', adapter: 'smtp', purpose: 'first_contact', audience: 'direct' };
const WHERE = 'in Settings under External messaging, or on the department\'s screen under About the department';

/* The company of department-owner-fixture.ts with Marketing beside it: Mia its head, Max its writer on a task, and Mona,
   given Marketing alone and named its owner. Development has a working channel of its own, with a secret. */
async function marketing() {
  const c = await company({ PUBLIC_URL: 'https://hornhoof.example' });
  const made = await appFixture(c.app, 'outbound department marketing', async () => {
    const [mkt] = await c.db.insert(departments).values({ companyId: c.companyId, templateKey: 'marketing', roleCode: 'MKT', position: 4 }).returning();
    const [sub] = await c.db.select({ id: agents.subscriptionId }).from(agents).where(eq(agents.id, c.head.id));
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) => (await c.db.insert(agents).values({ companyId: c.companyId, kind, name, roleKey, departmentId: mkt!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const head = await hire('Mia', 'head', 'MKT-HEAD');
    const writer = await hire('Max', 'worker', 'MKT-WRITE');
    const monaToken = await invitePerson(c.app, c.ceoToken, { name: 'Mona', email: 'mona@acme.com', access: { departments: [mkt!.id] } });
    const [mona] = await c.db.select({ id: people.id }).from(people).where(eq(people.email, 'mona@acme.com'));
    await c.setOwner(c.ceoToken, mkt!.id, mona!.id);
    const task = (await createTask(c.app.ctx, { agentId: head.id }, { title: 'Spring letters', brief: '', body: '', departmentId: mkt!.id, assigneeAgentId: writer.id, executor: true })).task;
    const devChannel = (await c.app.inject({ method: 'POST', url: '/api/outbound/channels', payload: { departmentId: c.dev.id, ...LETTERS }, ...as(c.ceoToken) })).json() as { channelId: string };
    const devAccount = (await c.app.inject({ method: 'POST', url: '/api/outbound/accounts', payload: { channelId: devChannel.channelId, label: 'Dev mail', config: { ...SMTP, host: 'smtp.dev.example', from: 'dev@dev.example' } }, ...as(c.ceoToken) })).json() as { accountId: string };
    const devRevision = (await c.app.inject({ method: 'POST', url: '/api/outbound/catalog', payload: { departmentId: c.dev.id, value: { kind: 'claim', locale: 'en', text: 'We answer within a day.' } }, ...as(c.ceoToken) })).json() as { id: string };
    return { mkt: mkt!, head, writer, monaToken, monaId: mona!.id, task, devChannelId: devChannel.channelId, devAccountId: devAccount.accountId, devRevisionId: devRevision.id };
  });
  const get = (url: string, token = made.monaToken): Promise<Answer> => c.app.inject({ method: 'GET', url, ...as(token) });
  const post = (url: string, payload: object, token = made.monaToken): Promise<Answer> => c.app.inject({ method: 'POST', url, payload, ...as(token) });
  return { c, ...made, get, post };
}
type M = Awaited<ReturnType<typeof marketing>>;

/* The department's review check as certified now, which only a passed run does in real life. */
async function aCheckOf(m: M) {
  const bindingDigest = sha('marketing binding');
  const [check] = await m.c.db.insert(modelChecks).values({ companyId: m.c.companyId, departmentId: m.mkt.id, kind: 'outbound_review', status: 'on', bindingDigest, validUntil: new Date('2036-01-01T00:00:00.000Z'), thresholds: { falseAllows: 0, falseDenies: 0, classErrors: 0 } as never, thresholdsBy: m.c.ids.ceo }).returning();
  return { checkId: check!.id, bindingDigest };
}

/* The head's way out, set up by its head and Mona: channel, account, policy, author and published words. */
async function lettersOf(m: M, policy: OutboundPolicyValue = AUTO) {
  const mia = await m.c.tools(m.head);
  const channelId = ok(await call(mia, 'outbound_channel_create', LETTERS)).channelId;
  const account = await m.post('/api/outbound/accounts', { channelId, label: 'Spring', config: SMTP });
  expect(account.statusCode, account.body).toBe(200);
  const accountId = account.json()['accountId'] as string;
  ok(await call(mia, 'outbound_policy_set', { channel: channelId, value: policy }));
  ok(await call(mia, 'outbound_account_author', { account: accountId, employee: m.writer.id }));
  const max = await m.c.tools(m.writer);
  const propose = async (value: object) => ok(await call(max, 'outbound_propose', { departmentId: m.mkt.id, value }));
  const unsubscribeSlot = randomUUID();
  const template = await propose({ kind: 'template', locale: 'en', subject: 'Spring', parts: [{ kind: 'text', text: 'Hello from the spring sale. ' }, { kind: 'slot', slotId: unsubscribeSlot, type: 'unsubscribe' }] });
  const stop = await propose({ kind: 'unsubscribe', locale: 'en', text: 'To stop these letters:' });
  const segment = await propose({ kind: 'segment', name: 'Shops' });
  return { mia, max, channelId, accountId, template, stop, segment };
}

type Letters = Awaited<ReturnType<typeof lettersOf>>;

const publishAll = async (l: Letters) => {
  for (const revision of [l.template, l.stop, l.segment]) ok(await call(l.mia, 'outbound_publish', { revision: revision.id }));
};

async function aContact(m: M, channelId: string, n: number): Promise<string> {
  const added = await m.post('/api/outbound/contacts', { channelId, kind: 'email', address: `shop${n}@shop.example`, source: 'form', evidence: `form ${n}` });
  expect(added.statusCode, added.body).toBe(200);
  return added.json()['contactId'] as string;
}

const submit = async (m: M, l: Letters, contactId: string) =>
  ok(await call(l.max, 'outbound_submit', {
    task: m.task.number, idempotencyKey: randomUUID(), channelId: l.channelId, accountId: l.accountId, bindingGeneration: 1, target: { kind: 'contact', contactId }, segmentId: l.segment.entryId,
    document: { locale: 'en', templateId: l.template.entryId, templateRevision: 1, blocks: [], variables: [] }, scheduledAt: '2026-01-02T00:00:00.000Z',
  })) as unknown as { messageId: string; contentDigest: string; status: string; reasonCodes: string[] };

const messageOf = async (m: M, id: string) => (await m.c.db.select().from(outboundMessages).where(eq(outboundMessages.id, id)))[0]!;

describe('Marketing runs its own messages, without the orchestrator or the CEO', () => {
  it('its owner connects the account, its head makes the channel, turns autoSend on and publishes the words, and messages go within the limit with no person asked', async () => {
    const m = await marketing();
    const before = await m.c.tools(m.head, m.monaId);
    expect(text(await call(before, 'outbound_setup'))).toContain(WHERE);
    const l = await lettersOf(m);
    const catalog = JSON.parse(text(await call(l.mia, 'outbound_catalog'))) as { current: number | null; revisions: { status: string }[] }[];
    expect(catalog.map(e => [e.current, e.revisions[0]!.status])).toEqual([[null, 'proposed'], [null, 'proposed'], [null, 'proposed']]);
    await publishAll(l);
    const check = await aCheckOf(m);
    const contacts = [await aContact(m, l.channelId, 1), await aContact(m, l.channelId, 2), await aContact(m, l.channelId, 3)];
    const asked = await m.c.db.select().from(requests);
    const sent: string[] = [];
    for (const contactId of contacts) {
      const { messageId, contentDigest, status } = await submit(m, l, contactId);
      expect(status).toBe('waiting_checks');
      await recordReview(m.c.app.ctx, reviewReceipt(messageId, contentDigest, 'allow', check.checkId, check.bindingDigest));
      expect(await messageOf(m, messageId)).toMatchObject({ status: 'scheduled', reasonCodes: [] });
      sent.push(messageId);
    }
    expect(await m.c.db.select().from(requests)).toEqual(asked);
    const dispatched = [];
    for (const id of sent) dispatched.push(await reserveDispatch(m.c.app.ctx, id, 1));
    expect(dispatched.map(d => d.kind === 'reserved' ? 'reserved' : d.reasonCodes)).toEqual(['reserved', 'reserved', ['daily_limit_exceeded']]);
    const orchestratorJobs = await m.c.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.agentId, m.c.orchestrator.id));
    expect(orchestratorJobs).toEqual([]);
  }, 60_000);

  it('keeps in the department\'s log who did each step and on whose word, which its owner reads, and which revisions its head published', async () => {
    const m = await marketing();
    const l = await lettersOf(m);
    await publishAll(l);
    ok(await call(l.mia, 'outbound_policy_set', { channel: l.channelId, value: { ...AUTO, autoSend: false } }));
    const log = await m.get(`/api/outbound/setup-log?department=${m.mkt.id}`);
    expect(log.statusCode, log.body).toBe(200);
    type Entry = { kind: string; person: { name: string }; agent: { name: string } | null; detail: Record<string, unknown> };
    const entries = (log.json()['entries'] as Entry[]).reverse().map(e => [e.kind, e.person.name, e.agent?.name ?? null]);
    expect(entries).toEqual([
      ['channel_created', 'Mona', 'Mia'], ['account_set_up', 'Mona', null], ['auto_send_on', 'Mona', 'Mia'], ['account_bound', 'Mona', 'Mia'],
      ['catalog_published', 'Mona', 'Mia'], ['catalog_published', 'Mona', 'Mia'], ['catalog_published', 'Mona', 'Mia'], ['auto_send_off', 'Mona', 'Mia'],
    ]);
    expect(log.body).not.toContain(PASSWORD);
    expect(log.body).not.toContain('smtp.mkt.example');
    const catalog = await m.get(`/api/outbound/catalog?department=${m.mkt.id}`);
    expect(catalog.statusCode, catalog.body).toBe(200);
    type Entry2 = { kind: string; current: number | null; revisions: { status: string; publishedBy: { name: string } | null; publishedVia: { name: string } | null; createdBy: { kind: string; name: string } }[] };
    const shown = (catalog.json()['entries'] as Entry2[]).map(e => ({ kind: e.kind, current: e.current, ...e.revisions[0]! }));
    expect(shown.map(e => e.kind).sort()).toEqual(['segment', 'template', 'unsubscribe']);
    for (const e of shown) expect(e).toMatchObject({ current: 1, status: 'published', publishedBy: { name: 'Mona' }, publishedVia: { name: 'Mia' }, createdBy: { kind: 'agent', name: 'Max' } });
    const overview = await m.get(`/api/outbound?department=${m.mkt.id}`);
    expect(overview.json()['channels']).toMatchObject([{ id: l.channelId, canManage: true, policy: { revision: 2, value: { autoSend: false, accountDailyLimit: 2 } }, accounts: [{ id: l.accountId, author: { agentId: m.writer.id, name: 'Max' } }] }]);
    expect(overview.body).not.toContain(PASSWORD);
    const wes = await m.get('/api/outbound', m.c.wholeToken);
    expect((wes.json()['channels'] as { id: string; canManage: boolean }[]).find(ch => ch.id === l.channelId)).toMatchObject({ canManage: false });
  });

  it('without autoSend a message waits for a person, and once its head turns it on the message goes', async () => {
    const m = await marketing();
    const l = await lettersOf(m, { ...AUTO, autoSend: false });
    await publishAll(l);
    const check = await aCheckOf(m);
    const { messageId, contentDigest } = await submit(m, l, await aContact(m, l.channelId, 1));
    await recordReview(m.c.app.ctx, reviewReceipt(messageId, contentDigest, 'allow', check.checkId, check.bindingDigest));
    expect(await messageOf(m, messageId)).toMatchObject({ status: 'waiting_approval', reasonCodes: ['approval_required'] });
    ok(await call(l.mia, 'outbound_policy_set', { channel: l.channelId, value: AUTO }));
    expect(await reserveDispatch(m.c.app.ctx, messageId, 1)).toMatchObject({ kind: 'reserved' });
  });

  it('a revision its head published goes back with its head\'s outbound_revoke, and a stopped channel takes nothing', async () => {
    const m = await marketing();
    const l = await lettersOf(m);
    await publishAll(l);
    ok(await call(l.mia, 'outbound_revoke', { revision: l.template.id }));
    expect((await m.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, l.template.id)))[0]!.status).toBe('revoked');
    ok(await call(l.mia, 'outbound_channel_stop', { channel: l.channelId }));
    const message = await submit(m, l, await aContact(m, l.channelId, 1));
    expect(message).toMatchObject({ status: 'rejected', reasonCodes: ['channel_stopped'] });
  });
});

describe('a department reaches nothing of another one', () => {
  it('Marketing\'s owner neither reads nor changes Development\'s channels, accounts, catalog or log', async () => {
    const m = await marketing();
    for (const url of [`/api/outbound/catalog?department=${m.c.dev.id}`, `/api/outbound/setup-log?department=${m.c.dev.id}`, `/api/outbound/channels/${m.devChannelId}/accounts`]) {
      const answer = await m.get(url);
      expect(answer.statusCode, url).toBe(403);
      expect(answer.body).not.toContain(PASSWORD);
    }
    expect((await m.get(`/api/outbound?department=${m.c.dev.id}`)).statusCode).toBe(404);
    for (const [url, payload] of [
      [`/api/outbound/channels/${m.devChannelId}/policies`, AUTO], [`/api/outbound/channels/${m.devChannelId}/stop`, {}], [`/api/outbound/catalog/${m.devRevisionId}/publish`, {}],
      [`/api/outbound/accounts/${m.devAccountId}/bind`, { agentId: m.writer.id }], [`/api/outbound/accounts/${m.devAccountId}/revoke`, {}], [`/api/outbound/accounts/${m.devAccountId}/rotate`, { config: SMTP }],
    ] as const) expect((await m.post(url, payload)).statusCode, url).toBe(403);
    const mine = await m.get('/api/outbound');
    expect(mine.body).not.toContain(m.devChannelId);
    expect(mine.body).not.toContain(PASSWORD);
    expect((await m.c.db.select().from(outboundPolicies).where(eq(outboundPolicies.channelId, m.devChannelId)))).toEqual([]);
    expect((await m.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, m.devRevisionId)))[0]!.status).toBe('proposed');
  });

  it('Marketing\'s head, even on the CEO\'s word, is told of Development\'s channel, account and revision what it is told of nothing', async () => {
    const m = await marketing();
    const mia = await m.c.tools(m.head, m.c.ids.ceo);
    const pairs: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['outbound_policy_set', { channel: m.devChannelId, value: AUTO }, { channel: randomUUID(), value: AUTO }],
      ['outbound_channel_stop', { channel: m.devChannelId }, { channel: randomUUID() }],
      ['outbound_publish', { revision: m.devRevisionId }, { revision: randomUUID() }],
      ['outbound_revoke', { revision: m.devRevisionId }, { revision: randomUUID() }],
      ['outbound_account_author', { account: m.devAccountId, employee: m.head.id }, { account: randomUUID(), employee: m.head.id }],
      ['outbound_account_revoke', { account: m.devAccountId }, { account: randomUUID() }],
    ];
    for (const [name, theirs, nothing] of pairs) expect(refused(await call(mia, name, theirs)), name).toBe(refused(await call(mia, name, nothing)));
    const seen = `${text(await call(mia, 'outbound_setup'))}${text(await call(mia, 'outbound_catalog'))}`;
    for (const id of [m.devChannelId, m.devAccountId, m.devRevisionId, PASSWORD, 'smtp.dev.example']) expect(seen).not.toContain(id);
    expect((await m.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, m.devRevisionId)))[0]!.status).toBe('proposed');
  });

  it('a route called through a head answers for another department as for nothing at all', async () => {
    const m = await marketing();
    const [job] = await m.c.db.insert(jobs).values({ companyId: m.c.companyId, subscriptionId: m.head.subscriptionId!, agentId: m.head.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), createdBy: m.c.ids.ceo, answersCeo: true }).returning();
    const headers = orchestratorDecisionHeaders({ personId: m.c.ids.ceo, agentId: m.head.id, jobId: job!.id, sourceSeq: null });
    const through = (url: string, payload: object = {}) => m.c.app.inject({ method: 'POST', url, payload, headers });
    const answers = async (url: string, nothing: string) => {
      const [theirs, none] = [await through(url), await through(nothing)];
      expect([theirs.statusCode, theirs.json().error]).toEqual([none.statusCode, none.json().error]);
      expect(theirs.statusCode).toBe(404);
    };
    await answers(`/api/outbound/catalog/${m.devRevisionId}/publish`, `/api/outbound/catalog/${randomUUID()}/publish`);
    await answers(`/api/outbound/channels/${m.devChannelId}/stop`, `/api/outbound/channels/${randomUUID()}/stop`);
    await answers(`/api/outbound/accounts/${m.devAccountId}/release`, `/api/outbound/accounts/${randomUUID()}/release`);
    const catalog = await m.c.app.inject({ method: 'GET', url: `/api/outbound/catalog?department=${m.c.dev.id}`, headers });
    expect(catalog.statusCode).toBe(404);
    const made = await through('/api/outbound/channels', { departmentId: m.c.dev.id, ...LETTERS, name: 'Theirs' });
    expect(made.statusCode).toBe(404);
  });

  it('an agent of another department publishes nothing of this one, and a worker has no tool for it', async () => {
    const m = await marketing();
    const l = await lettersOf(m);
    const sue = await m.c.tools(m.c.salesHead, m.c.ids.ceo);
    refused(await call(sue, 'outbound_publish', { revision: l.template.id }));
    const worker = (await (await m.c.tools(m.writer)).listTools()).tools.map(t => t.name);
    for (const name of ['outbound_publish', 'outbound_revoke', 'outbound_policy_set', 'outbound_account_author']) expect(worker, name).not.toContain(name);
    expect((await m.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, l.template.id)))[0]!.status).toBe('published');
  });
});

describe('a head and an account\'s secrets', () => {
  it('never takes a setting: an account is connected or changed only by a person on their screen', async () => {
    const m = await marketing();
    const l = await lettersOf(m);
    const [job] = await m.c.db.insert(jobs).values({ companyId: m.c.companyId, subscriptionId: m.head.subscriptionId!, agentId: m.head.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), createdBy: m.monaId }).returning();
    const headers = orchestratorDecisionHeaders({ personId: m.monaId, agentId: m.head.id, jobId: job!.id, sourceSeq: null });
    for (const [url, payload] of [['/api/outbound/accounts', { channelId: l.channelId, label: 'Other', config: SMTP }], [`/api/outbound/accounts/${l.accountId}/rotate`, { config: SMTP }]] as const) {
      expect((await m.c.app.inject({ method: 'POST', url, payload, headers })).statusCode, url).toBe(403);
    }
    const names = (await l.mia.listTools()).tools.map(t => t.name);
    expect(names.filter(n => /smtp|password|secret|setup_account|account_set/.test(n))).toEqual([]);
    const seen = text(await call(l.mia, 'outbound_setup'));
    for (const secret of [PASSWORD, 'smtp.mkt.example', 'letters@mkt.example', 'configEnc']) expect(seen).not.toContain(secret);
    expect(JSON.parse(seen).channels[0].accounts[0]).toMatchObject({ label: 'Spring', status: 'active', author: { agentId: m.writer.id, name: 'Max' } });
  });

  it('publishes on its own authority without a fresh word from a person', async () => {
    const m = await marketing();
    const l = await lettersOf(m);
    const alone = await m.c.tools(m.head, null);
    ok(await call(alone, 'outbound_publish', { revision: l.template.id }));
    expect((await m.c.db.select().from(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, l.template.id)))[0]!.status).toBe('published');
  });

  it('uses its own department owner when a person from another department writes', async () => {
    const m = await marketing();
    const l = await lettersOf(m);
    const onSams = await m.c.tools(m.head, m.c.ids.sam);
    ok(await call(onSams, 'outbound_publish', { revision: l.template.id }));
  });
});
