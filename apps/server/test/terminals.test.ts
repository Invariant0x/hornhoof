import { UNHEARD_MS } from '@hornhoof/protocol';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { asc, eq } from 'drizzle-orm';
import { agents, companies, departments, jobs, people, requests, subscriptions, tasks } from '../src/db/schema.js';
import { decisionPrincipal, withInputLock } from '../src/modules/conversation/decision-context.js';
import { enqueueTurn, openTypedTurn, pump } from '../src/modules/conversation/queue.js';
import { BUILTIN } from './builtin.js';
import { approvalAsked, as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until, takePlan } from './helpers.js';
import { nextOf as next } from './helpers.js';
import { handled } from './terminal-company.js';

const NODE_KEY = 'k'.repeat(40);
const IVAN_TO_ORCHESTRATOR = 'From Ivan (CEO) to Orchestrator:\n\n';

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

/* The orchestrator runs on a plan Zed lent: Zed, who may take no decision, is the one who types in its terminal. */
async function lent() {
  const at = await live();
  const zed = await invitePerson(at.app, at.ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
  const [z] = await at.db.select().from(people).where(eq(people.name, 'Zed'));
  await at.db.update(subscriptions).set({ ownerPersonId: z!.id });
  return { ...at, zed, zedId: z!.id };
}

/* Marks the person the CEO delegate, as the CEO does on the People screen. */
const delegate = (app: FastifyInstance, ceo: string, personId: string) => app.inject({ method: 'PUT', url: `/api/people/${personId}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(ceo) });
const say = (app: FastifyInstance, token: string, agent: string, text: string) => app.inject({ method: 'POST', url: `/api/agents/${agent}/messages`, payload: { text }, ...as(token) });
const jobOf = async (app: FastifyInstance, id: string) => (await app.ctx.db.select({ createdBy: jobs.createdBy, answersCeo: jobs.answersCeo }).from(jobs).where(eq(jobs.id, id)))[0];

/* The orchestrator runs on Zed's plan, and Clara is the CEO delegate: she writes to it and steers nothing. */
async function withDelegate() {
  const at = await lent();
  const clara = await invitePerson(at.app, at.ceo, { name: 'Clara', email: 'clara@example.com', access: { whole: true } });
  const [l] = await at.db.select().from(people).where(eq(people.name, 'Clara'));
  expect((await delegate(at.app, at.ceo, l!.id)).statusCode).toBe(200);
  return { ...at, clara, claraId: l!.id };
}

/* Bruno works in Development on the plan the orchestrator runs on, which is not Maria's, and Sam in Sales. */
async function withEmployees() {
  const at = await lent();
  const [orchestrator] = await at.db.select().from(agents);
  const place = (name: string, roleCode: string) => at.db.insert(departments).values({ companyId: orchestrator!.companyId, name, roleCode }).returning();
  const [dev] = await place('Development', 'DEV');
  const [sales] = await place('Sales', 'SAL');
  const hire = (name: string, departmentId: string) => at.db.insert(agents).values({ companyId: orchestrator!.companyId, kind: 'worker', name, model: 'sonnet', departmentId, subscriptionId: orchestrator!.subscriptionId }).returning();
  const [bruno] = await hire('Bruno', dev!.id);
  const [sam] = await hire('Sam', sales!.id);
  const maria = await invitePerson(at.app, at.ceo, { name: 'Maria', email: 'maria@example.com', access: { departments: [dev!.id] } });
  const [m] = await at.db.select().from(people).where(eq(people.name, 'Maria'));
  return { ...at, bruno: bruno!, sam: sam!, maria, mariaId: m!.id };
}

describe("writing to an agent on the plan of someone else", () => {
  it('opens the turn in the name of the CEO delegate, as answering the CEO, though the delegate does not own the plan', async () => {
    const { app, url, builtin, clara, claraId } = await withDelegate();
    const screen = await watch(url, clara);
    await next(builtin, 'term.open');
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: false, message: true });
    expect(await state(app, clara)).toMatchObject({ terminal: true, ready: true });

    const said = await say(app, clara, 'orchestrator', 'Please check the release');
    expect(said.statusCode).toBe(202);
    const run = await next(builtin, 'job.run');
    expect(run.prompt).toContain('From Clara');
    expect(run.prompt).toContain('Please check the release');
    expect(await jobOf(app, said.json().jobId)).toEqual({ createdBy: claraId, answersCeo: true });
    const message = (await events(app, clara)).find((e: { kind: string; jobId: string | null }) => e.kind === 'message' && e.jobId === said.json().jobId);
    expect(message).toMatchObject({ data: { text: 'Please check the release' }, person: { name: 'Clara' } });
  });

  it('marks a running turn as answering the CEO once the delegate writes into it', async () => {
    const { app, builtin, zed, clara } = await withDelegate();
    const first = await say(app, zed, 'orchestrator', 'Start the work');
    const jobId = first.json().jobId as string;
    await next(builtin, 'job.run');
    expect(await jobOf(app, jobId)).toMatchObject({ answersCeo: false });
    const delivered = say(app, clara, 'orchestrator', 'And check the release');
    const words = await next(builtin, 'agent.say');
    builtin.send({ type: 'agent.said', ref: words.ref, ok: true });
    expect((await delivered).json().jobId).toBe(jobId);
    expect(await jobOf(app, jobId)).toMatchObject({ answersCeo: true });
  });

  it('opens the turn the CEO delegate types into the terminal of their own plan as answering the CEO', async () => {
    const { app, url, builtin, ceo, orchestratorId, zed, zedId } = await lent();
    await delegate(app, ceo, zedId);
    const screen = await watch(url, zed);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'what do we sell\r' }));
    expect(await next(builtin, 'term.input')).toMatchObject({ data: 'what do we sell\r' });
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'what do we sell', ref: 'r-1' });
    const opened = await next(builtin, 'turn.opened');
    expect(await jobOf(app, opened.jobId!)).toEqual({ createdBy: zedId, answersCeo: true });
  });

  it('opens the turn in the name of a person of the department who owns the plan, without answering the CEO', async () => {
    const { app, db, url, builtin, bruno, maria, mariaId } = await withEmployees();
    await takePlan(db, 'maria@example.com', bruno.id);
    const screen = await watch(url, maria, bruno.id);
    expect((await next(builtin, 'term.open')).write).toBe(true);
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: true, message: true });
    const said = await say(app, maria, bruno.id, 'Please check the cart');
    expect(said.statusCode).toBe(202);
    const run = await next(builtin, 'job.run');
    expect(run.prompt).toContain('From Maria to Bruno');
    expect(await jobOf(app, said.json().jobId)).toEqual({ createdBy: mariaId, answersCeo: false });
  });

  describe.each([
    ['a CEO delegate mark without the whole company', { scopeKind: 'listed' as const }],
    ['a CEO delegate who is switched off', { status: 'disabled' as const }],
    ['a CEO delegate who has not come in yet', { status: 'invited' as const }],
  ])('gives no answers_ceo to %s', (_, change) => {
    it('on a turn their message opens or goes into', async () => {
      const { app, builtin, db, orchestratorId, claraId } = await withDelegate();
      await db.update(people).set(change).where(eq(people.id, claraId));
      const [agent] = await db.select().from(agents).where(eq(agents.id, orchestratorId));
      const message = { companyId: agent!.companyId, agentId: orchestratorId, prompt: 'Hi', createdBy: claraId, message: { personId: claraId, text: 'Hi' } };
      const first = await enqueueTurn(app.ctx, message);
      await next(builtin, 'job.run');
      expect(await jobOf(app, first)).toEqual({ createdBy: claraId, answersCeo: false });
      const delivered = enqueueTurn(app.ctx, message);
      const words = await next(builtin, 'agent.say');
      builtin.send({ type: 'agent.said', ref: words.ref, ok: true });
      expect(await delivered).toBe(first);
      expect(await jobOf(app, first)).toEqual({ createdBy: claraId, answersCeo: false });
    });

    it('on a turn they type', async () => {
      const { app, db, orchestratorId, claraId } = await withDelegate();
      await db.update(people).set(change).where(eq(people.id, claraId));
      const opened = await openTypedTurn(app.ctx, BUILTIN, orchestratorId, 'Typed words', claraId);
      expect(await jobOf(app, opened!.jobId)).toEqual({ createdBy: claraId, answersCeo: false });
    });
  });

  it('turns a switched off CEO delegate away from the window, and opens no turn', async () => {
    const { app, db, clara, claraId } = await withDelegate();
    const before = (await db.select().from(jobs)).length;
    await db.update(people).set({ status: 'disabled' }).where(eq(people.id, claraId));
    expect((await say(app, clara, 'orchestrator', 'Hi')).statusCode).toBe(401);
    expect(await db.select().from(jobs)).toHaveLength(before);
  });

  it('gives a person with a department and a CEO delegate mark no answers_ceo in the window, as anyone of the department', async () => {
    const { app, db, bruno, maria, mariaId } = await withEmployees();
    await db.update(people).set({ isCeoDelegate: true }).where(eq(people.id, mariaId));
    await takePlan(db, 'maria@example.com', bruno.id);
    const said = await say(app, maria, bruno.id, 'Please check the cart');
    expect(said.statusCode).toBe(202);
    expect(await jobOf(app, said.json().jobId)).toEqual({ createdBy: mariaId, answersCeo: false });
  });

  it('turns away someone without the right to write, on every door of the window, and opens no turn', async () => {
    const { app, url, db, sam, maria } = await withEmployees();
    const turnsBefore = (await db.select().from(jobs)).length;
    for (const [agent, reason] of [[sam.id, 'agent_hidden'], ['orchestrator', 'agent_hidden']] as const) {
      for (const res of [await say(app, maria, agent, 'Hi'), await app.inject({ url: `/api/agents/${agent}/events`, ...as(maria) }), await app.inject({ url: `/api/agents/${agent}`, ...as(maria) })]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.reason).toBe(reason);
      }
      await expect(watch(url, maria, agent)).rejects.toThrow('HTTP 403');
    }
    expect(await db.select().from(jobs)).toHaveLength(turnsBefore);
  });

  it('tells the window who types into the terminal, as the terminal itself says', async () => {
    const { app, url, builtin, zed, clara } = await withDelegate();
    for (const [person, owner] of [[zed, true], [clara, false]] as const) {
      expect((await state(app, person)).canType).toBe(owner);
      const screen = await watch(url, person);
      expect((await next(builtin, 'term.open')).write).toBe(true);
      await until(() => screen.frames.length > 0);
      expect(screen.frames[0]).toEqual({ type: 'ready', write: owner, message: true });
    }
  });

  it('tells the owner of the plan they type, and a person with the department on another plan that they watch and do not type', async () => {
    const { app, url, builtin, bruno, zed, maria } = await withEmployees();
    const read = (person: string) => app.inject({ url: `/api/agents/${bruno.id}/events`, ...as(person) });
    /* Everyone given the department sees its employees on whoever's plan; the program types for its plan's owner alone. */
    expect((await read(maria)).json().state.canType).toBe(false);
    const screen = await watch(url, maria, bruno.id);
    await next(builtin, 'term.open');
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: false, message: true });
    await takePlan(app.ctx.db, 'zed@example.com', bruno.id);
    await app.ctx.db.update(people).set({ isCeoDelegate: true }).where(eq(people.name, 'Zed'));
    expect((await read(zed)).json().state.canType).toBe(true);
  });

  it('goes by the plan the running turn is on when the agent moved to another plan mid-turn', async () => {
    const { app, db, url, builtin, ceo, zed, zedId, orchestratorId } = await lent();
    /* The CEO delegate sees the agent whichever plan it is on: this is about who types, not who sees. */
    await delegate(app, ceo, zedId);
    const [agent] = await db.select().from(agents).where(eq(agents.id, orchestratorId));
    const [running] = await db.insert(jobs).values({ companyId: agent!.companyId, subscriptionId: agent!.subscriptionId!, agentId: orchestratorId, kind: 'conversation', prompt: 'A long turn.', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [mine] = await db.insert(subscriptions).values({ companyId: agent!.companyId, provider: 'claude', kind: 'personal', label: 'Claude', ownerPersonId: owner!.id, status: 'ready' }).returning();
    await db.update(agents).set({ subscriptionId: mine!.id }).where(eq(agents.id, orchestratorId));
    expect((await state(app, zed)).canType).toBe(true);
    expect((await state(app, ceo)).canType).toBe(false);
    await watch(url, zed);
    expect((await next(builtin, 'term.open')).write).toBe(true);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, running!.id));
    expect((await state(app, zed)).canType).toBe(false);
    expect((await state(app, ceo)).canType).toBe(true);
  });

  it("still takes the keys that steer from the subscription's owner alone", async () => {
    const { url, builtin, zed, clara } = await withDelegate();
    const writing = await watch(url, clara);
    await next(builtin, 'term.open');
    const steering = await watch(url, zed);
    const owner = await next(builtin, 'term.open');
    writing.ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
    steering.ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
    expect(await next(builtin, 'term.input')).toEqual({ type: 'term.input', termId: owner.termId, data: '\x03' });
  });
});

describe("an agent's live terminal", () => {
  it('shows the screen from the node and passes on what the person types and the size of their window', async () => {
    const { url, ceo, builtin, orchestratorId } = await live();
    const screen = await watch(url, ceo);
    const open = await next(builtin, 'term.open');
    expect(open).toMatchObject({ agentKey: orchestratorId, cols: 100, rows: 30, write: true });
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: true, message: true });

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

  it("tells the browser that the agent's program sleeps until its next turn", async () => {
    const { url, ceo, builtin } = await live();
    const screen = await watch(url, ceo);
    const open = await next(builtin, 'term.open');
    builtin.send({ type: 'term.program', termId: open.termId, running: false, asleep: true });
    builtin.send({ type: 'term.program', termId: open.termId, running: false });
    await until(() => screen.frames.length > 2);
    expect(screen.frames.slice(1)).toEqual([{ type: 'program', running: false, asleep: true }, { type: 'program', running: false }]);
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

  it("lets only the subscription's owner steer: a CEO delegate who sees the agent writes", async () => {
    const { app, db, url, ceo, builtin } = await live();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.test', access: { whole: true } });
    await db.update(people).set({ isCeoDelegate: true }).where(eq(people.name, 'Maria'));
    const screen = await watch(url, maria);
    const open = await next(builtin, 'term.open');
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: false, message: true });
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

  it('shows the node its turn runs on when the agent moved to another subscription mid-turn, and moves once the turn ends', async () => {
    const { app, db, url, ceo, builtin, orchestratorId } = await live(true, { STREAM_PING_MS: '2147483647' });
    const [agent] = await db.select().from(agents).where(eq(agents.id, orchestratorId));
    const [acme] = await db.select().from(companies);
    const [running] = await db
      .insert(jobs)
      .values({ companyId: acme!.id, subscriptionId: agent!.subscriptionId!, agentId: orchestratorId, kind: 'conversation', prompt: 'A long turn.', timeoutMs: 900000, status: 'running', startedAt: new Date() })
      .returning();
    const [ceoRow] = await db.select().from(people);
    const [mine] = await db.insert(subscriptions).values({ companyId: acme!.id, provider: 'claude', kind: 'personal', label: 'Claude', ownerPersonId: ceoRow!.id, status: 'ready' }).returning();
    await db.update(agents).set({ subscriptionId: mine!.id }).where(eq(agents.id, orchestratorId));
    /* The window asks whether there is a terminal to show of the same machine it then opens. */
    expect((await state(app, ceo)).terminal).toBe(true);
    const screen = await watch(url, ceo);
    expect(await next(builtin, 'term.open')).toMatchObject({ agentKey: orchestratorId });
    /* A size has the view look again at what it shows once a second went by since its last look: the clock moves that second. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    vi.setSystemTime(Date.now() + 1000);
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30 }));
    expect(await next(builtin, 'term.resize')).toMatchObject({ cols: 90 });
    expect(screen.ws.readyState).toBe(WebSocket.OPEN);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, running!.id));
    vi.setSystemTime(Date.now() + 1000);
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 91, rows: 30 }));
    expect(await screen.closed).toEqual({ code: 4410, reason: 'node_offline' });
    expect((await state(app, ceo)).terminal).toBe(false);
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

  it('ends the view of a person who no longer reaches the agent at once, without waiting for the next look', async () => {
    const { app, db, url, ceo, builtin } = await live(true, { STREAM_PING_MS: '2147483647' });
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.test', access: { whole: true } });
    await db.update(people).set({ isCeoDelegate: true }).where(eq(people.name, 'Maria'));
    const screen = await watch(url, maria);
    await next(builtin, 'term.open');
    const [row] = await db.select().from(people).where(eq(people.name, 'Maria'));
    await app.inject({ method: 'PATCH', url: `/api/people/${row!.id}`, payload: { access: { departments: [sales!.id] } }, ...as(ceo) });
    expect(await screen.closed).toEqual({ code: 4403, reason: 'no_access' });
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
    expect(await next(builtin, 'term.input')).toMatchObject({ data: 'what do we sell\r' });
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'what do we sell', ref: 'r-7' });
    const opened = await next(builtin, 'turn.opened');
    expect(opened).toMatchObject({ agentKey: orchestratorId, jobId: expect.any(String), toolToken: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/), ref: 'r-7' });
    expect(await state(app, ceo)).toMatchObject({ busy: true, runningJobId: opened.jobId });
    const message = (await events(app, ceo)).find((e: { kind: string; jobId: string | null }) => e.kind === 'message' && e.jobId === opened.jobId);
    expect(message).toMatchObject({
      jobId: opened.jobId, data: { text: 'what do we sell' }, person: { name: 'Ivan' },
      message: { direction: 'in', from: { kind: 'person', name: 'Ivan', role: { en: 'CEO', ru: 'CEO' } }, to: { kind: 'agent', id: orchestratorId } },
    });
    /* The CEO typed it, so the tools only the CEO may ask for work in it. */
    expect((await app.ctx.db.select({ answersCeo: jobs.answersCeo, prompt: jobs.prompt }).from(jobs).where(eq(jobs.id, opened.jobId!)))[0]).toEqual({ answersCeo: true, prompt: 'what do we sell' });

    const tools = await app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${opened.toolToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    expect(tools.statusCode).toBe(200);

    builtin.send({ type: 'job.event', jobId: opened.jobId!, seq: 0, event: { kind: 'text', text: 'Software.' } });
    builtin.send({ type: 'job.done', jobId: opened.jobId!, ok: true, sessionId: 'sess-1', result: 'Software.', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    expect((await events(app, ceo)).some((e: { kind: string; data: { text?: string } }) => e.kind === 'text' && e.data.text === 'Software.')).toBe(true);

    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'thanks' }, ...as(ceo) });
    expect(await next(builtin, 'job.run')).toMatchObject({ sessionId: 'sess-1' });
  });

  it('opens only for a person who pressed Enter in the terminal', async () => {
    const { app, url, ceo, builtin, orchestratorId } = await live();
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: '\u001b[<64;10;5M' }));
    await next(builtin, 'term.input');
    /* The agent's own program, or anything it runs, asking for a turn of its own gets no job and no tool token. */
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'from the machine itself' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null, toolToken: null });
    expect(await state(app, ceo)).toMatchObject({ busy: false });
    screen.ws.send(JSON.stringify({ type: 'input', data: 'hi\r' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'hi' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: expect.any(String), toolToken: expect.any(String) });
    const said = (await events(app, ceo)).filter((e: { kind: string }) => e.kind === 'message');
    expect(said.map((e: { data: { text: string }; person: unknown }) => [e.data.text, e.person !== null])).toEqual([['hi', true]]);
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
      .values({ companyId: orchestrator!.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dept!.id, model: '', subscriptionId: orchestrator!.subscriptionId!, switchedOffAt: new Date() })
      .returning();
    const [task] = await db.insert(tasks).values({ companyId: orchestrator!.companyId, number: 1, title: 'Checkout API', assigneeAgentId: bruno!.id }).returning();
    await db.insert(jobs).values({ companyId: orchestrator!.companyId, subscriptionId: orchestrator!.subscriptionId!, agentId: bruno!.id, taskId: task!.id, kind: 'conversation', prompt: 'Do #1.', timeoutMs: 900000 });
    builtin.send({ type: 'agent.start', agentKey: bruno!.id });
    expect(await next(builtin, 'job.run')).toMatchObject({ prompt: '' });
  });

  it('lets a person who types while the program starts take over its start turn', async () => {
    const { app, db, url, ceo, builtin, orchestratorId } = await live();
    builtin.send({ type: 'agent.start', agentKey: orchestratorId });
    const start = await next(builtin, 'job.run');
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'add a department\r' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'add a department', ref: 'r-1' });
    const opened = await next(builtin, 'turn.opened');
    expect(opened).toMatchObject({ jobId: expect.any(String), toolToken: expect.any(String), ref: 'r-1' });
    expect((await db.select().from(jobs).where(eq(jobs.id, start.jobId)))[0]).toMatchObject({ status: 'done' });
    /* The node's own end of the start turn comes after, and changes nothing. */
    builtin.send({ type: 'job.done', jobId: start.jobId, ok: true, sessionId: null, result: '', tail: '', error: null });
    await until(() => builtin.acks.includes(start.jobId));
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
    await handled(builtin);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });
});

describe('opening a terminal while the plan is at its limit', () => {
  async function onPlan(provider: 'claude' | 'codex' | 'kimi' = 'claude', saved = true) {
    const company = await live();
    const { app, url, ceo, db, orchestratorId } = company;
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: [provider] }, ...as(ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'limit-test-machine', hostname: 'limit-test', os: 'linux', arch: 'arm64' } });
    const node = joined.json().nodes[0] as { subscriptionId: string; key: string };
    const plan = await connectNode(url, node.key);
    plan.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${node.subscriptionId}/orchestrator`, ...as(ceo) })).statusCode).toBe(200);
    await until(async () => (await state(app, ceo)).ready);
    if (saved) {
      await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'Save this history' }, ...as(ceo) });
      const earlier = await next(plan, 'job.run');
      plan.send({ type: 'job.done', jobId: earlier.jobId, ok: true, sessionId: 'saved-history', result: 'Saved answer', tail: '', error: null });
      await until(async () => !(await state(app, ceo)).busy);
    }
    const resetsAt = new Date(Date.now() + 60_000).toISOString();
    plan.send({ type: 'status', loggedIn: true, limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] } });
    await until(async () => (await state(app, ceo)).limitUntil === resetsAt);
    for (const text of ['First waiting prompt', 'Second waiting prompt']) {
      expect((await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text }, ...as(ceo) })).statusCode).toBe(202);
    }
    const waiting = (await db.select().from(jobs).where(eq(jobs.agentId, orchestratorId)).orderBy(asc(jobs.createdAt))).filter(j => j.status === 'queued');
    expect(waiting).toHaveLength(2);
    return { ...company, plan, node, resetsAt, waiting };
  }

  it.each(['claude', 'codex', 'kimi'] as const)('opens saved %s history after a node restart, once, without sending waiting prompts until reset', async provider => {
    const { app, db, url, ceo, builtin, orchestratorId, plan, node, resetsAt, waiting } = await onPlan(provider);
    plan.close();
    await plan.closed;
    await until(async () => !(await state(app, ceo)).ready);
    const back = await connectNode(url, node.key);
    back.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
    await until(async () => (await state(app, ceo)).ready);
    expect(await state(app, ceo)).toMatchObject({ limitUntil: resetsAt, queued: 2, busy: false });

    /* A different subscription's node cannot start this program or write its terminal. */
    builtin.send({ type: 'agent.start', agentKey: orchestratorId });
    const screens = await Promise.all([watch(url, ceo), watch(url, ceo)]);
    const opens = [await next(back, 'term.open'), await next(back, 'term.open')];
    for (const open of opens) {
      expect(open.write).toBe(true);
      back.send({ type: 'term.program', termId: open.termId, running: false });
      back.send({ type: 'agent.start', agentKey: orchestratorId });
      builtin.send({ type: 'term.program', termId: open.termId, running: true });
      builtin.send({ type: 'term.data', termId: open.termId, data: 'Foreign node data' });
    }
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'guard', ref: 'foreign-node-guard' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null, ref: 'foreign-node-guard' });
    for (const open of opens) back.send({ type: 'term.data', termId: open.termId, data: 'Owner node connected' });
    await until(() => screens.every(s => s.frames.some(f => f.type === 'data' && f.data === 'Owner node connected')));
    expect(screens.every(s => s.frames.some(f => f.type === 'program' && f.running === false) && s.frames.filter(f => f.type === 'program').every(f => f.running === false))).toBe(true);
    expect(screens.every(s => !s.frames.some(f => f.type === 'data' && f.data === 'Foreign node data'))).toBe(true);
    await until(() => back.queued() === 1);
    const start = await next(back, 'job.run');
    expect(start).toMatchObject({ prompt: '', sessionId: 'saved-history', provider });
    for (const prompt of ['First waiting prompt', 'Second waiting prompt']) {
      expect(start.context ?? '').not.toContain(prompt);
      expect(start.instructions ?? '').not.toContain(prompt);
    }
    for (let i = 0; i < 8; i++) back.send({ type: 'agent.start', agentKey: orchestratorId });
    for (const open of opens) {
      back.send({ type: 'term.data', termId: open.termId, data: 'Saved answer' });
      back.send({ type: 'term.program', termId: open.termId, running: true });
    }
    back.send({ type: 'job.done', jobId: start.jobId, ok: true, sessionId: 'saved-history', result: '', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    await until(() => screens.every(s => s.frames.some(f => f.type === 'program' && f.running === true) && s.frames.some(f => f.type === 'data' && f.data === 'Saved answer')));
    expect(await state(app, ceo)).toMatchObject({ limitUntil: resetsAt, queued: 2 });
    const rows = await db.select().from(jobs).where(eq(jobs.agentId, orchestratorId)).orderBy(asc(jobs.createdAt));
    expect(rows.filter(j => j.prompt === '')).toHaveLength(1);
    expect(rows.filter(j => j.status === 'queued')).toEqual(waiting);
    expect(back.queued()).toBe(0);
    expect(builtin.queued()).toBe(0);

    back.send({ type: 'status', loggedIn: true, limits: { status: 'allowed', windows: [] } });
    for (const queued of waiting) {
      const run = await next(back, 'job.run');
      expect(run).toMatchObject({ jobId: queued.id, prompt: `${IVAN_TO_ORCHESTRATOR}${queued.prompt}`, sessionId: 'saved-history' });
      back.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 'saved-history', result: 'Done', tail: '', error: null });
    }
    await until(async () => !(await state(app, ceo)).busy);
    expect(await state(app, ceo)).toMatchObject({ limitUntil: null, queued: 0 });
    expect((await db.select().from(jobs).where(eq(jobs.agentId, orchestratorId))).every(j => j.status === 'done')).toBe(true);
    expect(back.queued()).toBe(0);
  });

  it('does not open a limited agent for a person from another company', async () => {
    const { app, db, url, ceo, orchestratorId, plan } = await onPlan();
    const outsider = await invitePerson(app, ceo, { name: 'Other owner', email: 'other-owner@acme.test', access: { whole: true } });
    const [other] = await db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    await db.update(people).set({ companyId: other!.id }).where(eq(people.email, 'other-owner@acme.test'));
    await expect(watch(url, outsider, orchestratorId)).rejects.toThrow('HTTP 404');
    expect(await state(app, ceo)).toMatchObject({ busy: false, queued: 2 });
    expect(plan.queued()).toBe(0);
  });

  it('opens a fresh program without history and preserves prompts when reset races with repeated opens', async () => {
    const { app, db, url, ceo, orchestratorId, plan, waiting } = await onPlan('claude', false);
    const screen = await watch(url, ceo);
    const open = await next(plan, 'term.open');
    plan.send({ type: 'term.program', termId: open.termId, running: false });
    plan.send({ type: 'agent.start', agentKey: orchestratorId });
    await until(() => plan.queued() === 1);
    const start = await next(plan, 'job.run');
    expect(start).toMatchObject({ prompt: '', sessionId: null });
    for (const prompt of ['First waiting prompt', 'Second waiting prompt']) {
      expect(start.context ?? '').not.toContain(prompt);
      expect(start.instructions ?? '').not.toContain(prompt);
    }
    for (let i = 0; i < 8; i++) plan.send({ type: 'agent.start', agentKey: orchestratorId });
    plan.send({ type: 'status', loggedIn: true, limits: { status: 'allowed', windows: [] } });
    await until(async () => (await state(app, ceo)).limitUntil === null);
    expect(await state(app, ceo)).toMatchObject({ busy: true, runningJobId: start.jobId, queued: 2 });
    expect(plan.queued()).toBe(0);
    plan.send({ type: 'term.program', termId: open.termId, running: true });
    plan.send({ type: 'job.done', jobId: start.jobId, ok: true, sessionId: 'new-history', result: '', tail: '', error: null });
    for (const queued of waiting) {
      const run = await next(plan, 'job.run');
      expect(run).toMatchObject({ jobId: queued.id, prompt: `${IVAN_TO_ORCHESTRATOR}${queued.prompt}`, sessionId: 'new-history' });
      plan.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 'new-history', result: 'Done', tail: '', error: null });
    }
    await until(async () => !(await state(app, ceo)).busy);
    expect((await db.select().from(jobs).where(eq(jobs.agentId, orchestratorId))).filter(j => j.prompt === '')).toHaveLength(1);
    expect(await state(app, ceo)).toMatchObject({ queued: 0 });
    expect(screen.frames).toContainEqual({ type: 'program', running: true });
  });

  it.each(['person', 'task'] as const)('does not treat an empty %s turn as a program start during a limit', async origin => {
    const { app, db, ceo, orchestratorId, plan, node, waiting } = await onPlan();
    const [agent] = await db.select().from(agents).where(eq(agents.id, orchestratorId));
    const [person] = await db.select().from(people).where(eq(people.companyId, agent!.companyId));
    const [task] = origin === 'task'
      ? await db.insert(tasks).values({ companyId: agent!.companyId, number: 1, title: 'Waiting task' }).returning()
      : [];
    const [empty] = await db.insert(jobs).values({
      companyId: agent!.companyId, subscriptionId: node.subscriptionId, agentId: orchestratorId,
      kind: 'conversation', prompt: '', timeoutMs: 10000,
      createdBy: origin === 'person' ? person!.id : null, taskId: task?.id ?? null,
    }).returning();

    plan.send({ type: 'agent.start', agentKey: orchestratorId });
    const start = await next(plan, 'job.run');
    expect(start).toMatchObject({ prompt: '', sessionId: 'saved-history' });
    expect(start.jobId).not.toBe(empty!.id);
    const [started] = await db.select().from(jobs).where(eq(jobs.id, start.jobId));
    expect(started).toMatchObject({ createdBy: null, taskId: null });
    plan.send({ type: 'job.done', jobId: start.jobId, ok: true, sessionId: 'saved-history', result: '', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    const queued = (await db.select().from(jobs).where(eq(jobs.agentId, orchestratorId))).filter(j => j.status === 'queued');
    expect(queued.map(j => j.id).sort()).toEqual([...waiting.map(j => j.id), empty!.id].sort());
    expect(plan.queued()).toBe(0);
  });

  it('shows a startup failure to the owner and leaves real prompts waiting at the limit', async () => {
    const { app, db, url, ceo, orchestratorId, plan, resetsAt, waiting } = await onPlan();
    const screen = await watch(url, ceo);
    const open = await next(plan, 'term.open');
    plan.send({ type: 'term.program', termId: open.termId, running: false });
    plan.send({ type: 'agent.start', agentKey: orchestratorId });
    await until(() => plan.queued() === 1);
    const start = await next(plan, 'job.run');
    plan.send({ type: 'term.data', termId: open.termId, data: 'No conversation found with session ID: saved-history' });
    plan.send({ type: 'term.program', termId: open.termId, running: true });
    plan.send({ type: 'job.done', jobId: start.jobId, ok: false, sessionId: null, result: '', tail: 'No conversation found with session ID: saved-history', error: 'agent_failed' });
    await until(async () => !(await state(app, ceo)).busy);
    await until(() => screen.frames.some(f => f.type === 'program' && f.running === true));
    expect(screen.frames).toContainEqual({ type: 'data', data: 'No conversation found with session ID: saved-history' });
    expect(await state(app, ceo)).toMatchObject({ limitUntil: resetsAt, queued: 2 });
    expect((await db.select().from(jobs).where(eq(jobs.agentId, orchestratorId)).orderBy(asc(jobs.createdAt))).filter(j => j.status === 'queued')).toEqual(waiting);
    expect(plan.queued()).toBe(0);
  });
});

