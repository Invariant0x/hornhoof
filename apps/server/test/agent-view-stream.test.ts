import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, jobs } from '../src/db/schema.js';
import { appendEvent, publishWorking } from '../src/modules/events/store.js';
import { as, openStream, until, type StreamReader } from './helpers.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { prepareSharedDatabase } from './helpers-db.js';

/* The first copy of the shared database opens as the file is collected: a cold open is no part of the first test's time. */
await prepareSharedDatabase();

/* A stream needs no wait once it answers: the server takes the bus in the same step it sends the headers. */

/* A message that says the rest has gone by: everything comes in the order it was published. */
async function flush(c: AclCompany, stream: StreamReader) {
  const before = stream.messages.filter(m => m.type === 'org').length;
  c.app.ctx.bus.publish(c.companyId, { type: 'org' });
  await until(() => stream.messages.filter(m => m.type === 'org').length > before);
}

const said = (c: AclCompany, agent: { id: string }, text: string) => appendEvent(c.app.ctx, { companyId: c.companyId, agentId: agent.id, kind: 'text', data: { text } });

/* Words that only ask whether the stream carries an agent's conversation now: the counts below leave them out. */
const PROBE = 'probe';
const wordsOf = (m: StreamReader['messages'][number]) => (m as { event?: { data?: { text?: string } } }).event?.data?.text;
const heard = (stream: StreamReader) => stream.messages.filter(m => m.type === 'agent_event' && wordsOf(m) !== PROBE);
const probesOf = (stream: StreamReader, agent: { id: string }) => stream.messages.filter(m => m.type === 'agent_event' && m.agentId === agent.id && wordsOf(m) === PROBE).length;

/* The stream has taken a change of who the person opens: it carries the words of an agent they open only since. */
async function seesNow(c: AclCompany, stream: StreamReader, agent: { id: string }) {
  await until(async () => {
    await said(c, agent, PROBE);
    await flush(c, stream);
    return probesOf(stream, agent) > 0;
  });
}

/* The stream has taken a change of who the person opens: it no longer carries the words of an agent they opened only
   before. The flush after each shows whether they went out, as messages come in the order they were published. */
async function seesNoMore(c: AclCompany, stream: StreamReader, agent: { id: string }) {
  await until(async () => {
    const before = probesOf(stream, agent);
    await said(c, agent, PROBE);
    await flush(c, stream);
    return probesOf(stream, agent) === before;
  });
}

