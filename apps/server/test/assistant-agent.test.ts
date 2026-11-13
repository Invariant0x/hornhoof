import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { canViewAgent, maskEnvelope, viewerOf } from '../src/auth/agent-view.js';
import { personColumns } from '../src/auth/session.js';
import { agents, assistantEvents, jobs, people, subscriptions } from '../src/db/schema.js';
import { putOnPlan } from '../src/modules/assistants/setup.js';
import { appendEvent, publishWorking } from '../src/modules/events/store.js';
import { placeWaiting } from '../src/modules/subscriptions/waiting.js';
import { liveAgent } from '../src/modules/tasks/engine.js';
import { checkedWaitTarget } from '../src/modules/tasks/wait-target.js';
import { as, connectNode, invitePerson, listen, mcp, openStream, setUpCompany, testApp, until, type FakeNode, type StreamReader } from './helpers.js';

const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
const hello = { type: 'hello' as const, version: '0.9.0', loggedIn: true, running: [] };
const codeOf = (command: string) => command.split('--join ')[1]!;

/* Ivan the CEO with his own Claude plan on his machine, and Olga, who sees the whole company, with a plan of her own on no
   machine yet. */
async function company() {
  const { app, db } = await testApp();
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
  const plan = (connected.subscriptions as { id: string }[])[0]!.id;
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...MACHINE } })).json().nodes as { key: string }[];
  const node = await connectNode(url, joined[0]!.key);
  node.send(hello);
  const [owner] = await db.select(personColumns).from(people).where(eq(people.isOwner, true));
  const olgaSession = await invitePerson(app, ceo, { name: 'Olga', email: 'olga@acme.com', access: { whole: true } });
  const [olga] = await db.select(personColumns).from(people).where(eq(people.email, 'olga@acme.com'));
  const [olgaPlan] = await db.insert(subscriptions).values({ companyId: owner!.companyId, provider: 'claude', kind: 'personal', label: 'Olga plan', status: 'ready', ownerPersonId: olga!.id }).returning();
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, db, ceo, node, plan, owner: owner!, olgaSession, olga: olga!, olgaPlan: olgaPlan!.id, orchestrator: orchestrator! };
}

type Company = Awaited<ReturnType<typeof company>>;

const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

/* An assistant of this person, set up by whoever's session this is, with its key and signing secret. */
async function assistantOf(c: Company, session: string, ownerId: string, name = 'Ava') {
  const { id } = (await c.app.inject({ method: 'POST', url: '/api/people/assistants', payload: { name, owner: ownerId, program: 'avaclone' }, ...as(session) })).json().person;
  const { key, signingSecret } = (await c.app.inject({ method: 'POST', url: `/api/people/${id}/key`, ...as(session) })).json();
  return { id: id as string, key: key as string, secret: signingSecret as string };
}

const pick = (c: Company, session: string, assistantId: string, plan: string | null) =>
  c.app.inject({ method: 'PATCH', url: `/api/people/${assistantId}/assistant`, payload: { plan }, ...as(session) });
const me = async (c: Company, key: string) => (await c.app.inject({ url: '/api/assistant/me', ...bearer(key) })).json();
const write = (c: Company, key: string, payload: object) => c.app.inject({ method: 'POST', url: '/api/assistant/messages', ...bearer(key), payload });
const ownAgent = async (c: Company, assistantId: string) => {
  const [row] = await c.db.select().from(agents).where(and(eq(agents.kind, 'assistant'), eq(agents.name, (await c.db.select({ name: people.name }).from(people).where(eq(people.id, assistantId)))[0]!.name)));
  return row!;
};

type Run = { type: 'job.run'; jobId: string; prompt: string; instructions: string | null; toolToken: string | null };

/* The turn the node gets with these words in it, past any other. */
async function runWith(node: FakeNode, words: string): Promise<Run> {
  for (;;) {
    const message = (await node.next()) as unknown as Run;
    if (message.type === 'job.run' && message.prompt.includes(words)) return message;
  }
}

/* The CEO's assistant on his plan, its own agent ready, and the turn its first message started. */
async function talking(c: Company, words = 'Who writes to me today?') {
  const ava = await assistantOf(c, c.ceo, c.owner.id);
  expect((await pick(c, c.ceo, ava.id, c.plan)).statusCode).toBe(200);
  await until(async () => (await me(c, ava.key)).assistant.agentReady === true);
  const sent = await write(c, ava.key, { text: words });
  expect(sent.statusCode).toBe(202);
  return { ava, agent: await ownAgent(c, ava.id), message: sent.json().message as { id: string; agentId: string }, run: await runWith(c.node, words) };
}

