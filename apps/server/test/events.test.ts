import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { appendEvent, publishEvent } from '../src/modules/events/store.js';
import { as, connectNode, invitePerson, listen, openStream, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
/* A ping that never comes during a test, the longest a timer takes: the stream follows a change at once or not at all. */
const NO_PING_MS = '2147483647';

async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_KEY, ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [acme] = await db.select().from(companies);
  return { app, db, url, ceo, orchestrator: orchestrator!, companyId: acme!.id };
}

describe('GET /api/stream', () => {
  it('refuses a signed-out request', async () => {
    const { app } = await company();
    const stream = await openStream(app);
    expect(stream.res.status).toBe(401);
  });

  it('sends the orchestrator\'s conversation to people who see the whole company', async () => {
    const { app, ceo, orchestrator, companyId } = await company();
    /* A stream hears from its headers on: the server listens to the bus in the same step as it sends them. */
    const stream = await openStream(app, ceo);
    expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
    await appendEvent(app.ctx, { companyId, agentId: orchestrator.id, kind: 'text', data: { text: 'What does Acme sell?' } });
    await until(() => stream.messages.some(m => m.type === 'agent_event'));
    expect(stream.messages.find(m => m.type === 'agent_event')).toMatchObject({
      agentId: orchestrator.id,
      event: { kind: 'text', data: { text: 'What does Acme sell?' }, jobId: null, person: null, seq: expect.any(Number) },
    });
    stream.close();
  });

  it('keeps no machine command in a conversation, only the command with its code hidden', async () => {
    const { app, db, orchestrator, companyId } = await company();
    const command = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join Ab3_x-9Zq';
    const event = await appendEvent(app.ctx, { companyId, agentId: orchestrator.id, kind: 'tool_result', data: { text: `Run: ${command}`, nested: [{ line: command }] } });
    const hidden = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join [hidden]';
    expect(event.data).toEqual({ text: `Run: ${hidden}`, nested: [{ line: hidden }] });
    expect(JSON.stringify((await db.select(only(agentEvents, 'data')).from(agentEvents)).map(r => r.data))).not.toContain('Ab3_x-9Zq');
  });

  it("keeps an assistant's whole conversation out of a message with no envelope, in the window and in the stream", async () => {
    const { app, db, ceo, orchestrator, companyId } = await company();
    const stream = await openStream(app, ceo);
    const whole = 'Max: the whole private conversation';
    const [row] = await db.insert(agentEvents).values({ companyId, agentId: orchestrator.id, kind: 'message', data: { text: 'Hi', _fresh: whole } }).returning();
    await publishEvent(app.ctx, companyId, orchestrator.id, row!.id);
    await until(() => stream.messages.some(m => m.type === 'agent_event'));
    expect(stream.messages.find(m => m.type === 'agent_event')).toMatchObject({ event: { seq: row!.seq, kind: 'message', data: { text: 'Hi' } } });
    const shown = (await app.inject({ url: `/api/agents/${orchestrator.id}/events`, ...as(ceo) })).json().events as { seq: number; data: unknown }[];
    expect(shown.find(e => e.seq === row!.seq)?.data).toEqual({ text: 'Hi' });
    expect(JSON.stringify(shown)).not.toContain(whole);
    expect(JSON.stringify(stream.messages)).not.toContain(whole);
    stream.close();
  });

  it('keeps the conversation from a department head but tells them the org changed', async () => {
    const { app, db, ceo, orchestrator, companyId } = await company();
    const [sales] = await db.insert(departments).values({ companyId, name: 'Sales', roleCode: 'SAL' }).returning();
    const head = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
    const stream = await openStream(app, head);
    await appendEvent(app.ctx, { companyId, agentId: orchestrator.id, kind: 'text', data: { text: 'secret plans' } });
    app.ctx.bus.publish(companyId, { type: 'org' });
    await until(() => stream.messages.some(m => m.type === 'org'));
    expect(stream.messages.map(m => m.type)).toEqual(['org']);
    stream.close();
  });

  it('ends open streams first when the server shuts down, so it does not wait for them', async () => {
    const { app } = await testApp();
    await listen(app);
    const ceo = await setUpCompany(app);
    const stream = await openStream(app, ceo);
    /* Were it to wait for the stream, which nothing else ends, the close would never come. */
    await app.close();
    await until(() => stream.ended());
  });

  it('ends the stream of a person who was disabled, at the next ping', async () => {
    const { app, db, ceo, companyId } = await company({ STREAM_PING_MS: '50' });
    const [sales] = await db.insert(departments).values({ companyId, name: 'Sales', roleCode: 'SAL' }).returning();
    const head = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
    const stream = await openStream(app, head);
    const maria = (await app.inject({ url: '/api/people', ...as(ceo) })).json().people.find((p: { name: string }) => p.name === 'Maria');
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { status: 'disabled' }, ...as(ceo) })).statusCode).toBe(200);
    await until(() => stream.ended());
  });

  it('ends the stream of a person who was disabled at once, without waiting for the ping', async () => {
    const { app, db, ceo, companyId } = await company({ STREAM_PING_MS: NO_PING_MS });
    const [sales] = await db.insert(departments).values({ companyId, name: 'Sales', roleCode: 'SAL' }).returning();
    const head = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
    const stream = await openStream(app, head);
    const maria = (await app.inject({ url: '/api/people', ...as(ceo) })).json().people.find((p: { name: string }) => p.name === 'Maria');
    await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { status: 'disabled' }, ...as(ceo) });
    await until(() => stream.ended());
  });

  it("stops sending a department's news to a person at once when they no longer reach it", async () => {
    const { app, db, ceo, companyId } = await company({ STREAM_PING_MS: NO_PING_MS });
    const [sales] = await db.insert(departments).values({ companyId, name: 'Sales', roleCode: 'SAL' }).returning();
    const [support] = await db.insert(departments).values({ companyId, name: 'Support', roleCode: 'SUP' }).returning();
    const head = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
    const stream = await openStream(app, head);
    const maria = (await app.inject({ url: '/api/people', ...as(ceo) })).json().people.find((p: { name: string }) => p.name === 'Maria');
    await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { access: { departments: [support!.id] } }, ...as(ceo) });
    /* The change's own word that the org changed comes once the stream looked at her again, so what follows goes by her new
       reach. */
    await until(() => stream.messages.some(m => m.type === 'org'));
    app.ctx.bus.publish(companyId, { type: 'requests', spot: { departmentId: sales!.id } });
    app.ctx.bus.publish(companyId, { type: 'requests', spot: { departmentId: support!.id } });
    await until(() => stream.messages.some(m => m.type === 'requests'));
    /* The change itself tells everyone to fetch the map again, as owners of decisions may move with it. */
    expect(stream.messages).toEqual([{ type: 'org' }, { type: 'requests', spot: { departmentId: support!.id } }]);
    stream.close();
  });

  it('counts an agent with a running conversation as working, on the map and in the stream', async () => {
    const { app, db, url, ceo, orchestrator, companyId } = await company();
    const [sub] = await db.select().from(subscriptions);
    const [job] = await db
      .insert(jobs)
      .values({ companyId, subscriptionId: sub!.id, agentId: orchestrator.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000 })
      .returning();
    const stream = await openStream(app, ceo);
    const builtin = await connectNode(url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [job!.id] });
    builtin.send({ type: 'job.started', jobId: job!.id });
    await until(() => stream.messages.some(m => m.type === 'working'));
    expect(stream.messages.find(m => m.type === 'working')).toEqual({ type: 'working', working: 1 });
    expect((await app.inject({ url: '/api/org', ...as(ceo) })).json().agents).toMatchObject({ working: 1 });
    builtin.send({ type: 'job.done', jobId: job!.id, ok: true, sessionId: 's', result: 'ok', tail: '', error: null });
    await until(() => stream.messages.some(m => m.type === 'working' && m.working === 0));
    builtin.close();
    stream.close();
  });
});
