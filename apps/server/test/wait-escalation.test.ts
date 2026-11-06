import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, departments, jobs, people, requests, sessions, taskEvents, taskWaits, waitNotices, waitPolicies } from '../src/db/schema.js';
import * as queue from '../src/modules/conversation/queue.js';
import { answer, cancel, comment, createTask, type Task } from '../src/modules/tasks/engine.js';
import { checkWaitHealth } from '../src/modules/tasks/wait-monitor.js';
import * as notices from '../src/modules/tasks/wait-notices.js';
import { sweepWaits } from '../src/modules/tasks/wait-escalation.js';
import { moveWaitOwner, operationSourceKey, syncSourceWaits } from '../src/modules/tasks/wait-state.js';
import { as, askedOfPerson } from './helpers.js';
import { waitCompany } from './wait-company.js';

const HOUR = 3_600_000;

async function company() {
  const c = await waitCompany();
  const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
  const CEO = { personId: ceo!.id };
  const policy = (kind: 'after' | 'person' | 'review' | 'external' = 'after') => c.db.insert(waitPolicies).values({
    companyId: c.companyId, departmentId: c.dev.id, kind, stage: '', version: 1, ownerMs: HOUR, headMs: 2 * HOUR, decisionMs: 3 * HOUR, reviewIntervalMs: 4 * HOUR, createdByPersonId: ceo!.id,
  });
  const first = async () => c.task(c.agent.id);
  /* A task of the head's that comes after Bruno's: Bruno answers for the wait, on the department's dates from now. */
  const follow = async (before: Task) => (await createTask(c.ctx, { agentId: c.head.id }, { title: 'Follow', brief: '', body: 'Private words of the work.', departmentId: c.dev.id, assigneeAgentId: c.head.id, executor: true, gates: [], after: [before.id], independentNone: 'One piece.' })).task;
  const waiting = async () => {
    await policy();
    const before = await first();
    const task = await follow(before);
    return { before, task, wait: (await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, task.id)))[0]! };
  };
  const row = async (id: string) => (await c.db.select().from(taskWaits).where(eq(taskWaits.id, id)))[0]!;
  const noticesOf = (id: string) => c.db.select().from(waitNotices).where(eq(waitNotices.waitId, id));
  const named = async (name: string) => {
    const [person] = await c.db.insert(people).values({ companyId: c.companyId, name, email: `${name.toLowerCase()}@example.test`, status: 'active', scopeKind: 'company' }).returning();
    return person!;
  };
  const ownedBy = async (personId: string) => c.db.update(departments).set({ ownerPersonId: personId }).where(eq(departments.id, c.dev.id));
  const audit = (taskId: string) => c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'wait_due')));
  const ceoTurns = () => c.db.select().from(jobs).where(and(eq(jobs.companyId, c.companyId), eq(jobs.kind, 'conversation')));
  /* A signed-in session of a person, as the screen has. */
  const tokenOf = async (personId: string) => {
    const token = `session-${randomUUID()}`;
    await c.db.insert(sessions).values({ personId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 1000 * HOUR) });
    return token;
  };
  return { ...c, CEO, ceoPerson: ceo!, policy, first, follow, waiting, row, noticesOf, named, ownedBy, audit, ceoTurns, tokenOf };
}

const at = (date: Date | null, ms = 0) => new Date(date!.getTime() + ms);

