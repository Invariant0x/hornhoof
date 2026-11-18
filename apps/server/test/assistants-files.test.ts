import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, assistants, attachments, companies, jobs, requests, subscriptions, tasks } from '../src/db/schema.js';
import { disposition, fileLink } from '../src/modules/assistants/files.js';
import { callSkill } from '../src/modules/assistants/skills.js';
import { WORDS } from '../src/modules/assistants/words.js';
import { signedToken } from '../src/crypto/tokens.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-16T14:00:00Z'));
});
afterEach(() => vi.useRealTimers());

/* Real API calls with an owner's key, without running an assistant program. */
async function assistant(c: AclCompany, owner: keyof AclCompany['tokens'] = 'ann') {
  const added = await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name: `Ava of ${owner}`, owner: c.ids[owner], program: 'avaclone' }, ...as(c.tokens[owner]) });
  expect(added.statusCode).toBe(201);
  const id = added.json().person.id as string;
  const keyed = await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(c.tokens[owner]) });
  expect(keyed.statusCode).toBe(201);
  const key = keyed.json().key as string;
  return { id, download: (file: string, lang?: string) => c.app.inject({ url: `/api/assistant/attachments/${file}`, headers: { authorization: `Bearer ${key}`, ...(lang ? { 'accept-language': lang } : {}) } }) };
}

const BYTES = Buffer.from([0x50, 0x4b, 0, 0xff, 0x80, 0x0a, 0x0d]);
async function file(c: AclCompany, values: Partial<typeof attachments.$inferInsert> = {}) {
  return (await c.db.insert(attachments).values({ companyId: c.companyId, agentId: c.crew.mine.id, name: 'report.xlsx', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: BYTES, size: BYTES.length, ...values }).returning())[0]!;
}

