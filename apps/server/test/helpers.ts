import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle, PglitePreparedQuery, type PgliteDatabase } from 'drizzle-orm/pglite';
import WebSocket from 'ws';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { inject, onTestFinished, vi } from 'vitest';
import { buildApp, type Deps } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { agentRole, grantsFor, readerGrantsFor, readerRole, type AgentSql } from '../src/db/agent-sql.js';
import type { Db } from '../src/db/client.js';
import { FENCED, type LeaseKind, type LeaseSync } from '../src/db/net.js';
import { LINK_SESSION_COOKIE } from '../src/auth/session.js';
import * as schema from '../src/db/schema.js';
import { setupCode } from '../src/modules/setup/code.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';

export const TEST_SECRET = Buffer.alloc(32, 7).toString('base64');
export const TEST_API_KEY = 'sk-ant-api03-test-key-9f3a';
export const SETUP = {
  /* The code from the setup link the server logs while no company exists. */
  code: setupCode(Buffer.from(TEST_SECRET, 'base64')),
  companyName: 'Acme',
  name: 'Ivan',
  email: ' Ivan@Acme.com ',
  password: 'correct horse battery',
  orchestrator: { mode: 'api_key', provider: 'anthropic_api', apiKey: TEST_API_KEY },
};

/* Every test database starts from a copy of the one global-setup.ts migrated for the run. */
let migrated: Blob | undefined;
type TestDb = PgliteDatabase<typeof schema> & { $client: PGlite };

async function openTestDb(): Promise<{ client: PGlite; db: TestDb }> {
  migrated ??= new Blob([readFileSync(inject('migratedDataDir'))]);
  const client = new PGlite({ loadDataDir: migrated });
  /* PGlite applies no ALTER DATABASE or ALTER ROLE setting when it loads a dump, so each one says it for itself. */
  await client.exec(`SET ${FENCED} = 'on'`);
  const db = drizzle(client, { schema });
  return { client, db };
}

type LeaseChange = { until?: string; kind?: LeaseKind; sync?: LeaseSync | null; termNumber?: number };
const LEASE_COLUMNS: Record<keyof LeaseChange, string> = { until: 'until', kind: 'kind', sync: 'sync', termNumber: 'term_number' };

/* Changes what the test database's lease says. The until is a timestamptz as text: '-infinity' or an ISO time. */
export async function setLease(db: Db, change: LeaseChange): Promise<void> {
  const columns = (Object.keys(change) as (keyof LeaseChange)[]).map(name => sql`${sql.identifier(LEASE_COLUMNS[name])} = ${change[name] ?? null}`);
  await db.execute(sql`UPDATE net_local.lease SET ${sql.join(columns, sql`, `)}`);
}

/* The statements the database runs from now on, in order, with their values. PGlite has one connection, so two moves
   cannot race in a test; this shows instead that a move takes the locks that make them go one after the other. */
export function statements(): { sql: string; params: unknown[] }[] {
  const seen: { sql: string; params: unknown[] }[] = [];
  const execute = PglitePreparedQuery.prototype.execute;
  const spy = vi.spyOn(PglitePreparedQuery.prototype, 'execute').mockImplementation(function (this: PglitePreparedQuery<never>, values) {
    const q = this as unknown as { queryString: string; params: unknown[] };
    seen.push({ sql: q.queryString, params: q.params });
    return execute.call(this, values);
  });
  onTestFinished(() => spy.mockRestore());
  return seen;
}

/* Each PGlite is a whole Postgres in WASM memory, so it closes when its test ends. Call these inside a test. */
export async function createTestDb(): Promise<TestDb> {
  const { client, db } = await openTestDb();
  onTestFinished(() => client.close());
  return db;
}

/* Agents' database roles on PGlite. PGlite has one user, a superuser, so a role is taken with SET LOCAL ROLE: its rights
   hold, though a statement could take the superuser back, which on Postgres a separate sign-in rules out. */
function agentSqlOn(client: PGlite): AgentSql {
  const roles = { write: agentRole('postgres'), read: readerRole('postgres') };
  let granted: Promise<unknown> | null = null;
  return {
    run: async (text, mode) => {
      granted ??= client.exec(`${grantsFor(roles.write)};\n${readerGrantsFor(roles.read)}`);
      await granted;
      return client.transaction(async tx => {
        if (mode === 'read') await tx.query('SET TRANSACTION READ ONLY');
        await tx.query(`SET LOCAL ROLE "${roles[mode]}"`);
        return (await tx.exec(text)).map(r => ({ rows: r.rows as Record<string, unknown>[], changed: r.affectedRows ?? 0 }));
      });
    },
    close: async () => {},
  };
}

export async function testApp(env: NodeJS.ProcessEnv = {}, logger?: Deps['logger']): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const { client } = await openTestDb();
  onTestFinished(() => client.close());
  return appOn(client, env, logger);
}

/* The app on a database the test opened, which closes after the app: test hooks run last first, and stopping the app can
   still write to it. */
