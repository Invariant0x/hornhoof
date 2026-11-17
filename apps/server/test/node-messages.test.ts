import { createHmac, randomUUID } from 'node:crypto';
import { ACKS_HEADER } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import WebSocket from 'ws';
import type { Db } from '../src/db/client.js';
import { confirmCommits, NotConfirmed } from '../src/db/confirm.js';
import { agentEvents, agents, jobs } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { listed } from '../src/db/sources.js';
import { ApiError } from '../src/errors.js';
import { UNNAMED_BUILTIN } from '../src/modules/nodes/hub.js';
import { passing } from '../src/modules/nodes/numbered.js';
import { FakePgClient } from './fake-pg-client.js';
import { as, connectNode, listen, setLease, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;
const say = (app: FastifyInstance, token: string, text: string) => app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text }, ...as(token) });

async function nextRun(node: FakeNode): Promise<{ jobId: string }> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m;
}

/* The built-in node connected and greeted, numbering its messages within a stream unless the test says otherwise. */
async function live(stream: string | null = randomUUID()) {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  /* running: the turns the node says it still runs, as one that comes back in the middle of them does. */
  const connect = async (running: string[] = []): Promise<FakeNode> => {
    const node = await connectNode(url, NODE_KEY);
    onTestFinished(() => node.close());
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running, ...(stream ? { stream } : {}) });
    return node;
  };
  const builtin = await connect();
  await until(async () => (await state(app, ceo)).ready);
  /* A turn the orchestrator runs on the node. */
  const turn = async (node = builtin) => {
    await say(app, ceo, 'Hello');
    return nextRun(node);
  };
  return { app, db, url, ceo, builtin, connect, turn, stream };
}

const textsOf = async (db: Db, jobId: string): Promise<unknown[]> =>
  (await db.select(only(agentEvents, 'data')).from(agentEvents).where(sql`${agentEvents.jobId} = ${jobId} and ${agentEvents.kind} = 'text'`)).map(row => (row.data as { text: string }).text);
const word = (jobId: string, text: string, n?: number) => ({ type: 'job.event' as const, jobId, seq: n ?? 0, event: { kind: 'text' as const, text }, ...(n === undefined ? {} : { n }) });

