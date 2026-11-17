import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import type { ServerMessage } from '@hornhoof/protocol';
import { jobs } from '../src/db/schema.js';
import { failOpenJobs, handleNodeMessage } from '../src/modules/nodes/messages.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { as, connectNode, listen, setUpCompany, statements, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
type Run = Extract<ServerMessage, { type: 'job.run' }>;

async function atWork(terminals = false) {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const node = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals });
  await until(async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().state.ready);
  await app.inject({ method: 'POST', url: '/api/agents/orchestrator/start', ...as(ceo) });
  const run = await node.next() as Run;
  const stop = () => app.inject({ method: 'POST', url: `/api/jobs/${run.jobId}/cancel`, ...as(ceo) });
  const receive = (msg: Parameters<typeof handleNodeMessage>[2]) => handleNodeMessage(app.ctx, BUILTIN, msg);
  return { app, db, ceo, node, run, stop, receive };
}

it('keeps a reply only under the queued letter, ignoring the old stream as soon as Stop is requested', async () => {
  const c = await atWork();
  const queries = statements();
  await c.receive({ type: 'job.event', jobId: c.run.jobId, seq: 0, event: { kind: 'text', text: 'Work before Stop.' } });
  expect(queries.some(query => query.sql.includes('from "jobs"') && query.sql.includes('for update'))).toBe(true);
  await c.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'The queued letter.' }, ...as(c.ceo) });
  expect((await c.stop()).statusCode).toBe(202);
  expect(await c.node.next()).toEqual({ type: 'job.cancel', jobId: c.run.jobId });
  const reply = { kind: 'text' as const, text: 'The reply to the queued letter.' };
  await c.receive({ type: 'job.event', jobId: c.run.jobId, seq: 17, event: reply });
  await c.receive({ type: 'job.done', jobId: c.run.jobId, ok: false, sessionId: 'session-1', result: 'Stopped.', tail: '', error: 'cancelled' });
  await c.receive({ type: 'job.event', jobId: c.run.jobId, seq: 18, event: reply });
  const next = await c.node.next() as Run;
  expect(next.type).toBe('job.run');
  await c.receive({ type: 'job.event', jobId: next.jobId, seq: 0, event: reply });
  await c.receive({ type: 'job.done', jobId: next.jobId, ok: true, sessionId: 'session-1', result: reply.text, tail: '', error: null });
  const feed = (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceo) })).json().events;
  const replies = feed.filter((event: { kind: string; data: { text?: string } }) => event.kind === 'text' && event.data.text === reply.text);
  expect(replies).toHaveLength(1);
  expect(feed).toContainEqual(expect.objectContaining({ jobId: c.run.jobId, data: { kind: 'text', text: 'Work before Stop.' } }));
  expect(replies[0].jobId).toBe(next.jobId);
  const letter = feed.find((event: { kind: string; jobId: string }) => event.kind === 'message' && event.jobId === next.jobId);
  expect(replies[0].seq).toBeGreaterThan(letter.seq);
});

it('preserves Stop when the node races back with a successful completion', async () => {
  const c = await atWork();
  await c.stop();
  await c.receive({ type: 'job.done', jobId: c.run.jobId, ok: true, sessionId: 'session-1', result: 'Late answer.', tail: '', error: null });
  const [job] = await c.db.select().from(jobs).where(eq(jobs.id, c.run.jobId));
  expect(job).toMatchObject({ status: 'failed', error: 'cancelled', result: 'Stopped.', sessionId: 'session-1' });
});

it('preserves a pending Stop if the node restarts before confirming it', async () => {
  const c = await atWork();
  await c.stop();
  await failOpenJobs(c.app.ctx, eq(jobs.id, c.run.jobId), 'machine_restarted');
  const [job] = await c.db.select().from(jobs).where(eq(jobs.id, c.run.jobId));
  expect(job).toMatchObject({ status: 'failed', error: 'cancelled', result: 'Stopped.' });
});

it('queues a letter when its live delivery is acknowledged after Stop', async () => {
  const c = await atWork(true);
  const sending = c.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'The queued letter.' }, ...as(c.ceo) });
  const words = await c.node.next();
  expect(words.type).toBe('agent.say');
  if (words.type !== 'agent.say') throw new Error('Expected live delivery');
  await c.stop();
  expect(await c.node.next()).toEqual({ type: 'job.cancel', jobId: c.run.jobId });
  await c.receive({ type: 'agent.said', ref: words.ref, ok: true });
  const response = await sending;
  expect(response.json().jobId).not.toBe(c.run.jobId);
  const [queued] = await c.db.select().from(jobs).where(eq(jobs.id, response.json().jobId));
  expect(queued).toMatchObject({ status: 'queued' });
});

it('queues new words without sending them to a turn already stopping', async () => {
  const c = await atWork(true);
  await c.stop();
  expect(await c.node.next()).toEqual({ type: 'job.cancel', jobId: c.run.jobId });
  c.node.ws.on('message', data => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if (message.type === 'agent.say') c.node.send({ type: 'agent.said', ref: message.ref, ok: true });
  });
  const sent = vi.spyOn(c.app.ctx.hub, 'send');
  const response = await c.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'Words after Stop.' }, ...as(c.ceo) });
  expect(response.json().jobId).not.toBe(c.run.jobId);
  expect(sent.mock.calls.map(([, message]) => message.type)).not.toContain('agent.say');
});

it('keeps acknowledged live words in their original turn if it completed normally before the acknowledgment', async () => {
  const c = await atWork(true);
  const sending = c.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'An accepted live letter.' }, ...as(c.ceo) });
  const words = await c.node.next();
  expect(words.type).toBe('agent.say');
  if (words.type !== 'agent.say') throw new Error('Expected live delivery');
  await c.receive({ type: 'job.done', jobId: c.run.jobId, ok: true, sessionId: 'session-1', result: 'The answer to the live letter.', tail: '', error: null });
  await c.receive({ type: 'agent.said', ref: words.ref, ok: true });
  expect((await sending).json().jobId).toBe(c.run.jobId);
  expect(await c.db.select({ id: jobs.id }).from(jobs)).toEqual([{ id: c.run.jobId }]);
});
