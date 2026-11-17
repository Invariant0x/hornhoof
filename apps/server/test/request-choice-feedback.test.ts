import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, people, requests, sessions, subscriptions, taskEvents } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { orchestratorDecisionHeaders, orchestratorHeaders } from '../src/auth/internal.js';
import { appendEvent } from '../src/modules/events/store.js';
import { answer, ask, createTask } from '../src/modules/tasks/engine.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

const FEEDBACK = 'Neither option fits. Keep the labels readable.';

async function company() {
  const { app, db } = await testApp();
  const session = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [ceo] = await db.select().from(people);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [worker] = await db.insert(agents).values({ companyId: acme!.id, departmentId: dev!.id, subscriptionId: sub!.id, kind: 'worker', name: 'Fran', roleKey: 'DEV-FE', model: '' }).returning();
  const task = (await createTask(app.ctx, { personId: ceo!.id }, { title: 'Choose a preview', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: worker!.id, executor: true })).task;
  const request = (await ask(app.ctx, worker!.id, task.id, { kind: 'choice', topic: 'task', text: 'Which shape?', options: [{ label: 'Round', image: null }, { label: 'Square', image: null }] })).request;
  const saved = async () => (await db.select().from(requests).where(eq(requests.id, request.id)))[0]!;
  const answered = () => db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'answered')));
  return { app, db, session, ceo: ceo!, orchestrator: orchestrator!, companyId: acme!.id, sub: sub!, dev: dev!, worker: worker!, task, request, saved, answered };
}

describe('choice feedback without a pick', () => {
  it('accepts HTTP feedback as neutral text and delivers the actual person to its author', async () => {
    const c = await company();
    const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: `  ${FEEDBACK}  ` }, ...as(c.session) });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toEqual({ request: { id: c.request.id, status: 'answered', picked: null, answer: FEEDBACK } });
    expect(await c.saved()).toMatchObject({ status: 'answered', picked: null, answer: FEEDBACK, answeredBy: c.ceo.id, answeredByAgentId: null, answerJobId: null, answerSourceSeq: null });
    const [event] = await c.answered();
    expect(event).toMatchObject({ personId: c.ceo.id, agentId: null, text: FEEDBACK, data: { requestId: c.request.id, kind: 'choice', status: 'answered' } });
    const detail = await c.app.inject({ url: `/api/tasks/${c.task.id}`, ...as(c.session) });
    expect(detail.json().task.requests).toEqual([expect.objectContaining({ id: c.request.id, status: 'answered', picked: null, answer: FEEDBACK })]);
    const notices = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.worker.id), eq(agentEvents.kind, 'message')));
    const delivered = notices.filter(event => (event.data as { notification?: { source?: string } }).notification?.source === 'answered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.data).toMatchObject({ actor: { kind: 'person', id: c.ceo.id }, notification: { source: 'answered', tasks: [{ id: c.task.id, number: c.task.number }] } });
    expect((delivered[0]!.data as { text: string }).text).toContain(FEEDBACK);
    expect((delivered[0]!.data as { text: string }).text).not.toMatch(/Picked \d|Approved|Declined/);
  });

  it('keeps a neutral engine wake and its provenance without inventing a chosen option', async () => {
    const c = await company();
    const result = await answer(c.app.ctx, { personId: c.ceo.id }, c.request.id, { answer: FEEDBACK });
    const [event] = await c.answered();
    expect(result.request).toMatchObject({ status: 'answered', picked: null, answer: FEEDBACK, answeredBy: c.ceo.id });
    expect(result.wakes).toEqual([{ agentId: c.worker.id, taskId: c.task.id, why: 'answered', text: FEEDBACK, cause: { actor: { personId: c.ceo.id }, action: 'answered', eventId: event!.id, task: { id: c.task.id, number: c.task.number } } }]);
  });
});

it('rejects an approval-shaped reply to a choice even when it carries feedback', async () => {
  const c = await company();
  const response = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { approve: true, answer: FEEDBACK }, ...as(c.session) });
  expect(response.statusCode).toBe(400);
  expect(await c.saved()).toMatchObject({ status: 'open', picked: null, answer: null, answeredBy: null });
});
it.each(['Round', FEEDBACK])('does not infer a selected option from feedback %s', async text => {
  const c = await company();
  const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: text }, ...as(c.session) });
  expect(result.statusCode).toBe(200);
  expect(await c.saved()).toMatchObject({ status: 'answered', picked: null, answer: text });
  expect((await c.answered())[0]!.text).toBe(text);
});