describe('the live stream', () => {
  it('carries the conversation of a seen agent, and not of one on another plan or in another department', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.ann);
    await said(c, c.crew.mine, 'From Mina');
    await said(c, c.crew.other, 'From Otto');
    await said(c, c.crew.away, 'From Awa');
    await said(c, c.crew.far, 'From Fara');
    await flush(c, stream);
    const heard = stream.messages.filter(m => m.type === 'agent_event').map(m => m.agentId);
    expect(heard).toEqual([c.crew.mine.id]);
    expect(JSON.stringify(stream.messages)).not.toMatch(/Otto|Awa|Fara/);
    stream.close();
  });

  it('carries everything to the CEO and the delegate', async () => {
    const c = await aclCompany();
    for (const viewer of ['ceo', 'clara'] as const) {
      const stream = await openStream(c.app, c.tokens[viewer]);
      await said(c, c.crew.far, `To ${viewer}`);
      await flush(c, stream);
      expect(stream.messages.some(m => m.type === 'agent_event' && m.agentId === c.crew.far.id)).toBe(true);
      stream.close();
    }
  });

  it('carries a department owner every agent of their department, and a person with the whole company only their own', async () => {
    const c = await aclCompany();
    for (const [viewer, seen, hidden] of [['olga', [c.crew.owned, c.crew.other], c.crew.far], ['wes', [c.crew.wide], c.crew.other]] as const) {
      const stream = await openStream(c.app, c.tokens[viewer]);
      for (const agent of seen) await said(c, agent, 'Seen');
      await said(c, hidden, 'Hidden');
      await flush(c, stream);
      expect(stream.messages.filter(m => m.type === 'agent_event').map(m => m.agentId)).toEqual(seen.map(a => a.id));
      stream.close();
    }
  });

  it('names no hidden agent at the other end of a message of a seen agent', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.ann);
    const party = (a: { id: string; name: string }) => ({ kind: 'agent' as const, id: a.id, name: a.name, role: null, department: null });
    await appendEvent(c.app.ctx, { companyId: c.companyId, agentId: c.crew.mine.id, kind: 'message', data: { text: 'Do it' }, message: { direction: 'in', from: party(c.crew.other), to: party(c.crew.mine), senders: [party(c.crew.head)] } });
    await flush(c, stream);
    const event = stream.messages.find(m => m.type === 'agent_event') as unknown as { event: { message: { from: unknown; to: { id: string }; senders: unknown[] } } };
    expect(event.event.message.from).toEqual({ kind: 'agent', id: null, name: 'Employee', role: null, department: null });
    expect(event.event.message.senders).toEqual([{ kind: 'agent', id: null, name: 'Employee', role: null, department: null }]);
    expect(event.event.message.to.id).toBe(c.crew.mine.id);
    expect(JSON.stringify(stream.messages)).not.toMatch(new RegExp(`Otto|Hana|${c.crew.other.id}|${c.crew.head.id}`));
    stream.close();
  });

  it("carries every task and every agent's context to everyone, as the map and the departments show them", async () => {
    const c = await aclCompany();
    const own = await c.work('Own work', c.crew.mine);
    const hidden = await c.work('Hidden work', c.crew.other);
    const stream = await openStream(c.app, c.tokens.ann);
    const spot = { departmentId: c.product.id, parentId: c.dev.id };
    c.app.ctx.bus.publish(c.companyId, { type: 'task', id: hidden.id, spot });
    c.app.ctx.bus.publish(c.companyId, { type: 'task', id: own.id, spot });
    c.app.ctx.bus.publish(c.companyId, { type: 'context', agentId: c.crew.other.id, used: 0.9 });
    c.app.ctx.bus.publish(c.companyId, { type: 'context', agentId: c.crew.mine.id, used: 0.5 });
    await flush(c, stream);
    expect(stream.messages.filter(m => m.type === 'task').map(m => m.id)).toEqual([hidden.id, own.id]);
    expect(stream.messages.filter(m => m.type === 'context').map(m => m.agentId)).toEqual([c.crew.other.id, c.crew.mine.id]);
    stream.close();
  });

  it('draws every pulse of the company for everyone, as the map and the departments show them', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.ann);
    const mine = { kind: 'agent' as const, id: c.crew.mine.id, departmentId: c.dev.id };
    const other = { kind: 'agent' as const, id: c.crew.other.id, departmentId: c.dev.id };
    const ann = { kind: 'person' as const, id: c.ids.ann };
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: ann, to: mine });
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: other, to: mine });
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: c.dev.id } });
    c.app.ctx.bus.publish(c.companyId, { type: 'pulse', from: { kind: 'person', id: c.ids.bob }, to: other });
    await flush(c, stream);
    expect(stream.messages.filter(m => m.type === 'pulse')).toEqual([
      { type: 'pulse', from: ann, to: mine },
      { type: 'pulse', from: other, to: mine },
      { type: 'pulse', from: { kind: 'orchestrator' }, to: { kind: 'department', id: c.dev.id } },
      { type: 'pulse', from: { kind: 'person', id: c.ids.bob }, to: other },
    ]);
    stream.close();
  });

  it('counts every agent that works', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.ann);
    const running = (agent: { id: string }, subscriptionId: string) => c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId, agentId: agent.id, kind: 'conversation', prompt: 'x', timeoutMs: 1000, status: 'running', startedAt: new Date() });
    await running(c.crew.other, c.plans.bob.id);
    await running(c.crew.far, c.plans.bob.id);
    await publishWorking(c.app.ctx, c.companyId);
    await running(c.crew.mine, c.plans.ann.id);
    await publishWorking(c.app.ctx, c.companyId);
    await flush(c, stream);
    expect(stream.messages.filter(m => m.type === 'working').map(m => m.working)).toEqual([2, 3]);
    stream.close();
  });

  it('follows a change of plan at once, without waiting for the ping', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.ann);
    await said(c, c.crew.other, 'Before');
    await flush(c, stream);
    expect(stream.messages.some(m => m.type === 'agent_event')).toBe(false);
    const moved = await c.app.inject({ method: 'PATCH', url: `/api/agents/${c.crew.mine.id}`, payload: { subscription: c.plans.bob.id }, ...as(c.tokens.ceo) });
    expect(moved.statusCode).toBe(200);
    /* The change says 'org' before it answers, and the stream looks at Ann again before it checks anything after that. */
    await said(c, c.crew.mine, 'Gone now');
    await flush(c, stream);
    expect(stream.messages.some(m => m.type === 'agent_event')).toBe(false);
    await c.db.update(agents).set({ subscriptionId: c.plans.ann.id }).where(eq(agents.id, c.crew.other.id));
    c.app.ctx.bus.publish(c.companyId, { type: 'org' });
    await said(c, c.crew.other, 'Mine now');
    await flush(c, stream);
    expect(stream.messages.filter(m => m.type === 'agent_event').map(m => m.agentId)).toEqual([c.crew.other.id]);
    stream.close();
  });

  it('follows a change of access at once', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.ann);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.ann}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.tokens.ceo) })).statusCode).toBe(200);
    await seesNow(c, stream, c.crew.away);
    await said(c, c.crew.mine, 'Out of reach now');
    await said(c, c.crew.away, 'In reach now');
    await flush(c, stream);
    expect(heard(stream).map(m => m.agentId)).toEqual([c.crew.away.id]);
    stream.close();
  });

  it('ends for a person who was disabled or whose session is gone', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.ann);
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.ann}`, payload: { status: 'disabled' }, ...as(c.tokens.ceo) })).statusCode).toBe(200);
    await until(() => stream.ended());
    expect((await openStream(c.app, c.tokens.ann)).res.status).toBe(401);
  });

  it('hears the whole company once a person becomes the delegate, and stops when they are one no more', async () => {
    const c = await aclCompany();
    const stream = await openStream(c.app, c.tokens.wes);
    await said(c, c.crew.far, 'Before');
    await flush(c, stream);
    expect(stream.messages.some(m => m.type === 'agent_event')).toBe(false);
    await c.app.inject({ method: 'PUT', url: `/api/people/${c.ids.wes}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(c.tokens.ceo) });
    await seesNow(c, stream, c.crew.far);
    await said(c, c.crew.far, 'While delegate');
    await flush(c, stream);
    expect(heard(stream)).toHaveLength(1);
    await c.app.inject({ method: 'PUT', url: `/api/people/${c.ids.wes}/ceo-delegate`, payload: { isCeoDelegate: false }, ...as(c.tokens.ceo) });
    await seesNoMore(c, stream, c.crew.far);
    await said(c, c.crew.far, 'After');
    await flush(c, stream);
    expect(heard(stream)).toHaveLength(1);
    stream.close();
  });
});