describe('who typed into the terminal, for the decisions of a turn', () => {
  it('takes the Enter of a person once, and only from the node that shows the terminal', async () => {
    const { TerminalRelay } = await import('../src/modules/terminals/relay.js');
    const { BUILTIN } = await import('./builtin.js');
    const { nodeIdentity } = await import('../src/modules/nodes/hub.js');
    const relay = new TerminalRelay();
    const other = nodeIdentity('00000000-0000-4000-8000-0000000000aa');
    relay.typing('agent-1', 'ivan', BUILTIN);
    expect(relay.takeTyped(other, 'agent-1')).toBeNull();
    expect(relay.takeTyped(BUILTIN, 'agent-2')).toBeNull();
    expect(relay.takeTyped(BUILTIN, 'agent-1')).toBe('ivan');
    expect(relay.takeTyped(BUILTIN, 'agent-1')).toBeNull();
  });

  it('keeps an Enter pressed in a turn for that turn and node, each once, the last one first', async () => {
    const { TerminalRelay } = await import('../src/modules/terminals/relay.js');
    const { BUILTIN } = await import('./builtin.js');
    const { nodeIdentity } = await import('../src/modules/nodes/hub.js');
    const relay = new TerminalRelay();
    const other = nodeIdentity('00000000-0000-4000-8000-0000000000aa');
    relay.pressedIn('agent-1', 'job-1', 'ivan', BUILTIN);
    relay.pressedIn('agent-1', 'job-1', 'zed', BUILTIN);
    expect(relay.takePressed(other, 'agent-1', 'job-1')).toBeNull();
    expect(relay.takePressed(BUILTIN, 'agent-2', 'job-1')).toBeNull();
    expect(relay.takePressed(BUILTIN, 'agent-1', 'job-2')).toBeNull();
    expect(relay.takePressed(BUILTIN, 'agent-1', 'job-1')).toBe('zed');
    expect(relay.takePressed(BUILTIN, 'agent-1', 'job-1')).toBe('ivan');
    expect(relay.takePressed(BUILTIN, 'agent-1', 'job-1')).toBeNull();
    /* The takeTyped of a person's Enter with no turn is another thing. */
    relay.pressedIn('agent-1', 'job-1', 'ivan', BUILTIN);
    expect(relay.takeTyped(BUILTIN, 'agent-1')).toBeNull();
  });

  it('forgets an Enter pressed in a turn once no turn can still run, and keeps a few for an agent', async () => {
    const { TerminalRelay } = await import('../src/modules/terminals/relay.js');
    const { BUILTIN } = await import('./builtin.js');
    const relay = new TerminalRelay();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      relay.pressedIn('agent-1', 'job-1', 'ivan', BUILTIN);
      clock.mockReturnValue(now + 2 * 3_600_000);
      expect(relay.takePressed(BUILTIN, 'agent-1', 'job-1')).toBeNull();
      for (let i = 0; i < 12; i++) relay.pressedIn('agent-1', `job-${i}`, 'ivan', BUILTIN);
      expect(relay.takePressed(BUILTIN, 'agent-1', 'job-0')).toBeNull();
      expect(relay.takePressed(BUILTIN, 'agent-1', 'job-11')).toBe('ivan');
    } finally { clock.mockRestore(); }
  });

  it('reads Enter in every way the program behind tmux takes one, also split over frames, and nothing else as one', async () => {
    const { readKeys } = await import('../src/modules/terminals/keys.js');
    const enter = (...frames: string[]) => {
      let rest = '';
      return frames.map(data => {
        const read = readKeys(rest, data);
        rest = read.rest;
        return read.enter;
      });
    };
    const enters = ['\r', '\n', 'hi\r', '\u001b[13;1u', '\u001b[13u', '\u001b[13;2u', '\u001b[27;1;13~', '\u001b[109;5u', '\u001b[106;5u', '\u001b[27;5;106~', '\u001bOM', '\u001b\r'];
    for (const keys of enters) expect(enter(keys)).toEqual([true]);
    for (const keys of ['hi', '\u001b[A', '\u001b[<64;10;5M', '\u001b[200~text', '\u001b']) expect(enter(keys)).toEqual([false]);
    expect(enter('hi\u001b[13', ';1u')).toEqual([false, true]);
    expect(enter('\u001b', 'OM')).toEqual([false, true]);
    expect(enter('\u001b[1', 'A', '3;1u')).toEqual([false, false, false]);
    expect(enter(`\u001b[${'1'.repeat(200)}`, ';1u')).toEqual([false, true]);
  });

  it('opens no second turn for one Enter', async () => {
    const { app, url, ceo, builtin, orchestratorId } = await live();
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'hi\r' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'hi' });
    const opened = await next(builtin, 'turn.opened');
    expect(opened.jobId).toEqual(expect.any(String));
    builtin.send({ type: 'job.done', jobId: opened.jobId!, ok: true, sessionId: 'sess-1', result: 'Hi', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'approve the release' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null, toolToken: null });
  });

  it("makes the person who presses Enter in the orchestrator's running turn its last word, before the keys go on", async () => {
    const { app, db, url, ceo, builtin } = await live();
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/start', ...as(ceo) });
    const greeting = await next(builtin, 'job.run');
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    /* Hornhoof's greeting is no person's word: the turn goes as the owner, with no message behind it. */
    expect(await decisionPrincipal(db, greeting.jobId)).toEqual({ personId: owner!.id, sourceSeq: null });
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'approve it' }));
    expect(await next(builtin, 'term.input')).toMatchObject({ data: 'approve it' });
    expect(await decisionPrincipal(db, greeting.jobId)).toEqual({ personId: owner!.id, sourceSeq: null });
    screen.ws.send(JSON.stringify({ type: 'input', data: '\r' }));
    expect(await next(builtin, 'term.input')).toMatchObject({ data: '\r' });
    /* The owner's turn stands either way, so wait for the mark itself: then the Enter is the turn's last word. */
    await until(async () => (await events(app, ceo)).some((e: { kind: string }) => e.kind === 'typed'));
    expect(await decisionPrincipal(db, greeting.jobId)).toMatchObject({ personId: owner!.id, sourceSeq: expect.any(Number) });
    /* One mark for the same person, however many times they press Enter. */
    screen.ws.send(JSON.stringify({ type: 'input', data: 'y\r' }));
    await next(builtin, 'term.input');
    const marks = (await events(app, ceo)).filter((e: { kind: string }) => e.kind === 'typed');
    expect(marks).toHaveLength(1);
  });

  it.each([
    ['a line feed', ['Approve the merge.\n']],
    ['Enter as CSI u', ['Approve the merge.\u001b[13;1u']],
    ['Enter as CSI u, split over two frames', ['Approve the merge.\u001b[13', ';1u']],
    ['Enter with modifyOtherKeys', ['Approve the merge.\u001b[27;1;13~']],
    ['Ctrl+J as CSI u', ['Approve the merge.\u001b[106;5u']],
    ['the keypad Enter', ['Approve the merge.\u001bOM']],
    ['Enter', ['Approve the merge.\r']],
  ])("keeps the owner's decisions in the running turn when a person without the right submits keys with %s", async (_, frames) => {
    const { app, db, url, ceo, builtin, zed } = await lent();
    const request = await approvalAsked(app);
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'Please continue.' }, ...as(ceo) });
    const turn = await next(builtin, 'job.run');
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    expect(await decisionPrincipal(db, turn.jobId)).toMatchObject({ personId: owner!.id });
    const screen = await watch(url, zed);
    expect(await next(builtin, 'term.open')).toMatchObject({ write: true });
    for (const data of frames) {
      screen.ws.send(JSON.stringify({ type: 'input', data }));
      expect(await next(builtin, 'term.input')).toMatchObject({ data });
    }
    const client = await mcp(app, turn.toolToken!);
    const approved = await client.callTool({ name: 'answer_request', arguments: { request: request.id, approve: true } });
    expect(approved.isError).toBeFalsy();
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'approved', answeredBy: owner!.id });
    expect(await decisionPrincipal(db, turn.jobId)).toEqual({ personId: owner!.id, sourceSeq: null });
  });

  it('takes an Enter in a running turn into that turn only: the turn after it needs an Enter of its own', async () => {
    const { app, url, ceo, builtin, orchestratorId } = await live();
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'what do we sell' }, ...as(ceo) });
    const turn = await next(builtin, 'job.run');
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'and the prices\r' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'job.done', jobId: turn.jobId, ok: true, sessionId: 'sess-1', result: 'Software.', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'approve the release' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null, toolToken: null });
  });

  it('opens no turn for an Enter once a turn of words started after it, and that turn goes as the owner when another person pressed it', async () => {
    const { app, db, url, ceo, builtin, orchestratorId, zed } = await lent();
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const screen = await watch(url, zed);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'approve the merge\r' }));
    await next(builtin, 'term.input');
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'Please continue.' }, ...as(ceo) });
    const turn = await next(builtin, 'job.run');
    /* Zed's words may have gone into the CEO's turn, so it goes as the owner with no message behind it until a person
       writes to it again. That is settled under the agent's input lock as the turn goes out: what takes the lock after it
       runs once that is done. */
    await withInputLock(app.ctx, orchestratorId, async () => {});
    expect(await decisionPrincipal(db, turn.jobId)).toEqual({ personId: owner!.id, sourceSeq: null });
    builtin.send({ type: 'job.done', jobId: turn.jobId, ok: true, sessionId: 'sess-1', result: 'Done.', tail: '', error: null });
    await until(async () => !(await state(app, ceo)).busy);
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'approve the merge' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null, toolToken: null });
  });
});