describe('files an assistant downloads for its owner', () => {
  it.each([
    ['report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['report.pdf', 'application/pdf'],
  ])('downloads %s from another agent on a task its owner sees, with its bytes, type and name', async (name, mediaType) => {
    const c = await aclCompany();
    const ava = await assistant(c);
    const task = await c.work('Report', c.crew.mine);
    const kept = await file(c, { taskId: task.id, name, mediaType });
    const owner = await c.get(`/api/attachments/${kept.id}`, c.tokens.ann);
    expect(owner.statusCode).toBe(200);
    const got = await ava.download(kept.id);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload).toEqual(BYTES);
    expect(got.headers).toMatchObject({ 'content-type': mediaType, 'content-length': String(BYTES.length), 'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${name}`, 'x-content-type-options': 'nosniff' });
  });

  it('uses the same visibility for files in an agent chat, a person message and a request', async () => {
    const c = await aclCompany();
    const ava = await assistant(c, 'ceo');
    const task = await c.work('Choose report', c.crew.mine);
    const [request] = await c.db.insert(requests).values({ companyId: c.companyId, taskId: task.id, agentId: c.crew.mine.id, kind: 'question', text: 'Which report?', status: 'answered' }).returning();
    const kept = [await file(c), await file(c, { personId: c.ids.ann }), await file(c, { requestId: request!.id, name: null, mediaType: 'image/png' })];
    for (const row of kept) {
      expect((await c.get(`/api/attachments/${row.id}`, c.tokens.ceo)).statusCode).toBe(200);
      const got = await ava.download(row.id);
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload).toEqual(BYTES);
      expect(got.headers['content-type']).toBe(row.mediaType);
    }
  });

  it('checks current owner rights on each download with the same key', async () => {
    const c = await aclCompany();
    const ava = await assistant(c);
    const kept = await file(c, { taskId: (await c.work('Report', c.crew.mine)).id });
    expect((await ava.download(kept.id)).statusCode).toBe(200);
    await c.db.update(subscriptions).set({ ownerPersonId: c.ids.bob }).where(eq(subscriptions.id, c.plans.ann.id));
    expect((await c.get(`/api/attachments/${kept.id}`, c.tokens.ann)).statusCode).toBe(404);
    const got = await ava.download(kept.id);
    const absent = await ava.download(randomUUID());
    expect(got.statusCode).toBe(404);
    expect(got.body).toBe(absent.body);
    expect(got.headers).toEqual(absent.headers);
  });

  it('hides a task of another person\'s assistant, an unreadable author, another company and missing ids with the same 404', async () => {
    const c = await aclCompany();
    const ava = await assistant(c);
    const bob = await assistant(c, 'bob');
    const [privateAgent] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Bob assistant', kind: 'assistant', model: '' }).returning();
    await c.db.update(assistants).set({ agentId: privateAgent!.id }).where(eq(assistants.personId, bob.id));
    const [privateTask] = await c.db.insert(tasks).values({ companyId: c.companyId, number: 100, title: 'Private work', assigneeAgentId: privateAgent!.id, executorAgentId: privateAgent!.id }).returning();
    const taskFile = await file(c, { taskId: privateTask!.id });
    const otherAuthor = await file(c, { taskId: (await c.work('Other report', c.crew.other)).id, agentId: c.crew.other.id });
    const hiddenMessage = await file(c, { personId: c.ids.bob, agentId: c.crew.other.id });
    const [foreign] = await c.db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    const [foreignAgent] = await c.db.insert(agents).values({ companyId: foreign!.id, name: 'Other agent', kind: 'orchestrator', model: '' }).returning();
    const foreignFile = await file(c, { companyId: foreign!.id, agentId: foreignAgent!.id });
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, agentId: c.crew.mine.id, subscriptionId: c.plans.ann.id, kind: 'conversation', prompt: 'Report', timeoutMs: 1000 }).returning();
    const screenshot = await file(c, { jobId: job!.id, name: null, mediaType: 'image/png' });
    const linkedScreenshot = await file(c, { taskId: (await c.work('Screenshot', c.crew.mine)).id, jobId: job!.id, name: null, mediaType: 'image/png' });
    const absent = await ava.download(randomUUID());
    expect(absent.statusCode).toBe(404);
    for (const id of [taskFile.id, otherAuthor.id, hiddenMessage.id, foreignFile.id, screenshot.id, linkedScreenshot.id, 'not-a-uuid']) {
      const got = await ava.download(id);
      expect(got.statusCode).toBe(404);
      expect(got.body).toBe(absent.body);
      expect(got.headers).toEqual(absent.headers);
    }
  });

  it("tells its owner in their language, as one person to another, that a file is not there for them, the same for any file it may not have", async () => {
    const c = await aclCompany();
    const ava = await assistant(c);
    const hidden = await file(c, { taskId: (await c.work('Other report', c.crew.other)).id, agentId: c.crew.other.id });
    const said = {
      'ru-RU,ru;q=0.9,en;q=0.8': 'такого файла в Hornhoof нет, его удалили через 30 дней, или вам его там не открыть.',
      'en-GB': 'there is no such file in Hornhoof, it was deleted after its 30 days, or you cannot open it there.',
      '': 'there is no such file in Hornhoof, it was deleted after its 30 days, or you cannot open it there.',
    };
    for (const [lang, message] of Object.entries(said)) {
      for (const id of [hidden.id, randomUUID(), 'not-a-uuid']) {
        const got = await ava.download(id, lang);
        expect(got.statusCode).toBe(404);
        expect(got.json()).toEqual({ error: { code: 'not_found', message, reason: 'attachment_unknown' } });
      }
    }
  });
});

