import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, notebookNotes, subscriptions } from '../src/db/schema.js';
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
