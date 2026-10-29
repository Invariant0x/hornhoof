import type { AddressInfo } from 'node:net';
import type { NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import WebSocket from 'ws';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { MIGRATIONS, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');
export const TEST_API_KEY = 'sk-ant-api03-test-key-9f3a';
export const SETUP = {
  companyName: 'Acme',
  name: 'Ivan',
  email: ' Ivan@Acme.com ',
  password: 'correct horse battery',
  orchestrator: { mode: 'api_key', provider: 'anthropic_api', apiKey: TEST_API_KEY },
};

async function openTestDb(): Promise<{ client: PGlite; db: Db }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { client, db: db as unknown as Db };
}

/* Each PGlite is a whole Postgres in WASM memory, so it closes when its test ends. Call these inside a test. */
export async function createTestDb(): Promise<Db> {
  const { client, db } = await openTestDb();
  onTestFinished(() => client.close());
  return db;
}

export async function testApp(env: NodeJS.ProcessEnv = {}): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const { client, db } = await openTestDb();
  let app: FastifyInstance | undefined;
  /* The app closes first, since stopping it can still write to the database. */
  onTestFinished(async () => {
    await app?.close();
    await client.close();
  });
  const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, ...env });
  app = await buildApp({ db, config });
  return { app, db, config };
}

export function sessionFrom(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find(c => c.name === 'hh_session');
  if (!cookie) throw new Error(`No session cookie in a ${res.statusCode} response.`);
  return cookie.value;
}

/* Runs first-run setup and returns the CEO's session token. */
export async function setUpCompany(app: FastifyInstance): Promise<string> {
  return sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
}

export const as = (token: string) => ({ cookies: { hh_session: token } });

type Scope = { kind: 'company' } | { kind: 'department' | 'team'; id: string };

/* Invites a person, accepts the invite with a password and returns their session token. */
export async function invitePerson(app: FastifyInstance, ceoToken: string, input: { name: string; email: string; scope: Scope }): Promise<string> {
  const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { ...input, title: '' }, ...as(ceoToken) });
  if (invited.statusCode !== 201) throw new Error(`Invite failed with ${invited.statusCode}: ${invited.body}`);
  const token = new URL(invited.json().inviteUrl).pathname.split('/').pop()!;
  return sessionFrom(await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } }));
}

export type FakeNode = {
  ws: WebSocket;
  send(msg: NodeMessage): void;
  next(): Promise<ServerMessage>;
  closed: Promise<number>;
  close(): void;
};

/* A stand-in for a node: connects with a key and collects what the server sends. */
export function connectNode(url: string, key: string, opts: { autoPong?: boolean } = {}): Promise<FakeNode> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` }, autoPong: opts.autoPong ?? true });
    const queue: ServerMessage[] = [];
    const waiters: ((m: ServerMessage) => void)[] = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(msg);
      else queue.push(msg);
    });
    const closed = new Promise<number>(done => ws.on('close', code => done(code)));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        send: msg => ws.send(JSON.stringify(msg)),
        next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise(done => waiters.push(done))),
        closed,
        close: () => ws.close(),
      }),
    );
  });
}

/* Waits until check() is true, for state that changes after a socket message. */
export async function until(check: () => Promise<boolean> | boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting.');
    await new Promise(r => setTimeout(r, 15));
  }
}

/* Starts the app on a free local port and returns the node socket address. */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/nodes/socket`;
}
