import { randomUUID } from 'node:crypto';
import { PRIVATE_TOOL_NOTE } from '@hornhoof/protocol';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import type { Db } from '../src/db/client.js';
import { agentEvents, agents, companies, jobs, machines, nodes, people, subscriptions } from '../src/db/schema.js';
import { applyParkedMessages, handleNodeMessage } from '../src/modules/nodes/messages.js';
import { ownBuiltin } from '../src/modules/nodes/hub.js';
import { applyParked, mergePending, park, parkedJobs, pendingChanged } from '../src/modules/nodes/parked.js';
import { thisMachine } from '../src/modules/network/store.js';
import { setUpCompany, testApp } from './helpers.js';

type Parked = { job_id: string; kind: string; node: unknown; body: { type?: string }; applied_at: string | null };
/* The built-in node of the server the tests run. */
const BUILTIN = ownBuiltin({ machineId: 'b1c2d3e4'.repeat(4) });
const rowsOf = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => ((await db.execute(query)) as unknown as { rows: T[] }).rows;

/* A company on the machine that leads now, with the machine the server was taken from, and the orchestrator, whose
   turns the server's own node runs. */
async function stand() {
  const { app, db, config } = await testApp({ HORNHOOF_MACHINE_ID: 'b1c2d3e4'.repeat(4) });
  await setUpCompany(app);
  const ctx = app.ctx;
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const here = await thisMachine(db, config, acme!.id);
  const [old] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'old-leader', hostname: 'deb', kind: 'computer', role: 'data', networkId: 'a'.repeat(64) }).returning();
  const send = vi.spyOn(ctx.hub, 'send').mockReturnValue(true);
  vi.spyOn(ctx.hub, 'isReady').mockReturnValue(false);
  const handed = async (kind: 'takeover' | 'ceo' | 'planned', at = new Date()) => {
    await db.execute(sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, kind)
      VALUES (gen_random_uuid(), ${old!.id}, 7, 'a', '0/1', ${here.id}, ${at.toISOString()}::timestamptz, ${kind})`);
    pendingChanged(db);
  };
  const merge = async (status: string, at = new Date()) => {
    await db.execute(sql`INSERT INTO net.merges (source, label, status, machine, created_at) VALUES (${`machine:${old!.id}:led-7`}, 'deb', ${status}, ${old!.id}, ${at.toISOString()}::timestamptz)
      ON CONFLICT (source) DO UPDATE SET status = excluded.status, created_at = excluded.created_at`);
    pendingChanged(db);
  };
  const pending = () => (pendingChanged(db), mergePending(db));
  const parked = () => rowsOf<Parked>(db, sql`SELECT job_id::text AS job_id, kind, node, body, applied_at FROM net.parked ORDER BY at, id`);
  const job = async (set: Partial<typeof jobs.$inferInsert> = {}) =>
    (await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900_000, status: 'running', startedAt: new Date(), ...set }).returning())[0]!;
  const jobNow = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];
  const hello = (running: string[]) => handleNodeMessage(ctx, BUILTIN, { type: 'hello', version: '0.18.10', loggedIn: true, running });
  const cancelled = () => send.mock.calls.filter(([, msg]) => msg.type === 'job.cancel').map(([, msg]) => (msg as { jobId: string }).jobId);
  const acked = () => send.mock.calls.filter(([, msg]) => msg.type === 'job.ack').map(([, msg]) => (msg as { jobId: string }).jobId);
  return { app, db, ctx, old: old!, here, handed, merge, pending, parked, job, jobNow, hello, cancelled, acked, send };
}

const done = (jobId: string, over: object = {}) => ({ type: 'job.done' as const, jobId, ok: true, result: 'Done over there.', tail: 'the end', error: null, sessionId: 'session-1', ...over });
const event = (jobId: string, text: string, seq = 0) => ({ type: 'job.event' as const, jobId, seq, event: { kind: 'text' as const, text } });

describe('jobs of the machine the server was taken from', () => {
  it('knows when a merge is pending', async () => {
    const s = await stand();
    expect(await s.pending()).toBe(false);
    await s.handed('planned');
    expect(await s.pending()).toBe(false);
    const at = new Date(Date.now() - 60_000);
    await s.handed('takeover', at);
    expect(await s.pending()).toBe(true);
    /* What that machine led is merged only by a merge made after the takeover, and only once it ended. */
    await s.merge('applied');
    expect(await s.pending()).toBe(true);
    await s.merge('merged', new Date(at.getTime() - 1000));
    expect(await s.pending()).toBe(true);
    await s.merge('merged');
    expect(await s.pending()).toBe(false);
    await s.merge('pending');
    expect(await s.pending()).toBe(true);
    /* A machine that came back with a new copy and no database of before, as one that was wiped, brings nothing. */
    await s.db.update(machines).set({ copyState: 'ready', copyAt: new Date(), copyOld: null }).where(eq(machines.id, s.old.id));
    expect(await s.pending()).toBe(false);
    await s.db.update(machines).set({ copyOld: 2 }).where(eq(machines.id, s.old.id));
    expect(await s.pending()).toBe(true);
    await s.db.update(machines).set({ copyOld: null, copyAt: new Date(at.getTime() - 1000) }).where(eq(machines.id, s.old.id));
    expect(await s.pending()).toBe(true);
    /* Nor does one that stopped holding the data, or left the company. */
    await s.db.update(machines).set({ role: 'worker' }).where(eq(machines.id, s.old.id));
    expect(await s.pending()).toBe(false);
    await s.db.update(machines).set({ role: 'data', revokedAt: new Date() }).where(eq(machines.id, s.old.id));
    expect(await s.pending()).toBe(false);
  });

  it('reads it at most once a second', async () => {
    const s = await stand();
    expect(await mergePending(s.db, 1000)).toBe(false);
    await s.db.execute(sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, kind) VALUES (gen_random_uuid(), ${s.old.id}, 7, 'a', '0/1', ${s.here.id}, now(), 'ceo')`);
    expect(await mergePending(s.db, 1999)).toBe(false);
    expect(await mergePending(s.db, 2000)).toBe(true);
  });

  it('keeps a job running that it does not know', async () => {
    const s = await stand();
    const [unknown, ended, waiting] = [randomUUID(), (await s.job({ status: 'failed', error: 'cancelled', finishedAt: new Date() })).id, (await s.job({ status: 'queued', startedAt: null })).id];
    /* With nothing to wait for, a job nobody knows is stopped, as ever. */
    await s.hello([unknown]);
    expect(s.cancelled()).toEqual([unknown]);
    expect(await s.parked()).toEqual([]);
    s.send.mockClear();
    await s.handed('takeover');
    await s.hello([unknown, ended, waiting]);
    expect(s.cancelled()).toEqual([ended]);
    expect(await s.parked()).toMatchObject([{ job_id: unknown, kind: 'listed', node: BUILTIN, applied_at: null }]);
    /* The one that waited in the queue here runs on that node from now, so it is never sent out again. */
    expect(await s.jobNow(waiting)).toMatchObject({ status: 'running' });
    await s.hello([unknown]);
    expect(await s.parked()).toHaveLength(1);
    expect(await parkedJobs(s.db)).toEqual(new Map([[unknown, BUILTIN]]));
  });

  it("keeps a turn that waits here running on the personal node that says it runs it, and only a turn of that node's plan", async () => {
    const s = await stand();
    const [acme] = await s.db.select().from(companies);
    const [owner] = await s.db.select().from(people).where(eq(people.isOwner, true));
    const plans = await s.db.insert(subscriptions).values([
      { companyId: acme!.id, ownerPersonId: owner!.id, provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready' },
      { companyId: acme!.id, ownerPersonId: owner!.id, provider: 'claude', kind: 'personal', label: 'Another', status: 'ready' },
    ]).returning();
    const [node] = await s.db.insert(nodes).values({ companyId: acme!.id, machineId: s.old.id, subscriptionId: plans[0]!.id, keyHash: 'laptop', status: 'ready', version: '0.18.10' }).returning();
    const [other] = await s.db.insert(nodes).values({ companyId: acme!.id, machineId: s.old.id, subscriptionId: plans[1]!.id, keyHash: 'desktop', status: 'ready', version: '0.18.10' }).returning();
    const laptop = { kind: 'node' as const, nodeId: node!.id };
    /* Turns wait in the queue with no node: the machine that led sent these out after its last change reached here. */
    const mine = (await s.job({ status: 'queued', startedAt: null, subscriptionId: plans[0]!.id })).id;
    const foreign = (await s.job({ status: 'queued', startedAt: null, subscriptionId: plans[1]!.id })).id;
    const elsewhere = (await s.job({ status: 'queued', startedAt: null, subscriptionId: plans[0]!.id, nodeId: other!.id })).id;
    await s.handed('takeover');
    await handleNodeMessage(s.ctx, laptop, { type: 'hello', version: '0.18.10', loggedIn: true, running: [mine, foreign, elsewhere] });
    expect(await s.jobNow(mine)).toMatchObject({ status: 'running', nodeId: node!.id });
    /* A turn of another plan, or one that names another node, is not this node's to run. */
    expect(await s.jobNow(foreign)).toMatchObject({ status: 'queued', nodeId: null });
    expect(await s.jobNow(elsewhere)).toMatchObject({ status: 'queued', nodeId: other!.id });
    expect(s.cancelled().sort()).toEqual([foreign, elsewhere].sort());
  });

  it('parks what an unknown job sends', async () => {
    const s = await stand();
    await s.handed('ceo');
    const id = randomUUID();
    const agentKey = randomUUID();
    await handleNodeMessage(s.ctx, BUILTIN, { type: 'job.started', jobId: id });
    await handleNodeMessage(s.ctx, BUILTIN, event(id, 'Working over there.'));
    await handleNodeMessage(s.ctx, BUILTIN, { type: 'agent.restarted', agentKey, jobId: id, ok: true, reason: null });
    await handleNodeMessage(s.ctx, BUILTIN, done(id));
    expect((await s.parked()).map(row => [row.kind, row.body.type])).toEqual([['started', 'job.started'], ['event', 'job.event'], ['event', 'agent.restarted'], ['done', 'job.done']]);
    expect(s.acked()).toEqual([id]);
    /* What a job this Hornhoof knows sends is handled at once. */
    const known = await s.job();
    await handleNodeMessage(s.ctx, BUILTIN, done(known.id));
    expect(await s.jobNow(known.id)).toMatchObject({ status: 'done', result: 'Done over there.' });
    expect(await s.parked()).toHaveLength(4);
  });

  it('parks nothing while no merge is pending', async () => {
    const s = await stand();
    const id = randomUUID();
    await handleNodeMessage(s.ctx, BUILTIN, { type: 'job.started', jobId: id });
    await handleNodeMessage(s.ctx, BUILTIN, done(id));
    expect(await s.parked()).toEqual([]);
  });

  it('asks a tool call to wait', async () => {
    const s = await stand();
    const call = (token: string) => s.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    const tokens = { unknown: 'tool-token-unknown-0123456789abcdef', queued: 'tool-token-queued-0123456789abcdef', ended: 'tool-token-ended-0123456789abcdef0' };
    await s.job({ status: 'queued', startedAt: null, toolTokenHash: hashToken(tokens.queued) });
    await s.job({ status: 'done', finishedAt: new Date(), toolTokenHash: hashToken(tokens.ended) });
    for (const token of Object.values(tokens)) expect((await call(token)).statusCode, token).toBe(401);
    await s.handed('takeover');
    for (const token of [tokens.unknown, tokens.queued]) {
      const refused = await call(token);
      expect([refused.statusCode, refused.json().error.reason, refused.headers['retry-after']], token).toEqual([503, 'merge_pending', '60']);
    }
    expect((await call(tokens.ended)).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).statusCode).toBe(401);
  });

  it('applies what it parked once the job is there', async () => {
    const s = await stand();
    await s.handed('takeover');
    const id = randomUUID();
    await s.hello([id]);
    await handleNodeMessage(s.ctx, BUILTIN, { type: 'job.started', jobId: id });
    await handleNodeMessage(s.ctx, BUILTIN, event(id, 'Working over there.'));
    await handleNodeMessage(s.ctx, BUILTIN, done(id));
    /* Nothing to apply while the job's row is not there. */
    expect(await applyParkedMessages(s.ctx)).toBe(0);
    /* The merge brought the row, open, on the node that listed it. */
    await s.job({ id });
    expect(await applyParkedMessages(s.ctx)).toBe(3);
    /* Kept while this server had no row of the turn, its words come masked: whether the turn used a vault value, and
       which, came only with its database, so nothing raw of it was kept (7645605b, "Keep vault values out of replay and
       turn records"). The job still ends, with its session and its events. */
    expect(await s.jobNow(id)).toMatchObject({ status: 'done', result: PRIVATE_TOOL_NOTE, sessionId: 'session-1' });
    const events = await s.db.select().from(agentEvents).where(eq(agentEvents.jobId, id));
    expect(events.some(row => JSON.stringify(row.data).includes(PRIVATE_TOOL_NOTE))).toBe(true);
    const kept = JSON.stringify([await s.jobNow(id), events, await s.parked()]);
    for (const raw of ['Working over there.', 'Done over there.', 'the end']) expect(kept).not.toContain(raw);
    expect((await s.parked()).every(row => row.applied_at !== null)).toBe(true);
    expect(await applyParkedMessages(s.ctx)).toBe(0);
  });

  it('goes on from the message that failed', async () => {
    const s = await stand();
    await s.handed('takeover');
    const id = randomUUID();
    await handleNodeMessage(s.ctx, BUILTIN, { type: 'job.started', jobId: id });
    await handleNodeMessage(s.ctx, BUILTIN, event(id, 'Working over there.'));
    await handleNodeMessage(s.ctx, BUILTIN, done(id));
    await s.job({ id, status: 'queued', startedAt: null });
    let calls = 0;
    /* The second message fails: it is not marked, and nothing after it is tried. */
    const applied = await applyParked(s.ctx, async (app, node, msg) => {
      calls += 1;
      if (calls === 2) throw new Error('the database went away');
      /* The app itself handles it, so what it keeps by the app, as a wait for words, is where the app looks. */
      expect(app).toBe(s.ctx);
      await handleNodeMessage(app, node, msg);
    });
    expect([applied, calls]).toEqual([1, 2]);
    expect(await s.jobNow(id)).toMatchObject({ status: 'running' });
    expect(await s.db.select().from(agentEvents).where(eq(agentEvents.jobId, id))).toEqual([]);
    expect((await s.parked()).map(row => row.applied_at !== null)).toEqual([true, false, false]);
    expect(await applyParkedMessages(s.ctx)).toBe(2);
    expect(await s.jobNow(id)).toMatchObject({ status: 'done' });
    expect(await s.db.select().from(agentEvents).where(eq(agentEvents.jobId, id))).toHaveLength(1);
  });

  it('keeps once that a node lists a job, whoever says so', async () => {
    const s = await stand();
    const id = randomUUID();
    await park(s.db, { jobId: id, node: BUILTIN, kind: 'listed', body: {} });
    await park(s.db, { jobId: id, node: { kind: 'node', nodeId: randomUUID(), keyHash: 'k' }, kind: 'listed', body: {} });
    const other = { kind: 'node' as const, nodeId: randomUUID() };
    await park(s.db, { jobId: id, node: { ...other, keyHash: 'never kept' }, kind: 'started', body: { type: 'job.started', jobId: id } });
    expect((await s.parked()).map(row => row.kind)).toEqual(['listed', 'started']);
    /* The node that said it started is where it runs, and nothing of its key is kept. */
    expect(await parkedJobs(s.db)).toEqual(new Map([[id, other]]));
  });
});