describe('words a person typed in a running turn, which the program takes after it', () => {
  type At = Awaited<ReturnType<typeof live>>;
  /* A turn of the CEO's runs; the person who types into the terminal presses Enter in it, and it ends with the words queued. */
  async function pressedIn(at: At, token: string, text = 'and the limits') {
    await at.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'what do we sell' }, ...as(at.ceo) });
    const turn = await next(at.builtin, 'job.run');
    const screen = await watch(at.url, token);
    await next(at.builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: `${text}\r` }));
    expect(await next(at.builtin, 'term.input')).toMatchObject({ data: `${text}\r`, pressedIn: turn.jobId });
    at.builtin.send({ type: 'job.done', jobId: turn.jobId, ok: true, sessionId: 'sess-1', result: 'Software.', tail: '', error: null, wordsWaiting: true });
    await until(async () => !(await state(at.app, at.ceo)).busy);
    return turn;
  }
  const open = async (at: At, text: string, queuedFrom?: string) => {
    at.builtin.send({ type: 'turn.open', agentKey: at.orchestratorId, text, ref: 'typed', ...(queuedFrom ? { queuedFrom } : {}) });
    return next(at.builtin, 'turn.opened');
  };
  const refusal = async (at: At) => (await state(at.app, at.ceo)).turnRefused;
  /* The next turn waits while the program may still take its waiting words, and goes out once that chance is over: here
     the server's pump runs past that deadline at once, instead of the test waiting it out. */
  const pastWordsDeadline = async (at: At) => {
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    try {
      await pump(at.app.ctx, at.orchestratorId);
    } finally {
      clock.mockRestore();
    }
  };

  it.each([
    ['the CEO', async () => { const at = await live(); const [p] = await at.db.select().from(people).where(eq(people.isOwner, true)); return { at, token: at.ceo, personId: p!.id, answersCeo: true }; }],
    ['the CEO delegate', async () => { const at = await lent(); await delegate(at.app, at.ceo, at.zedId); return { at, token: at.zed, personId: at.zedId, answersCeo: true }; }],
    ['a person without the rights of the CEO', async () => { const at = await lent(); return { at, token: at.zed, personId: at.zedId, answersCeo: false }; }],
  ])('open their own turn with its tools for %s', async (_, who) => {
    const { at, token, personId, answersCeo } = await who();
    const turn = await pressedIn(at, token);
    const opened = await open(at, 'and the limits', turn.jobId);
    expect(opened).toMatchObject({ jobId: expect.any(String), toolToken: expect.any(String), ref: 'typed' });
    expect(await jobOf(at.app, opened.jobId!)).toEqual({ createdBy: personId, answersCeo });
    const said = (await events(at.app, at.ceo)).filter((e: { kind: string; jobId: string }) => e.kind === 'message' && e.jobId === opened.jobId);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ data: { text: 'and the limits' }, person: { id: personId } });
    const [owner] = await at.db.select().from(people).where(eq(people.isOwner, true));
    expect(await decisionPrincipal(at.db, opened.jobId!)).toMatchObject({ personId: answersCeo ? personId : owner!.id });
    const client = await mcp(at.app, opened.toolToken!);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('open one turn for one Enter', async () => {
    const at = await live();
    const turn = await pressedIn(at, at.ceo);
    const first = await open(at, 'and the limits', turn.jobId);
    expect(first.jobId).toEqual(expect.any(String));
    at.builtin.send({ type: 'job.done', jobId: first.jobId!, ok: true, sessionId: 'sess-1', result: 'Done.', tail: '', error: null });
    await until(async () => !(await state(at.app, at.ceo)).busy);
    expect(await open(at, 'approve the release', turn.jobId)).toMatchObject({ jobId: null, toolToken: null });
  });

  it('give no turn to words of a turn nobody pressed Enter in', async () => {
    const at = await live();
    await at.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'what do we sell' }, ...as(at.ceo) });
    const turn = await next(at.builtin, 'job.run');
    at.builtin.send({ type: 'job.done', jobId: turn.jobId, ok: true, sessionId: 'sess-1', result: 'Software.', tail: '', error: null, wordsWaiting: true });
    await until(async () => !(await state(at.app, at.ceo)).busy);
    expect(await open(at, 'approve the release', turn.jobId)).toMatchObject({ jobId: null, toolToken: null });
  });

  it('give no turn for an Enter of another turn', async () => {
    const at = await live();
    const turn = await pressedIn(at, at.ceo);
    await at.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'next' }, ...as(at.ceo) });
    await pastWordsDeadline(at);
    const other = await next(at.builtin, 'job.run');
    at.builtin.send({ type: 'job.done', jobId: other.jobId, ok: true, sessionId: 'sess-1', result: 'Next.', tail: '', error: null });
    await until(async () => !(await state(at.app, at.ceo)).busy);
    expect(await open(at, 'and the limits', other.jobId)).toMatchObject({ jobId: null });
    expect(await open(at, 'and the limits', turn.jobId)).toMatchObject({ jobId: expect.any(String) });
  });

  it('go into the turn that runs by then, which goes as the owner when the person who typed them is not the CEO', async () => {
    const at = await lent();
    const turn = await pressedIn(at, at.zed);
    await at.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'Please continue.' }, ...as(at.ceo) });
    await pastWordsDeadline(at);
    const other = await next(at.builtin, 'job.run');
    const [owner] = await at.db.select().from(people).where(eq(people.isOwner, true));
    expect(await decisionPrincipal(at.db, other.jobId)).toMatchObject({ personId: owner!.id });
    expect(await open(at, 'and the limits', turn.jobId)).toMatchObject({ jobId: null, toolToken: null });
    expect(await decisionPrincipal(at.db, other.jobId)).toEqual({ personId: owner!.id, sourceSeq: null });
    expect(await refusal(at)).toBe('busy');
  });

  it('tell nothing to a node that keeps no turn in mind, while no turn runs', async () => {
    const at = await live();
    const screen = await watch(at.url, at.ceo);
    await next(at.builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'hi\r' }));
    expect(await next(at.builtin, 'term.input')).not.toHaveProperty('pressedIn');
  });
});