describe("an assistant's own agent", () => {
  it("runs on the plan its owner picks on the assistant's card, and takes the assistant's words with no agent named", async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await me(c, ava.key)).assistant).toMatchObject({ agentId: null, agentReady: false });
    expect((await write(c, ava.key, { text: 'Hello' })).statusCode).toBe(409);
    const picked = await pick(c, c.ceo, ava.id, c.plan);
    expect(picked.statusCode).toBe(200);
    const agent = await ownAgent(c, ava.id);
    expect(agent).toMatchObject({ kind: 'assistant', name: 'Ava', departmentId: null, subscriptionId: c.plan, removedAt: null });
    expect(picked.json().person.assistant).toMatchObject({ agent: { id: agent.id, plan: c.plan }, skillsUrl: null });
    await until(async () => (await me(c, ava.key)).assistant.agentReady === true);
    expect((await me(c, ava.key)).assistant.agentId).toBe(agent.id);
    const sent = await write(c, ava.key, { text: 'Who writes to me today?' });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().message.agentId).toBe(agent.id);
    const run = await runWith(c.node, 'Who writes to me today?');
    expect(run.prompt).not.toContain('through the assistant');
    expect(run.instructions).toContain("You are Ava, the personal assistant of Ivan at Acme.");
    expect(run.instructions).not.toContain('department');
  });

  it('runs only on a personal plan of its owner, which its owner alone picks, and waits with none', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.ceo, c.olga.id);
    expect((await pick(c, c.ceo, ava.id, c.olgaPlan)).json().error.reason).toBe('assistant_plan_owner_only');
    expect((await pick(c, c.olgaSession, ava.id, c.plan)).json().error.reason).toBe('assistant_plan_invalid');
    expect(await c.db.select().from(agents).where(eq(agents.kind, 'assistant'))).toEqual([]);
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).statusCode).toBe(200);
    expect((await pick(c, c.olgaSession, ava.id, null)).statusCode).toBe(200);
    const agent = await ownAgent(c, ava.id);
    expect(agent.subscriptionId).toBeNull();
    expect((await me(c, ava.key)).assistant).toEqual(expect.objectContaining({ agentId: agent.id, agentReady: false }));
    expect((await write(c, ava.key, { text: 'Hello' })).json().error.reason).toBe('agent_not_ready');
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).statusCode).toBe(200);
    expect(await c.db.select().from(agents).where(eq(agents.kind, 'assistant'))).toHaveLength(1);
  });

  it('is seen and written to by its owner alone: not the CEO, not the orchestrator, not another assistant', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.olgaSession, c.olga.id);
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).statusCode).toBe(200);
    const agent = await ownAgent(c, ava.id);
    expect((await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.olgaSession) })).statusCode).toBe(200);
    expect((await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.ceo) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`, payload: { text: 'Hi' }, ...as(c.ceo) })).statusCode).toBe(403);
    expect((await c.app.inject({ url: '/api/org', ...as(c.ceo) })).body).not.toContain(agent.id);
    expect(await canViewAgent(c.db, { ...c.olga, via: c.orchestrator.id }, agent)).toBe(false);
    const max = await assistantOf(c, c.ceo, c.owner.id, 'Max');
    const listed = (await c.app.inject({ url: '/api/assistant/agents', ...bearer(max.key) })).json().agents.map((a: { id: string }) => a.id);
    expect(listed).not.toContain(agent.id);
    expect((await write(c, max.key, { agentId: agent.id, text: 'Hi' })).statusCode).toBe(403);
  });

  it("is the CEO's own when the CEO owns it, still out of the orchestrator's reach", async () => {
    const c = await company();
    const { agent } = await talking(c);
    expect(await canViewAgent(c.db, c.owner, agent)).toBe(true);
    expect(await canViewAgent(c.db, { ...c.owner, via: c.orchestrator.id }, agent)).toBe(false);
    expect((await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.olgaSession) })).statusCode).toBe(403);
  });

  it("works with its owner's assistant tools, not with the company's", async () => {
    const c = await company();
    const { run } = await talking(c);
    const client = await mcp(c.app, run.toolToken!);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['answer_request', 'list_agents', 'list_requests', 'persona_call', 'read_events', 'send_message', 'tell_owner', 'who_am_i']);
  });
});

describe("an assistant's own agent, for the company", () => {
  it("is changed on its assistant's card, not as an employee: its own card neither edits nor removes it", async () => {
    const c = await company();
    const { agent } = await talking(c);
    const card = await c.app.inject({ url: `/api/agents/${agent.id}`, ...as(c.ceo) });
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ id: agent.id, kind: 'assistant', name: 'Ava' });
    const edit = await c.app.inject({ method: 'PATCH', url: `/api/agents/${agent.id}`, payload: { name: 'Eve' }, ...as(c.ceo) });
    expect(edit.json().error.reason).toBe('assistant_agent_card');
    expect((await c.app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}`, ...as(c.ceo) })).json().error.reason).toBe('assistant_agent_card');
    expect((await ownAgent(c, (await c.db.select().from(people).where(eq(people.name, 'Ava')))[0]!.id)).name).toBe('Ava');
  });

  it('is no employee: no task takes it or waits for it, and no plan comes to it by itself', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.olgaSession, c.olga.id);
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).statusCode).toBe(200);
    const agent = await ownAgent(c, ava.id);
    await expect(liveAgent(c.db, c.owner.companyId, agent.id)).rejects.toThrow(/no employee/);
    await expect(checkedWaitTarget(c.app.ctx, c.owner.companyId, c.orchestrator.id, { kind: 'employee', employee: agent.id } as never)).rejects.toThrow(/cannot take work/);
    expect((await pick(c, c.olgaSession, ava.id, null)).statusCode).toBe(200);
    await placeWaiting(c.app.ctx, c.owner.companyId, [c.plan, c.olgaPlan]);
    expect((await ownAgent(c, ava.id)).subscriptionId).toBeNull();
  });
});

