import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { canViewAgent, maskEnvelope, viewerOf } from '../src/auth/agent-view.js';
import { personColumns } from '../src/auth/session.js';
import { agentEvents, agents, assistantEvents, attachments, companies, departments, jobs, nodes, people, programInstances, programOperatorCases, subscriptions } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { ASSISTANT_WITHOUT_SKILLS, instructionsOf } from '../src/modules/agents/instructions.js';
import { putOnPlan } from '../src/modules/assistants/setup.js';
import { appendEvent, publishWorking } from '../src/modules/events/store.js';
import { placeWaiting } from '../src/modules/subscriptions/waiting.js';
import { liveAgent } from '../src/modules/tasks/engine.js';
import { checkedWaitTarget } from '../src/modules/tasks/wait-target.js';
import { as, connectNode, invitePerson, listen, mcp, openStream, setUpCompany, testApp, until, type FakeNode, type StreamReader } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { stored } from './files-fixture.js';

await prepareSharedDatabase();

const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
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
  const [row] = await c.db.select().from(agents).where(and(eq(agents.kind, 'assistant'), eq(agents.name, (await c.db.select(only(people, 'name')).from(people).where(eq(people.id, assistantId)))[0]!.name)));
  return row!;
};

type Run = { type: 'job.run'; jobId: string; prompt: string; freshPrompt?: string; sessionId: string | null; instructions: string | null; toolToken: string | null };

/* The turn the node gets with these words in it, past any other. */
async function runWith(node: FakeNode, words: string): Promise<Run> {
  for (;;) {
    const message = (await node.next()) as unknown as Run;
    if (message.type === 'job.run' && message.prompt.includes(words)) return message;
  }
}