/* The key the built-in node of that machine signs in with. */
const keyOf = (machine: string): string => `builtin.${machine}.${createHmac('sha256', NODE_KEY).update(`hornhoof builtin node ${machine}`).digest('hex')}`;
const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const hello = (running: string[] = []) => ({ type: 'hello' as const, version: '0.5.0', loggedIn: true, running });
const jobOf = async (db: Db, id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;

describe("each machine's built-in node", () => {
  it("keeps each built-in node's jobs apart", async () => {
    const c = await live(null);
    const other = await connectNode(c.url, keyOf(B));
    onTestFinished(() => other.close());
    other.send(hello());
    await until(() => c.app.ctx.hub.builtins().length === 2);
    /* One turn runs on the server's own built-in node, and one, of the same key, on the other machine's. */
    const { jobId: here } = await c.turn();
    const first = await jobOf(c.db, here);
    expect(first).toMatchObject({ status: 'running', builtinMachine: UNNAMED_BUILTIN });
    const [there] = await c.db.insert(jobs).values({ companyId: first.companyId, subscriptionId: first.subscriptionId, agentId: null, kind: 'test', prompt: 'x', timeoutMs: 60_000, status: 'running', startedAt: new Date(), builtinMachine: B }).returning();
    /* The other machine's node cannot end a job of this one, nor this one's a job of that. */
    other.send({ type: 'job.done', jobId: here, ok: true, sessionId: null, result: 'not mine', tail: '', error: null });
    c.builtin.send({ type: 'job.done', jobId: there!.id, ok: true, sessionId: null, result: 'not mine either', tail: '', error: null });
    /* The server's own comes back knowing of no job: its own turn is over, the other machine's goes on. */
    const back = await c.connect([]);
    await until(async () => (await jobOf(c.db, here)).status === 'failed');
    expect(await jobOf(c.db, here)).toMatchObject({ error: 'machine_restarted', result: null });
    expect(await jobOf(c.db, there!.id)).toMatchObject({ status: 'running', result: null });
    back.close();
  });

  it('keeps a turn across a planned switch', async () => {
    /* This server leads on machine B now. The turn went out on machine A, which led before and whose built-in node
       still runs it. */
    const { app, db } = await testApp({ NODE_KEY, HORNHOOF_MACHINE_ID: B });
    const url = await listen(app);
    const ceo = await setUpCompany(app);
    const own = await connectNode(url, keyOf(B));
    onTestFinished(() => own.close());
    own.send(hello());
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'Hello');
    const { jobId } = await nextRun(own);
    await db.update(jobs).set({ builtinMachine: A }).where(eq(jobs.id, jobId));
    /* Its node reaches the new leader and says it still runs the turn. */
    const old = await connectNode(url, keyOf(A));
    onTestFinished(() => old.close());
    old.send(hello([jobId]));
    await until(() => app.ctx.hub.builtins().length === 2);
    /* The new leader's own node, which knows nothing of it, takes nothing from it. */
    own.send(hello());
    own.send({ type: 'job.done', jobId, ok: true, sessionId: null, result: 'not mine', tail: '', error: null });
    old.send({ type: 'job.event', jobId, seq: 0, event: { kind: 'text', text: 'Still here.' } });
    await until(async () => (await textsOf(db, jobId)).length === 1);
    expect(await jobOf(db, jobId)).toMatchObject({ status: 'running', builtinMachine: A });
    old.send({ type: 'job.done', jobId, ok: true, sessionId: null, result: 'Done on A.', tail: '', error: null });
    await until(async () => (await jobOf(db, jobId)).status === 'done');
    expect((await jobOf(db, jobId)).result).toBe('Done on A.');
  });

  it("keeps an agent on its machine's built-in node", async () => {
    const c = await live(null);
    const other = await connectNode(c.url, keyOf(B));
    other.send(hello());
    await until(() => c.app.ctx.hub.builtins().length === 2);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const agent = async () => (await c.db.select().from(agents).where(eq(agents.id, orchestrator!.id)))[0]!;
    /* Its program is on machine B: its turn goes there, though the server's own node is ready too. */
    await c.db.update(agents).set({ builtinMachine: B }).where(eq(agents.id, orchestrator!.id));
    await say(c.app, c.ceo, 'Hello');
    const first = await nextRun(other);
    expect(await jobOf(c.db, first.jobId)).toMatchObject({ builtinMachine: B });
    expect((await agent()).builtinMachine).toBe(B);
    other.send({ type: 'job.done', jobId: first.jobId, ok: true, sessionId: 's-on-b', result: 'Hi.', tail: '', error: null });
    await until(async () => (await jobOf(c.db, first.jobId)).status === 'done');
    /* That machine is gone: the next turn goes to the server's own, as a move, with no session of the other machine. */
    other.close();
    await other.closed;
    await say(c.app, c.ceo, 'Again');
    const second = await nextRun(c.builtin) as { jobId: string; sessionId?: string | null };
    expect(second.sessionId ?? null).toBeNull();
    expect(await jobOf(c.db, second.jobId)).toMatchObject({ builtinMachine: UNNAMED_BUILTIN });
    expect((await agent()).builtinMachine).toBe(UNNAMED_BUILTIN);
    c.builtin.send({ type: 'job.done', jobId: second.jobId, ok: true, sessionId: 's-here', result: 'Hi again.', tail: '', error: null });
    await until(async () => (await jobOf(c.db, second.jobId)).status === 'done');
    /* With no built-in node there, its turns wait for a machine. */
    c.builtin.close();
    await c.builtin.closed;
    expect(await state(c.app, c.ceo)).toMatchObject({ ready: false, reason: 'machine_offline' });
  });
});

