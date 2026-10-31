import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { MAX_INSTRUCTIONS, parseServerMessage } from '@hornhoof/protocol';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, notebookNotes, subscriptions } from '../src/db/schema.js';
import { instructionsOf } from '../src/modules/agents/instructions.js';
import { as, invitePerson, listen, openStream, setUpCompany, testApp, until } from './helpers.js';

const TOKEN = 'tool-token-0123456789abcdef0123456789';

async function company() {
  const { app, db } = await testApp();
  await listen(app);
  const ceo = await setUpCompany(app);
  return { app, db, ceo };
}

const notes = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/notebook', ...as(token) })).json().notes;
const write = (app: FastifyInstance, token: string, text: string) => app.inject({ method: 'POST', url: '/api/notebook', payload: { text }, ...as(token) });

describe("the company's notebook", () => {
  it('keeps numbered notes that people who see the whole company write, rewrite and remove', async () => {
    const { app, ceo } = await company();
    expect(await notes(app, ceo)).toEqual([]);
    expect((await write(app, ceo, 'Commits are made by Ivan only.')).statusCode).toBe(201);
    await write(app, ceo, 'One question at a time.');
    expect(await notes(app, ceo)).toMatchObject([
      { number: 1, text: 'Commits are made by Ivan only.', by: { kind: 'person', name: 'Ivan' } },
      { number: 2, text: 'One question at a time.', by: { kind: 'person', name: 'Ivan' } },
    ]);
    expect((await app.inject({ method: 'PATCH', url: '/api/notebook/2', payload: { text: 'Ask one question at a time.' }, ...as(ceo) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/notebook/1', ...as(ceo) })).statusCode).toBe(204);
    await write(app, ceo, 'Russian without the letter yo.');
    expect((await notes(app, ceo)).map((n: { number: number; text: string }) => [n.number, n.text])).toEqual([
      [2, 'Ask one question at a time.'],
      [3, 'Russian without the letter yo.'],
    ]);
    const gone = await app.inject({ method: 'DELETE', url: '/api/notebook/1', ...as(ceo) });
    expect([gone.statusCode, gone.json().error.reason]).toEqual([404, 'note_unknown']);
  });

  it('never gives a removed note\'s number to another note, so a late change cannot hit the wrong one', async () => {
    const { app, ceo } = await company();
    await write(app, ceo, 'First.');
    await app.inject({ method: 'DELETE', url: '/api/notebook/1', ...as(ceo) });
    expect((await write(app, ceo, 'Second.')).json().note.number).toBe(2);
    const late = await app.inject({ method: 'PATCH', url: '/api/notebook/1', payload: { text: 'Late.' }, ...as(ceo) });
    expect([late.statusCode, late.json().error.reason]).toEqual([404, 'note_unknown']);
    expect((await notes(app, ceo)).map((n: { number: number }) => n.number)).toEqual([2]);
  });

  it('takes notes written at the same moment, each with its own number', async () => {
    const { app, ceo } = await company();
    const all = await Promise.all(['One.', 'Two.', 'Three.'].map(text => write(app, ceo, text)));
    expect(all.map(r => r.statusCode)).toEqual([201, 201, 201]);
    expect(all.map(r => r.json().note.number).sort()).toEqual([1, 2, 3]);
  });

  it('is only for people who see the whole company', async () => {
    const { app, db, ceo } = await company();
    const [acme] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [dev!.id] } });
    expect((await app.inject({ url: '/api/notebook', ...as(dana) })).statusCode).toBe(403);
    expect((await write(app, dana, 'Mine.')).statusCode).toBe(403);
  });

  it('keeps notes short and the notebook small enough for the instructions', async () => {
    const { app, ceo } = await company();
    const long = await write(app, ceo, 'x'.repeat(301));
    expect(long.statusCode).toBe(400);
    for (let i = 0; i < 13; i++) expect((await write(app, ceo, `${i} ${'y'.repeat(295)}`)).statusCode).toBe(201);
    const full = await write(app, ceo, 'z'.repeat(200));
    expect([full.statusCode, full.json().error.reason]).toEqual([409, 'notebook_full']);
    /* 3864 characters so far; a short note still fits, and growing it past 4000 does not. */
    expect((await write(app, ceo, 'v'.repeat(130))).statusCode).toBe(201);
    const longer = await app.inject({ method: 'PATCH', url: '/api/notebook/14', payload: { text: 'w'.repeat(140) }, ...as(ceo) });
    expect([longer.statusCode, longer.json().error.reason]).toEqual([409, 'notebook_full']);
  });

  it('says on the stream that it changed, to people who see the whole company', async () => {
    const { app, ceo } = await company();
    const stream = await openStream(app, ceo);
    await write(app, ceo, 'A rule.');
    await until(() => stream.messages.some(m => m.type === 'notebook'));
  });

  it('is written by the orchestrator with its tools, as the orchestrator', async () => {
    const { app, db, ceo } = await company();
    const [acme] = await db.select().from(companies);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [sub] = await db.select().from(subscriptions);
    await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) });
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    onTestFinished(() => client.close());
    type Result = { content: { text: string }[]; isError?: boolean };
    const call = async (name: string, args: object) => (await client.callTool({ name, arguments: args })) as Result;
    expect(JSON.parse((await call('remember', { text: 'The CEO wants turns small.' })).content[0]!.text)).toMatchObject({ note: { number: 1 } });
    await call('remember', { text: 'Design reviews go to Oleg.' });
    expect((await call('rewrite_note', { note: 1, text: 'The CEO wants small turns.' })).isError).toBeFalsy();
    expect((await call('forget', { note: 2 })).isError).toBeFalsy();
    expect((await call('forget', { note: 2 })).isError).toBe(true);
    const rows = await db.select().from(notebookNotes).orderBy(notebookNotes.number);
    /* A removed note stays behind with its number, so the number is never given again. */
    expect(rows.map(r => [r.number, r.text, r.byOrchestrator, r.personId, Boolean(r.removedAt)])).toEqual([
      [1, 'The CEO wants small turns.', true, null, false],
      [2, 'Design reviews go to Oleg.', true, null, true],
    ]);
    expect(await notes(app, ceo)).toMatchObject([{ number: 1, by: { kind: 'orchestrator' } }]);
  });
});

