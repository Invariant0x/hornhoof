import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { PGlite } from '@electric-sql/pglite';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { onTestFinished } from 'vitest';
import { buildApp, type Deps } from '../src/app.js';
import type { CommitMarker } from '../src/modules/testruns/github-status.js';
import type { RepositoryCreator } from '../src/modules/departments/repo-hosts.js';
import type { IssueCreator } from '../src/modules/feedback/github-issue.js';
import type { ModelsReader } from '../src/modules/subscriptions/api-models.js';
import type { BranchCreator, CommitReader } from '../src/modules/testruns/refs.js';
import { loadConfig, type Config } from '../src/config.js';
import { gated, PRE_COMMIT, PUBLIC_REVOKES, readerGrantsFor, readerRole, type AgentSql, PRE_COMMIT_SETTINGS, RECORD_CALL } from '../src/db/agent-sql.js';
import type { Db } from '../src/db/client.js';
import type { LeaseKind, LeaseSync } from '../src/db/net.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import { LINK_SESSION_COOKIE } from '../src/auth/session.js';
import * as schema from '../src/db/schema.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { openTestDb, timed } from './helpers-db.js';
import { TEST_SECRET } from './helpers-basic.js';
import { templatesFor } from './templates-once.js';
import { listenAt } from '../../../test-support/ports.mjs';
import { recordSources } from '../src/db/sources.js';
export { createTestDb, fixture, ownDatabases, statements } from './helpers-db.js';
export { as, sessionFrom, TEST_SECRET, until } from './helpers-basic.js';

export { TEST_API_KEY, SETUP, appFixture, withoutOperations, setUpCompany, invitePerson } from './helpers-company.js';

type LeaseChange = { until?: string; kind?: LeaseKind; sync?: LeaseSync | null; termNumber?: number };
const LEASE_COLUMNS: Record<keyof LeaseChange, string> = { until: 'until', kind: 'kind', sync: 'sync', termNumber: 'term_number' };

/* Changes what the test database's lease says. The until is a timestamptz as text: '-infinity' or an ISO time. */
export async function setLease(db: Db, change: LeaseChange): Promise<void> {
  const columns = (Object.keys(change) as (keyof LeaseChange)[]).map(name => sql`${sql.identifier(LEASE_COLUMNS[name])} = ${change[name] ?? null}`);
  await db.execute(sql`UPDATE net_local.lease SET ${sql.join(columns, sql`, `)}`);
}

/* One test database seen both ways: as the app's code reads it, and as the keeper's plain statements do. */
export async function createTestSql(): Promise<{ db: Db; sql: Sql }> {
  const { client, db } = await timed('setupMs', openTestDb);
  onTestFinished(() => timed('teardownMs', () => client.close()));
  const sql: Sql = { query: async <R>(text: string, params?: unknown[]) => ({ rows: (params ? (await client.query<R>(text, params)).rows : ((await client.exec(text)).at(-1)?.rows ?? [])) as R[] }) };
  return { db, sql };
}

/* The tunnel container's address in tests: start the app with testApp({ TUNNEL_HOST: TUNNEL }). */
export const TUNNEL = '192.0.2.10';

/* A request that came over https through the tunnel container, as a visitor of the public link sends it. */
export const viaLink = (token?: string) => ({
  remoteAddress: TUNNEL,
  headers: { 'x-forwarded-proto': 'https' },
  cookies: (token ? { [LINK_SESSION_COOKIE]: token } : {}) as Record<string, string>,
});

/* Agents' database access on PGlite. PGlite has one user, a superuser, which is Hornhoof's own as the orchestrator's is;
   Operations' role is taken with SET LOCAL ROLE: its rights hold, though a statement could take the superuser back, which
   on Postgres a separate sign-in rules out. */
