import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people } from '../src/db/schema.js';
import { FIRST_TURN, ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';
import { as, connectNode, invitePerson, listen, openStream, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

type Run = { type: 'job.run'; jobId: string; prompt: string; sessionId: string | null; instructions: string | null; toolToken: string | null; timeoutMs: number };

async function live() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
  await until(async () => (await state(app, ceo)).ready);
  return { app, db, url, ceo, builtin };
}

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;
const events = async (app: FastifyInstance, token: string, after = 0) => (await app.inject({ url: `/api/agents/orchestrator/events?after=${after}`, ...as(token) })).json().events;
const start = (app: FastifyInstance, token: string) => app.inject({ method: 'POST', url: '/api/agents/orchestrator/start', ...as(token) });
const say = (app: FastifyInstance, token: string, text: string) => app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text }, ...as(token) });

async function nextRun(node: FakeNode): Promise<Run> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as Run;
}

/* The node takes the job, then finishes it with a session id. */
async function finish(node: FakeNode, run: Run, sessionId = 'sess-1') {
  node.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId, result: 'ok', tail: '', error: null });
}

const quiet = async (node: FakeNode) => {
  await new Promise(r => setTimeout(r, 150));
  return node.queued();
};

describe('the orchestrator\'s conversation', () => {
  it('starts with a greeting turn that carries his instructions and a tool token, once', async () => {
    const { app, ceo, builtin } = await live();
    expect((await start(app, ceo)).json()).toEqual({ started: true });
    const run = await nextRun(builtin);
    expect(run).toMatchObject({ prompt: FIRST_TURN, instructions: ORCHESTRATOR_INSTRUCTIONS, sessionId: null, timeoutMs: 900000 });
    expect(run.toolToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await start(app, ceo)).json()).toEqual({ started: false });
  });

  it('does not start over a company that already has departments', async () => {
    const { app, db, ceo, builtin } = await live();
    const [acme] = await db.select().from(companies);
    await db.insert(departments).values({ companyId: acme!.id, name: null, templateKey: 'operations', roleCode: 'OPS' });
    expect((await start(app, ceo)).json()).toEqual({ started: false });
    expect(await quiet(builtin)).toBe(0);
  });

  it('keeps what the agent does, in order, and streams it to the CEO', async () => {
    const { app, ceo, builtin } = await live();
    const stream = await openStream(app, ceo);
    await start(app, ceo);
    const run = await nextRun(builtin);
    builtin.send({ type: 'job.started', jobId: run.jobId });
    builtin.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'Hello, Ivan. What does Acme do?' } });
    builtin.send({ type: 'job.event', jobId: run.jobId, seq: 1, event: { kind: 'tool', name: 'hornhoof.company', input: '{}' } });
    await until(async () => (await events(app, ceo)).length === 2);
    const log = await events(app, ceo);
    expect(log.map((e: { kind: string }) => e.kind)).toEqual(['text', 'tool']);
    expect(log[0]).toMatchObject({ jobId: run.jobId, data: { kind: 'text', text: 'Hello, Ivan. What does Acme do?' } });
    expect(log[1].seq).toBeGreaterThan(log[0].seq);
    expect((await events(app, ceo, log[0].seq)).map((e: { kind: string }) => e.kind)).toEqual(['tool']);
    await until(() => stream.messages.filter(m => m.type === 'agent_event').length === 2);
  });

  it('queues a message while he works and sends it after, in the same session', async () => {
    const { app, ceo, builtin } = await live();
    await start(app, ceo);
    const first = await nextRun(builtin);
    expect((await say(app, ceo, 'We make characters for schools')).statusCode).toBe(202);
    expect(await state(app, ceo)).toMatchObject({ busy: true, queued: 1, runningJobId: first.jobId });
    expect(await quiet(builtin)).toBe(0);
    await finish(builtin, first, 'sess-1');
    const second = await nextRun(builtin);
    expect(second).toMatchObject({ prompt: 'Ivan (CEO): We make characters for schools', sessionId: 'sess-1' });
    const log = await events(app, ceo);
    expect(log.find((e: { kind: string }) => e.kind === 'message')).toMatchObject({ person: { name: 'Ivan' }, data: { text: 'We make characters for schools' }, jobId: second.jobId });
  });

  it('sends two people\'s messages in the order they wrote', async () => {
    const { app, db, ceo, builtin } = await live();
    const olga = await invitePerson(app, ceo, { name: 'Olga', email: 'olga@acme.com', scope: { kind: 'company' } });
    await db.update(people).set({ title: 'Deputy' }).where(eq(people.name, 'Olga'));
    await start(app, ceo);
    const first = await nextRun(builtin);
    await say(app, ceo, 'Schools first');
    await say(app, olga, 'And parents later');
    await finish(builtin, first);
    const second = await nextRun(builtin);
    expect(second.prompt).toBe('Ivan (CEO): Schools first');
    await finish(builtin, second);
    expect((await nextRun(builtin)).prompt).toBe('Olga (Deputy): And parents later');
  });

  it('opens a new session with the earlier conversation when he moves to another subscription', async () => {
    const { app, ceo, builtin } = await live();
    await start(app, ceo);
    await finish(builtin, await nextRun(builtin));
    await say(app, ceo, 'We sell shoes');
    await finish(builtin, await nextRun(builtin));
    const moved = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Second key', apiKey: 'sk-ant-api03-second-key-5678', target: { kind: 'orchestrator' } },
      ...as(ceo),
    });
    expect(moved.statusCode).toBe(201);
    await say(app, ceo, 'What next?');
    const run = await nextRun(builtin);
    expect(run.sessionId).toBeNull();
    expect(run.prompt).toMatch(/^Earlier in this conversation/);
    expect(run.prompt).toContain('Ivan: We sell shoes');
    expect(run.prompt.endsWith('Ivan (CEO): What next?')).toBe(true);
    expect(run.prompt.match(/What next\?/g)).toHaveLength(1);
  });

  it('fails the running turn when the machine restarted, and goes on with the next one', async () => {
    const { app, ceo, builtin } = await live();
    await start(app, ceo);
    await nextRun(builtin);
    await say(app, ceo, 'Still there?');
    builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
    const next = await nextRun(builtin);
    expect(next.prompt).toBe('Ivan (CEO): Still there?');
    expect((await events(app, ceo)).find((e: { kind: string }) => e.kind === 'failed')).toMatchObject({ data: { error: 'machine_restarted' } });
  });

  it('stops a running turn on request', async () => {
    const { app, ceo, builtin } = await live();
    await start(app, ceo);
    const run = await nextRun(builtin);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${run.jobId}/cancel`, ...as(ceo) })).statusCode).toBe(202);
    expect(await builtin.next()).toEqual({ type: 'job.cancel', jobId: run.jobId });
    builtin.send({ type: 'job.done', jobId: run.jobId, ok: false, sessionId: null, result: 'Stopped.', tail: '', error: 'cancelled' });
    await until(async () => (await events(app, ceo)).some((e: { kind: string }) => e.kind === 'stopped'));
    const again = await app.inject({ method: 'POST', url: `/api/jobs/${run.jobId}/cancel`, ...as(ceo) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('nothing_running');
  });

  it('waits for a machine that connected until it said hello', async () => {
    const { app } = await testApp({ NODE_KEY });
    const url = await listen(app);
    const ceo = await setUpCompany(app);
    const builtin = await connectNode(url, NODE_KEY);
    await new Promise(r => setTimeout(r, 100));
    expect(await state(app, ceo)).toMatchObject({ ready: false, reason: 'machine_offline' });
    expect((await start(app, ceo)).json()).toEqual({ started: false });
    builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
    await until(async () => (await state(app, ceo)).ready);
  });

  it('refuses a message while his machine is offline and says why', async () => {
    const { app, ceo, builtin } = await live();
    builtin.close();
    await until(async () => (await state(app, ceo)).ready === false);
    expect(await state(app, ceo)).toMatchObject({ ready: false, reason: 'machine_offline', busy: false });
    const res = await say(app, ceo, 'Hello?');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.reason).toBe('orchestrator_not_ready');
  });

  it('is only for people who see the whole company', async () => {
    const { app, db, ceo, builtin } = await live();
    await start(app, ceo);
    const run = await nextRun(builtin);
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', scope: { kind: 'department', id: sales!.id } });
    for (const res of [
      await app.inject({ url: '/api/agents/orchestrator/events', ...as(maria) }),
      await say(app, maria, 'hi'),
      await start(app, maria),
      await app.inject({ method: 'POST', url: `/api/jobs/${run.jobId}/cancel`, ...as(maria) }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('company_scope_only');
    }
    expect(await db.select().from(agents)).toHaveLength(1);
  });
});