describe('a wait past its dates', () => {
  it('says nothing before its date, and once at the very moment it comes', async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.ownerDueAt, -1));
    expect(await c.noticesOf(wait.id)).toEqual([]);
    expect(await c.row(wait.id)).toMatchObject({ level: 0, generation: 1 });
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    expect(await c.row(wait.id)).toMatchObject({ level: 1, nextActionAt: wait.headDueAt });
    expect(await c.noticesOf(wait.id)).toMatchObject([{ agentId: c.agent.id, personId: null, level: 1, generation: 1, purpose: 'escalation', routeRevision: 0, deliveredAt: null }]);
    expect(await c.audit(task.id)).toMatchObject([{ data: { wait: { id: wait.id, level: 1, generation: 1 } } }]);
  });

  it('goes up one level in each sweep however late it is, and no date moves', async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    const late = at(wait.decisionDueAt, 100 * HOUR);
    const levels: number[] = [];
    for (let i = 0; i < 4; i++) {
      await sweepWaits(c.ctx, late);
      levels.push((await c.row(wait.id)).level);
    }
    expect(levels).toEqual([1, 2, 3, 3]);
    expect(await c.row(wait.id)).toMatchObject({ ownerDueAt: wait.ownerDueAt, headDueAt: wait.headDueAt, decisionDueAt: wait.decisionDueAt, state: 'active', plan: wait.plan });
    const raised = (await c.audit(task.id)).map(e => (e.data as { wait: { level?: number } }).wait.level).filter(level => level !== undefined);
    expect(raised).toEqual([1, 2, 3]);
  });

  it('keeps its date and its notice through a comment', async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    await comment(c.ctx, { agentId: c.agent.id }, task.id, 'Still on it.');
    expect(await c.row(wait.id)).toMatchObject({ generation: 1, level: 1, ownerDueAt: wait.ownerDueAt });
    await notices.deliverWaitNotices(c.ctx, at(wait.ownerDueAt));
    expect((await c.noticesOf(wait.id))[0]!.deliveredAt).not.toBeNull();
    expect(await c.messages(c.agent.id)).toHaveLength(1);
  });

  it('takes one step and writes one notice for two sweeps at once', async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    await Promise.all([sweepWaits(c.ctx, at(wait.ownerDueAt)), sweepWaits(c.ctx, at(wait.ownerDueAt))]);
    expect(await c.row(wait.id)).toMatchObject({ level: 1 });
    expect(await c.noticesOf(wait.id)).toHaveLength(1);
    expect(await c.audit(task.id)).toHaveLength(1);
  });

  it('keeps none of a step that fails, and takes it in the next sweep', async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    const failing = vi.spyOn(notices, 'recordWaitNotice').mockRejectedValueOnce(new Error('The disk is full.'));
    onTestFinished(() => failing.mockRestore());
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    expect(await c.row(wait.id)).toMatchObject({ level: 0, nextActionAt: wait.ownerDueAt });
    expect(await c.audit(task.id)).toEqual([]);
    failing.mockRestore();
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    expect(await c.row(wait.id)).toMatchObject({ level: 1 });
    expect(await c.noticesOf(wait.id)).toHaveLength(1);
  });

  it('keeps a notice that could not go out for the next round, and sends it once', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    const failing = vi.spyOn(queue, 'insertOrDeliverTurn').mockRejectedValueOnce(new Error('The queue is gone.'));
    onTestFinished(() => failing.mockRestore());
    await notices.deliverWaitNotices(c.ctx, at(wait.ownerDueAt));
    expect((await c.noticesOf(wait.id))[0]).toMatchObject({ deliveredAt: null, cancelledAt: null });
    failing.mockRestore();
    await notices.deliverWaitNotices(c.ctx, at(wait.ownerDueAt, 3 * 60_000));
    await notices.deliverWaitNotices(c.ctx, at(wait.ownerDueAt, 6 * 60_000));
    expect((await c.noticesOf(wait.id))[0]!.deliveredAt).not.toBeNull();
    expect(await c.messages(c.agent.id)).toHaveLength(1);
  });

  it('forgets what was written for an owner who is no longer the one, and goes on from the level it reached', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    const raised = await c.row(wait.id);
    await c.db.transaction(tx => moveWaitOwner(tx, raised, { agentId: c.watcher.id }, { agentId: c.head.id }));
    expect((await c.noticesOf(wait.id))[0]!.cancelledAt).not.toBeNull();
    await notices.deliverWaitNotices(c.ctx, at(wait.ownerDueAt));
    expect(await c.messages(c.agent.id)).toEqual([]);
    expect(await c.row(wait.id)).toMatchObject({ generation: 2, level: 1, nextActionAt: wait.headDueAt, ownerAgentId: c.watcher.id });
  });

  it('sends nothing for a wait whose source ended, also when it ended after the notice was written', async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    expect(await c.noticesOf(wait.id)).toHaveLength(1);
    await cancel(c.ctx, c.CEO, task.id, 'Not needed.');
    await notices.deliverWaitNotices(c.ctx, at(wait.ownerDueAt));
    expect(await c.messages(c.agent.id)).toEqual([]);
    expect((await c.noticesOf(wait.id))[0]!.cancelledAt).not.toBeNull();
    await sweepWaits(c.ctx, at(wait.headDueAt));
    expect(await c.row(wait.id)).toMatchObject({ state: 'cancelled', level: 1 });
  });

  it('checks the wait again as it sends, whatever a late sweep or a stale claim wrote', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    /* The level moved on with no cancel, as a claim from before a restart would find it. */
    await c.db.update(taskWaits).set({ level: 2 }).where(eq(taskWaits.id, wait.id));
    await notices.deliverWaitNotices(c.ctx, at(wait.ownerDueAt));
    expect(await c.messages(c.agent.id)).toEqual([]);
    expect((await c.noticesOf(wait.id))[0]!.cancelledAt).not.toBeNull();
  });

  it('cancels what is still waiting to go out for the level before', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.headDueAt));
    await sweepWaits(c.ctx, at(wait.headDueAt));
    const rows = await c.noticesOf(wait.id);
    expect(rows.find(n => n.level === 1)!.cancelledAt).not.toBeNull();
    expect(rows.find(n => n.level === 2)).toMatchObject({ agentId: c.head.id, cancelledAt: null, purpose: 'escalation' });
  });

  it('does not tell again one who has already heard, and keeps that in the record', async () => {
    const c = await company();
    await c.policy();
    const held = await c.task(c.head.id);
    const task = await c.follow(held);
    const [wait] = await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, task.id));
    await sweepWaits(c.ctx, at(wait!.decisionDueAt));
    await sweepWaits(c.ctx, at(wait!.decisionDueAt));
    expect(await c.row(wait!.id)).toMatchObject({ level: 2, ownerAgentId: c.head.id });
    expect((await c.noticesOf(wait!.id)).filter(n => n.purpose === 'escalation').map(n => [n.level, n.agentId])).toEqual([[1, c.head.id]]);
    const steps = (await c.audit(task.id)).filter(e => (e.data as { wait: { level?: number } }).wait.level !== undefined);
    expect(steps.map(e => (e.data as { collapsed?: boolean }).collapsed ?? false)).toEqual([false, true]);
  });

  it('never says what the work is: only its number, the kind of wait and whose date it was', async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    await sweepWaits(c.ctx, at(wait.ownerDueAt));
    const [notice] = await c.noticesOf(wait.id);
    const words = JSON.stringify(notice!.message);
    expect(words).toContain(`#${task.number}`);
    expect(words).not.toContain('Private words');
    expect(words).not.toContain('Follow');
    expect(words).not.toContain('Publish images');
  });
});