export function agentSqlOn(client: PGlite): AgentSql {
  const reader = readerRole('postgres');
  let granted: Promise<unknown> | null = null;
  return {
    run: async (text, mode, call) => {
      granted ??= client.exec(`${PUBLIC_REVOKES};\n${readerGrantsFor(reader)}`);
      await granted;
      return gated(mode, () => client.transaction(async tx => {
        if (mode === 'read') await tx.query('SET TRANSACTION READ ONLY');
        if (mode === 'read') await tx.query(`SET LOCAL ROLE "${reader}"`);
        const answers = (await tx.exec(text)).map(r => ({ rows: r.rows as Record<string, unknown>[], changed: r.affectedRows ?? 0 }));
        if (mode === 'write' && call) {
          await tx.exec(PRE_COMMIT_SETTINGS);
          await tx.query(RECORD_CALL, [call.invocation, call.jobId, JSON.stringify(call.answer(answers))]);
        } else if (mode === 'write') await tx.exec(PRE_COMMIT);
        return answers;
      }));
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
/* Nor does a test create a repository on GitHub: one that does answers for it here. */
const noGitHost: RepositoryCreator = async () => ({ problem: 'Tests reach no git host.' });
/* Nor do they open an issue there: one that does puts its own GitHub here. */
const noIssues: IssueCreator = async () => ({ problem: 'Tests reach no git host.' });
/* Nor do they push a branch to any host: a test that makes one says what its repository does with it. */
const noBranches: BranchCreator = async () => ({ problem: 'Tests reach no git host.' });
/* Nor any API's list of models: a test that loads one answers through ctx.readModels. */
const noApis: ModelsReader = async () => ({ ok: false, reason: 'unreachable' });

/* The app on a database the test opened, which closes after the app: test hooks run last first, and stopping the app can
   still write to it. */
export async function appOn(client: PGlite, env: NodeJS.ProcessEnv = {}, logger?: Deps['logger']): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const db = recordSources(drizzle(client, { schema }) as unknown as Db);
  /* Tests never reach the real registry or a real CA unless they ask. */
  const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', ACME_DIRECTORY: 'off', ...env });
  const app = await timed('setupMs', () => buildApp({ db, config, logger, templates: templatesFor(config), agentSql: agentSqlOn(client), readCommit: atTestCommit, markCommit: markedInTest, createRepository: noGitHost, createIssue: noIssues, readModels: noApis, readCompare: async () => ({ complete: true, baseSha: TEST_COMMIT, headSha: TEST_COMMIT, paths: [], diff: '' }), readTree: async () => ({ complete: false, reason: 'no-repository-in-tests' }), readBranches: async () => ({ heads: {} }), createBranch: noBranches, readTags: async () => ({ tags: {} }), readMerged: async () => null }));
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
/* The open turn every top-level department runs, for departments a test made straight in the database: one for each that
   runs none, numbered on in the order of the departments. Gives the first. */
export async function echelonsTurn(db: Db, companyId: string): Promise<typeof schema.turns.$inferSelect> {
  const [last] = await db.select({ number: schema.turns.number }).from(schema.turns).where(eq(schema.turns.companyId, companyId)).orderBy(desc(schema.turns.number)).limit(1);
  const running = new Set((await db.select({ id: schema.turns.departmentId }).from(schema.turns).where(and(eq(schema.turns.companyId, companyId), eq(schema.turns.status, 'open')))).map(t => t.id));
  const tops = (await db.select().from(schema.departments).where(and(eq(schema.departments.companyId, companyId), isNull(schema.departments.parentId))).orderBy(asc(schema.departments.position), asc(schema.departments.createdAt), asc(schema.departments.id))).filter(d => !running.has(d.id));
  if (!tops.length) {
    /* Departments made through the API got their open turn as they were made. */
    const [open] = await db.select().from(schema.turns).where(and(eq(schema.turns.companyId, companyId), eq(schema.turns.status, 'open'))).orderBy(asc(schema.turns.number)).limit(1);
    if (open) return open;
    throw new Error('A turn belongs to a top-level department: make one before opening a turn.');
  }
  const opened = await db.insert(schema.turns).values(tops.map((d, i) => ({ companyId, departmentId: d.id, number: (last?.number ?? 0) + 1 + i, goal: 'Checked work', status: 'open' as const, openedAt: new Date() }))).returning();
  return opened.sort((a, b) => a.number - b.number)[0]!;
}

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
  /* Up to which number each confirmation of numbered messages went, in the order they came. */
  upto: number[];
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
    const upto: number[] = [];
    ws.on('message', data => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.type === 'job.ack') return void acks.push(msg.jobId);
      if (msg.type === 'ack') return void upto.push(msg.upto);
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
        upto,
        queued: () => queue.length,
        closed,
        close: () => ws.close(),
      }),
    );
  });
}

/* Starts the app on a free local port and returns the node socket address. */
export async function listen(app: FastifyInstance): Promise<string> {
  await listenAt(port => app.listen({ host: '127.0.0.1', port }));
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
