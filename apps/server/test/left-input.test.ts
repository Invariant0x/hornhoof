import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { agentEvents, agents, departments, jobs, people, subscriptions } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { decisionPrincipal } from '../src/modules/conversation/decision-context.js';
import { enqueueTurn } from '../src/modules/conversation/queue.js';
import { appendEvent } from '../src/modules/events/store.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { TerminalRelay } from '../src/modules/terminals/relay.js';
import { failureCompany } from './failure-company.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until, ownPlan } from './helpers.js';
import { nextOf as next } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const OTHER_NODE = nodeIdentity('00000000-0000-4000-8000-000000000001');
const left = (agentKey: string, more: { jobId?: string | null; text?: string; typed?: boolean; ref?: string } = {}) =>
  ({ type: 'agent.input_left' as const, agentKey, jobId: null, text: 'a draft', typed: false, ref: 'ref-1', ...more });

async function company() {
  const c = await failureCompany();
  const kept = () => c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.agent.id), eq(agentEvents.kind, 'input_left')));
  const told = () => c.sent.mock.calls.filter(([, m]) => m.type === 'agent.input_kept').map(([, m]) => m);
  return { ...c, kept, told };
}

/* The orchestrator runs on a plan Zed lent: only Zed types in its terminal. The CEO writes turns through Hornhoof. */
async function atTerminal() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
  const stateOf = async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().state;
  await until(async () => (await stateOf()).ready);
  const zed = await invitePerson(app, ceo, { name: 'Zed', email: 'zed@example.com', access: { whole: true } });
  const [z] = await db.select().from(people).where(eq(people.name, 'Zed'));
  await db.update(subscriptions).set({ ownerPersonId: z!.id });
  const [orchestrator] = await db.select().from(agents);
  const typeAs = async (token: string, data: string) => {
    const ws = new WebSocket(url.replace('/api/nodes/socket', '/api/agents/orchestrator/terminal?cols=100&rows=30'), { headers: { cookie: `hh_session=${token}` } });
    await new Promise(resolve => ws.on('open', resolve));
    await next(builtin, 'term.open');
    ws.send(JSON.stringify({ type: 'input', data }));
    await next(builtin, 'term.input');
    return ws;
  };
  const lines = async (token = ceo) => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(token) })).json().events.filter((e: { kind: string }) => e.kind === 'input_left');
  return { app, db, url, ceo, zed, zedId: z!.id, builtin, agentId: orchestrator!.id, typeAs, lines };
}