describe('who hears of it in the end', () => {
  it('tells the head its plan named while the department has none now', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    await c.db.update(agents).set({ kind: 'worker' }).where(eq(agents.id, c.head.id));
    for (let i = 0; i < 2; i++) await sweepWaits(c.ctx, at(wait.headDueAt));
    expect((await c.noticesOf(wait.id)).find(n => n.level === 2)).toMatchObject({ agentId: c.head.id });
  });

  it('tells nobody at that level once that head has left too, and still goes up', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    await c.db.update(agents).set({ kind: 'worker', removedAt: new Date() }).where(eq(agents.id, c.head.id));
    for (let i = 0; i < 2; i++) await sweepWaits(c.ctx, at(wait.headDueAt));
    expect(await c.row(wait.id)).toMatchObject({ level: 2 });
    expect((await c.noticesOf(wait.id)).filter(n => n.level === 2)).toEqual([]);
  });

  it('keeps the CEO as the one who decides, with no notice and no turn for it at any level', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    for (let i = 0; i < 4; i++) await sweepWaits(c.ctx, at(wait.decisionDueAt));
    expect(await c.row(wait.id)).toMatchObject({ level: 3, finalDecisionPersonId: c.ceoPerson.id, fallbackToCeo: true });
    expect((await c.noticesOf(wait.id)).map(n => n.personId).filter(Boolean)).toEqual([]);
    await notices.deliverWaitNotices(c.ctx, at(wait.decisionDueAt));
    expect((await c.ceoTurns()).filter(j => j.agentId === c.orchestrator.id)).toEqual([]);
  });

  it('asks nothing of a CEO who owns a question: the question itself is what waits', async () => {
    const c = await company();
    await c.policy('person');
    const task = await c.task(c.agent.id);
    const { request } = await askedOfPerson(c.ctx, c.agent.id, task.id, { kind: 'question', text: 'Which way?', topic: 'task' });
    const [wait] = await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, task.id));
    expect(wait).toMatchObject({ ownerPersonId: c.ceoPerson.id });
    await sweepWaits(c.ctx, at(wait!.ownerDueAt));
    expect(await c.noticesOf(wait!.id)).toEqual([]);
    expect(await c.row(wait!.id)).toMatchObject({ level: 1 });
    await sweepWaits(c.ctx, at(wait!.headDueAt));
    expect(await c.noticesOf(wait!.id)).toMatchObject([{ level: 2, agentId: c.head.id }]);
    expect((await c.db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'open' });
    await answer(c.ctx, c.CEO, request.id, { answer: 'This way.' });
    expect((await c.row(wait!.id)).state).toBe('resolved');
  });

  it('goes to the owner the CEO named for the department, on a card that is kept', async () => {
    const c = await company();
    const ann = await c.named('Ann');
    await c.ownedBy(ann.id);
    const { wait, task } = await c.waiting();
    for (let i = 0; i < 3; i++) await sweepWaits(c.ctx, at(wait.decisionDueAt));
    expect(await c.row(wait.id)).toMatchObject({ level: 3, finalDecisionPersonId: ann.id, fallbackToCeo: false });
    const card = (await c.noticesOf(wait.id)).find(n => n.level === 3)!;
    expect(card).toMatchObject({ personId: ann.id, agentId: null, purpose: 'escalation', deliveredAt: null });
    await notices.deliverWaitNotices(c.ctx, at(wait.decisionDueAt));
    expect((await c.noticesOf(wait.id)).find(n => n.level === 3)!.deliveredAt).not.toBeNull();
    const logged = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'wait_card')));
    expect(logged).toMatchObject([{ data: { notice: card.id, personId: ann.id } }]);
    expect((await c.ceoTurns()).filter(j => j.prompt.includes(`#${task.number}`) && j.agentId === c.orchestrator.id)).toEqual([]);
  });

  it('asks again who decides at each step: one named since is the one told, under a new route', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    expect(await c.row(wait.id)).toMatchObject({ fallbackToCeo: true, routeRevision: 0 });
    const ann = await c.named('Ann');
    await c.ownedBy(ann.id);
    for (let i = 0; i < 3; i++) await sweepWaits(c.ctx, at(wait.decisionDueAt));
    expect(await c.row(wait.id)).toMatchObject({ finalDecisionPersonId: ann.id, fallbackToCeo: false, routeRevision: 1 });
    expect((await c.noticesOf(wait.id)).find(n => n.level === 3)).toMatchObject({ personId: ann.id, routeRevision: 1 });
  });

  it('does not hand a card to one who lost access since, and leaves the record to say so', async () => {
    const c = await company();
    const ann = await c.named('Ann');
    await c.ownedBy(ann.id);
    const { wait } = await c.waiting();
    for (let i = 0; i < 3; i++) await sweepWaits(c.ctx, at(wait.decisionDueAt));
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, ann.id));
    await notices.deliverWaitNotices(c.ctx, at(wait.decisionDueAt));
    expect((await c.noticesOf(wait.id)).find(n => n.level === 3)).toMatchObject({ deliveredAt: null, cancelledAt: expect.any(Date) as Date });
  });
});