it.each([undefined, 'A bit smaller.'])('retains explicit pick zero and its comment %s', async text => {
  const c = await company();
  const response = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { pick: 0, ...(text ? { answer: text } : {}) }, ...as(c.session) });
  expect(response.statusCode).toBe(200);
  expect(await c.saved()).toMatchObject({ status: 'answered', picked: 0, answer: text ?? null, answeredBy: c.ceo.id });
  expect((await c.answered())[0]!.text).toBe(`Picked 1: Round.${text ? ` ${text}` : ''}`);
});

it.each([{}, { answer: '' }, { answer: '  \n\t' }, { answer: 4001 }, { pick: null, answer: FEEDBACK }, { pick: -1, answer: FEEDBACK }, { pick: 2, answer: FEEDBACK }, { pick: 0.5, answer: FEEDBACK }, { pick: '0', answer: FEEDBACK }])('rejects an invalid answer without changing the request: %j', async payload => {
  const c = await company();
  const response = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload, ...as(c.session) });
  expect(response.statusCode).toBe(400);
  expect(await c.saved()).toMatchObject({ status: 'open', picked: null, answer: null, answeredBy: null });
  expect(await c.answered()).toEqual([]);
});

it('keeps a 4000-character feedback after trimming', async () => {
  const c = await company();
  const text = 'x'.repeat(4000);
  const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: ` ${text} ` }, ...as(c.session) });
  expect(result.statusCode).toBe(200);
  expect(await c.saved()).toMatchObject({ answer: text, picked: null, status: 'answered' });
});

it('requires explicit approval for an approval request', async () => {
  const c = await company();
  const approval = (await ask(c.app.ctx, c.worker.id, c.task.id, { kind: 'approval', text: 'Approve this test commit?', commit: 'a'.repeat(40) })).request;
  const feedback = await c.app.inject({ method: 'POST', url: `/api/requests/${approval.id}`, payload: { answer: FEEDBACK }, ...as(c.session) });
  expect(feedback.statusCode).toBe(400);
  expect((await c.db.select().from(requests).where(eq(requests.id, approval.id)))[0]).toMatchObject({ status: 'open', answeredBy: null });
  const approved = await c.app.inject({ method: 'POST', url: `/api/requests/${approval.id}`, payload: { approve: true }, ...as(c.session) });
  expect(approved.statusCode).toBe(200);
  expect(approved.json().request.status).toBe('approved');
});

