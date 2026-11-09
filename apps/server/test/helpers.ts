import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { onTestFinished } from 'vitest';
import { buildApp, type Deps } from '../src/app.js';
import type { CommitMarker } from '../src/modules/testruns/github-status.js';
import type { CommitReader } from '../src/modules/testruns/refs.js';
import { loadConfig, type Config } from '../src/config.js';
import { agentRole, grantsFor, readerGrantsFor, readerRole, type AgentSql } from '../src/db/agent-sql.js';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { openTestDb, timed } from './helpers-db.js';
import { TEST_SECRET } from './helpers-basic.js';
export { createTestDb, fixture, ownDatabases, statements } from './helpers-db.js';
export { as, sessionFrom, TEST_SECRET, until } from './helpers-basic.js';

export { TEST_API_KEY, SETUP, appFixture, withoutOperations, setUpCompany, invitePerson } from './helpers-company.js';

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
  const { client } = await timed('setupMs', openTestDb);
  onTestFinished(() => timed('teardownMs', () => client.close()));
  return appOn(client, env, logger);
}

/* Tests never reach a real repository: every branch is at this commit, until a test moves it through ctx.readCommit. */
export const TEST_COMMIT = 'a'.repeat(40);
const atTestCommit: CommitReader = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : `task-${want.task}`, commitSha: TEST_COMMIT });
/* Nor GitHub: a test that looks at the mark on a commit puts its own here. */
const markedInTest: CommitMarker = async () => ({ ok: true });

/* The app on a database the test opened, which closes after the app: test hooks run last first, and stopping the app can
   still write to it. */
export async function appOn(client: PGlite, env: NodeJS.ProcessEnv = {}, logger?: Deps['logger']): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const db = drizzle(client, { schema }) as unknown as Db;
  /* Tests never reach the real registry unless they ask. */
  const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', ...env });
  const app = await timed('setupMs', () => buildApp({ db, config, logger, agentSql: agentSqlOn(client), readCommit: atTestCommit, markCommit: markedInTest, readCompare: async () => ({ complete: true, baseSha: TEST_COMMIT, headSha: TEST_COMMIT, paths: [], diff: '' }) }));
  onTestFinished(() => timed('teardownMs', () => app.close()));
  return { app, db, config };
}

/* A worker of a new Development department asks the CEO to approve a merge, which only the CEO or the CEO delegate may. */
export async function approvalAsked(app: FastifyInstance) {
  const { db } = app.ctx;
  const [orchestrator] = await db.select().from(schema.agents).where(eq(schema.agents.kind, 'orchestrator'));
  const on = { companyId: orchestrator!.companyId, subscriptionId: orchestrator!.subscriptionId, model: '' };
  const [dev] = await db.insert(schema.departments).values({ companyId: on.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [head] = await db.insert(schema.agents).values({ ...on, kind: 'head', name: 'Head', roleKey: 'DEV-HEAD', departmentId: dev!.id }).returning();
  const [worker] = await db.insert(schema.agents).values({ ...on, kind: 'worker', name: 'Worker', roleKey: 'DEV-BE', departmentId: dev!.id }).returning();
  const { task } = await createTask(app.ctx, { agentId: head!.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: worker!.id, executor: true });
  return (await ask(app.ctx, worker!.id, task.id, { kind: 'approval', text: 'Merge?', commit: 'a'.repeat(40) })).request;
}

/* Moves these agents onto a new plan of this person's own: to see an agent one must own its plan and reach its department. */
export async function ownPlan(db: Db, email: string, ...agentIds: string[]): Promise<string> {
  const [person] = await db.select().from(schema.people).where(eq(schema.people.email, email));
  const [plan] = await db.insert(schema.subscriptions).values({ companyId: person!.companyId, provider: 'claude', kind: 'personal', label: `${person!.name}'s plan`, status: 'ready', ownerPersonId: person!.id }).returning();
  for (const id of agentIds) await db.update(schema.agents).set({ subscriptionId: plan!.id }).where(eq(schema.agents.id, id));
  return plan!.id;
}

/* Gives this person the plan the agent runs on, so it goes on running where it does. */
export async function takePlan(db: Db, email: string, agentId: string): Promise<void> {
  const [person] = await db.select().from(schema.people).where(eq(schema.people.email, email));
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  await db.update(schema.subscriptions).set({ ownerPersonId: person!.id }).where(eq(schema.subscriptions.id, agent!.subscriptionId!));
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

/* The next message of one kind a node gets, past the others. */
export async function nextOf<T extends ServerMessage['type']>(node: FakeNode, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const message = await node.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

/* Every node since skill files says in its hello that it writes them, so a stand-in says so too unless its test says
   otherwise. */
const withSkillFiles = (msg: NodeMessage): NodeMessage => (msg.type === 'hello' && msg.skillFiles === undefined ? { ...msg, skillFiles: true } : msg);

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
        send: msg => ws.send(JSON.stringify(withSkillFiles(msg))),
        next: () => (queue.length ? Promise.resolve(queue.shift()!) : new Promise(done => waiters.push(done))),
        acks,
        queued: () => queue.length,
        closed,
        close: () => ws.close(),
      }),
    );
  });
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