describe('a person\'s card', () => {
  async function delivered() {
    const c = await company();
    const token = await c.named('Ann');
    await c.ownedBy(token.id);
    await c.policy('person');
    const { wait, task } = await c.waiting();
    for (let i = 0; i < 3; i++) await sweepWaits(c.ctx, at(wait.decisionDueAt));
    await notices.deliverWaitNotices(c.ctx, at(wait.decisionDueAt));
    return { ...c, ann: token, wait, late: task, card: (await c.noticesOf(wait.id)).find(n => n.level === 3 && n.purpose === 'escalation')! };
  }

  it('lives on through a restart until it is acknowledged, in one write with its log line', async () => {
    const c = await delivered();
    await c.ctx.db.update(waitNotices).set({ leaseId: null, leaseUntil: null }).where(eq(waitNotices.id, c.card.id));
    await checkWaitHealth(c.ctx, at(c.wait.decisionDueAt, 60_000));
    expect((await c.noticesOf(c.wait.id)).find(n => n.id === c.card.id)).toMatchObject({ deliveredAt: c.card.deliveredAt, acknowledgedAt: null });
    const logged = await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.late.id), eq(taskEvents.kind, 'wait_card')));
    expect(logged).toHaveLength(1);
  });

  it('is read by its person alone, and acknowledging it decides nothing', async () => {
    const c = await delivered();
    const asked = await c.task(c.agent.id);
    const { request } = await askedOfPerson(c.ctx, c.agent.id, asked.id, { kind: 'approval', text: 'Release?', commit: 'b'.repeat(40) });
    const annToken = await c.tokenOf(c.ann.id);
    const list = await c.app.inject({ url: '/api/wait-cards', ...as(annToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().cards).toMatchObject([{ id: c.card.id, level: 3, taskId: c.late.id, number: c.late.number, kind: 'after' }]);
    expect(list.body).not.toContain('Private words');
    const ceoList = await c.app.inject({ url: '/api/wait-cards', ...as(c.ceo) });
    expect(ceoList.json().cards).toEqual([]);
    const stranger = await c.app.inject({ method: 'POST', url: `/api/wait-cards/${c.card.id}/ack`, ...as(c.ceo) });
    expect(stranger.statusCode).toBe(404);
    const ack = await c.app.inject({ method: 'POST', url: `/api/wait-cards/${c.card.id}/ack`, ...as(annToken) });
    expect(ack.statusCode).toBe(200);
    const again = await c.app.inject({ method: 'POST', url: `/api/wait-cards/${c.card.id}/ack`, ...as(annToken) });
    expect(again.statusCode).toBe(200);
    expect((await c.app.inject({ url: '/api/wait-cards', ...as(annToken) })).json().cards).toEqual([]);
    expect((await c.noticesOf(c.wait.id)).find(n => n.id === c.card.id)).toMatchObject({ acknowledgedByPersonId: c.ann.id, acknowledgedAt: expect.any(Date) as Date });
    expect(await c.row(c.wait.id)).toMatchObject({ state: 'active', level: 3 });
    expect((await c.db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'open', answeredBy: null, commit: 'b'.repeat(40) });
    expect(await c.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, c.late.id), eq(taskEvents.kind, 'wait_card')))).toHaveLength(2);
  });
});

