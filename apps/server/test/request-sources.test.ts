import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Db } from '../src/db/client.js';
import { companies } from '../src/db/schema.js';
import { ALREADY_DONE, registerErrorHandling } from '../src/errors.js';
import { registerRequestSources, REQUEST_ID } from '../src/modules/sources/requests.js';
import { as, createTestDb, setUpCompany, testApp } from './helpers.js';

const rowsOf = <T>(answer: unknown): T[] => (answer as { rows: T[] }).rows;
const sourcesOf = async (db: Db): Promise<string[]> => rowsOf<{ source: string }>(await db.execute(sql`select source from applied order by at, source`)).map(row => row.source);
const notes = async (app: FastifyInstance, token: string): Promise<{ text: string }[]> => (await app.inject({ url: '/api/notebook', ...as(token) })).json().notes;
const keyed = (key: string) => ({ [REQUEST_ID]: key });

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const write = (text: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/notebook', payload: { text }, headers, ...as(ceo) });
  return { app, db, ceo, write };
}

describe('a change the page sends with a request id', () => {
  it('is applied once when the page sends it again, and the second try hears that it was done', async () => {
    const { app, db, ceo, write } = await company();
    const key = randomUUID();
    const first = await write('Commits are made by Ivan only.', keyed(key));
    expect(first.statusCode).toBe(201);
    const second = await write('Commits are made by Ivan only.', keyed(key.toUpperCase()));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toEqual({ code: 'conflict', message: ALREADY_DONE, reason: 'already_done' });
    expect(await notes(app, ceo)).toHaveLength(1);
    expect(await sourcesOf(db)).toEqual([`web:${key}:0`]);
    expect(rowsOf(await db.execute(sql`select base from applied`))).toEqual([{ base: `web:${key}` }]);
  });

  it('records nothing for a change that changed nothing, so the same try is judged again', async () => {
    const { db, write } = await company();
    const key = randomUUID();
    expect((await write(7, keyed(key))).statusCode).toBe(400);
    expect((await write(7, keyed(key))).statusCode).toBe(400);
    expect(await sourcesOf(db)).toEqual([]);
    expect((await write('Now a note.', keyed(key))).statusCode).toBe(201);
  });

  it('leaves a request without an id, or with one that is no uuid, as it was', async () => {
    const { app, db, ceo, write } = await company();
    expect((await write('One')).statusCode).toBe(201);
    expect((await write('Two')).statusCode).toBe(201);
    expect((await write('Three', keyed('again'))).statusCode).toBe(201);
    expect((await write('Four', keyed('again'))).statusCode).toBe(201);
    expect(await notes(app, ceo)).toHaveLength(4);
    expect(await sourcesOf(db)).toEqual([]);
  });

  it('opens no source for a tool call, whose id is another', async () => {
    const { app, db } = await company();
    const res = await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: keyed(randomUUID()) });
    expect(res.statusCode).not.toBe(409);
    expect(await sourcesOf(db)).toEqual([]);
  });

  it('answers a read as before, whatever id comes with it', async () => {
    const { app, db, ceo } = await company();
    const key = randomUUID();
    for (let i = 0; i < 2; i++) expect((await app.inject({ url: '/api/notebook', headers: keyed(key), ...as(ceo) })).statusCode).toBe(200);
    expect(await sourcesOf(db)).toEqual([]);
  });
});

describe('the source of a request', () => {
  /* An app of its own with two routes: one that answers and writes later, one that acts outside the database first. */
  async function ownApp() {
    const db = await createTestDb();
    await db.insert(companies).values({ name: 'Acme' });
    const app = Fastify();
    onTestFinished(() => app.close());
    registerErrorHandling(app);
    registerRequestSources(app, db);
    let open!: () => void;
    const gate = new Promise<void>(done => (open = done));
    let late: Promise<unknown> = Promise.resolve();
    const acted: string[] = [];
    const rename = (name: string) => db.update(companies).set({ name });
    app.post('/later', async () => {
      late = gate.then(() => rename('Later'));
      return { ok: true };
    });
    app.post('/act', { config: { startsFirst: true } }, async () => {
      acted.push(JSON.stringify(await sourcesOf(db)));
      return { ok: true };
    });
    return { app, db, acted, settle: async () => (open(), late) };
  }

  it('closes when its answer goes: what the request left running records nothing', async () => {
    const { app, db, settle } = await ownApp();
    expect((await app.inject({ method: 'POST', url: '/later', headers: keyed(randomUUID()) })).statusCode).toBe(200);
    await settle();
    expect((await db.select().from(companies))[0]!.name).toBe('Later');
    expect(await sourcesOf(db)).toEqual([]);
  });

  it('commits the first step of an action outside the database before the action', async () => {
    const { app, acted } = await ownApp();
    const key = randomUUID();
    expect((await app.inject({ method: 'POST', url: '/act', headers: keyed(key) })).statusCode).toBe(200);
    expect(acted).toEqual([JSON.stringify([`web:${key}:0`])]);
    const again = await app.inject({ method: 'POST', url: '/act', headers: keyed(key) });
    expect(again.json().error.reason).toBe('already_done');
    expect(acted).toHaveLength(1);
  });
});
