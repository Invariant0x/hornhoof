import type { ServerMessage } from '@hornhoof/protocol';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { eq } from 'drizzle-orm';
import { agents, companies, departments, jobs, people, subscriptions, tasks } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

type Screen = { ws: WebSocket; frames: { type: string; [k: string]: unknown }[]; closed: Promise<{ code: number; reason: string }> };

/* A person's browser watching an agent's terminal. */
function watch(url: string, token: string, agent = 'orchestrator', size = 'cols=100&rows=30'): Promise<Screen> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('/api/nodes/socket', `/api/agents/${agent}/terminal?${size}`), { headers: { cookie: `hh_session=${token}` } });
    const frames: Screen['frames'] = [];
    ws.on('message', data => frames.push(JSON.parse(String(data))));
    const closed = new Promise<{ code: number; reason: string }>(done => ws.on('close', (code, reason) => done({ code, reason: String(reason) })));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, frames, closed }));
  });
}

async function next<T extends ServerMessage['type']>(node: FakeNode, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const m = await node.next();
    if (m.type === type) return m as Extract<ServerMessage, { type: T }>;
  }
}

async function live(terminals = true, env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_KEY, ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals });
  await until(async () => (await state(app, ceo)).ready);
  const [orchestrator] = await db.select().from(agents);
  return { app, db, url, ceo, builtin, orchestratorId: orchestrator!.id };
}

const state = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().state;
const events = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().events;

describe("an agent's live terminal", () => {
  it('shows the screen from the node and passes on what the person types and the size of their window', async () => {
    const { url, ceo, builtin, orchestratorId } = await live();
    const screen = await watch(url, ceo);
    const open = await next(builtin, 'term.open');
    expect(open).toMatchObject({ agentKey: orchestratorId, cols: 100, rows: 30, write: true });
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: true });

    builtin.send({ type: 'term.data', termId: open.termId, data: '\u001b[1mhello\u001b[0m' });
    await until(() => screen.frames.length > 1);
    expect(screen.frames[1]).toEqual({ type: 'data', data: '\u001b[1mhello\u001b[0m' });

    screen.ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }));
    expect(await next(builtin, 'term.input')).toEqual({ type: 'term.input', termId: open.termId, data: 'ls\r' });
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    expect(await next(builtin, 'term.resize')).toEqual({ type: 'term.resize', termId: open.termId, cols: 132, rows: 40 });

    screen.ws.close();
    expect(await next(builtin, 'term.close')).toEqual({ type: 'term.close', termId: open.termId });
  });

  it("tells the browser whether the agent's program is up yet", async () => {
    const { url, ceo, builtin } = await live();
    const screen = await watch(url, ceo);
    const open = await next(builtin, 'term.open');
    builtin.send({ type: 'term.program', termId: open.termId, running: false });
    builtin.send({ type: 'term.program', termId: open.termId, running: true });
    await until(() => screen.frames.length > 2);
    expect(screen.frames.slice(1)).toEqual([{ type: 'program', running: false }, { type: 'program', running: true }]);
  });

  it('ends the view when the session on the node ends', async () => {
    const { url, ceo, builtin } = await live();
    const screen = await watch(url, ceo);
    const open = await next(builtin, 'term.open');
    builtin.send({ type: 'term.exit', termId: open.termId });
    expect(await screen.closed).toEqual({ code: 1000, reason: 'exit' });
  });

  it('ends the views of a node that went away', async () => {
    const { url, ceo, builtin } = await live();
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    builtin.close();
    expect(await screen.closed).toEqual({ code: 4410, reason: 'node_offline' });
  });

  it("tells the agent's window whether its node shows a terminal", async () => {
    const shown = await live();
    expect(await state(shown.app, shown.ceo)).toMatchObject({ terminal: true });
    const plain = await live(false);
    expect(await state(plain.app, plain.ceo)).toMatchObject({ terminal: false });
  });

  it("lets only the subscription's owner type: anyone else who reaches the agent watches", async () => {
    const { app, url, ceo, builtin } = await live();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.test', access: { whole: true } });
    const screen = await watch(url, maria);
    const open = await next(builtin, 'term.open');
    expect(open.write).toBe(false);
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: false });
    screen.ws.send(JSON.stringify({ type: 'input', data: '! cat /data/node.json\r' }));
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }));
    expect(await builtin.next()).toEqual({ type: 'term.resize', termId: open.termId, cols: 90, rows: 30 });
  });

  it('keeps the view trying while the node is away, instead of saying it has no terminal', async () => {
    const { url, ceo, builtin } = await live();
    builtin.close();
    await builtin.closed;
    const screen = await watch(url, ceo);
    expect(await screen.closed).toEqual({ code: 4410, reason: 'node_offline' });
  });

  it('ends the view when the agent moves to another subscription, so it opens again on the new node', async () => {
    const { db, url, ceo, builtin, orchestratorId } = await live(true, { STREAM_PING_MS: '100' });
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    const [ceoRow] = await db.select().from(people);
    const [acme] = await db.select().from(companies);
    const [mine] = await db.insert(subscriptions).values({ companyId: acme!.id, provider: 'claude', kind: 'personal', label: 'Claude', ownerPersonId: ceoRow!.id, status: 'ready' }).returning();
    await db.update(agents).set({ subscriptionId: mine!.id }).where(eq(agents.id, orchestratorId));
    expect(await screen.closed).toEqual({ code: 4410, reason: 'node_offline' });
    expect(await next(builtin, 'term.close')).toMatchObject({ type: 'term.close' });
  });

  it('says so when the node of the agent cannot show a terminal', async () => {
    const { url, ceo } = await live(false);
    const screen = await watch(url, ceo);
    expect(await screen.closed).toEqual({ code: 4404, reason: 'no_terminal' });
  });

  it('ignores screens and ends that a node sends for a view it does not show', async () => {
    const { url, ceo, builtin } = await live();
    const screen = await watch(url, ceo);
    const open = await next(builtin, 'term.open');
    builtin.send({ type: 'term.data', termId: 'someone-else', data: 'nope' });
    builtin.send({ type: 'term.exit', termId: 'someone-else' });
    builtin.send({ type: 'term.data', termId: open.termId, data: 'mine' });
    await until(() => screen.frames.length > 1);
    expect(screen.frames.slice(1)).toEqual([{ type: 'data', data: 'mine' }]);
  });

  it('drops what a browser sends that is not keys or a size', async () => {
    const { url, ceo, builtin } = await live();
    const screen = await watch(url, ceo);
    const open = await next(builtin, 'term.open');
    screen.ws.send('not json');
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 5000, rows: 1 }));
    screen.ws.send(JSON.stringify({ type: 'input', data: 'ok' }));
    expect(await next(builtin, 'term.input')).toEqual({ type: 'term.input', termId: open.termId, data: 'ok' });
  });

  it('is only for people who reach the agent', async () => {
    const { app, db, url, ceo } = await live();
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const seller = await invitePerson(app, ceo, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales!.id] } });
    await expect(watch(url, seller)).rejects.toThrow('HTTP 403');
    await expect(watch(url, 'not-a-session')).rejects.toThrow('HTTP 401');
  });
});