describe('the final review of a wait', () => {
  const reviewed = async () => {
    const c = await company();
    const { wait, task } = await c.waiting();
    const anchor = wait.plan!.finalReview.anchorAt;
    const interval = wait.plan!.finalReview.intervalMs!;
    return { ...c, wait, task, anchor: new Date(anchor), interval };
  };

  it('comes to the head on the sequence its plan declares, once for each', async () => {
    const c = await reviewed();
    await sweepWaits(c.ctx, at(c.anchor, -1));
    expect((await c.row(c.wait.id)).reviewOrdinal).toBe(0);
    await sweepWaits(c.ctx, c.anchor);
    await sweepWaits(c.ctx, c.anchor);
    expect(await c.row(c.wait.id)).toMatchObject({ reviewOrdinal: 1, nextReviewAt: at(c.anchor, c.interval) });
    const shown = (await c.noticesOf(c.wait.id)).filter(n => n.purpose!.startsWith('final_review'));
    expect(shown).toMatchObject([{ agentId: c.head.id, purpose: 'final_review:1' }]);
  });

  it('passes over the periods a late sweep missed, says how many and drops what was not sent', async () => {
    const c = await reviewed();
    await sweepWaits(c.ctx, c.anchor);
    await sweepWaits(c.ctx, at(c.anchor, 3 * c.interval + 1));
    const row = await c.row(c.wait.id);
    expect(row).toMatchObject({ reviewOrdinal: 2, nextReviewAt: at(c.anchor, 4 * c.interval) });
    const shown = (await c.noticesOf(c.wait.id)).filter(n => n.purpose!.startsWith('final_review'));
    expect(shown.find(n => n.purpose === 'final_review:1')!.cancelledAt).not.toBeNull();
    expect(shown.find(n => n.purpose === 'final_review:2')).toMatchObject({ cancelledAt: null });
    const logged = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id));
    expect(logged.some(e => (e.data as { wait?: { skipped?: number } }).wait?.skipped === 2)).toBe(true);
  });

  it('ends with its source', async () => {
    const c = await reviewed();
    await cancel(c.ctx, c.CEO, c.task.id, 'Not needed.');
    await sweepWaits(c.ctx, c.anchor);
    expect((await c.row(c.wait.id)).reviewOrdinal).toBe(0);
    expect(await c.noticesOf(c.wait.id)).toEqual([]);
  });
});