export async function appOn(client: PGlite, env: NodeJS.ProcessEnv = {}, logger?: Deps['logger']): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const db = drizzle(client, { schema }) as unknown as Db;
  /* Tests never reach the real registry or a real CA unless they ask. */
  const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', ACME_DIRECTORY: 'off', ...env });
  const app = await buildApp({ db, config, logger, agentSql: agentSqlOn(client) });
  onTestFinished(() => app.close());
  return { app, db, config };
}

const isSessionCookie = (cookie: { name: string }) => cookie.name === 'hh_session' || cookie.name === LINK_SESSION_COOKIE;

export function sessionFrom(res: LightMyRequestResponse): string {
  const [value] = res.cookies.filter(isSessionCookie).map(cookie => cookie.value).filter(Boolean);
  if (!value) throw new Error(`No session cookie in a ${res.statusCode} response.`);
  return value;
}

/* Runs first-run setup and returns the CEO's session token. */
export async function setUpCompany(app: FastifyInstance): Promise<string> {
  return sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
}

export const as = (token: string) => ({ cookies: { hh_session: token } });

/* The tunnel container's address in tests: start the app with testApp({ TUNNEL_HOST: TUNNEL }). */
export const TUNNEL = '192.0.2.10';

/* A request that came over https through the tunnel container, as a visitor of the public link sends it. */
export const viaLink = (token?: string) => ({
  remoteAddress: TUNNEL,
  headers: { 'x-forwarded-proto': 'https' },
  cookies: (token ? { [LINK_SESSION_COOKIE]: token } : {}) as Record<string, string>,
});

type Access = { whole: true } | { departments?: string[]; teams?: string[] };

/* A worker of a new Development department asks the CEO to approve a merge, which only the CEO or the CEO delegate may. */
export async function approvalAsked(app: FastifyInstance) {
  const { db } = app.ctx;
  const [orchestrator] = await db.select().from(schema.agents).where(eq(schema.agents.kind, 'orchestrator'));
  const on = { companyId: orchestrator!.companyId, subscriptionId: orchestrator!.subscriptionId, model: '' };
  const [dev] = await db.insert(schema.departments).values({ companyId: on.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [head] = await db.insert(schema.agents).values({ ...on, kind: 'head', name: 'Head', roleKey: 'DEV-HEAD', departmentId: dev!.id }).returning();
  const [worker] = await db.insert(schema.agents).values({ ...on, kind: 'worker', name: 'Worker', roleKey: 'DEV-BE', departmentId: dev!.id }).returning();
  const { task } = await createTask(app.ctx, { agentId: head!.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: worker!.id, executor: true, gates: [] });
  return (await ask(app.ctx, worker!.id, task.id, { kind: 'approval', text: 'Merge?', commit: 'a'.repeat(40) })).request;
}

/* Invites a person, accepts the invite with a password and returns their session token. */
export async function invitePerson(app: FastifyInstance, ceoToken: string, input: { name: string; email: string; access: Access }): Promise<string> {
  const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { ...input, title: '' }, ...as(ceoToken) });
  if (invited.statusCode !== 201) throw new Error(`Invite failed with ${invited.statusCode}: ${invited.body}`);
  const token = new URL(invited.json().inviteUrl).pathname.split('/').pop()!;
  return sessionFrom(await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } }));
}

export type FakeNode = {
  ws: WebSocket;
  send(msg: NodeMessage): void;
  /* The next message other than a confirmation of a finished job, which lands in acks. */
  next(): Promise<ServerMessage>;
  acks: string[];
  /* Messages that arrived and nobody took yet. */
  queued(): number;
  closed: Promise<number>;
  close(): void;
};

/* A stand-in for a node: connects with a key and collects what the server sends. */
export function connectNode(url: string, key: string, opts: { autoPong?: boolean } = {}): Promise<FakeNode> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` }, autoPong: opts.autoPong ?? true });
    const queue: ServerMessage[] = [];
    const waiters: ((m: ServerMessage) => void)[] = [];
    const acks: string[] = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'job.ack') return void acks.push(msg.jobId);
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
        acks,
        queued: () => queue.length,
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

export async function mcp(app: FastifyInstance, token: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  onTestFinished(() => client.close());
  return client;
}

export type StreamReader = { res: Response; messages: { type: string; [k: string]: unknown }[]; ended(): boolean; close(): void };

/* Reads Server-Sent Events from /api/stream of a listening app as parsed messages; headers sign in another way, as the
   orchestrator does inside. */
export async function openStream(app: FastifyInstance, token?: string, headers: Record<string, string> = {}): Promise<StreamReader> {
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const stop = new AbortController();
  const res = await fetch(`${base}/api/stream`, { headers: { ...(token ? { cookie: `hh_session=${token}` } : {}), ...headers }, signal: stop.signal });
  const messages: StreamReader['messages'] = [];
  let ended = false;
  if (res.ok) {
    void (async () => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) for (const line of frame.split('\n')) if (line.startsWith('data: ')) messages.push(JSON.parse(line.slice(6)));
        }
      } catch {
        /* Aborted. */
      }
      ended = true;
    })();
  }
  onTestFinished(() => stop.abort());
  return { res, messages, ended: () => ended, close: () => stop.abort() };
}
