import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { appendEvent } from '../src/modules/events/store.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

/* Reads Server-Sent Events from /api/stream as parsed messages. */
async function openStream(app: FastifyInstance, token?: string) {
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const stop = new AbortController();
  const res = await fetch(`${base}/api/stream`, { headers: token ? { cookie: `hh_session=${token}` } : {}, signal: stop.signal });
  const messages: { type: string; [k: string]: unknown }[] = [];
  let ended = false;
  if (res.ok) {
    void (async () => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) for (const line of frame.split('\n')) if (line.startsWith('data: ')) messages.push(JSON.parse(line.slice(6)));
        }
      } catch {
        /* Aborted. */
      }
      ended = true;
    })();
  }
  return { res, messages, ended: () => ended, close: () => stop.abort() };
}

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
    const stream = await openStream(app, ceo);
    expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
    await new Promise(r => setTimeout(r, 50));
    await appendEvent(app.ctx, { companyId, agentId: orchestrator.id, kind: 'text', data: { text: 'What does Acme sell?' } });
    await until(() => stream.messages.some(m => m.type === 'agent_event'));
    expect(stream.messages.find(m => m.type === 'agent_event')).toMatchObject({
      agentId: orchestrator.id,
      event: { kind: 'text', data: { text: 'What does Acme sell?' }, jobId: null, person: null, seq: expect.any(Number) },
    });
    stream.close();
  });

  it('keeps the conversation from a department head but tells them the org changed', async () => {
    const { app, db, ceo, orchestrator, companyId } = await company();
    const [sales] = await db.insert(departments).values({ companyId, name: 'Sales', roleCode: 'SAL' }).returning();
    const head = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', scope: { kind: 'department', id: sales!.id } });
    const stream = await openStream(app, head);
    await new Promise(r => setTimeout(r, 50));
    await appendEvent(app.ctx, { companyId, agentId: orchestrator.id, kind: 'text', data: { text: 'secret plans' } });
    app.ctx.bus.publish(companyId, { type: 'org' });
    await until(() => stream.messages.some(m => m.type === 'org'));
    expect(stream.messages.map(m => m.type)).toEqual(['org']);
    stream.close();
  });

  it('ends the stream of a person who was disabled, at the next ping', async () => {
    const { app, db, ceo, companyId } = await company({ STREAM_PING_MS: '50' });
    const [sales] = await db.insert(departments).values({ companyId, name: 'Sales', roleCode: 'SAL' }).returning();
    const head = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', scope: { kind: 'department', id: sales!.id } });
    const stream = await openStream(app, head);
    const maria = (await app.inject({ url: '/api/people', ...as(ceo) })).json().people.find((p: { name: string }) => p.name === 'Maria');
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${maria.id}`, payload: { status: 'disabled' }, ...as(ceo) })).statusCode).toBe(200);
    await until(() => stream.ended());
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