describe('a turn a person typed into the terminal', () => {
  it("opens as that person's message, runs with a tool token and goes on in the same session after", async () => {
    const { app, url, ceo, builtin, orchestratorId } = await live();
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/start', ...as(ceo) });
    const greeting = await next(builtin, 'job.run');
    builtin.send({ type: 'job.done', jobId: greeting.jobId, ok: true, sessionId: 'sess-1', result: 'Hi', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);

    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'what do we sell\r' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'what do we sell', ref: 'r-7' });
    const opened = await next(builtin, 'turn.opened');
    expect(opened).toMatchObject({ agentKey: orchestratorId, jobId: expect.any(String), toolToken: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/), ref: 'r-7' });
    expect(await state(app, ceo)).toMatchObject({ busy: true, runningJobId: opened.jobId });
    const message = (await events(app, ceo)).find((e: { kind: string }) => e.kind === 'message');
    expect(message).toMatchObject({ jobId: opened.jobId, data: { text: 'what do we sell' }, person: { name: expect.any(String) } });

    const tools = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${opened.toolToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(tools.statusCode).toBe(200);

    builtin.send({ type: 'job.event', jobId: opened.jobId!, seq: 0, event: { kind: 'text', text: 'Software.' } });
    builtin.send({ type: 'job.done', jobId: opened.jobId!, ok: true, sessionId: 'sess-1', result: 'Software.', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    expect((await events(app, ceo)).some((e: { kind: string; data: { text?: string } }) => e.kind === 'text' && e.data.text === 'Software.')).toBe(true);

    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'thanks' }, ...as(ceo) });
    expect(await next(builtin, 'job.run')).toMatchObject({ sessionId: 'sess-1' });
  });

  it('counts as typed by a person only when they pressed Enter in the terminal', async () => {
    const { app, url, ceo, builtin, orchestratorId } = await live();
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: '\u001b[<64;10;5M' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'from the machine itself' });
    const first = await next(builtin, 'turn.opened');
    builtin.send({ type: 'job.done', jobId: first.jobId!, ok: true, sessionId: 's', result: 'ok', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    screen.ws.send(JSON.stringify({ type: 'input', data: 'hi\r' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'hi' });
    await next(builtin, 'turn.opened');
    const said = (await events(app, ceo)).filter((e: { kind: string }) => e.kind === 'message');
    expect(said.map((e: { data: { text: string }; person: unknown }) => [e.data.text, e.person !== null])).toEqual([
      ['from the machine itself', false],
      ['hi', true],
    ]);
  });

  it('is not opened while another turn runs, or for an agent the node does not run', async () => {
    const { app, ceo, builtin, orchestratorId } = await live();
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/start', ...as(ceo) });
    await next(builtin, 'job.run');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'hi' });
    expect(await next(builtin, 'turn.opened')).toEqual({ type: 'turn.opened', agentKey: orchestratorId, jobId: null, toolToken: null });
    builtin.send({ type: 'turn.open', agentKey: 'not-an-agent', text: 'hi' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null });
    builtin.send({ type: 'turn.open', agentKey: '00000000-0000-4000-8000-000000000000', text: 'hi' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null });
  });
});

