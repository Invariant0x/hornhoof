import { MAX_INSTRUCTIONS, OLD_NODE_INSTRUCTIONS } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments, jobs, people, subscriptions, turns } from '../src/db/schema.js';
import { renderInstructions } from '../src/modules/agents/instructions.js';
import { FIRST_TURN, FIRST_TURN_TEMPLATE, ORCHESTRATOR_INSTRUCTIONS } from '../src/modules/conversation/prompt.js';
import { pumpWaiting } from '../src/modules/conversation/queue.js';
import { holdTurns } from '../src/modules/updates/drain.js';
import { as, connectNode, invitePerson, listen, openStream, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

type Run = { type: 'job.run'; jobId: string; prompt: string; sessionId: string | null; model: string | null; effort?: string | null; compactWindow?: number; instructions: string | null; toolToken: string | null; timeoutMs: number; skills?: { name: string }[] };

async function live() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], skillFiles: true });
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
    expect(run).toMatchObject({ prompt: FIRST_TURN, effort: 'xhigh', sessionId: null, timeoutMs: 2 * 3_600_000 });
    expect(run.instructions?.startsWith(ORCHESTRATOR_INSTRUCTIONS)).toBe(true);
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

  it('greets a company started from a template, so he offers to staff its departments', async () => {
    const { app, db, ceo, builtin } = await live();
    const [acme] = await db.select().from(companies);
    await db.update(companies).set({ template: 'studio' }).where(eq(companies.id, acme!.id));
    await db.insert(departments).values({ companyId: acme!.id, name: null, templateKey: 'development', roleCode: 'DEV' });
    expect((await start(app, ceo)).json()).toEqual({ started: true });
    expect((await nextRun(builtin)).prompt).toBe(FIRST_TURN_TEMPLATE);
    expect((await start(app, ceo)).json()).toEqual({ started: false });
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

  it('puts a turn back in line when sending it breaks, and sends it on the next try', async () => {
    const { app, db, ceo, builtin } = await live();
    const send = app.ctx.hub.send.bind(app.ctx.hub);
    let broke = false;
    vi.spyOn(app.ctx.hub, 'send').mockImplementation((id, m) => {
      if (m.type !== 'job.run' || broke) return send(id, m);
      broke = true;
      throw new Error('The socket is not open.');
    });
    expect((await start(app, ceo)).json()).toEqual({ started: true });
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({ status: 'queued', startedAt: null, toolTokenHash: null, prompt: FIRST_TURN });
    builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
    expect((await nextRun(builtin)).jobId).toBe(job!.id);
  });

  it('carries the company notebook in his instructions, and a new note keeps his session', async () => {
    const { app, ceo, builtin } = await live();
    await start(app, ceo);
    const first = await nextRun(builtin);
    expect(first.instructions).toContain('## Company notebook');
    expect(first.instructions).toContain('The notebook is empty.');
    await finish(builtin, first, 'sess-1');
    await app.inject({ method: 'POST', url: '/api/notebook', payload: { text: 'Commits are made by Ivan only.' }, ...as(ceo) });
    await say(app, ceo, 'Hi');
    const second = await nextRun(builtin);
    expect(second.sessionId).toBe('sess-1');
    expect(second.instructions).toContain('[#1] Commits are made by Ivan only.');
    expect(second.instructions).not.toContain('The notebook is empty.');
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

  it('goes on in the session of a turn that ran out of time or was stopped, and not of one that broke or never ran', async () => {
    const { app, db, ceo, builtin } = await live();
    await start(app, ceo);
    const first = await nextRun(builtin);
    builtin.send({ type: 'job.done', jobId: first.jobId, ok: false, sessionId: 'sess-1', result: '', tail: '', error: 'timeout' });
    await say(app, ceo, 'Go on');
    const second = await nextRun(builtin);
    expect(second.sessionId).toBe('sess-1');
    builtin.send({ type: 'job.done', jobId: second.jobId, ok: false, sessionId: 'sess-2', result: 'Stopped.', tail: '', error: 'cancelled' });
    await say(app, ceo, 'And on');
    const third = await nextRun(builtin);
    expect(third.sessionId).toBe('sess-2');
    builtin.send({ type: 'job.done', jobId: third.jobId, ok: false, sessionId: 'sess-3', result: '', tail: 'broken', error: 'agent_failed' });
    await until(async () => (await state(app, ceo)).busy === false);
    /* A turn called off while it waited for its machine. */
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    await db.insert(jobs).values({ companyId: orchestrator!.companyId, subscriptionId: orchestrator!.subscriptionId!, agentId: orchestrator!.id, kind: 'conversation', prompt: 'x', status: 'failed', error: 'cancelled', timeoutMs: 1000, finishedAt: new Date() });
    await say(app, ceo, 'Again');
    expect((await nextRun(builtin)).sessionId).toBe('sess-2');
  });

  it('sends two people\'s messages in the order they wrote', async () => {
    const { app, db, ceo, builtin } = await live();
    const olga = await invitePerson(app, ceo, { name: 'Olga', email: 'olga@acme.com', access: { whole: true } });
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
    expect(run.prompt).toContain('Ivan:\n> We sell shoes');
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

  it('stops a turn that was stopped while the machine was away, once it is back', async () => {
    const { app, url, ceo, builtin } = await live();
    await start(app, ceo);
    const run = await nextRun(builtin);
    builtin.close();
    await builtin.closed;
    await until(async () => (await app.inject({ method: 'POST', url: `/api/jobs/${run.jobId}/cancel`, ...as(ceo) })).statusCode === 202);
    await until(async () => (await events(app, ceo)).some((e: { kind: string }) => e.kind === 'stopped'));
    const back = await connectNode(url, NODE_KEY);
    back.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [run.jobId] });
    expect(await back.next()).toEqual({ type: 'job.cancel', jobId: run.jobId });
  });

  it('stops the jobs of a removed company key on the built-in node', async () => {
    const { app, db, ceo, builtin } = await live();
    await start(app, ceo);
    const run = await nextRun(builtin);
    const [key] = await db.select().from(subscriptions);
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${key!.id}`, ...as(ceo) })).statusCode).toBe(204);
    expect(await builtin.next()).toEqual({ type: 'job.cancel', jobId: run.jobId });
  });

  /* The orchestrator moves to Ivan's Claude plan on his Mac, whose node says hello with this version. */
  async function onMac(version: string, provider = 'claude', hello: object = {}) {
    const { app, url, ceo } = await live();
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: [provider] }, ...as(ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' } });
    const node = joined.json().nodes[0] as { subscriptionId: string; key: string };
    const mac = await connectNode(url, node.key);
    mac.send({ type: 'hello', version, loggedIn: true, running: [], ...hello });
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${node.subscriptionId}/orchestrator`, ...as(ceo) })).statusCode).toBe(200);
    return { app, url, ceo, mac, node };
  }

  it('keeps turns from a machine whose Hornhoof is too old to run them, and says so', async () => {
    const { app, url, ceo, mac, node } = await onMac('0.2.0');
    await until(async () => (await state(app, ceo)).reason === 'node_outdated');
    expect((await say(app, ceo, 'Hello')).statusCode).toBe(409);
    expect(await quiet(mac)).toBe(0);
    mac.close();
    await mac.closed;
    const updated = await connectNode(url, node.key);
    updated.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [] });
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'Hello');
    expect((await nextRun(updated)).prompt).toBe('Ivan (CEO): Hello');
  });

  it('lets a worker compact its conversation at half a million tokens, while heads and the orchestrator keep the full window', async () => {
    const { app, db, ceo, builtin } = await live();
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
      (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const hana = await hire('Hana', 'head', 'DEV-HEAD');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    const runOf = async (id: string) => {
      expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, payload: { text: 'Hi' }, ...as(ceo) })).statusCode).toBeLessThan(300);
      const run = await nextRun(builtin);
      await finish(builtin, run);
      return run;
    };
    expect((await runOf('orchestrator')).compactWindow).toBeUndefined();
    expect((await runOf(hana.id)).compactWindow).toBeUndefined();
    expect((await runOf(bruno.id)).compactWindow).toBe(500_000);
  });

  it("fits his xhigh to a Kimi plan, and keeps a person's pick in the same session", async () => {
    const models = [{ id: 'kimi-code/k3', name: 'K3', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }];
    const { app, ceo, mac } = await onMac('0.3.0', 'kimi', { models });
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'First');
    const first = await nextRun(mac);
    expect(first.effort).toBe('high');
    await finish(mac, first, 'sess-k');
    await until(async () => !(await state(app, ceo)).busy);
    const r = await app.inject({ method: 'PATCH', url: '/api/agents/orchestrator', payload: { effort: 'low' }, ...as(ceo) });
    expect(r.statusCode).toBe(200);
    await say(app, ceo, 'Second');
    expect(await nextRun(mac)).toMatchObject({ effort: 'low', sessionId: 'sess-k' });
  });

  it('runs him on a Codex plan at xhigh even when it takes more', async () => {
    const models = [{ id: 'gpt-6.1-sol', name: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'], defaultEffort: 'medium' }];
    const { app, ceo, mac } = await onMac('0.3.0', 'codex', { models });
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'First');
    expect((await nextRun(mac)).effort).toBe('xhigh');
  });

  it('tells a machine that writes no skill files every skill in the text, and one that writes them only their list', async () => {
    const { app, ceo, mac } = await onMac('0.5.0');
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'Hello');
    const old = await nextRun(mac);
    const plan = app.ctx.templates.skills.get('orch-plan-turn')!.body;
    expect(old.instructions).toContain(plan);
    expect(old.instructions).not.toContain('superpowers');
    expect(old.skills).toBeUndefined();
    const fresh = await onMac('0.5.0', 'claude', { skillFiles: true });
    await until(async () => (await state(fresh.app, fresh.ceo)).ready);
    await say(fresh.app, fresh.ceo, 'Hello');
    const run = await nextRun(fresh.mac);
    expect(run.instructions).not.toContain(plan);
    expect(run.skills?.map(s => s.name)).toContain('orch-plan-turn');
  });

  it("ends a turn too long for a machine from before skill files at once, saying its node needs an update", async () => {
    const { app, ceo, mac, node } = await onMac('0.5.0');
    const { db } = app.ctx;
    await until(async () => (await state(app, ceo)).ready);
    const [acme] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const base = 'x'.repeat(OLD_NODE_INSTRUCTIONS);
    const [bruno] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Bruno', model: '', departmentId: dev!.id, subscriptionId: node.subscriptionId, roleKey: 'DEV-BE', overrides: { base } }).returning();
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno!.id}/messages`, payload: { text: 'Hello' }, ...as(ceo) })).statusCode).toBe(202);
    await until(async () => (await db.select().from(jobs).where(eq(jobs.agentId, bruno!.id)))[0]?.status === 'failed');
    const [job] = await db.select().from(jobs).where(eq(jobs.agentId, bruno!.id));
    expect(job!.error).toBe('node_too_old');
    expect(job!.result).toMatch(/^This machine's node is too old for these instructions; update it\./);
    expect(await quiet(mac)).toBe(0);
  });

  it('keeps the next message waiting when the machine says its login ran out', async () => {
    const { app, ceo, mac } = await onMac('0.3.0');
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'First');
    const first = await nextRun(mac);
    await say(app, ceo, 'Second');
    mac.send({ type: 'job.done', jobId: first.jobId, ok: false, sessionId: null, result: '', tail: 'signed out', error: 'not_logged_in' });
    await until(async () => (await state(app, ceo)).reason === 'needs_login');
    expect(await quiet(mac)).toBe(0);
    expect((await state(app, ceo)).queued).toBe(1);
  });

  it("holds turns while the plan is at its limit, says until when, and sends them once the limit starts over", async () => {
    const { app, ceo, mac } = await onMac('0.3.0');
    await until(async () => (await state(app, ceo)).ready);
    const resetsAt = new Date(Date.now() + 1500).toISOString();
    mac.send({ type: 'status', loggedIn: true, limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] } });
    await until(async () => (await state(app, ceo)).limitUntil === resetsAt);
    expect((await say(app, ceo, 'Go on')).statusCode).toBe(202);
    expect(await quiet(mac)).toBe(0);
    expect((await state(app, ceo)).queued).toBe(1);
    expect((await nextRun(mac)).prompt).toBe('Ivan (CEO): Go on');
    expect((await state(app, ceo)).limitUntil).toBeNull();
  });

  it('waits quietly for a limit that starts over in more than 24 days, too long for one timer', async () => {
    const { app, ceo, mac } = await onMac('0.3.0');
    await until(async () => (await state(app, ceo)).ready);
    const overflows: string[] = [];
    const warned = (w: Error) => w.name === 'TimeoutOverflowWarning' && overflows.push(w.message);
    process.on('warning', warned);
    onTestFinished(() => void process.off('warning', warned));
    const resetsAt = new Date(Date.now() + 40 * 24 * 3600_000).toISOString();
    mac.send({ type: 'status', loggedIn: true, limits: { status: 'rejected', windows: [{ name: 'seven_day', utilization: 1, resetsAt }] } });
    await until(async () => (await state(app, ceo)).limitUntil === resetsAt);
    expect((await say(app, ceo, 'Go on')).statusCode).toBe(202);
    await new Promise(r => setTimeout(r, 300));
    expect(overflows).toEqual([]);
    expect((await state(app, ceo)).queued).toBe(1);
  });

  it('holds turns when the program said the plan ran out of its usage limit, though the plan itself said nothing', async () => {
    const { app, ceo, mac } = await onMac('0.3.0', 'kimi');
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'First');
    const first = await nextRun(mac);
    await say(app, ceo, 'Second');
    const tail = "Error: [provider.api_error] 429 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.\n\u276f ";
    mac.send({ type: 'job.done', jobId: first.jobId, ok: false, sessionId: 'sess-k', result: '', tail, error: 'agent_failed' });
    await until(async () => (await state(app, ceo)).limitUntil !== null);
    const wait = Date.parse((await state(app, ceo)).limitUntil!) - Date.now();
    /* Kimi says no time: Hornhoof tries again in a quarter of an hour. */
    expect(wait).toBeGreaterThan(14 * 60_000);
    expect(wait).toBeLessThanOrEqual(15 * 60_000);
    expect(await quiet(mac)).toBe(0);
    expect((await state(app, ceo)).queued).toBe(1);
    const [sub] = await app.ctx.db.select({ limits: subscriptions.limits }).from(subscriptions).where(eq(subscriptions.provider, 'kimi'));
    expect(sub!.limits).toMatchObject({ status: 'rejected', windows: [{ name: 'five_hour', utilization: 1 }] });
  });

  it.each([
    ['its error event', '{"type":"error","code":"provider.api_error","message":"You exceeded your current token quota","name":"APIProviderQuotaExhaustedError","details":{"statusCode":429,"requestId":null,"traceId":null},"retryable":false}\n'],
    ['its terminal', 'Error: [provider.api_error] 429 You exceeded your current token quota, please check your account balance\n❯ '],
  ])("holds turns when Kimi says in %s that the plan's quota ran out, and tries again in a quarter of an hour", async (_, tail) => {
    const { app, ceo, mac } = await onMac('0.3.0', 'kimi');
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'First');
    const first = await nextRun(mac);
    await say(app, ceo, 'Second');
    mac.send({ type: 'job.done', jobId: first.jobId, ok: false, sessionId: 'sess-k', result: '', tail, error: 'agent_failed' });
    await until(async () => (await state(app, ceo)).limitUntil !== null);
    const wait = Date.parse((await state(app, ceo)).limitUntil!) - Date.now();
    expect(wait).toBeGreaterThan(14 * 60_000);
    expect(wait).toBeLessThanOrEqual(15 * 60_000);
    expect(await quiet(mac)).toBe(0);
    expect((await state(app, ceo)).queued).toBe(1);
  });

  it('takes the time a program names for its usage limit to start over, and the map hears of it', async () => {
    const { app, ceo, mac } = await onMac('0.3.0', 'codex');
    await until(async () => (await state(app, ceo)).ready);
    const [company] = await app.ctx.db.select({ id: companies.id }).from(companies);
    const heard: string[] = [];
    app.ctx.bus.subscribe(company!.id, m => heard.push(m.type));
    await say(app, ceo, 'First');
    const first = await nextRun(mac);
    const tail = "ERROR: You've hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.";
    mac.send({ type: 'job.done', jobId: first.jobId, ok: false, sessionId: null, result: '', tail, error: 'agent_failed' });
    await until(async () => (await state(app, ceo)).limitUntil !== null);
    const wait = Date.parse((await state(app, ceo)).limitUntil!) - Date.now();
    expect(wait).toBeGreaterThan(124 * 60_000);
    expect(wait).toBeLessThanOrEqual(125 * 60_000);
    expect(heard).toContain('org');
  });

  it('does not hold turns for an agent that only spoke about usage limits in its work', async () => {
    const { app, ceo, mac } = await onMac('0.3.0', 'kimi');
    await until(async () => (await state(app, ceo)).ready);
    await say(app, ceo, 'First');
    const first = await nextRun(mac);
    const tail = "Wrote the test for the 429 usage limit message.\n" + 'x'.repeat(3000) + '\nThe build broke.';
    mac.send({ type: 'job.done', jobId: first.jobId, ok: false, sessionId: null, result: '', tail, error: 'agent_failed' });
    await until(async () => !(await state(app, ceo)).busy);
    expect((await state(app, ceo)).limitUntil).toBeNull();
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
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
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

describe("an employee's conversation", () => {
  const sayTo = (app: FastifyInstance, token: string, id: string, text: string) => app.inject({ method: 'POST', url: `/api/agents/${id}/messages`, payload: { text }, ...as(token) });
  const stateOf = async (app: FastifyInstance, token: string, id: string) => (await app.inject({ url: `/api/agents/${id}/events`, ...as(token) })).json().state;

  /* An employee in Development on the orchestrator's key, as hiring will make one. */
  async function withEmployee(kind: 'head' | 'worker' = 'worker') {
    const company = await live();
    const { db, app } = company;
    const [acme] = await db.select().from(companies);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, name: null, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: null, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const role = app.ctx.templates.roles.get(kind === 'head' ? 'DEV-HEAD' : 'DEV-BE')!;
    const hire = async (name: string, departmentId: string, subscriptionId: string | null = orchestrator!.subscriptionId) =>
      (
        await db
          .insert(agents)
          .values({ companyId: acme!.id, kind, name, model: 'sonnet', departmentId, subscriptionId, roleKey: role.id, skills: role.skills.filter(s => s.on).map(s => s.id) })
          .returning()
      )[0]!;
    return { ...company, dev: dev!, sales: sales!, hire, bruno: await hire('Bruno', dev!.id) };
  }

  async function inNewCompanyTurn(kind: 'head' | 'orchestrator') {
    const company = await withEmployee('head');
    const { app, db, ceo, builtin, bruno } = company;
    const id = kind === 'head' ? bruno.id : 'orchestrator';
    await sayTo(app, ceo, id, 'We agreed to support card payments.');
    await finish(builtin, await nextRun(builtin), 'sess-1');
    await until(async () => !(await stateOf(app, ceo, id)).busy);
    await db.insert(turns).values({ companyId: bruno.companyId, number: 1, goal: 'Card payments.', status: 'open', openedAt: new Date() });
    return { ...company, id };
  }

  it('ends a turn whose instructions are longer than a machine takes at once, saying so, and sends nothing', async () => {
    const { app, db, ceo, builtin, bruno } = await withEmployee();
    /* Saved before its header grew: Hornhoof refuses such an edit now. */
    await db.update(agents).set({ overrides: { base: 'x'.repeat(MAX_INSTRUCTIONS) } }).where(eq(agents.id, bruno.id));
    expect((await sayTo(app, ceo, bruno.id, 'What do you own?')).statusCode).toBe(202);
    const log = async () => (await app.inject({ url: `/api/agents/${bruno.id}/events`, ...as(ceo) })).json().events as { kind: string; data: object }[];
    await until(async () => (await log()).some(e => e.kind === 'failed'));
    expect((await log()).at(-1)).toMatchObject({ kind: 'failed', data: { error: 'instructions_too_long' } });
    const [job] = await db.select().from(jobs).where(eq(jobs.agentId, bruno.id));
    expect(job).toMatchObject({ status: 'failed', error: 'instructions_too_long' });
    expect(job!.result).toMatch(/^Bruno's instructions are \d+ characters, more than the 200000 a turn carries/);
    expect(await quiet(builtin)).toBe(0);
  });

  it('talks to an employee with its rendered instructions', async () => {
    const { app, db, ceo, builtin, bruno } = await withEmployee();
    const res = await sayTo(app, ceo, bruno.id, 'What do you own?');
    expect(res.statusCode).toBe(202);
    const run = await nextRun(builtin);
    const expected = renderInstructions(app.ctx.templates, bruno, { company: 'Acme', department: 'Development', product: null });
    expect(run).toMatchObject({ prompt: 'Ivan (CEO): What do you own?', instructions: expected.text, sessionId: null });
    expect(run.instructions).toContain('You are Bruno, the Backend engineer of the Development department at Acme.');
    /* Skills that are not core rules go as files the program reads when it needs them. */
    expect(expected.skills.length).toBeGreaterThan(0);
    expect(run.skills).toEqual(expected.skills);
    expect(run.toolToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, run.jobId));
    expect(job!.instructionsHash).toBe(expected.hash);
    const log = (await app.inject({ url: `/api/agents/${bruno.id}/events`, ...as(ceo) })).json().events;
    expect(log[0]).toMatchObject({ kind: 'message', data: { text: 'What do you own?' }, person: { name: 'Ivan' } });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/start`, ...as(ceo) })).json()).toEqual({ started: false });
  });

  it("starts a fresh session after the employee's instructions changed", async () => {
    const { app, db, ceo, builtin, bruno } = await withEmployee();
    await sayTo(app, ceo, bruno.id, 'Hello');
    await finish(builtin, await nextRun(builtin), 'sess-1');
    await sayTo(app, ceo, bruno.id, 'Still you?');
    const same = await nextRun(builtin);
    expect(same.sessionId).toBe('sess-1');
    await finish(builtin, same, 'sess-1');
    await until(async () => !(await stateOf(app, ceo, bruno.id)).busy);
    await db.update(agents).set({ overrides: { base: 'You own the billing API.' } }).where(eq(agents.id, bruno.id));
    await sayTo(app, ceo, bruno.id, 'And now?');
    const fresh = await nextRun(builtin);
    expect(fresh.sessionId).toBeNull();
    expect(fresh.instructions).toContain('You own the billing API.');
    expect(fresh.prompt).toMatch(/^Earlier in this conversation/);
    expect(fresh.prompt.endsWith('Ivan (CEO): And now?')).toBe(true);
  });

  it.each(['head', 'orchestrator'] as const)('keeps the %s session when a new turn of the company opens', async kind => {
    const { app, ceo, builtin, id } = await inNewCompanyTurn(kind);
    await sayTo(app, ceo, id, 'The new turn starts.');
    expect(await nextRun(builtin)).toMatchObject({ sessionId: 'sess-1', prompt: 'Ivan (CEO): The new turn starts.' });
  });

  it('catches up the head in a new company turn when its instructions changed', async () => {
    const { app, db, ceo, builtin, id } = await inNewCompanyTurn('head');
    await db.update(agents).set({ overrides: { base: 'Keep track of the billing agreements.' } }).where(eq(agents.id, id));
    await sayTo(app, ceo, id, 'The new turn starts.');
    const fresh = await nextRun(builtin);
    expect(fresh.sessionId).toBeNull();
    expect(fresh.instructions).toContain('Keep track of the billing agreements.');
    expect(fresh.prompt).toMatch(/^Earlier in this conversation/);
    expect(fresh.prompt).toContain('Ivan:\n> We agreed to support card payments.');
    expect(fresh.prompt.endsWith('Ivan (CEO): The new turn starts.')).toBe(true);
  });

  it('starts a member in a clean session when a new turn of the company opens, and goes on in it during the turn', async () => {
    const { app, db, ceo, builtin, bruno } = await withEmployee();
    await sayTo(app, ceo, bruno.id, 'Hello');
    await finish(builtin, await nextRun(builtin), 'sess-1');
    await until(async () => !(await stateOf(app, ceo, bruno.id)).busy);
    await db.insert(turns).values({ companyId: bruno.companyId, number: 1, goal: 'Card payments.', status: 'open', openedAt: new Date() });
    await sayTo(app, ceo, bruno.id, 'The new turn starts.');
    const fresh = await nextRun(builtin);
    expect(fresh.sessionId).toBeNull();
    expect(fresh.prompt).toBe('Ivan (CEO): The new turn starts.');
    await finish(builtin, fresh, 'sess-2');
    await until(async () => !(await stateOf(app, ceo, bruno.id)).busy);
    await sayTo(app, ceo, bruno.id, 'Still you?');
    expect((await nextRun(builtin)).sessionId).toBe('sess-2');
  });

  it('starts no turn of an employee while an update waits for the agents, and starts it once the wait is over', async () => {
    const { app, ceo, builtin, bruno } = await withEmployee();
    holdTurns(app.ctx, bruno.companyId, true);
    await sayTo(app, ceo, bruno.id, 'Hello');
    expect(await quiet(builtin)).toBe(0);
    holdTurns(app.ctx, bruno.companyId, false);
    await pumpWaiting(app.ctx);
    expect((await nextRun(builtin)).prompt).toContain('Hello');
  });

  it("lets a person with the department write to its employees and nobody else's", async () => {
    const { app, ceo, builtin, dev, sales, hire, bruno } = await withEmployee();
    const seller = await hire('Sam', sales.id);
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [dev.id] } });
    expect((await sayTo(app, maria, bruno.id, 'Hi Bruno')).statusCode).toBe(202);
    expect((await nextRun(builtin)).prompt).toBe('Maria: Hi Bruno');
    for (const res of [await sayTo(app, maria, seller.id, 'Hi Sam'), await app.inject({ url: `/api/agents/${seller.id}/events`, ...as(maria) })]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.reason).toBe('not_your_department');
    }
    expect((await sayTo(app, maria, 'orchestrator', 'Hi')).json().error.reason).toBe('company_scope_only');
    expect((await sayTo(app, ceo, '00000000-0000-4000-8000-000000000000', 'Hi')).statusCode).toBe(404);
  });

  it('runs an employee on its model, and a new model starts a fresh session', async () => {
    const { app, db, ceo, builtin, bruno } = await withEmployee();
    await sayTo(app, ceo, bruno.id, 'Hello');
    const first = await nextRun(builtin);
    expect(first.model).toBeNull();
    await finish(builtin, first, 'sess-1');
    await until(async () => !(await stateOf(app, ceo, bruno.id)).busy);
    expect((await app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { model: 'claude-opus-5-5' }, ...as(ceo) })).statusCode).toBe(200);
    await sayTo(app, ceo, bruno.id, 'And now?');
    const second = await nextRun(builtin);
    expect(second).toMatchObject({ model: 'claude-opus-5-5', sessionId: null });
    const [agent] = await db.select().from(agents).where(eq(agents.id, bruno.id));
    expect(agent!.model).toBe('claude-opus-5-5');
  });

  it("runs an employee at its role effort and keeps a person's pick in the same session", async () => {
    const { app, ceo, builtin, bruno } = await withEmployee();
    await sayTo(app, ceo, bruno.id, 'Hello');
    const first = await nextRun(builtin);
    expect(first.effort).toBe('xhigh');
    await finish(builtin, first, 'sess-1');
    await until(async () => !(await stateOf(app, ceo, bruno.id)).busy);
    expect((await app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { effort: 'max' }, ...as(ceo) })).statusCode).toBe(200);
    await sayTo(app, ceo, bruno.id, 'Think hard');
    const picked = await nextRun(builtin);
    expect(picked).toMatchObject({ effort: 'max', sessionId: 'sess-1' });
    await finish(builtin, picked);
    await until(async () => !(await stateOf(app, ceo, bruno.id)).busy);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/reset`, ...as(ceo) })).json().effort).toBeNull();
    await sayTo(app, ceo, bruno.id, 'Use the role again');
    expect((await nextRun(builtin)).effort).toBe('xhigh');
  });

  it.each([
    ['codex', 'DEV-BE', ['low', 'high', 'xhigh', 'ultra'], 'xhigh'],
    ['kimi', 'DEV-SEC', ['low', 'high', 'max'], 'high'],
    ['antigravity', 'DEV-BE', [], null],
  ])('runs a %s employee with role %s at its fitted effort', async (provider, roleKey, efforts, expected) => {
    const { app, db, ceo, builtin, bruno } = await withEmployee();
    const model = { id: 'test-model', name: 'Test model', efforts };
    await db.update(subscriptions).set({ provider, models: efforts.length ? [model] : [] }).where(eq(subscriptions.id, bruno.subscriptionId!));
    await db.update(agents).set({ roleKey, model: model.id }).where(eq(agents.id, bruno.id));
    await sayTo(app, ceo, bruno.id, 'Hello');
    expect((await nextRun(builtin)).effort).toBe(expected);
  });

  it('leaves a role without an effort at the program default', async () => {
    const { app, ceo, builtin, bruno } = await withEmployee();
    app.ctx.templates.roles.set('DEV-BE', { ...app.ctx.templates.roles.get('DEV-BE')!, effort: undefined });
    await sayTo(app, ceo, bruno.id, 'Hello');
    expect((await nextRun(builtin)).effort).toBeNull();
  });

  it('stops an employee while it works', async () => {
    const { app, ceo, builtin, bruno } = await withEmployee();
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/stop`, ...as(ceo) })).json().error.reason).toBe('nothing_running');
    await sayTo(app, ceo, bruno.id, 'Write a long essay');
    const run = await nextRun(builtin);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/stop`, ...as(ceo) })).statusCode).toBe(202);
    expect(await builtin.next()).toEqual({ type: 'job.cancel', jobId: run.jobId });
  });

  it('says why an employee without a subscription cannot answer', async () => {
    const { app, ceo, dev, hire } = await withEmployee();
    const idle = await hire('Ida', dev.id, null);
    expect(await stateOf(app, ceo, idle.id)).toMatchObject({ ready: false, reason: 'no_subscription' });
    const res = await sayTo(app, ceo, idle.id, 'Hello?');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.reason).toBe('agent_not_ready');
  });

  it('still talks to the orchestrator by its id as before', async () => {
    const { app, db, ceo, builtin } = await withEmployee();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect((await sayTo(app, ceo, orchestrator!.id, 'Hello')).statusCode).toBe(202);
    const run = await nextRun(builtin);
    expect(run.prompt).toBe('Ivan (CEO): Hello');
    expect(run.instructions?.startsWith(ORCHESTRATOR_INSTRUCTIONS)).toBe(true);
  });
});