describe('numbered messages of a node', () => {
  it('says on the upgrade that it confirms them', async () => {
    const { url } = await live();
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${NODE_KEY}` } });
    onTestFinished(() => ws.close());
    const headers = await new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on('upgrade', res => resolve(res.headers));
      ws.on('error', reject);
    });
    expect(headers[ACKS_HEADER]).toBe('1');
  });

  it('applies a numbered message once, and confirms it each time it comes', async () => {
    const c = await live();
    const run = await c.turn();
    c.builtin.send(word(run.jobId, 'On it.', 5));
    c.builtin.send(word(run.jobId, 'On it.', 5));
    await until(() => c.builtin.upto.length === 2);
    expect(c.builtin.upto).toEqual([5, 5]);
    expect(await textsOf(c.db, run.jobId)).toEqual(['On it.']);
    expect(await listed(c.db, `node:builtin:${c.stream}:5`)).toMatchObject({ steps: 1, first: `node:builtin:${c.stream}:5:0` });
  });

  it("handles a job's end again when it is listed, and goes on from the steps it had", async () => {
    const c = await live();
    const run = await c.turn();
    const end = { type: 'job.done' as const, jobId: run.jobId, ok: false, sessionId: null, result: '', tail: '', error: 'agent_failed' as const, n: 7 };
    c.builtin.send(end);
    await until(() => c.builtin.upto.length === 1);
    const first = await listed(c.db, `node:builtin:${c.stream}:7`);
    c.builtin.send(end);
    await until(() => c.builtin.upto.length === 2);
    expect(c.builtin.upto).toEqual([7, 7]);
    expect(c.builtin.acks).toEqual([run.jobId, run.jobId]);
    expect((await c.db.select().from(jobs).where(eq(jobs.id, run.jobId)))[0]).toMatchObject({ status: 'failed', error: 'agent_failed' });
    expect((await listed(c.db, `node:builtin:${c.stream}:7`))!.next).toBeGreaterThanOrEqual(first!.next);
  });

  it('takes a message again after a failure that passes, and nothing that came after it', async () => {
    const c = await live();
    const run = await c.turn();
    await setLease(c.db, { until: '-infinity' });
    c.builtin.send(word(run.jobId, 'Eight.', 8));
    c.builtin.send(word(run.jobId, 'Nine.', 9));
    expect(await c.builtin.closed).toBe(1013);
    expect(c.builtin.upto).toEqual([]);
    await setLease(c.db, { until: 'infinity' });
    expect(await textsOf(c.db, run.jobId)).toEqual([]);

    const back = await c.connect([run.jobId]);
    back.send(word(run.jobId, 'Eight.', 8));
    back.send(word(run.jobId, 'Nine.', 9));
    await until(() => back.upto.length === 2);
    expect(back.upto).toEqual([8, 9]);
    expect(await textsOf(c.db, run.jobId)).toEqual(['Eight.', 'Nine.']);
  });

  it('talks to a node of the build before as it always did', async () => {
    const c = await live(null);
    const run = await c.turn();
    c.builtin.send(word(run.jobId, 'Twice.'));
    c.builtin.send(word(run.jobId, 'Twice.'));
    c.builtin.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 's1', result: 'ok', tail: '', error: null });
    await until(() => c.builtin.acks.includes(run.jobId));
    expect(c.builtin.upto).toEqual([]);
    expect(await textsOf(c.db, run.jobId)).toEqual(['Twice.', 'Twice.']);
    expect((await c.db.execute(sql`select 1 from applied`) as unknown as { rows: unknown[] }).rows).toEqual([]);
  });

  /* That a message still being handled finishes first is the hub's own test: here a message may or may not have come by
     the time the app stops, and one that has not is sent again by the node. */
  it('tells its nodes that the server is stopping, once what they sent is handled', async () => {
    const c = await live();
    const run = await c.turn();
    c.builtin.send(word(run.jobId, 'Before the stop.', 3));
    await until(() => c.builtin.upto.length === 1);
    await c.app.close();
    expect(await c.builtin.closed).toBe(1001);
    expect(await textsOf(c.db, run.jobId)).toEqual(['Before the stop.']);
  });
});

describe('a failure that passes', () => {
  const coded = (code: string) => Object.assign(new Error('x'), { code });
  /* The same failure as a query of the database throws it. */
  async function ofDatabase(code: string): Promise<unknown> {
    const client = new FakePgClient();
    confirmCommits(client.asPg);
    client.answer = { error: coded(code) };
    return client.asPg.query('SELECT 1').catch((err: unknown) => err);
  }

  it('is a lease refused, a commit not confirmed, a database busy or in conflict, or a 503 of the app', () => {
    for (const code of ['HHF01', '40001', '40P01', '55P03', '57P03', '53300', '08006', '08P01']) expect(passing(coded(code)), code).toBe(true);
    expect(passing(new NotConfirmed(new Error('ended')))).toBe(true);
    expect(passing(new ApiError(503, 'unavailable', 'x', 'starting'))).toBe(true);
    expect(passing(new Error('wrapped', { cause: coded('40P01') }))).toBe(true);
  });

  /* Any socket says these, so only the database's own count: a call to another service that stays down would otherwise
     hold a node's messages back for good. */
  it('is a database out of reach, and not the same words from anything else', async () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
      expect(passing(await ofDatabase(code)), code).toBe(true);
      expect(passing(new Error('wrapped', { cause: await ofDatabase(code) })), code).toBe(true);
      expect(passing(coded(code)), code).toBe(false);
    }
  });

  it('is no other failure', () => {
    for (const err of [new Error('broken'), coded('23505'), coded('42501'), new ApiError(409, 'conflict', 'x'), null, 'text']) expect(passing(err)).toBe(false);
  });
});