describe('starting an agent for someone who opens its window to talk', () => {
  it('starts the program with a turn that types nothing, and the next turn catches up in it', async () => {
    const { app, ceo, builtin, orchestratorId } = await live();
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'what do we sell' }, ...as(ceo) });
    const earlier = await next(builtin, 'job.run');
    builtin.send({ type: 'job.event', jobId: earlier.jobId, seq: 0, event: { kind: 'text', text: 'Software.' } });
    builtin.send({ type: 'job.done', jobId: earlier.jobId, ok: true, sessionId: null, result: 'Software.', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);

    builtin.send({ type: 'agent.start', agentKey: orchestratorId });
    const start = await next(builtin, 'job.run');
    expect(start).toMatchObject({ prompt: '', sessionId: null });
    /* What was said before goes with the instructions, for what the person types into the new session. */
    expect(start.context).toContain('Earlier in this conversation');
    expect(start.context).toContain('what do we sell');
    builtin.send({ type: 'job.done', jobId: start.jobId, ok: true, sessionId: null, result: '', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    expect((await events(app, ceo)).filter((e: { kind: string }) => e.kind === 'message')).toHaveLength(1);

    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'thanks' }, ...as(ceo) });
    const later = await next(builtin, 'job.run');
    expect(later.sessionId).toBeNull();
    expect(later.prompt).toContain('Earlier in this conversation');
    expect(later.prompt).toContain('thanks');
  });

  it('starts a switched-off employee whose task turns wait for it to be on', async () => {
    const { db, builtin, orchestratorId } = await live();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.id, orchestratorId));
    const [dept] = await db.insert(departments).values({ companyId: orchestrator!.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator!.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dept!.id, model: '', subscriptionId: orchestrator!.subscriptionId, switchedOffAt: new Date() })
      .returning();
    const [task] = await db.insert(tasks).values({ companyId: orchestrator!.companyId, number: 1, title: 'Checkout API', assigneeAgentId: bruno!.id }).returning();
    await db.insert(jobs).values({ companyId: orchestrator!.companyId, subscriptionId: orchestrator!.subscriptionId, agentId: bruno!.id, taskId: task!.id, kind: 'conversation', prompt: 'Do #1.', timeoutMs: 900000 });
    builtin.send({ type: 'agent.start', agentKey: bruno!.id });
    expect(await next(builtin, 'job.run')).toMatchObject({ prompt: '' });
  });

  it('lets a person who types while the program starts take over its start turn', async () => {
    const { app, db, ceo, builtin, orchestratorId } = await live();
    builtin.send({ type: 'agent.start', agentKey: orchestratorId });
    const start = await next(builtin, 'job.run');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'add a department', ref: 'r-1' });
    const opened = await next(builtin, 'turn.opened');
    expect(opened).toMatchObject({ jobId: expect.any(String), toolToken: expect.any(String), ref: 'r-1' });
    expect((await db.select().from(jobs).where(eq(jobs.id, start.jobId)))[0]).toMatchObject({ status: 'done' });
    /* The node's own end of the start turn comes after, and changes nothing. */
    builtin.send({ type: 'job.done', jobId: start.jobId, ok: true, sessionId: null, result: '', tail: '', error: null });
    await new Promise(r => setTimeout(r, 300));
    expect(await state(app, ceo)).toMatchObject({ busy: true, runningJobId: opened.jobId });
    expect((await events(app, ceo)).filter((e: { kind: string }) => e.kind === 'message').map((e: { data: { text: string } }) => e.data.text)).toEqual(['add a department']);
  });

  it('starts nothing while a turn waits or runs, or for an agent it does not know', async () => {
    const { app, db, ceo, builtin, orchestratorId } = await live();
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'hello' }, ...as(ceo) });
    await next(builtin, 'job.run');
    builtin.send({ type: 'agent.start', agentKey: orchestratorId });
    builtin.send({ type: 'agent.start', agentKey: 'not-an-agent' });
    builtin.send({ type: 'agent.start', agentKey: '00000000-0000-4000-8000-000000000000' });
    await new Promise(r => setTimeout(r, 300));
    expect(await db.select().from(jobs)).toHaveLength(1);
  });
});