describe('words a person wrote into the last seconds of a turn, which the program takes after it', () => {
  type At = Awaited<ReturnType<typeof live>>;
  async function writtenIn(at: At, token: string) {
    await at.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'what do we sell' }, ...as(at.ceo) });
    const turn = await next(at.builtin, 'job.run');
    const sent = say(at.app, token, 'orchestrator', 'Set this task.');
    const words = await next(at.builtin, 'agent.say');
    at.builtin.send({ type: 'agent.said', ref: words.ref, ok: true });
    expect((await sent).statusCode).toBeLessThan(300);
    at.builtin.send({ type: 'job.done', jobId: turn.jobId, ok: true, sessionId: 'sess-1', result: 'Software.', tail: '', error: null, wordsWaiting: true });
    await until(async () => !(await state(at.app, at.ceo)).busy);
    at.builtin.send({ type: 'turn.open', agentKey: at.orchestratorId, text: words.text, queuedFrom: turn.jobId, ref: 'letter' });
    return next(at.builtin, 'turn.opened');
  }

  it('open a turn in the name of the CEO delegate who wrote them, with its tools', async () => {
    const at = await withDelegate();
    const opened = await writtenIn(at, at.clara);
    expect(opened).toMatchObject({ jobId: expect.any(String), toolToken: expect.any(String) });
    expect(await jobOf(at.app, opened.jobId!)).toEqual({ createdBy: at.claraId, answersCeo: true });
    expect(await decisionPrincipal(at.db, opened.jobId!)).toMatchObject({ personId: at.claraId });
    const client = await mcp(at.app, opened.toolToken!);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  });

  it('open a turn answering no CEO for a person without the rights of the CEO, in a turn that answered the CEO', async () => {
    const at = await lent();
    const opened = await writtenIn(at, at.zed);
    expect(await jobOf(at.app, opened.jobId!)).toEqual({ createdBy: at.zedId, answersCeo: false });
    const [owner] = await at.db.select().from(people).where(eq(people.isOwner, true));
    expect(await decisionPrincipal(at.db, opened.jobId!)).toEqual({ personId: owner!.id, sourceSeq: null });
  });
});