describe('what a sweep leaves alone', () => {
  it('a wait no one planned', async () => {
    const c = await company();
    const before = await c.first();
    const task = await c.follow(before);
    const [wait] = await c.db.select().from(taskWaits).where(eq(taskWaits.taskId, task.id));
    expect(wait!.state).toBe('legacy_needs_plan');
    await sweepWaits(c.ctx, new Date(Date.now() + 1000 * HOUR));
    expect(await c.row(wait!.id)).toMatchObject({ level: 0, state: 'legacy_needs_plan' });
    expect(await c.noticesOf(wait!.id)).toEqual([]);
  });

  it('an external operation, which signals once by its own road and repeats nothing', async () => {
    const c = await company();
    const task = await c.task(c.agent.id);
    const now = Date.now();
    const iso = (hours: number) => new Date(now + hours * HOUR).toISOString();
    const wait = await c.db.transaction(tx => syncSourceWaits(tx, {
      taskId: task.id, kind: 'external', sourceKey: operationSourceKey(randomUUID()), sourceRevision: 0, ownerBinding: { agentId: c.agent.id }, sourceState: {}, actor: { agentId: c.agent.id },
      plan: { version: 1, ownerDueAt: iso(1), headDueAt: iso(2), decisionDueAt: iso(3), provenance: { kind: 'explicit_promise', actor: { personId: c.ceoPerson.id }, ref: 'operation', revision: 1, origin: 'test' }, finalReview: { headAgentId: c.head.id, anchorAt: iso(1), intervalMs: null } },
    }));
    await sweepWaits(c.ctx, new Date(now + 100 * HOUR));
    expect(await c.row(wait.id)).toMatchObject({ level: 0, reviewOrdinal: 0 });
    expect(await c.noticesOf(wait.id)).toEqual([]);
  });

  it('nothing else because of a wait whose step failed', async () => {
    const c = await company();
    const { wait } = await c.waiting();
    const second = await c.follow(await c.first());
    const failing = vi.spyOn(notices, 'recordWaitNotice').mockRejectedValueOnce(new Error('Only this one.'));
    onTestFinished(() => failing.mockRestore());
    await sweepWaits(c.ctx, at(wait.ownerDueAt, 60_000));
    const rows = await c.db.select().from(taskWaits).where(inArray(taskWaits.taskId, [wait.taskId, second.id]));
    expect(rows.map(r => r.level).sort()).toEqual([0, 1]);
  });
});