describe('a link to one file, for its owner to open on a phone', () => {
  const opened = (c: AclCompany, url: string, lang?: string) => c.app.inject({ url: new URL(url).pathname, headers: lang ? { 'accept-language': lang } : {} });

  it('downloads that file for 7 days with no key and no sign-in, and then says in the phone\'s language that the link is over', async () => {
    const c = await aclCompany();
    const kept = await file(c, { name: 'Архив май.zip', mediaType: 'application/octet-stream' });
    const url = fileLink(c.app.ctx.config.secret, 'https://ann.hornhoof.org', kept.id);
    expect(url).toMatch(/^https:\/\/ann\.hornhoof\.org\/api\/files\/[\w-]+\.[\w-]+$/);
    const got = await opened(c, url);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload).toEqual(BYTES);
    expect(got.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'content-length': String(BYTES.length), 'content-disposition': disposition('Архив май.zip'), 'x-content-type-options': 'nosniff' });
    vi.setSystemTime(new Date('2026-11-23T13:59:59Z'));
    expect((await opened(c, url)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-23T14:00:00Z'));
    const over = await opened(c, url, 'ru-RU,ru;q=0.9');
    expect(over.statusCode).toBe(410);
    expect(over.json()).toEqual({ error: { code: 'gone', message: 'ссылка на файл работала 7 дней, и они прошли.', reason: 'file_link_expired' } });
    expect((await opened(c, url, 'en')).json().error.message).toBe('the link to the file worked for 7 days, and they are over.');
  });

  it('opens nothing for a link changed by one character, of another file, signed for something else, or of a file that is gone', async () => {
    const c = await aclCompany();
    const [kept, other] = [await file(c), await file(c, { name: 'other.xlsx' })];
    const url = fileLink(c.app.ctx.config.secret, 'https://ann.hornhoof.org', kept.id);
    const [payload, mac] = new URL(url).pathname.split('/').pop()!.split('.');
    const otherPayload = new URL(fileLink(c.app.ctx.config.secret, 'https://ann.hornhoof.org', other.id)).pathname.split('/').pop()!.split('.')[0];
    const stop = signedToken(c.app.ctx.config.secret, 'another link', { f: kept.id, until: Date.now() + 60_000 });
    const wrong = [`${payload}.${mac!.startsWith('A') ? 'B' : 'A'}${mac!.slice(1)}`, `${otherPayload}.${mac}`, stop, 'not-a-link', `${payload}.${mac}.x`];
    for (const link of wrong) {
      const got = await opened(c, `https://ann.hornhoof.org/api/files/${link}`);
      expect(got.statusCode).toBe(404);
      expect(got.json()).toEqual({ error: { code: 'not_found', message: WORDS.attachment_unknown!.en, reason: 'attachment_unknown' } });
    }
    await c.db.delete(attachments).where(eq(attachments.id, kept.id));
    expect((await opened(c, url)).statusCode).toBe(404);
  });
});

it('words every refusal as one neutral reason that reads after "<file name> did not come: ", in both languages', () => {
  const said = Object.values(WORDS).flatMap(words => [words!.en, words!.ru]);
  expect(said).toHaveLength(32);
  for (const words of said) {
    expect(words).toMatch(/^(?:\p{Ll}|Hornhoof )/u);
    expect(words).not.toMatch(/[\u2013\u2014\u0401\u0451]|did not come|did not go|не дошел|не ушло|(?<!\p{L})(?:I|me|my|я|мне|меня|мой)(?!\p{L})/u);
  }
});

it('makes a refused file delivery explicit to the agent, with its reason and no success claim', async () => {
  const c = await aclCompany();
  const ava = await assistant(c);
  const [agent] = await c.db.insert(agents).values({ companyId: c.companyId, name: 'Ava', kind: 'assistant', model: '' }).returning();
  await c.db.update(assistants).set({ agentId: agent!.id, skillsUrl: 'https://assistant.example/skills' }).where(eq(assistants.personId, ava.id));
  /* A recorded refusal from the assistant program, not a real Telegram request. */
  vi.useFakeTimers();
  vi.stubGlobal('fetch', async () => Response.json({ ok: false, text: 'file_unknown', data: { delivered: false } }));
  try {
    const got = await callSkill(c.app.ctx, { id: randomUUID(), agentId: agent!.id }, { name: 'send_file', arguments: { attachmentId: randomUUID() } }, new AbortController().signal);
    expect(got.ok).toBe(false);
    expect(got.text).toContain('file_unknown');
    expect(got.text).toContain('"delivered":false');
    expect(got.text).toContain('Do not report success');
    expect(got.text).toContain('the file did not arrive');
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