describe('words left unsent in a program\'s input', () => {
  it('are kept, and only then the node hears that it may clear them', async () => {
    const { builtin, agentId, lines } = await atTerminal();
    builtin.send(left(agentId));
    expect(await next(builtin, 'agent.input_kept')).toMatchObject({ agentKey: agentId, ref: 'ref-1' });
    expect(await lines()).toEqual([expect.objectContaining({ kind: 'input_left', person: null, data: expect.objectContaining({ text: 'a draft' }) })]);
  });

  it('are kept once however many times the node asks, and it hears each time', async () => {
    const c = await company();
    await Promise.all([handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id)), handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id))]);
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id));
    expect(await c.kept()).toHaveLength(1);
    expect(c.told()).toHaveLength(3);
  });

  it('are kept apart for another ref and for another agent with the same ref', async () => {
    const c = await company();
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id));
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id, { ref: 'ref-2', text: 'another draft' }));
    await handleNodeMessage(c.ctx, BUILTIN, left(c.head.id));
    expect((await c.kept()).map(e => (e.data as { text: string }).text)).toEqual(['a draft', 'another draft']);
    expect(await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.head.id), eq(agentEvents.kind, 'input_left')))).toHaveLength(1);
  });

  it.each([
    ['a node that does not run the agent', (c: Awaited<ReturnType<typeof company>>) => handleNodeMessage(c.ctx, OTHER_NODE, left(c.agent.id))],
    ['an agent that is not there', (c: Awaited<ReturnType<typeof company>>) => handleNodeMessage(c.ctx, BUILTIN, left('00000000-0000-4000-8000-000000000000'))],
    ['an agent key that is no id', (c: Awaited<ReturnType<typeof company>>) => handleNodeMessage(c.ctx, BUILTIN, left('not-an-id'))],
  ])('are refused from %s, so the node clears nothing', async (_, send) => {
    const c = await company();
    await send(c);
    expect(await c.db.select().from(agentEvents).where(eq(agentEvents.kind, 'input_left'))).toEqual([]);
    expect(c.told()).toEqual([]);
  });

  it("are refused when they name a turn of another agent", async () => {
    const c = await company();
    const other = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.head.id, prompt: 'work', createdBy: null });
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id, { jobId: other }));
    expect(await c.kept()).toEqual([]);
    expect(c.told()).toEqual([]);
  });

  it('are refused when an agent was removed', async () => {
    const c = await company();
    await c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, c.agent.id));
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id));
    expect(await c.kept()).toEqual([]);
    expect(c.told()).toEqual([]);
  });

  it('name the turn they were found in, without its author', async () => {
    const c = await company();
    const job = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'work', createdBy: c.sub.ownerPersonId });
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id, { jobId: job, typed: true }));
    expect(await c.kept()).toEqual([expect.objectContaining({ jobId: job, personId: null })]);
  });

  it('open no turn, go to no program and leave the rights of the next turn alone', async () => {
    const c = await company();
    const job = await enqueueTurn(c.ctx, { companyId: c.companyId, agentId: c.agent.id, prompt: 'work', createdBy: c.sub.ownerPersonId, answersCeo: true });
    await appendEvent(c.ctx, { companyId: c.companyId, agentId: c.agent.id, jobId: job, kind: 'message', personId: c.sub.ownerPersonId, data: { text: 'Do it.' } });
    const principal = await decisionPrincipal(c.db, job);
    const jobsBefore = await c.db.select().from(jobs).where(eq(jobs.agentId, c.agent.id));
    c.sent.mockClear();
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id, { jobId: job, typed: true }));
    expect(await c.db.select().from(jobs).where(eq(jobs.agentId, c.agent.id))).toEqual(jobsBefore);
    expect(await decisionPrincipal(c.db, job)).toEqual(principal);
    expect(c.sent.mock.calls.map(([, m]) => m.type)).toEqual(['agent.input_kept']);
  });

  it('hide a machine code the way the journal hides it', async () => {
    const c = await company();
    await handleNodeMessage(c.ctx, BUILTIN, left(c.agent.id, { text: 'run it --join abc123' }));
    expect((await c.kept())[0]!.data).toMatchObject({ text: 'run it --join [hidden]' });
  });

  it('name who typed in the terminal last, not the author of the new assignment', async () => {
    const { app, builtin, agentId, zed, zedId, typeAs, lines, ceo, db } = await atTerminal();
    await typeAs(zed, 'a draft');
    await app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'An assignment of the CEO.' }, ...as(ceo) });
    const [turn] = await db.select().from(jobs).where(eq(jobs.agentId, agentId));
    const [{ id: ceoId } = { id: '' }] = await db.select(idOnly(people)).from(people).where(eq(people.isOwner, true));
    expect(turn!.createdBy).toBe(ceoId);
    builtin.send(left(agentId, { typed: true, jobId: turn!.id }));
    await next(builtin, 'agent.input_kept');
    expect(await lines(ceo)).toEqual([expect.objectContaining({ jobId: turn!.id, person: { id: zedId, name: 'Zed' } })]);
    expect((await db.select().from(jobs).where(eq(jobs.id, turn!.id)))[0]!.createdBy).toBe(ceoId);
  });

  it('name nobody when no person typed since Hornhoof did, even if someone typed before', async () => {
    const { builtin, agentId, zed, typeAs, lines } = await atTerminal();
    await typeAs(zed, 'a draft');
    builtin.send(left(agentId, { typed: false }));
    await next(builtin, 'agent.input_kept');
    expect(await lines()).toEqual([expect.objectContaining({ person: null })]);
  });

  it('name nobody when the server does not know who typed', async () => {
    const { builtin, agentId, lines } = await atTerminal();
    builtin.send(left(agentId, { typed: true }));
    await next(builtin, 'agent.input_kept');
    expect(await lines()).toEqual([expect.objectContaining({ person: null })]);
  });

  it('name no one for keys that type no words, like a scroll', async () => {
    const { builtin, agentId, zed, typeAs, lines } = await atTerminal();
    await typeAs(zed, '\x1b[A');
    builtin.send(left(agentId, { typed: true }));
    await next(builtin, 'agent.input_kept');
    expect(await lines()).toEqual([expect.objectContaining({ person: null })]);
  });

  it('are read only by those who reach the agent', async () => {
    const { app, db, builtin, agentId, ceo } = await atTerminal();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.id, agentId));
    const place = (name: string, roleCode: string) => db.insert(departments).values({ companyId: orchestrator!.companyId, name, roleCode }).returning();
    const [dev] = await place('Development', 'DEV');
    const [sales] = await place('Sales', 'SAL');
    const hire = (name: string, departmentId: string) => db.insert(agents).values({ companyId: orchestrator!.companyId, kind: 'worker', name, model: 'sonnet', departmentId, subscriptionId: orchestrator!.subscriptionId }).returning();
    const [bruno] = await hire('Bruno', dev!.id);
    const [sam] = await hire('Sam', sales!.id);
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@example.com', access: { departments: [dev!.id] } });
    for (const agent of [bruno!, sam!]) {
      builtin.send(left(agent.id));
      await next(builtin, 'agent.input_kept');
    }
    await ownPlan(db, 'maria@example.com', bruno!.id, sam!.id);
    const read = (id: string) => app.inject({ url: `/api/agents/${id}/events`, ...as(maria) });
    expect((await read(bruno!.id)).json().events.map((e: { kind: string }) => e.kind)).toContain('input_left');
    expect((await read(sam!.id)).statusCode).toBe(403);
  });
});

describe('who typed in a terminal last', () => {
  const NODE_A = nodeIdentity('00000000-0000-4000-8000-00000000000a');
  const NODE_B = nodeIdentity('00000000-0000-4000-8000-00000000000b');

  it('is the last of them, on that node only', () => {
    const relay = new TerminalRelay();
    expect(relay.lastWriter(NODE_A, 'agent')).toBeNull();
    relay.wrote('agent', 'zed', NODE_A);
    relay.wrote('agent', 'ivan', NODE_A);
    expect(relay.lastWriter(NODE_A, 'agent')).toBe('ivan');
    expect(relay.lastWriter(NODE_B, 'agent')).toBeNull();
    expect(relay.lastWriter(NODE_A, 'other')).toBeNull();
  });

  it('stays after an Enter opened a turn, which does not take back what was typed since', () => {
    const relay = new TerminalRelay();
    relay.wrote('agent', 'zed', NODE_A);
    relay.typing('agent', 'zed', NODE_A);
    relay.takeTyped(NODE_A, 'agent');
    expect(relay.lastWriter(NODE_A, 'agent')).toBe('zed');
  });
});