type Fixture = Awaited<ReturnType<typeof company>>;
async function person(c: Fixture, name: string, access: { whole: true } | { departments: string[] }, delegate = false) {
  const email = `${name.toLowerCase()}@feedback.invalid`;
  const token = await invitePerson(c.app, c.session, { name, email, access });
  const [row] = await c.db.select().from(people).where(eq(people.email, email));
  if (delegate) expect((await c.app.inject({ method: 'PUT', url: `/api/people/${row!.id}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(c.session) })).statusCode).toBe(200);
  return { token, id: row!.id };
}

it.each(['department', 'delegate'] as const)('lets the actual authorized %s person answer neutrally', async role => {
  const c = await company();
  const p = await person(c, 'Reader', role === 'department' ? { departments: [c.dev.id] } : { whole: true }, role === 'delegate');
  const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: FEEDBACK }, ...as(p.token) });
  expect(result.statusCode, result.body).toBe(200);
  expect(await c.saved()).toMatchObject({ status: 'answered', picked: null, answeredBy: p.id, answeredByAgentId: null });
});

it('refuses a company viewer who cannot decide, and an unauthenticated caller', async () => {
  const c = await company();
  const viewer = await person(c, 'Viewer', { whole: true });
  const url = `/api/requests/${c.request.id}`;
  expect((await c.app.inject({ method: 'POST', url, payload: { answer: FEEDBACK }, ...as(viewer.token) })).statusCode).toBe(403);
  expect((await c.app.inject({ method: 'POST', url, payload: { answer: FEEDBACK } })).statusCode).toBe(401);
  expect(await c.saved()).toMatchObject({ status: 'open', answer: null, answeredBy: null, picked: null });
  expect(await c.answered()).toEqual([]);
});

it('does not reveal or answer another company request', async () => {
  const c = await company();
  const [other] = await c.db.insert(companies).values({ name: 'Other fixture', singleton: false }).returning();
  const [owner] = await c.db.insert(people).values({ companyId: other!.id, name: 'Other owner', email: 'other@feedback.invalid', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const token = 'foreign-feedback-fixture-session';
  await c.db.insert(sessions).values({ tokenHash: hashToken(token), personId: owner!.id, expiresAt: new Date(Date.now() + 60_000) });
  const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: FEEDBACK }, ...as(token) });
  expect(result.statusCode).toBe(404);
  expect(await c.saved()).toMatchObject({ status: 'open', answer: null, answeredBy: null, picked: null });
});

it('rechecks authority when the answer is committed', async () => {
  const c = await company();
  const delegate = await person(c, 'Delegate', { whole: true }, true);
  const transaction = c.db.transaction.bind(c.db);
  vi.spyOn(c.db, 'transaction').mockImplementationOnce(async (fn, options) => {
    await c.db.update(people).set({ isCeoDelegate: false }).where(eq(people.id, delegate.id));
    return transaction(fn, options);
  });
  const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: FEEDBACK }, ...as(delegate.token) });
  expect(result.statusCode).toBe(403);
  expect(await c.saved()).toMatchObject({ status: 'open', picked: null, answer: null, answeredBy: null });
  expect(await c.answered()).toEqual([]);
});

it('preserves delegated identity and audit and rejects stale delegation', async () => {
  const c = await company();
  const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.orchestrator.id, kind: 'conversation', prompt: '', timeoutMs: 900000, status: 'running' }).returning();
  const { seq } = await appendEvent(c.app.ctx, { companyId: c.companyId, agentId: c.orchestrator.id, jobId: job!.id, kind: 'message', data: { text: FEEDBACK }, personId: c.ceo.id });
  const headers = orchestratorDecisionHeaders({ personId: c.ceo.id, agentId: c.orchestrator.id, jobId: job!.id, sourceSeq: seq });
  const ok = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: FEEDBACK }, headers });
  expect(ok.statusCode, ok.body).toBe(200);
  expect(await c.saved()).toMatchObject({ status: 'answered', picked: null, answer: FEEDBACK, answeredBy: c.ceo.id, answeredByAgentId: c.orchestrator.id, answerJobId: job!.id, answerSourceSeq: seq });
  const [event] = await c.answered();
  expect(event).toMatchObject({ agentId: c.orchestrator.id, personId: null, text: FEEDBACK, data: { onBehalfOfPersonId: c.ceo.id, jobId: job!.id, sourceSeq: seq } });
  const next = (await ask(c.app.ctx, c.worker.id, c.task.id, { kind: 'choice', text: 'Try again?', options: [{ label: 'One', image: null }, { label: 'Two', image: null }] })).request;
  await appendEvent(c.app.ctx, { companyId: c.companyId, agentId: c.orchestrator.id, jobId: job!.id, kind: 'message', data: { text: 'New words' }, personId: c.ceo.id });
  const stale = await c.app.inject({ method: 'POST', url: `/api/requests/${next.id}`, payload: { answer: FEEDBACK }, headers });
  expect(stale.statusCode).toBe(409);
  expect((await c.db.select().from(requests).where(eq(requests.id, next.id)))[0]).toMatchObject({ status: 'open', answer: null, answeredBy: null });
});

it("takes the orchestrator's own feedback, with no turn of a person in it, as the owner's", async () => {
  const c = await company();
  const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: FEEDBACK }, headers: orchestratorHeaders(c.ceo.id, c.orchestrator.id) });
  expect(result.statusCode, result.body).toBe(200);
  expect(await c.saved()).toMatchObject({ status: 'answered', answer: FEEDBACK, answeredBy: c.ceo.id });
});

it('answers once when feedback races or is retried', async () => {
  const c = await company();
  const result = await Promise.all(['First feedback.', 'Second feedback.'].map(text => c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: text }, ...as(c.session) })));
  expect(result.map(r => r.statusCode).sort()).toEqual([200, 409]);
  const saved = await c.saved();
  expect(['First feedback.', 'Second feedback.']).toContain(saved.answer);
  expect(saved).toMatchObject({ status: 'answered', picked: null, answeredBy: c.ceo.id });
  const answered = await c.answered();
  expect(answered).toHaveLength(1);
  expect(answered[0]!.text).toBe(saved.answer);
  const notices = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.worker.id), eq(agentEvents.kind, 'message')));
  expect(notices.filter(event => (event.data as { notification?: { source?: string } }).notification?.source === 'answered')).toHaveLength(1);
  const retry = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: FEEDBACK }, ...as(c.session) });
  expect(retry.statusCode).toBe(409);
  expect(retry.json().error.reason).toBe('request_closed');
  expect(await c.answered()).toHaveLength(1);
});

it('leaves a withdrawn request untouched', async () => {
  const c = await company();
  await c.db.update(requests).set({ status: 'withdrawn' }).where(eq(requests.id, c.request.id));
  const result = await c.app.inject({ method: 'POST', url: `/api/requests/${c.request.id}`, payload: { answer: FEEDBACK }, ...as(c.session) });
  expect(result.statusCode).toBe(409);
  expect(await c.saved()).toMatchObject({ status: 'withdrawn', picked: null, answer: null, answeredBy: null });
  expect(await c.answered()).toEqual([]);
});