/* The node ends the turn, in this session. */
const finish = (c: Company, run: Run, sessionId: string | null) => {
  c.node.send({ type: 'job.started', jobId: run.jobId });
  c.node.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId, result: '', tail: '', error: null });
};
const idle = (c: Company, agentId: string) => until(async () => (await c.db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.agentId, agentId))).every(j => j.status === 'done'));
const skillsAt = (c: Company, assistantId: string, skillsUrl: string | null) =>
  c.app.inject({ method: 'PATCH', url: `/api/people/${assistantId}/assistant`, payload: { skillsUrl }, ...as(c.ceo) });

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

  it('is written to by its owner alone and seen by the orchestrator too: not the CEO, not another assistant', async () => {
    const c = await company();
    const ava = await assistantOf(c, c.olgaSession, c.olga.id);
    expect((await pick(c, c.olgaSession, ava.id, c.olgaPlan)).statusCode).toBe(200);
    const agent = await ownAgent(c, ava.id);
    expect((await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.olgaSession) })).statusCode).toBe(200);
    expect((await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.ceo) })).statusCode).toBe(403);
    expect((await c.app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`, payload: { text: 'Hi' }, ...as(c.ceo) })).statusCode).toBe(403);
    expect((await c.app.inject({ url: '/api/org', ...as(c.ceo) })).body).not.toContain(agent.id);
    /* The orchestrator inspects every assistant; only its own person talks to it (people-delete.test.ts). */
    expect(await canViewAgent(c.db, { ...c.olga, via: c.orchestrator.id }, agent)).toBe(true);
    const max = await assistantOf(c, c.ceo, c.owner.id, 'Max');
    const listed = (await c.app.inject({ url: '/api/assistant/agents', ...bearer(max.key) })).json().agents.map((a: { id: string }) => a.id);
    expect(listed).not.toContain(agent.id);
    expect((await write(c, max.key, { agentId: agent.id, text: 'Hi' })).statusCode).toBe(403);
  });

  it("is the CEO's own when the CEO owns it, and the orchestrator sees it too", async () => {
    const c = await company();
    const { agent } = await talking(c);
    expect(await canViewAgent(c.db, c.owner, agent)).toBe(true);
    expect(await canViewAgent(c.db, { ...c.owner, via: c.orchestrator.id }, agent)).toBe(true);
    expect((await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.olgaSession) })).statusCode).toBe(403);
  });

  it("works with its owner's assistant tools, the company's vault and phones, not with the rest of the company's", async () => {
    const c = await company();
    const { run } = await talking(c);
    const client = await mcp(c.app, run.toolToken!);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['answer_request', 'list_agents', 'list_requests', 'phone_acquire', 'phone_action', 'phone_release', 'phone_session', 'phones', 'read_events', 'send_message', 'tell_owner', 'vault_entries', 'vault_entry', 'who_am_i']);
  });
});

describe('the sender of an assistant message', () => {
  type Event = { kind: string; data: { messageId: string | null; byOwnAgent: boolean } };
  const eventsOf = async (c: Company, key: string): Promise<Event[]> => (await c.app.inject({ url: '/api/assistant/events', ...bearer(key) })).json().events;

  /* A node sample answers immediately; collection waits for the state, never for a real-time grace. */
  async function answer(c: Company, run: Run, key: string, messageId: string) {
    c.node.send({ type: 'job.started', jobId: run.jobId });
    c.node.send({ type: 'job.event', jobId: run.jobId, seq: 0, event: { kind: 'text', text: 'Ready.' } });
    c.node.send({ type: 'job.done', jobId: run.jobId, ok: true, sessionId: 'replied', result: '', tail: '', error: null });
    await until(async () => (await eventsOf(c, key)).some(e => e.kind === 'reply_end' && e.data.messageId === messageId));
    return (await eventsOf(c, key)).filter(e => e.data.messageId === messageId).map(e => [e.kind, e.data.byOwnAgent]);
  }

  it('marks replies and their end when the own agent sent the message, and keeps the origin after a restart', async () => {
    const c = await company();
    c.app.ctx.assistants.replyGraceMs = 0;
    const { ava, run } = await talking(c);
    await c.db.update(agents).set({ subscriptionId: c.plan, model: '' }).where(eq(agents.id, c.orchestrator.id));
    const client = await mcp(c.app, run.toolToken!);
    const result = await client.callTool({ name: 'send_message', arguments: { agentId: c.orchestrator.id, text: 'Plan from my own agent.' } }) as { content: { text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const sent = JSON.parse(result.content[0]!.text) as { message: { id: string } };
    finish(c, run, 'caller');
    const reply = await runWith(c.node, 'Plan from my own agent.');
    await c.app.ctx.assistants.stop();
    await c.app.ctx.assistants.start();
    expect(await answer(c, reply, ava.key, sent.message.id)).toEqual([['reply', true], ['reply_end', true]]);
  });

  it('marks replies and their end false for a message from the program, even when its own agent answers', async () => {
    const c = await company();
    c.app.ctx.assistants.replyGraceMs = 0;
    const { ava, message, run } = await talking(c);
    expect(await answer(c, run, ava.key, message.id)).toEqual([['reply', false], ['reply_end', false]]);
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

  it('is nobody at the other end of a message for the CEO, as an agent the CEO does not see, and itself for the orchestrator', async () => {
    const c = await company();
    const { agent } = await olgasAgent(c);
    const ava = { kind: 'agent' as const, id: agent.id, name: 'Ava', role: null, department: null, agentKind: 'assistant' as const };
    const head = { kind: 'agent' as const, id: c.orchestrator.id, name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' as const };
    const message = { direction: 'in' as const, from: ava, to: head, senders: [ava] };
    const masked = maskEnvelope(await viewerOf(c.db, c.owner), message);
    expect(masked.from).toMatchObject({ id: null, name: 'Employee' });
    expect(masked.senders![0]).toMatchObject({ id: null, name: 'Employee' });
    expect(masked.to.id).toBe(c.orchestrator.id);
    expect(maskEnvelope(await viewerOf(c.db, { ...c.owner, via: c.orchestrator.id }), message).from).toMatchObject({ id: agent.id, name: 'Ava' });
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

  it('is among its tools only while the assistant has a skills address, as the address is at each list, and a call by name without one says so', async () => {
    const c = await company();
    const { ava, run } = await talking(c);
    const client = await mcp(c.app, run.toolToken!);
    const listed = async () => (await client.listTools()).tools.map(t => t.name);
    expect(await listed()).not.toContain('persona_call');
    const at = await program({ ok: true, text: 'Reminder set.' });
    expect((await skillsAt(c, ava.id, at.url)).statusCode).toBe(200);
    expect(await listed()).toContain('persona_call');
    expect(said(await client.callTool({ name: 'persona_call', arguments: { name: 'remind', arguments: {} } })).content[0]!.text).toBe('Reminder set.');
    expect((await skillsAt(c, ava.id, null)).statusCode).toBe(200);
    expect(await listed()).not.toContain('persona_call');
    const stale = said(await client.callTool({ name: 'persona_call', arguments: { name: 'remind', arguments: {} } }));
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toContain('no skills address');
    expect(at.calls).toHaveLength(1);
  });

  it('is in its instructions only while there is a skills address, and a change of that starts its program anew', async () => {
    const c = await company();
    const { ava, agent, run } = await talking(c);
    expect(run.instructions).toContain('You are Ava');
    expect(run.instructions).not.toContain('persona_call');
    expect(run.instructions).not.toMatch(/skills address/);
    finish(c, run, 's1');
    await idle(c, agent.id);
    expect((await write(c, ava.key, { text: 'Same as before' })).statusCode).toBe(202);
    const same = await runWith(c.node, 'Same as before');
    expect(same.sessionId).toBe('s1');
    finish(c, same, 's1');
    await idle(c, agent.id);
    const at = await program({ ok: true, text: 'Done.' });
    expect((await skillsAt(c, ava.id, at.url)).statusCode).toBe(200);
    expect((await write(c, ava.key, { text: 'Remind me at 9' })).statusCode).toBe(202);
    const next = await runWith(c.node, 'Remind me at 9');
    expect(next.instructions).toContain('persona_call');
    expect(next.instructions).toContain('hh-attach --chat');
    expect(next.sessionId).toBeNull();
  });

  it('is not in the instructions of an own agent whose assistant is gone, which speaks for its owner with no names', async () => {
    const c = await company();
    const [left] = await c.db.insert(agents).values({ companyId: c.owner.companyId, name: 'Left', kind: 'assistant', model: '', subscriptionId: c.plan }).returning();
    const told = await instructionsOf(c.app.ctx, left!);
    expect(told.text).toContain(`You are Left, the personal assistant of your owner at the company.\n\n${ASSISTANT_WITHOUT_SKILLS}`);
    expect(told.text).not.toContain('persona_call');
  });

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

describe('GET /api/assistant/attachments/:id', () => {
  /* What hh-attach --chat FILE sends from the turn: the file's bytes with the turn's token, to POST /api/attachments. */
  async function attach(c: Company, token: string, name: string, bytes: Buffer): Promise<string> {
    const res = await c.app.inject({ method: 'POST', url: `/api/attachments?chat=1&name=${encodeURIComponent(name)}`, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }
  const download = (c: Company, key: string | null, id: string) => c.app.inject({ url: `/api/assistant/attachments/${id}`, ...(key ? bearer(key) : {}) });
  /* Every byte value, so nothing on the way reads the file as text. */
  const BYTES = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a picture')]);

  it('gives a file its own agent put with hh-attach --chat, by the id hh-attach printed, its exact bytes under its type and name, as often as asked', async () => {
    const c = await company();
    const { ava, agent, run } = await talking(c);
    const id = await attach(c, run.toolToken!, 'report.bin', BYTES);
    const [kept] = await c.db.select({ agentId: attachments.agentId, jobId: attachments.jobId, personId: attachments.personId }).from(attachments).where(eq(attachments.id, id));
    expect(kept).toEqual({ agentId: agent.id, jobId: run.jobId, personId: null });
    for (let time = 1; time <= 3; time++) {
      const got = await download(c, ava.key, id);
      expect(got.statusCode).toBe(200);
      expect(got.rawPayload.equals(BYTES)).toBe(true);
      expect(got.headers).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-length': '512',
        'content-disposition': `attachment; filename="report.bin"; filename*=UTF-8''report.bin`,
        'x-content-type-options': 'nosniff',
      });
    }
    const picture = await download(c, ava.key, await attach(c, run.toolToken!, 'shot.png', PNG));
    expect(picture.headers['content-type']).toBe('image/png');
    expect(picture.rawPayload.equals(PNG)).toBe(true);
  });

  it('names a file of any letters as UTF-8 in filename*, and in plain ASCII in filename', async () => {
    const c = await company();
    const { ava, run } = await talking(c);
    const got = await download(c, ava.key, await attach(c, run.toolToken!, 'Отчет май caf\u00e9.pdf', BYTES));
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-disposition']).toBe(`attachment; filename="_____ ___ cafe.pdf"; filename*=UTF-8''%D0%9E%D1%82%D1%87%D0%B5%D1%82%20%D0%BC%D0%B0%D0%B9%20caf%C3%A9.pdf`);
  });

  it('keeps a name with quotes, a backslash or line breaks inside its one header, so no other header comes of it', async () => {
    const c = await company();
    const { ava, agent, run } = await talking(c);
    const quoted = await download(c, ava.key, await attach(c, run.toolToken!, `say "hi" (it's).txt`, BYTES));
    expect(quoted.headers['content-disposition']).toBe(`attachment; filename="say _hi_ (it's).txt"; filename*=UTF-8''say%20%22hi%22%20%28it%27s%29.txt`);
    /* hh-attach keeps no backslash or line break in a name; one already in the database still goes out escaped. */
    const [odd] = await c.db
      .insert(attachments)
      .values({ companyId: c.owner.companyId, jobId: run.jobId, agentId: agent.id, name: 'a\\b\r\nX-Injected: 1\u2028\ud800.txt', mediaType: 'application/octet-stream', sha256: await stored(c.db, BYTES, c.app.ctx.config), size: BYTES.length })
      .returning();
    const got = await download(c, ava.key, odd!.id);
    expect(got.statusCode).toBe(200);
    expect(got.headers['x-injected']).toBeUndefined();
    expect(got.headers['content-disposition']).toBe(`attachment; filename="a_b__X-Injected: 1__.txt"; filename*=UTF-8''a%5Cb%0D%0AX-Injected%3A%201%E2%80%A8%EF%BF%BD.txt`);
    expect(got.rawPayload.equals(BYTES)).toBe(true);
  });

  it("opens with the assistant's own key alone, as every assistant call: 401 with none, a wrong one, a turn's token or a revoked key", async () => {
    const c = await company();
    const { ava, run } = await talking(c);
    const id = await attach(c, run.toolToken!, 'report.bin', BYTES);
    const refusal = (await c.app.inject({ url: '/api/assistant/me' })).json();
    expect(refusal.error.reason).toBe('assistant_key_invalid');
    const tries = [await download(c, null, id), await download(c, `hha_${'x'.repeat(43)}`, id), await download(c, run.toolToken!, id)];
    expect((await c.app.inject({ method: 'DELETE', url: `/api/people/${ava.id}/key`, ...as(c.ceo) })).statusCode).toBe(200);
    tries.push(await download(c, ava.key, id), await download(c, ava.key, 'not-a-uuid'));
    for (const got of tries) {
      expect(got.statusCode).toBe(401);
      expect(got.json()).toEqual(refusal);
    }
  });

  it('answers a file its owner may not have exactly as one that is not there: of another owner\'s assistant, another company, or no id at all', async () => {
    const c = await company();
    const { ava, agent, run } = await talking(c);
    const turnOf = async (agentId: string, companyId = c.owner.companyId, subscriptionId = c.plan) =>
      (await c.db.insert(jobs).values({ companyId, subscriptionId, agentId, kind: 'conversation', prompt: 'Hi', status: 'running', startedAt: new Date(), timeoutMs: 9_000_000 }).returning())[0]!.id;
    const file = async (values: Partial<typeof attachments.$inferInsert>) =>
      (await c.db.insert(attachments).values({ companyId: c.owner.companyId, agentId: agent.id, name: 'file.bin', mediaType: 'application/octet-stream', sha256: await stored(c.db, BYTES, c.app.ctx.config), size: BYTES.length, ...values }).returning())[0]!.id;
    const bo = await assistantOf(c, c.olgaSession, c.olga.id, 'Bo');
    expect((await pick(c, c.olgaSession, bo.id, c.olgaPlan)).statusCode).toBe(200);
    const boAgent = await ownAgent(c, bo.id);
    const [other] = await c.db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    const [otherPerson] = await c.db.insert(people).values({ companyId: other!.id, name: 'Other person', email: 'other@example.test', status: 'active', scopeKind: 'company' }).returning();
    const [otherPlan] = await c.db.insert(subscriptions).values({ companyId: other!.id, ownerPersonId: otherPerson!.id, provider: 'claude', kind: 'personal', label: 'Other plan', status: 'ready' }).returning();
    const [otherAgent] = await c.db.insert(agents).values({ companyId: other!.id, name: 'Other orchestrator', kind: 'orchestrator', model: '', subscriptionId: otherPlan!.id }).returning();
    const refused = {
      'an id nothing has': randomUUID(),
      'no id at all': 'not-a-uuid',
      "another assistant's agent's file": await file({ agentId: boAgent.id, jobId: await turnOf(boAgent.id) }),
      "Hornhoof's picture of its agent's program": await file({ jobId: run.jobId, name: null, mediaType: 'image/png' }),
      "another company's file": await file({ companyId: other!.id, agentId: otherAgent!.id, jobId: await turnOf(otherAgent!.id, other!.id, otherPlan!.id) }),
    };
    const seen = (got: Awaited<ReturnType<typeof download>>) => {
      const headers = Object.fromEntries(Object.entries(got.headers).filter(([name]) => name !== 'date'));
      return { status: got.statusCode, body: got.body, headers };
    };
    const unknown = seen(await download(c, ava.key, randomUUID()));
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body).error).toMatchObject({ code: 'not_found', reason: 'attachment_unknown' });
    for (const [what, id] of Object.entries(refused)) expect(seen(await download(c, ava.key, id)), what).toEqual(unknown);
    expect((await download(c, ava.key, await attach(c, run.toolToken!, 'own.bin', BYTES))).statusCode).toBe(200);
  });

  it('keeps operator case files closed even when they are named files of its own agent and visible to its owner', async () => {
    const c = await company();
    const { ava, agent, run } = await talking(c);
    const [node] = await c.db.select().from(nodes).where(eq(nodes.subscriptionId, c.plan));
    const instance = randomUUID();
    await c.db.insert(programInstances).values({ id: instance, companyId: c.owner.companyId, agentId: agent.id, nodeId: node!.id });
    const [incident] = await c.db.insert(programOperatorCases).values({ companyId: c.owner.companyId, agentId: agent.id, jobId: run.jobId, nodeId: node!.id, instance, reason: 'assignment_unrecorded', evidenceKey: 'file-test', capability: randomUUID(), deadlineAt: new Date('2099-01-01') }).returning();
    const [picture] = await c.db.insert(attachments).values({ companyId: c.owner.companyId, agentId: agent.id, jobId: run.jobId, operatorCaseId: incident!.id, name: 'case.png', mediaType: 'image/png', sha256: await stored(c.db, PNG, c.app.ctx.config), size: PNG.length }).returning();
    expect((await c.app.inject({ url: `/api/attachments/${picture!.id}`, ...as(c.ceo) })).statusCode).toBe(200);
    const got = await download(c, ava.key, picture!.id);
    const missing = await download(c, ava.key, randomUUID());
    expect(got.statusCode).toBe(404);
    expect(got.body).toBe(missing.body);
    expect(got.headers['content-type']).toBe(missing.headers['content-type']);
    expect(got.headers['content-disposition']).toBeUndefined();
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
    expect(heard).toMatchObject({ kind: 'reply', data: { messageId: null, agent: from, byOwnAgent: true, text: '7' } });
    expect(heard!.data.agent).toMatchObject({ id: (await me(c, ava.key)).assistant.agentId });
    expect((await eventsOf(c, ava.key)).map(e => [e.kind, e.data])).toEqual([['reply', { messageId: null, agent: from, byOwnAgent: true, text: '7' }]]);
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

describe('freshText', () => {
  /* The CEO's assistant on his plan, its own agent ready to answer. */
  async function ready(c: Company) {
    const ava = await assistantOf(c, c.ceo, c.owner.id);
    expect((await pick(c, c.ceo, ava.id, c.plan)).statusCode).toBe(200);
    await until(async () => (await me(c, ava.key)).assistant.agentReady === true);
    return { ava, agent: await ownAgent(c, ava.id) };
  }

  it('takes text of 1 to 50000 characters and freshText of up to 200000 after trimming, and cuts nothing: more is refused', async () => {
    const c = await company();
    const { ava } = await ready(c);
    expect((await write(c, ava.key, { text: ` ${'a'.repeat(50_000)} ` })).statusCode).toBe(202);
    const long = await write(c, ava.key, { text: 'a'.repeat(50_001) });
    expect(long.statusCode).toBe(400);
    expect((await write(c, ava.key, { text: 'Hi', freshText: ` ${'f'.repeat(200_000)} ` })).statusCode).toBe(202);
    expect((await write(c, ava.key, { text: 'Hi', freshText: 'f'.repeat(200_001) })).statusCode).toBe(400);
  });

  it('takes a body near 2 MiB, as a program that escapes every letter in its JSON sends it, and refuses a bigger one', async () => {
    const c = await company();
    const { ava } = await ready(c);
    /* Each Cyrillic letter as \uXXXX: six bytes for one character. */
    const escaped = (n: number) => '\\u044f'.repeat(n);
    const body = (pad: number) => `{"text":"${escaped(50_000)}","freshText":"${escaped(200_000)}"}${' '.repeat(pad)}`;
    const near = body(2 * 1024 * 1024 - 1_520_000);
    expect(Buffer.byteLength(near)).toBeGreaterThan(2 * 1024 * 1024 - 50_000);
    const sent = (payload: string) => c.app.inject({ method: 'POST', url: '/api/assistant/messages', payload, headers: { ...bearer(ava.key).headers, 'content-type': 'application/json' } });
    expect((await sent(near)).statusCode).toBe(202);
    expect((await sent(body(2 * 1024 * 1024))).statusCode).toBe(413);
  });

  it("goes in place of the text and of Hornhoof's catch-up when the own agent's turn starts a new session, and the window shows only the text", async () => {
    const c = await company();
    const { ava, agent } = await ready(c);
    expect((await c.app.inject({ method: 'POST', url: `/api/agents/${agent.id}/messages`, payload: { text: 'Earlier words in the window' }, ...as(c.ceo) })).statusCode).toBe(202);
    finish(c, await runWith(c.node, 'Earlier words in the window'), null);
    await idle(c, agent.id);
    /* Without freshText a new session reads Hornhoof's catch-up of the conversation before the words. */
    expect((await write(c, ava.key, { text: 'Words with no frame' })).statusCode).toBe(202);
    const caught = await runWith(c.node, 'Words with no frame');
    expect(caught.sessionId).toBeNull();
    expect(caught.prompt).toContain('Earlier words in the window');
    finish(c, caught, null);
    await idle(c, agent.id);
    expect((await write(c, ava.key, { text: 'New words', freshText: 'The frame and the whole conversation' })).statusCode).toBe(202);
    const run = await runWith(c.node, 'The frame and the whole conversation');
    expect(run.sessionId).toBeNull();
    expect(run.prompt).toBe('The frame and the whole conversation');
    expect(run.freshPrompt).toBeUndefined();
    expect(run.prompt).not.toContain('Earlier words in the window');
    const shown = (await c.app.inject({ url: `/api/agents/${agent.id}/events`, ...as(c.ceo) })).json().events as { kind: string; data: { text?: string } }[];
    expect(shown.filter(e => e.kind === 'message').map(e => e.data.text)).toContain('New words');
    expect(JSON.stringify(shown)).not.toContain('The frame and the whole conversation');
    const kept = await c.db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.jobId, run.jobId), eq(agentEvents.kind, 'message')));
    expect(JSON.stringify(kept)).not.toContain('The frame and the whole conversation');
  });

  it('goes beside the text when the own agent goes on in its session, for the node to type only into a session begun anew', async () => {
    const c = await company();
    const { ava, agent } = await ready(c);
    expect((await write(c, ava.key, { text: 'First words', freshText: 'First frame' })).statusCode).toBe(202);
    finish(c, await runWith(c.node, 'First frame'), 's1');
    await idle(c, agent.id);
    expect((await write(c, ava.key, { text: 'Second words', freshText: 'Second frame' })).statusCode).toBe(202);
    const run = await runWith(c.node, 'Second words');
    expect(run.sessionId).toBe('s1');
    expect(run.prompt).toBe('Second words');
    expect(run.freshPrompt).toBe('Second frame');
    finish(c, run, 's1');
    await idle(c, agent.id);
    expect((await write(c, ava.key, { text: 'Third words' })).statusCode).toBe(202);
    const plain = await runWith(c.node, 'Third words');
    expect(plain).toMatchObject({ sessionId: 's1', prompt: 'Third words' });
    expect(plain.freshPrompt).toBeUndefined();
  });

  it('carries the files of the message for its own agent to open, in the text and in freshText alike', async () => {
    const c = await company();
    const { ava, agent } = await ready(c);
    const upload = async (name: string) => {
      const got = await c.app.inject({ method: 'POST', url: `/api/assistant/files?name=${name}`, headers: { ...bearer(ava.key).headers, 'content-type': 'audio/ogg' }, payload: Buffer.from('OggS\0\x02') });
      expect(got.statusCode).toBe(201);
      return got.json().file as { id: string; name: string };
    };
    const first = await upload('voice.ogg');
    expect((await write(c, ava.key, { text: 'Listen to this', freshText: 'The frame', files: [first.id] })).statusCode).toBe(202);
    const fresh = await runWith(c.node, 'The frame');
    expect(fresh.prompt).toContain(`voice.ogg: hh-fetch message ${first.id}`);
    finish(c, fresh, 's1');
    await idle(c, agent.id);
    const second = await upload('again.ogg');
    expect((await write(c, ava.key, { text: 'And this', freshText: 'The frame again', files: [second.id] })).statusCode).toBe(202);
    const run = await runWith(c.node, 'And this');
    expect(run.prompt).toContain(`again.ogg: hh-fetch message ${second.id}`);
    expect(run.freshPrompt).toContain(`again.ogg: hh-fetch message ${second.id}`);
  });

  it("is left aside for any other agent, an employee or another assistant's own agent, even when its turn starts a new session", async () => {
    const c = await company();
    const { ava } = await ready(c);
    const [sales] = await c.db.insert(departments).values({ companyId: c.owner.companyId, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const [wendy] = await c.db.insert(agents).values({ companyId: c.owner.companyId, subscriptionId: c.plan, model: '', kind: 'worker', name: 'Wendy', roleKey: 'SAL-SDR', departmentId: sales!.id }).returning();
    const bo = await assistantOf(c, c.ceo, c.owner.id, 'Bo');
    expect((await pick(c, c.ceo, bo.id, c.plan)).statusCode).toBe(200);
    for (const [agentId, words] of [[wendy!.id, 'Find leads'], [(await ownAgent(c, bo.id)).id, 'Plan the week']] as const) {
      expect((await write(c, ava.key, { agentId, text: words, freshText: 'A frame for my own agent' })).statusCode).toBe(202);
      const run = await runWith(c.node, words);
      expect(run.sessionId).toBeNull();
      expect(run.prompt).not.toContain('A frame for my own agent');
      expect(run.freshPrompt).toBeUndefined();
    }
    expect(JSON.stringify(await c.db.select(only(agentEvents, 'data')).from(agentEvents))).not.toContain('A frame for my own agent');
  });
});