describe("an assistant's own agent, out of everyone else's sight", () => {
  /* Olga's assistant with its own agent on her plan. */
  async function olgasAgent(c: Company) {
    const ava = await assistantOf(c, c.olgaSession, c.olga.id);
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).statusCode).toBe(200);
    return { ava, agent: await ownAgent(c, ava.id) };
  }

  /* A message that says the rest has gone by: everything comes in the order it was published. */
  async function flush(c: Company, stream: StreamReader) {
    const before = stream.messages.filter(m => m.type === 'org').length;
    c.app.ctx.bus.publish(c.owner.companyId, { type: 'org' });
    await until(() => stream.messages.filter(m => m.type === 'org').length > before);
  }

  it("says nothing of it on the CEO's live stream, not its words, its pulses or how full it is, and all of it on its owner's", async () => {
    const c = await company();
    const { agent } = await olgasAgent(c);
    const ceo = await openStream(c.app, c.ceo);
    const olga = await openStream(c.app, c.olgaSession);
    await appendEvent(c.app.ctx, { companyId: c.owner.companyId, agentId: agent.id, kind: 'text', data: { text: 'Only for Olga' } });
    c.app.ctx.bus.publish(c.owner.companyId, { type: 'pulse', from: { kind: 'person', id: c.olga.id }, to: { kind: 'agent', id: agent.id, departmentId: '' } });
    c.app.ctx.bus.publish(c.owner.companyId, { type: 'context', agentId: agent.id, used: 42 });
    await flush(c, ceo);
    await flush(c, olga);
    expect(JSON.stringify(ceo.messages)).not.toContain(agent.id);
    expect(olga.messages.map(m => m.type)).toEqual(expect.arrayContaining(['agent_event', 'pulse', 'context']));
  });

  it('is nobody at the other end of a message for the CEO and the orchestrator, as an agent they do not see', async () => {
    const c = await company();
    const { agent } = await olgasAgent(c);
    const ava = { kind: 'agent' as const, id: agent.id, name: 'Ava', role: null, department: null, agentKind: 'assistant' as const };
    const head = { kind: 'agent' as const, id: c.orchestrator.id, name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' as const };
    const message = { direction: 'in' as const, from: ava, to: head, senders: [ava] };
    for (const who of [c.owner, { ...c.owner, via: c.orchestrator.id }]) {
      const masked = maskEnvelope(await viewerOf(c.db, who), message);
      expect(masked.from).toMatchObject({ id: null, name: 'Employee' });
      expect(masked.senders![0]).toMatchObject({ id: null, name: 'Employee' });
      expect(masked.to.id).toBe(c.orchestrator.id);
    }
    expect(maskEnvelope(await viewerOf(c.db, c.olga), message).from.id).toBe(agent.id);
  });

  it("counts none of its turns among the employees at work, on the map or on the live stream", async () => {
    const c = await company();
    const { agent } = await olgasAgent(c);
    await c.db.insert(jobs).values({ companyId: c.owner.companyId, subscriptionId: c.olgaPlan, agentId: agent.id, kind: 'conversation', prompt: 'Hi', status: 'running', startedAt: new Date(), timeoutMs: 9_000_000 });
    for (const session of [c.ceo, c.olgaSession]) expect((await c.app.inject({ url: '/api/org', ...as(session) })).json().agents.working).toBe(0);
    const stream = await openStream(c.app, c.ceo);
    await publishWorking(c.app.ctx, c.owner.companyId);
    await until(() => stream.messages.some(m => m.type === 'working'));
    expect(stream.messages.find(m => m.type === 'working')).toEqual({ type: 'working', working: 0 });
  });

  it('lets go of its plan when the assistant is switched off, and takes none until it is on again', async () => {
    const c = await company();
    const { ava } = await olgasAgent(c);
    const status = (to: string) => c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}`, payload: { status: to }, ...as(c.ceo) });
    expect((await status('disabled')).statusCode).toBe(200);
    expect((await ownAgent(c, ava.id)).subscriptionId).toBeNull();
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).json().error.reason).toBe('assistant_switched_off');
    expect((await status('active')).statusCode).toBe(200);
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).statusCode).toBe(200);
    expect((await ownAgent(c, ava.id)).subscriptionId).toBe(c.olgaPlan);
  });

  it('is made once when its owner picks a plan from several screens at the same moment', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.olgaSession, c.olga.id);
    const [assistant] = await c.db.select({ ...personColumns, assistantOf: people.assistantOf }).from(people).where(eq(people.id, ava.id));
    await Promise.all([1, 2, 3, 4].map(() => putOnPlan(c.app.ctx, c.olga, assistant!, c.olgaPlan)));
    expect(await c.db.select().from(agents).where(eq(agents.kind, 'assistant'))).toHaveLength(1);
  });
});

describe('persona_call', () => {
  /* The assistant's program at a local address, which answers each call with this. */
  async function program(answer: object, status = 200) {
    const calls: { headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        calls.push({ headers: req.headers, body });
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    onTestFinished(() => new Promise<void>(done => server.close(() => done())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/skills`, calls };
  }

  const said = (result: unknown) => (result as { content: { text: string }[]; isError?: boolean });

  it("asks the assistant's program at its skills address, signed, with the message that started the turn, and gives its answer", async () => {
    const c = await company();
    const { ava, message, run } = await talking(c);
    const at = await program({ ok: true, text: 'Reminder set for 9:00.', data: { id: 7 } });
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { skillsUrl: at.url }, ...as(c.ceo) })).statusCode).toBe(200);
    const client = await mcp(c.app, run.toolToken!);
    const result = said(await client.callTool({ name: 'persona_call', arguments: { name: 'remind', arguments: { at: '9:00' } } }));
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('Reminder set for 9:00.');
    expect(result.content[0]!.text).toContain('{"id":7}');
    expect(at.calls).toHaveLength(1);
    const [call] = at.calls;
    expect(JSON.parse(call!.body)).toEqual({ messageId: message.id, name: 'remind', arguments: { at: '9:00' } });
    const stamp = call!.headers['x-hornhoof-timestamp'] as string;
    expect(Math.abs(Number(stamp) - Date.now() / 1000)).toBeLessThan(60);
    expect(call!.headers['x-hornhoof-signature']).toBe(`sha256=${createHmac('sha256', ava.secret).update(`${stamp}.${call!.body}`).digest('hex')}`);
  });

  it("says so when the assistant has no skills address, or the program refuses, and never follows a redirect", async () => {
    const c = await company();
    const { ava, run } = await talking(c);
    const client = await mcp(c.app, run.toolToken!);
    const none = said(await client.callTool({ name: 'persona_call', arguments: { name: 'remind', arguments: {} } }));
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain('no skills address');
    const refusing = await program({ ok: false, text: 'No such skill.' });
    await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { skillsUrl: refusing.url }, ...as(c.ceo) });
    const refused = said(await client.callTool({ name: 'persona_call', arguments: { name: 'fly', arguments: {} } }));
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain('No such skill.');
    const moving = await program({}, 302);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { skillsUrl: moving.url }, ...as(c.ceo) });
    expect(said(await client.callTool({ name: 'persona_call', arguments: { name: 'remind', arguments: {} } })).isError).toBe(true);
  });

  it('says so when the program breaks off in the middle of its answer', async () => {
    const c = await company();
    const { ava, run } = await talking(c);
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":true,"te', () => res.destroy());
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    onTestFinished(() => new Promise<void>(done => server.close(() => done())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/skills`;
    await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { skillsUrl: url }, ...as(c.ceo) });
    const client = await mcp(c.app, run.toolToken!);
    const broken = said(await client.callTool({ name: 'persona_call', arguments: { name: 'remind', arguments: {} } }));
    expect(broken.isError).toBe(true);
    expect(broken.content[0]!.text).toContain("The assistant's program stopped in the middle of its answer.");
  });
});

describe('tell_owner', () => {
  type Event = { seq: number; kind: string; data: Record<string, unknown> };
  const said = (result: unknown) => result as { content: { text: string }[]; isError?: boolean };
  const eventsOf = async (c: Company, key: string, after = 0): Promise<Event[]> => (await c.app.inject({ url: `/api/assistant/events?after=${after}`, ...bearer(key) })).json().events;

  /* The CEO's assistant on his plan, and the turn of its own agent the CEO started in its window with these words. */
  async function fromWindow(c: Company, words: string) {
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await pick(c, c.ceo, ava.id, c.plan)).statusCode).toBe(200);
    await until(async () => (await me(c, ava.key)).assistant.agentReady === true);
    const agent = await ownAgent(c, ava.id);
    expect((await c.app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`, payload: { text: words }, ...as(c.ceo) })).statusCode).toBe(202);
    return { ava, agent, run: await runWith(c.node, words) };
  }

  /* The assistant's events address, which keeps every wake. */
  async function eventsAddress() {
    const wakes: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        wakes.push(body);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    onTestFinished(() => new Promise<void>(done => server.close(() => done())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hornhoof`, wakes };
  }

  it("passes words its owner asked for in its window to the program, as one reply with no message and no end, and wakes the program", async () => {
    const c = await company();
    const { ava, agent, run } = await fromWindow(c, 'Write to me in my chat: 7');
    const address = await eventsAddress();
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { eventsUrl: address.url }, ...as(c.ceo) })).statusCode).toBe(200);
    expect(await eventsOf(c, ava.key)).toEqual([]);
    const waiting = c.app.inject({ url: '/api/assistant/events?after=0&wait=50', ...bearer(ava.key) });
    const client = await mcp(c.app, run.toolToken!);
    const result = said(await client.callTool({ name: 'tell_owner', arguments: { text: '  7  ' } }));
    expect(result.isError).toBeFalsy();
    const from = { id: agent.id, name: 'Ava', kind: 'assistant' };
    const [heard] = (await waiting).json().events as Event[];
    expect(heard).toMatchObject({ kind: 'reply', data: { messageId: null, agent: from, text: '7' } });
    expect(heard!.data.agent).toMatchObject({ id: (await me(c, ava.key)).assistant.agentId });
    expect((await eventsOf(c, ava.key)).map(e => [e.kind, e.data])).toEqual([['reply', { messageId: null, agent: from, text: '7' }]]);
    await until(() => address.wakes.length > 0);
    expect(JSON.parse(address.wakes[0]!)).toEqual({ type: 'wake', after: heard!.seq - 1 });
  });

  it("wakes OpenClaw's model for them at once, as words its owner waits for", async () => {
    const c = await company();
    const { ava, run } = await fromWindow(c, 'Write to me in my chat: done');
    const address = await eventsAddress();
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${ava.id}/assistant`, payload: { program: 'openclaw', eventsUrl: address.url }, ...as(c.ceo) })).statusCode).toBe(200);
    const client = await mcp(c.app, run.toolToken!);
    expect(said(await client.callTool({ name: 'tell_owner', arguments: { text: 'Done.' } })).isError).toBeFalsy();
    await until(() => address.wakes.length > 0);
    expect(JSON.parse(address.wakes[0]!)).toMatchObject({ mode: 'now' });
  });

  it('passes on no empty words, and nothing of an assistant that is switched off', async () => {
    const c = await company();
    const { ava, run } = await fromWindow(c, 'Write to me in my chat later');
    const client = await mcp(c.app, run.toolToken!);
    expect(said(await client.callTool({ name: 'tell_owner', arguments: { text: '   ' } })).isError).toBe(true);
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, ava.id));
    const off = said(await client.callTool({ name: 'tell_owner', arguments: { text: 'Hello' } }));
    expect(off.isError).toBe(true);
    expect(off.content[0]!.text).toContain('assistant_not_allowed');
    expect(await c.db.select().from(assistantEvents).where(eq(assistantEvents.assistantId, ava.id))).toEqual([]);
  });
});