describe("a department's notebook", () => {
  async function withDepartments() {
    const { app, db, ceo } = await company();
    const [acme] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [ops] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    return { app, db, ceo, acme: acme!, dev: dev!, ops: ops! };
  }
  const book = (id: string) => `/api/departments/${id}/notebook`;
  const add = (app: FastifyInstance, token: string, id: string, text: string) => app.inject({ method: 'POST', url: book(id), payload: { text }, ...as(token) });
  const texts = async (app: FastifyInstance, token: string, id: string) => (await app.inject({ url: book(id), ...as(token) })).json().notes.map((n: { text: string }) => n.text);

  it('keeps numbered notes of its own, apart from the company notebook and other departments', async () => {
    const { app, ceo, dev, ops } = await withDepartments();
    await write(app, ceo, 'A company rule.');
    expect((await add(app, ceo, dev.id, 'Tests first.')).json().note.number).toBe(1);
    await add(app, ceo, dev.id, 'Small commits.');
    expect((await add(app, ceo, ops.id, 'Check every hour.')).json().note.number).toBe(1);
    expect((await app.inject({ method: 'PATCH', url: `${book(dev.id)}/2`, payload: { text: 'Small commits, one idea each.' }, ...as(ceo) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `${book(dev.id)}/1`, ...as(ceo) })).statusCode).toBe(204);
    expect((await app.inject({ url: book(dev.id), ...as(ceo) })).json().notes).toMatchObject([{ number: 2, text: 'Small commits, one idea each.', by: { kind: 'person', name: 'Ivan' } }]);
    expect((await add(app, ceo, dev.id, 'Review before merge.')).json().note.number).toBe(3);
    expect(await texts(app, ceo, ops.id)).toEqual(['Check every hour.']);
    expect((await notes(app, ceo)).map((n: { text: string }) => n.text)).toEqual(['A company rule.']);
  });

  it("is for people who may change the department's employees", async () => {
    const { app, ceo, dev, ops } = await withDepartments();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [dev.id] } });
    expect((await add(app, dana, dev.id, 'Mine.')).statusCode).toBe(201);
    expect(await texts(app, dana, dev.id)).toEqual(['Mine.']);
    expect((await app.inject({ url: book(ops.id), ...as(dana) })).statusCode).toBe(403);
    expect((await add(app, dana, ops.id, 'Theirs.')).statusCode).toBe(403);
    expect((await app.inject({ url: book('00000000-0000-4000-8000-000000000000'), ...as(ceo) })).statusCode).toBe(404);
  });

  it('gives a head as much of a full notebook as a turn takes, and its tool for the rest', async () => {
    const { app, db, ceo, acme } = await withDepartments();
    const [mkt] = await db.insert(departments).values({ companyId: acme.id, templateKey: 'marketing', roleCode: 'MKT' }).returning();
    /* Notes of many lines, so that a cut between lines would fall inside one. */
    const note = (i: number) => [`${i} `, ...Array<string>(25).fill('xxxxxxxxx'), `end ${i}.`].join('\n');
    for (let i = 0; i < 13; i++) expect((await add(app, ceo, mkt!.id, note(i))).statusCode).toBe(201);
    const key = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Team key', apiKey: 'sk-ant-api03-team-key-5678', target: { kind: 'any' } },
      ...as(ceo),
    });
    /* Its own skills and others up to near the limit a person may write; the notebook comes on top. */
    const { templates } = app.ctx;
    const role = templates.roles.get('MKT-HEAD')!;
    const skills = role.skills.map(s => s.id);
    let size = role.body.length + skills.reduce((n, id) => n + templates.skills.get(id)!.body.length + 60, 0);
    for (const [id, skill] of templates.skills) {
      if (skills.includes(id) || id.startsWith('orch-') || size + skill.body.length + 60 > 17_500) continue;
      skills.push(id);
      size += skill.body.length + 60;
    }
    const hired = await app.inject({
      method: 'POST',
      url: `/api/departments/${mkt!.id}/staff`,
      payload: { people: [{ role: 'MKT-HEAD', name: 'Mira', model: 'claude-sonnet-5-5', subscription: key.json().subscription.id, skills }] },
      ...as(ceo),
    });
    expect(hired.statusCode).toBe(201);
    const [mira] = await db.select().from(agents).where(eq(agents.name, 'Mira'));
    const { text } = await instructionsOf(app.ctx, mira!);
    expect(text.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS);
    expect(text).toContain(`[#1] 0 `);
    expect(text).not.toContain(`[#13] 12 `);
    /* Only whole notes. */
    for (let i = 0; i < 13; i++) expect([i, text.includes(`[#${i + 1}] ${i} `)]).toEqual([i, text.includes(`end ${i}.`)]);
    expect(text).toContain('The rest of the notebook did not fit here. Read it whole with the notebook tool.');
    /* Any node takes the turn. */
    const run = { type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 1000, secret: null, instructions: text, toolToken: null };
    expect(parseServerMessage(JSON.stringify(run))).toMatchObject({ instructions: text });
  });

  it("stays out of the head's card, which people edit and people of a product may read", async () => {
    const { app, db, ceo, acme, dev } = await withDepartments();
    const [sub] = await db.select().from(subscriptions);
    const [head] = await db.insert(agents).values({ companyId: acme.id, kind: 'head', name: 'Hana', roleKey: 'DEV-HEAD', departmentId: dev.id, model: '', subscriptionId: sub!.id }).returning();
    await add(app, ceo, dev.id, 'Deploy on Fridays never.');
    const card = (await app.inject({ url: `/api/agents/${head!.id}`, ...as(ceo) })).json();
    expect(card.parts.map((p: { kind: string }) => p.kind)).not.toContain('notebook');
    expect(card.raw).not.toContain('Deploy on Fridays never.');
    /* The program carries it all the same. */
    expect((await instructionsOf(app.ctx, head!)).text).toContain('Deploy on Fridays never.');
  });

  it("goes into its head's instructions, which say to read it again after a compaction", async () => {
    const { app, db, ceo, acme, dev } = await withDepartments();
    const [sub] = await db.select().from(subscriptions);
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
      (await db.insert(agents).values({ companyId: acme.id, kind, name, roleKey, departmentId: dev.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const hana = await hire('Hana', 'head', 'DEV-HEAD');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    const before = await instructionsOf(app.ctx, hana);
    await add(app, ceo, dev.id, 'Tests first.');
    const now = await instructionsOf(app.ctx, hana);
    expect(now.parts.at(-1)).toMatchObject({ kind: 'notebook' });
    expect(now.text).toContain('## Department notebook');
    expect(now.text).toContain('[#1] Tests first.');
    expect(now.text).toContain('your department notebook again with "notebook"');
    /* A note does not start its program again: it reads the notebook with its tool. */
    expect(now.hash).toBe(before.hash);
    expect((await instructionsOf(app.ctx, bruno)).text).not.toContain('notebook');
  });

  it('says on the stream that it changed, only to people who reach the department', async () => {
    const { app, ceo, dev, ops } = await withDepartments();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.test', access: { departments: [ops.id] } });
    const hers = await openStream(app, dana);
    const mine = await openStream(app, ceo);
    await add(app, ceo, dev.id, 'A rule.');
    await until(() => mine.messages.some(m => m.type === 'notebook' && (m as { spot?: { departmentId: string } }).spot?.departmentId === dev.id));
    expect(hers.messages.some(m => m.type === 'notebook')).toBe(false);
  });

  it('is read and written by its head with its own tools, and by the orchestrator naming the department', async () => {
    const { app, db, ceo, acme, dev } = await withDepartments();
    const [sub] = await db.select().from(subscriptions);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
      (await db.insert(agents).values({ companyId: acme.id, kind, name, roleKey, departmentId: dev.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const hana = await hire('Hana', 'head', 'DEV-HEAD');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    const tokens = { [hana.id]: 'tool-token-head-0123456789abcdef0123', [bruno.id]: 'tool-token-worker-0123456789abcdef01', [orchestrator!.id]: TOKEN };
    for (const [agentId, token] of Object.entries(tokens))
      await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) });
    const connect = async (token: string) => {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      onTestFinished(() => client.close());
      type Result = { content: { text: string }[]; isError?: boolean };
      return { names: async () => (await client.listTools()).tools.map(t => t.name), call: async (name: string, args: object = {}) => (await client.callTool({ name, arguments: args })) as Result };
    };
    const head = await connect(tokens[hana.id]!);
    expect(await head.names()).toEqual(expect.arrayContaining(['notebook', 'remember', 'rewrite_note', 'forget']));
    expect(await (await connect(tokens[bruno.id]!)).names()).not.toContain('remember');
    await add(app, ceo, dev.id, 'Tests first.');
    expect((await head.call('notebook')).content[0]!.text).toContain('[#1] Tests first.');
    expect(JSON.parse((await head.call('remember', { text: 'Review before merge.' })).content[0]!.text)).toMatchObject({ note: { number: 2 } });
    expect((await head.call('rewrite_note', { note: 2, text: 'Review every merge.' })).isError).toBeFalsy();
    expect((await head.call('forget', { note: 1 })).isError).toBeFalsy();
    expect((await head.call('forget', { note: 1 })).isError).toBe(true);
    expect((await app.inject({ url: book(dev.id), ...as(ceo) })).json().notes).toMatchObject([{ number: 2, text: 'Review every merge.', by: { kind: 'agent', name: 'Hana' } }]);
    const orch = await connect(TOKEN);
    expect((await orch.call('remember', { department: dev.id, text: 'Hana plans the week.' })).isError).toBeFalsy();
    expect((await orch.call('notebook', { department: dev.id })).content[0]!.text).toContain('Hana plans the week.');
    expect((await orch.call('remember', { text: 'A company rule.' })).isError).toBeFalsy();
    expect((await orch.call('notebook')).content[0]!.text).toContain('A company rule.');
    expect(await texts(app, ceo, dev.id)).toEqual(['Review every merge.', 'Hana plans the week.']);
  });
});
