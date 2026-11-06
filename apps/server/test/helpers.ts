import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
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
import { setupCode } from '../src/modules/setup/code.js';
import { ask, createTask, type Ask, type Request } from '../src/modules/tasks/engine.js';
import { classifyComputerIntent, raiseComputerIntent } from '../src/modules/tasks/question-computer.js';
import { bindRequest, questionSourceKey } from '../src/modules/tasks/wait-producers.js';
import { endOpenSource } from '../src/modules/tasks/wait-state.js';
import { openTestDb, timed } from './helpers-db.js';
import { as, sessionFrom, TEST_SECRET } from './helpers-basic.js';
export { createTestDb, statements } from './helpers-db.js';
export { as, sessionFrom, TEST_SECRET, until } from './helpers-basic.js';

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

/* Runs first-run setup and returns the CEO's session token. */
/* Takes away the Operations every company gets at its setup, for a test that stages the departments it needs itself. */
export async function withoutOperations(db: Db): Promise<void> {
  const ops = await db.select({ id: schema.departments.id }).from(schema.departments).where(eq(schema.departments.templateKey, 'operations'));
  for (const { id } of ops) {
    const staff = await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.departmentId, id));
    for (const agent of staff) await db.delete(schema.agentChanges).where(eq(schema.agentChanges.agentId, agent.id));
    await db.delete(schema.agents).where(eq(schema.agents.departmentId, id));
    await db.delete(schema.departments).where(eq(schema.departments.id, id));
  }
}

/* A company with its orchestrator and nothing else, for a test about something other than Operations. A test about what
   people really get calls /api/setup itself. */
export async function setUpCompany(app: FastifyInstance): Promise<string> {
  const token = sessionFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: SETUP }));
  await withoutOperations(app.ctx.db);
  return token;
}

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
  return (await askedOfPerson(app.ctx, worker!.id, task.id, { kind: 'approval', text: 'Merge?', commit: 'a'.repeat(40) })).request;
}

/* A question already before a person. An agent's question gets there only through classify_human_intent, which
   question-lifecycle.test.ts and wait-producers.test.ts prove on the real route. Tests of what people read and answer start
   from here, with the row kept as a goal question is: for a person, unclassified, its wait on that person. */
export function beforePerson(ctx: { db: Db }, requestId: string): Promise<Request> {
  return ctx.db.transaction(async tx => {
    const [asked] = await tx.select().from(schema.requests).where(eq(schema.requests.id, requestId));
    if (asked!.audience !== 'internal' || asked!.status !== 'open') return asked!;
    const [held] = await tx.update(schema.requests).set({ audience: 'human', triageAgentId: null }).where(eq(schema.requests.id, requestId)).returning();
    const [task] = await tx.select().from(schema.tasks).where(eq(schema.tasks.id, held!.taskId));
    await tx.delete(schema.pendingWakes).where(and(eq(schema.pendingWakes.why, 'question'), eq(schema.pendingWakes.text, requestId)));
    const [inside] = await tx.delete(schema.taskWaits).where(and(eq(schema.taskWaits.taskId, task!.id), eq(schema.taskWaits.sourceKey, questionSourceKey(requestId)))).returning();
    await bindRequest(tx, task!, held!, { agentId: held!.agentId }, { plan: inside?.plan ?? undefined, strict: false });
    return held!;
  });
}

/* Every question still inside on this task, already before a person, for flows that ask through a tool. */
export async function allBeforePerson(ctx: { db: Db }, taskId: string): Promise<void> {
  const open = await ctx.db.select({ id: schema.requests.id }).from(schema.requests).where(and(eq(schema.requests.taskId, taskId), eq(schema.requests.status, 'open'), eq(schema.requests.audience, 'internal')));
  for (const { id } of open) await beforePerson(ctx, id);
}

/* Every card still inside, already before a person. classify_human_intent takes one there, as question-proposals.test.ts proves; a
   test of what comes after a person has it starts here. */
export const allCardsBeforePerson = (ctx: { db: Db }) => ctx.db.update(schema.proposals).set({ audience: 'human' }).where(and(eq(schema.proposals.status, 'pending'), eq(schema.proposals.audience, 'internal')));

/* The orchestrator's request for the computer before the CEO, the way it gets there. */
export async function computerBeforePerson(ctx: FastifyInstance['ctx'], reason: string) {
  const [orchestrator] = await ctx.db.select().from(schema.agents).where(eq(schema.agents.kind, 'orchestrator'));
  const { id: agentId, companyId, subscriptionId } = orchestrator!;
  const [job] = await ctx.db.insert(schema.jobs).values({ companyId, agentId, subscriptionId: subscriptionId!, kind: 'conversation', prompt: 'Work.', status: 'running', startedAt: new Date(), timeoutMs: 1000 }).returning();
  const by = { id: job!.id, agentId, companyId };
  const intent = await raiseComputerIntent(ctx, by, reason);
  await classifyComputerIntent(ctx, { jobId: job!.id, agentId, companyId }, { operationId: randomUUID(), source: { kind: 'computer_access', id: intent.id }, expectedRevision: 1, expectedRouteRevision: 1, classification: { kind: 'human_only_action', actionBinding: { kind: 'ceo_permission', resourceId: 'server' } }, humanEnvelope: { situation: reason, requiredAction: 'Open it or say no.', options: [] } });
  await ctx.db.update(schema.jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(schema.jobs.id, job!.id));
  return intent;
}

/* An agent asks, and the question is already before a person. */
export async function askedOfPerson(ctx: Parameters<typeof ask>[0], agentId: string, taskId: string, q: Ask) {
  const asked = await ask(ctx, agentId, taskId, q);
  return { ...asked, wakes: [], request: await beforePerson(ctx, asked.request.id) };
}

/* Invites a person, accepts the invite with a password and returns their session token. */
export async function invitePerson(app: FastifyInstance, ceoToken: string, input: { name: string; email: string; access: Access }): Promise<string> {
  const invited = await app.inject({ method: 'POST', url: '/api/people/invite', payload: { ...input, title: '' }, ...as(ceoToken) });
  if (invited.statusCode !== 201) throw new Error(`Invite failed with ${invited.statusCode}: ${invited.body}`);
  const token = new URL(invited.json().inviteUrl).pathname.split('/').pop()!;
  return sessionFrom(await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } }));
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