describe('a turn Hornhoof could not open, as the window of the agent shows it', () => {
  it('says that no turn has the words nobody typed, until the next turn opens', async () => {
    const { app, url, ceo, builtin, orchestratorId } = await live();
    expect((await state(app, ceo)).turnRefused).toBeNull();
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'words nobody typed' });
    await next(builtin, 'turn.opened');
    expect((await state(app, ceo)).turnRefused).toBe('unknown_words');
    const screen = await watch(url, ceo);
    await next(builtin, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: 'hi\r' }));
    await next(builtin, 'term.input');
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: 'hi' });
    expect((await next(builtin, 'turn.opened')).jobId).toEqual(expect.any(String));
    expect((await state(app, ceo)).turnRefused).toBeNull();
  });

  it("says nothing of a program's own notice of its background work", async () => {
    const { app, ceo, builtin, orchestratorId } = await live();
    builtin.send({ type: 'turn.open', agentKey: orchestratorId, text: '<task-notification>\n<status>completed</status>\n</task-notification>' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null });
    expect((await state(app, ceo)).turnRefused).toBeNull();
  });

  it('says nothing for an agent that is not there', async () => {
    const { app, ceo, builtin } = await live();
    builtin.send({ type: 'turn.open', agentKey: '00000000-0000-4000-8000-000000000000', text: 'hi' });
    expect(await next(builtin, 'turn.opened')).toMatchObject({ jobId: null });
    expect((await state(app, ceo)).turnRefused).toBeNull();
  });
});
