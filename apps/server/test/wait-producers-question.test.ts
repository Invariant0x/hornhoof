import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { people, requestInternal, requests, tasks, taskWaits } from '../src/db/schema.js';
import { ask, cancel, type Request, type Task } from '../src/modules/tasks/engine.js';
import { endQuestionWait, keepWaitsWithMove, questionSourceKey, syncQuestionWait, type QuestionGuard } from '../src/modules/tasks/wait-producers.js';
import { requestSourceKey } from '../src/modules/tasks/wait-state.js';
import { waitCompany } from './wait-company.js';

const HOUR = 3_600_000;
const later = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

async function company() {
  const c = await waitCompany();
  const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
  const work = await c.task();
  const { request } = await ask(c.ctx, c.agent.id, work.id, { kind: 'question', text: 'Which one?' });
  const guard = (r: Pick<Request, 'id' | 'questionRevision' | 'routeRevision'> = request, t: Pick<Task, 'id'> = work): QuestionGuard => ({ taskId: t.id, requestId: r.id, expectedRevision: r.questionRevision, expectedRouteRevision: r.routeRevision, actor: { agentId: c.head.id } });
  const sync = (g: QuestionGuard = guard(), plan?: Parameters<typeof syncQuestionWait>[1]['plan']) => c.db.transaction(tx => syncQuestionWait(tx, { ...g, plan }));
  const end = (g: QuestionGuard = guard(), outcome: 'resolved' | 'cancelled' | 'superseded' = 'resolved', proofRef = `question:${request.id}:test`) => c.db.transaction(tx => endQuestionWait(tx, { ...g, outcome, proofRef }));
  const waits = (t: Pick<Task, 'id'> = work) => c.db.select().from(taskWaits).where(eq(taskWaits.taskId, t.id)).orderBy(asc(taskWaits.createdAt));
  const plan = () => ({ version: 1 as const, ownerDueAt: later(1), headDueAt: later(2), decisionDueAt: later(3), provenance: { kind: 'explicit_promise' as const, actor: { personId: ceo!.id }, ref: 'promise-1', revision: 1, origin: 'test' }, finalReview: { headAgentId: c.head.id, anchorAt: later(4), intervalMs: HOUR } });
  const reason = (p: Promise<unknown>) => p.then(() => 'ok', (err: { reason?: string }) => err.reason ?? String(err));
  /* What classification leaves: the kernel itself is tested with the question's whole life. */
  const beforeAPerson = async (recipients = [ceo!.id], kind: 'decision' | 'owner_login' = 'decision') => {
    const purpose = kind === 'decision' ? { kind, decisionKind: 'question', authorityKind: 'ceo_and_delegate', departmentId: null } : { kind, resourceId: c.sub.id, subscriptionId: c.sub.id, ownerPersonId: recipients[0]!, provider: 'anthropic_api' };
    await c.db.update(requests).set({ audience: 'human', classification: { authority: { recipientPersonIds: recipients, authorityDigest: 'a'.repeat(64), purpose } } as never }).where(eq(requests.id, request.id));
  };
  return { ...c, ceoPerson: ceo!, work, request, guard, sync, end, waits, plan, reason, beforeAPerson };
}

describe('the wait of a question', () => {
  it('while inside is of an agent, by its own key, under the revision of its route', async () => {
    const c = await company();
    expect(await c.waits()).toMatchObject([{ kind: 'external', sourceKey: questionSourceKey(c.request.id), ownerAgentId: c.head.id, ownerPersonId: null, sourceRevision: 1, state: 'legacy_needs_plan', plan: null, ownerDueAt: null, nextActionAt: null }]);
  });

  it('takes a promise given for it, and then dates of its own', async () => {
    const c = await company();
    const kept = await c.sync(c.guard(), c.plan());
    expect(kept).toMatchObject({ kind: 'external', state: 'active', ownerAgentId: c.head.id, sourceRevision: 1 });
    expect(kept!.ownerDueAt).not.toBeNull();
  });

  it('before a person is of that person, and the kind it was before ends in the same write', async () => {
    const c = await company();
    await c.beforeAPerson();
    const kept = await c.sync();
    expect(kept).toMatchObject({ kind: 'person', ownerPersonId: c.ceoPerson.id, ownerAgentId: null, sourceKey: questionSourceKey(c.request.id), sourceRevision: 1 });
    expect(await c.waits()).toMatchObject([{ kind: 'external', state: 'superseded', proofRef: `question:${c.request.id}:route:1` }, { kind: 'person', state: 'legacy_needs_plan' }]);
  });

  it('for what only one person can do is of that person', async () => {
    const c = await company();
    await c.beforeAPerson([c.ceoPerson.id], 'owner_login');
    expect(await c.sync()).toMatchObject({ kind: 'person', ownerPersonId: c.ceoPerson.id });
  });

  it('is refused for a person who is not among those who were bound to take it', async () => {
    const c = await company();
    await c.beforeAPerson([randomUUID()]);
    expect(await c.reason(c.sync())).toBe('stale_route');
    expect((await c.waits()).filter(w => w.kind === 'person')).toEqual([]);
  });

  it('is refused before a person with nothing put before them', async () => {
    const c = await company();
    await c.db.update(requests).set({ audience: 'human' }).where(eq(requests.id, c.request.id));
    expect(await c.reason(c.sync())).toBe('classification_required');
  });

  it('with nobody to have it keeps only the recovery intent: no wait, no date', async () => {
    const c = await company();
    const second = (await ask(c.ctx, c.agent.id, c.work.id, { kind: 'question', text: 'And this?' })).request;
    await c.db.update(requests).set({ triageAgentId: null }).where(eq(requests.id, second.id));
    await c.db.delete(taskWaits).where(eq(taskWaits.sourceKey, questionSourceKey(second.id)));
    expect(await c.sync(c.guard(second))).toBeNull();
    expect((await c.waits()).filter(w => w.sourceKey === questionSourceKey(second.id))).toEqual([]);
  });

  it('goes with whoever has it now, with no date made up', async () => {
    const c = await company();
    await c.db.update(requests).set({ triageAgentId: c.orchestrator.id, routeRevision: 2 }).where(eq(requests.id, c.request.id));
    const kept = await c.sync(c.guard({ ...c.request, routeRevision: 2 }));
    expect(kept).toMatchObject({ ownerAgentId: c.orchestrator.id, plan: null, state: 'legacy_needs_plan' });
  });

  it('with no dates carries the revision of its route, even with the same one having it, and a repeat changes nothing', async () => {
    const c = await company();
    await c.db.update(requests).set({ routeRevision: 2 }).where(eq(requests.id, c.request.id));
    const guard = c.guard({ ...c.request, routeRevision: 2 });
    const kept = await c.sync(guard);
    expect(kept).toMatchObject({ ownerAgentId: c.head.id, sourceRevision: 2, state: 'legacy_needs_plan', ownerDueAt: null });
    expect((await c.sync(guard))!.id).toBe(kept!.id);
    expect((await c.waits()).filter(w => w.endedAt === null)).toHaveLength(1);
  });

  it('that was open ends once nobody can have it, and only the recovery intent stays', async () => {
    const c = await company();
    await c.db.update(requests).set({ triageAgentId: null, routeRevision: 2 }).where(eq(requests.id, c.request.id));
    expect(await c.sync(c.guard({ ...c.request, routeRevision: 2 }))).toBeNull();
    expect(await c.waits()).toMatchObject([{ outcome: 'superseded', proofRef: `question:${c.request.id}:route:2`, endedAt: expect.any(Date) }]);
    expect((await c.db.select().from(requestInternal).where(eq(requestInternal.requestId, c.request.id)))[0]!.recoveryIntent).toMatchObject({ reason: 'internal_route_unavailable' });
  });

  it('keeps a promise given for it when another comes to have it, under the new route', async () => {
    const c = await company();
    await c.sync(c.guard(), c.plan());
    await c.db.update(requests).set({ triageAgentId: c.orchestrator.id, routeRevision: 2 }).where(eq(requests.id, c.request.id));
    expect(await c.sync(c.guard({ ...c.request, routeRevision: 2 }))).toMatchObject({ ownerAgentId: c.orchestrator.id, sourceRevision: 2, state: 'active', ownerDueAt: expect.any(Date) });
  });

  it('refuses what was read before, and a question of another task', async () => {
    const c = await company();
    expect(await c.reason(c.sync({ ...c.guard(), expectedRevision: 2 }))).toBe('stale_revision');
    expect(await c.reason(c.sync({ ...c.guard(), expectedRouteRevision: 2 }))).toBe('stale_route');
    const other = await c.task();
    expect(await c.reason(c.sync({ ...c.guard(), taskId: other.id }))).toBe('request_unknown');
    expect(await c.reason(c.sync({ ...c.guard(), requestId: randomUUID() }))).toBe('request_unknown');
    expect(await c.reason(c.sync({ ...c.guard(), taskId: randomUUID() }))).toBe('request_unknown');
  });

  it('refuses a question that is closed', async () => {
    const c = await company();
    await c.db.update(requests).set({ status: 'withdrawn' }).where(eq(requests.id, c.request.id));
    expect(await c.reason(c.sync())).toBe('source_closed');
  });

  it('ends for that one question: not the other, a repeat changes nothing and another outcome is refused', async () => {
    const c = await company();
    const second = (await ask(c.ctx, c.agent.id, c.work.id, { kind: 'question', text: 'And this?' })).request;
    await c.end();
    const after = await c.waits();
    expect(after.find(w => w.sourceKey === questionSourceKey(c.request.id))).toMatchObject({ state: 'resolved', proofRef: `question:${c.request.id}:test` });
    expect(after.find(w => w.sourceKey === questionSourceKey(second.id))).toMatchObject({ state: 'legacy_needs_plan' });
    await c.end();
    expect(await c.reason(c.end(c.guard(), 'cancelled'))).toBe('task_changed');
  });

  it('ends as a person wait once it is before one', async () => {
    const c = await company();
    await c.beforeAPerson();
    await c.sync();
    await c.end();
    expect((await c.waits()).find(w => w.kind === 'person')).toMatchObject({ state: 'resolved' });
  });

  it('ends with the task, whichever kind it waits as', async () => {
    const c = await company();
    const person = (await c.db.select().from(people).where(eq(people.isOwner, true)))[0]!;
    await cancel(c.ctx, { personId: person.id }, c.work.id, 'Not needed.');
    expect(await c.waits()).toMatchObject([{ kind: 'external', state: 'cancelled' }]);
    expect((await c.db.select().from(requests).where(eq(requests.id, c.request.id)))[0]!.status).toBe('withdrawn');
  });

  it('ends when its question is taken back while the task goes on, the old name and the new one alike', async () => {
    const c = await company();
    const person = (await c.db.select().from(people).where(eq(people.isOwner, true)))[0]!;
    const [held] = await c.db.insert(taskWaits).values({ companyId: c.companyId, taskId: c.work.id, kind: 'person', sourceKey: requestSourceKey(c.request.id), state: 'legacy_needs_plan', generation: 1, sourceRevision: 0, ownerPersonId: person.id, sourceState: {} }).returning();
    await c.db.update(requests).set({ status: 'withdrawn' }).where(eq(requests.id, c.request.id));
    const [row] = await c.db.select().from(tasks).where(eq(tasks.id, c.work.id));
    await c.db.transaction(tx => keepWaitsWithMove(tx, row!, row!, { kind: 'updated', actor: { personId: person.id }, eventId: 1 }));
    const after = await c.waits();
    expect(after.find(w => w.id === held!.id)).toMatchObject({ state: 'cancelled', proofRef: `request:${c.request.id}:withdrawn` });
    expect(after.find(w => w.sourceKey === questionSourceKey(c.request.id))).toMatchObject({ state: 'cancelled', proofRef: `request:${c.request.id}:withdrawn` });
  });
});
