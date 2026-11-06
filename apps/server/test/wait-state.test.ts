import { randomUUID } from 'node:crypto';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, taskEvents, tasks, taskWaits, waitNotices } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { ApiError } from '../src/errors.js';
import { claimFinalReview, endSourceWait, endTaskWaits, operationSourceKey, recordLegacyWait, replanWait, setWaitStage, syncSourceWaits, waitForSourceKey } from '../src/modules/tasks/wait-state.js';
import { recordWaitNotice } from '../src/modules/tasks/wait-notices.js';
import { createTestDb } from './helpers.js';

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.UTC(2030, 0, 1, hours)).toISOString();

async function fixture() {
  const db = await createTestDb();
  const [company, otherCompany] = await db.insert(companies).values([{ name: 'Acme' }, { name: 'Other', singleton: false }]).returning();
  const [department] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const agent = async (kind: 'head' | 'worker' | 'orchestrator', name: string, companyId = company!.id, removedAt?: Date) => (await db.insert(agents).values({
    companyId, departmentId: kind === 'orchestrator' || companyId !== company!.id ? null : department!.id, kind, name, model: '', removedAt: removedAt ?? null,
  }).returning())[0]!;
  const person = async (name: string, status: 'active' | 'disabled', isOwner = false, companyId = company!.id) => (await db.insert(people).values({
    companyId, name, email: `${name}@example.test`, status, scopeKind: 'company', isOwner,
  }).returning())[0]!;
  const [head, worker, peer, orchestrator, stranger, gone] = [
    await agent('head', 'Hana'), await agent('worker', 'Bruno'), await agent('worker', 'Rita'), await agent('orchestrator', 'Olga'),
    await agent('worker', 'Sam', otherCompany!.id), await agent('worker', 'Gus', company!.id, new Date()),
  ];
  const [ceo, disabled, outsider] = [await person('ceo', 'active', true), await person('off', 'disabled'), await person('outsider', 'active', false, otherCompany!.id)];
  const newTask = async (number: number, status: 'working' | 'done' = 'working') => (await db.insert(tasks).values({ companyId: company!.id, number, title: `Task ${number}`, departmentId: department!.id, status, assigneeAgentId: status === 'done' ? null : worker.id, closedAt: status === 'done' ? new Date() : null }).returning())[0]!;
  const task = await newTask(1);
  const plan = (change: Partial<WaitPlan> = {}): WaitPlan => ({
    version: 1,
    ownerDueAt: at(10),
    headDueAt: at(11),
    decisionDueAt: at(12),
    provenance: { kind: 'explicit_promise', actor: { agentId: head.id }, ref: 'promise-1', revision: 1, origin: 'test' },
    finalReview: { headAgentId: head.id, anchorAt: at(13), intervalMs: HOUR },
    ...change,
  });
  const key = waitForSourceKey(randomUUID());
  const source = { taskId: task.id, kind: 'external' as const, sourceKey: key, sourceRevision: 1, ownerBinding: { agentId: worker.id } as { agentId: string } | { personId: string }, plan: plan(), sourceState: {}, actor: { agentId: worker.id } };
  const sync = (change: Partial<typeof source> = {}, on: Db = db) => on.transaction(tx => syncSourceWaits(tx, { ...source, ...change }));
  const end = (change: Partial<Parameters<typeof endSourceWait>[1]> = {}) => db.transaction(tx => endSourceWait(tx, {
    taskId: task.id, kind: 'external', sourceKey: key, sourceRevision: 1, outcome: 'resolved', proofRef: 'proof-1', actor: { agentId: worker.id }, ...change,
  }));
  const replan = (input: Omit<Parameters<typeof replanWait>[1], 'actor' | 'reason'> & { actor?: Parameters<typeof replanWait>[1]['actor']; reason?: string }) => db.transaction(tx => replanWait(tx, {
    reason: 'A new promise.', actor: { agentId: head.id }, ...input,
  }));
  const rows = () => db.select().from(taskWaits).where(eq(taskWaits.taskId, task.id));
  const events = () => db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
  const notice = async (waitId: string, generation: number) => {
    await recordWaitNotice(db, {
      companyId: company!.id, agentId: worker.id, dedupKey: `${waitId}:${generation}:${randomUUID()}`, waitId, generation, level: 1, purpose: 'escalation', routeRevision: 0,
      message: { text: 'Late.' } as never, guard: { tasks: [{ id: task.id, version: task.version }] },
    });
  };
  const pendingNotices = async () => (await db.select().from(waitNotices)).filter(row => !row.cancelledAt && !row.deliveredAt);
  return { db, company: company!, otherCompany: otherCompany!, department: department!, head, worker, peer, orchestrator, stranger, gone, ceo, disabled, outsider, newTask, task, plan, key, source, sync, end, replan, rows, events, notice, pendingNotices };
}

const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (e: unknown) => e);
  expect(error, 'it should have been refused').toBeInstanceOf(ApiError);
  return { status: (error as ApiError).status, reason: (error as ApiError).reason };
};

describe('syncSourceWaits', () => {
  it('keeps a wait with its owner, its dates, its next action and its first review', async () => {
    const c = await fixture();
    const wait = await c.sync();
    expect(wait).toMatchObject({
      companyId: c.company.id, taskId: c.task.id, kind: 'external', sourceKey: c.key, sourceRevision: 1, generation: 1, state: 'active', level: 0,
      ownerAgentId: c.worker.id, ownerPersonId: null, attentionAgentId: c.worker.id, reviewOrdinal: 0,
    });
    expect(wait.ownerDueAt!.toISOString()).toBe(at(10));
    expect(wait.headDueAt!.toISOString()).toBe(at(11));
    expect(wait.decisionDueAt!.toISOString()).toBe(at(12));
    expect(wait.nextActionAt!.toISOString()).toBe(at(10));
    expect(wait.nextReviewAt!.toISOString()).toBe(at(13));
    expect(wait.plan?.provenance.kind).toBe('explicit_promise');
  });

  it('takes the next action the source names, and a person as owner', async () => {
    const c = await fixture();
    const wait = await c.sync({ ownerBinding: { personId: c.ceo.id }, sourceState: { nextActionAt: at(9), stage: 'waiting', route: 'operations' } });
    expect(wait.nextActionAt!.toISOString()).toBe(at(9));
    expect(wait).toMatchObject({ ownerAgentId: null, ownerPersonId: c.ceo.id, attentionPersonId: c.ceo.id, sourceState: { nextActionAt: at(9), stage: 'waiting', route: 'operations' } });
  });

  it('writes to the log who and when by ids, with no plan and no source key in it', async () => {
    const c = await fixture();
    const wait = await c.sync();
    const [event] = (await c.events()).filter(e => e.data.wait);
    expect(event!.data).toEqual({ wait: { id: wait.id, kind: 'external', generation: 1 } });
    expect(JSON.stringify(event)).not.toContain(c.key);
    expect(JSON.stringify(event)).not.toContain('promise-1');
  });

  it.each([
    ['no owner', { ownerBinding: undefined }],
    ['no plan', { plan: undefined }],
    ['a key of another kind', { sourceKey: `run:${randomUUID()}` }],
  ])('refuses %s, and takes the whole write back with it', async (_name, change) => {
    const c = await fixture();
    const work = c.db.transaction(async tx => {
      await tx.update(tasks).set({ title: 'Source change' }).where(eq(tasks.id, c.task.id));
      return syncSourceWaits(tx, { ...c.source, ...change } as never);
    });
    expect(await refusal(work)).toEqual({ status: 400, reason: 'task_invalid' });
    expect(await c.rows()).toEqual([]);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]!.title).toBe('Task 1');
  });

  it.each([
    ['an employee of another company', 'stranger'],
    ['an employee who left', 'gone'],
  ] as const)('takes no owner who is %s', async (_name, who) => {
    const c = await fixture();
    expect(await refusal(c.sync({ ownerBinding: { agentId: c[who].id } }))).toEqual({ status: 400, reason: 'task_invalid' });
  });

  it.each([
    ['a person of another company', 'outsider'],
    ['a person switched off', 'disabled'],
  ] as const)('takes no owner who is %s', async (_name, who) => {
    const c = await fixture();
    expect(await refusal(c.sync({ ownerBinding: { personId: c[who].id } }))).toEqual({ status: 400, reason: 'task_invalid' });
  });

  it('takes no made-up owner', async () => {
    const c = await fixture();
    expect(await refusal(c.sync({ ownerBinding: { agentId: randomUUID() } }))).toEqual({ status: 400, reason: 'task_invalid' });
  });

  it('wants a real head of the company for the final review', async () => {
    const c = await fixture();
    for (const headAgentId of [c.worker.id, c.stranger.id, randomUUID()]) {
      const plan = c.plan({ finalReview: { headAgentId, anchorAt: at(13), intervalMs: HOUR } });
      expect(await refusal(c.sync({ plan }))).toEqual({ status: 400, reason: 'task_invalid' });
    }
  });

  it('wants the one who promised to be of the company', async () => {
    const c = await fixture();
    const plan = c.plan({ provenance: { kind: 'explicit_promise', actor: { agentId: c.stranger.id }, ref: 'promise-1', revision: 1, origin: 'test' } });
    expect(await refusal(c.sync({ plan }))).toEqual({ status: 400, reason: 'task_invalid' });
  });

  it('takes no source from an actor of another company', async () => {
    const c = await fixture();
    expect(await refusal(c.sync({ actor: { agentId: c.stranger.id } }))).toEqual({ status: 403, reason: 'task_not_yours' });
  });

  it('refuses an unknown task, and a closed one', async () => {
    const c = await fixture();
    expect(await refusal(c.sync({ taskId: randomUUID() }))).toEqual({ status: 404, reason: 'task_unknown' });
    const closed = await c.newTask(2, 'done');
    expect(await refusal(c.sync({ taskId: closed.id }))).toEqual({ status: 409, reason: 'task_closed' });
  });

  it('changes nothing for the same revision with the same data', async () => {
    const c = await fixture();
    const first = await c.sync();
    const logged = (await c.events()).length;
    const again = await c.sync();
    expect(again).toEqual(first);
    expect((await c.events()).length).toBe(logged);
  });

  it('reads the same dates written another way as the same plan', async () => {
    const c = await fixture();
    const first = await c.sync();
    const again = await c.sync({ plan: c.plan({ ownerDueAt: '2030-01-01T12:00:00+02:00' }) });
    expect(again).toEqual(first);
  });

  it('refuses the same revision with other data, and an older one', async () => {
    const c = await fixture();
    await c.sync({ sourceRevision: 3 });
    expect(await refusal(c.sync({ sourceRevision: 3, ownerBinding: { agentId: c.peer.id } }))).toEqual({ status: 409, reason: 'task_changed' });
    expect(await refusal(c.sync({ sourceRevision: 2 }))).toEqual({ status: 409, reason: 'task_changed' });
    expect((await c.rows())[0]).toMatchObject({ sourceRevision: 3, generation: 1, ownerAgentId: c.worker.id });
  });

  it('starts a new generation for a new owner: what was written for the old one goes stale, the time spent stays', async () => {
    const c = await fixture();
    const first = await c.sync();
    await c.notice(first.id, 1);
    const logged = (await c.events()).length;
    const second = await c.sync({ sourceRevision: 2, ownerBinding: { agentId: c.peer.id } });
    expect(second).toMatchObject({ id: first.id, generation: 2, sourceRevision: 2, ownerAgentId: c.peer.id, attentionAgentId: c.peer.id });
    expect(second.createdAt).toEqual(first.createdAt);
    expect(await c.pendingNotices()).toEqual([]);
    expect((await c.events()).length).toBe(logged + 1);
  });

  it('starts a new generation for a new plan, back at the first level', async () => {
    const c = await fixture();
    const first = await c.sync();
    await c.db.update(taskWaits).set({ level: 2 }).where(eq(taskWaits.id, first.id));
    const second = await c.sync({ sourceRevision: 2, plan: c.plan({ ownerDueAt: at(14), headDueAt: at(15), decisionDueAt: at(16), finalReview: { headAgentId: c.head.id, anchorAt: at(17), intervalMs: HOUR } }) });
    expect(second).toMatchObject({ generation: 2, level: 0 });
    expect(second.nextActionAt!.toISOString()).toBe(at(14));
    expect(second.nextReviewAt!.toISOString()).toBe(at(17));
  });

  it('only notes what a newer revision says of the source when owner and plan stay', async () => {
    const c = await fixture();
    const first = await c.sync();
    await c.notice(first.id, 1);
    const second = await c.sync({ sourceRevision: 2, sourceState: { nextActionAt: at(9), stage: 'retry' } });
    expect(second).toMatchObject({ id: first.id, generation: 1, sourceRevision: 2, sourceState: { nextActionAt: at(9), stage: 'retry' } });
    expect(second.nextActionAt!.toISOString()).toBe(at(9));
    expect(await c.pendingNotices()).toHaveLength(1);
  });

  it('leaves the generation alone when the task itself moves or gets a comment', async () => {
    const c = await fixture();
    await c.sync();
    await c.db.update(tasks).set({ version: sql`${tasks.version} + 5` }).where(eq(tasks.id, c.task.id));
    expect(await c.sync()).toMatchObject({ generation: 1, sourceRevision: 1 });
  });

  it('keeps one open wait for each source, whatever writes it', async () => {
    const c = await fixture();
    const first = await c.sync();
    await expect(c.db.insert(taskWaits).values({ ...first, id: randomUUID() })).rejects.toThrow();
    expect(await c.sync({ sourceKey: waitForSourceKey(randomUUID()) })).toMatchObject({ generation: 1 });
    expect(await c.rows()).toHaveLength(2);
  });

  it('opens a source that ended again only with a newer revision, in a next generation, keeping the old record', async () => {
    const c = await fixture();
    await c.sync();
    await c.end();
    expect(await refusal(c.sync())).toEqual({ status: 409, reason: 'task_changed' });
    const reopened = await c.sync({ sourceRevision: 2 });
    expect(reopened).toMatchObject({ state: 'active', generation: 2 });
    expect((await c.rows()).map(row => row.state).sort()).toEqual(['active', 'resolved']);
  });

  it('gives a wait with no plan its plan, keeping when it began', async () => {
    const c = await fixture();
    const legacy = await c.db.transaction(tx => recordLegacyWait(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, sourceRevision: 1, ownerBinding: { agentId: c.worker.id }, sourceState: {}, actor: { agentId: c.worker.id } }));
    const planned = await c.sync();
    expect(planned).toMatchObject({ id: legacy.id, state: 'active', generation: 2 });
    expect(planned.createdAt).toEqual(legacy.createdAt);
  });

  it('names who decides in the end: the department\'s owner', async () => {
    const c = await fixture();
    await c.db.update(departments).set({ ownerPersonId: c.ceo.id }).where(eq(departments.id, c.department.id));
    const [owner] = await c.db.insert(people).values({ companyId: c.company.id, name: 'Ann', email: 'ann@example.test', status: 'active', scopeKind: 'company' }).returning();
    await c.db.update(departments).set({ ownerPersonId: owner!.id }).where(eq(departments.id, c.department.id));
    expect(await c.sync()).toMatchObject({ finalDecisionPersonId: owner!.id, fallbackToCeo: false });
  });

  it('names the CEO as who decides without one, and writes no alarm for it', async () => {
    const c = await fixture();
    expect(await c.sync()).toMatchObject({ finalDecisionPersonId: c.ceo.id, fallbackToCeo: true });
    expect(await c.db.select().from(waitNotices)).toEqual([]);
  });

  it('lets only an external operation have no repeats of its final review', async () => {
    const c = await fixture();
    const once = c.plan({ finalReview: { headAgentId: c.head.id, anchorAt: at(13), intervalMs: null } });
    expect(await refusal(c.sync({ plan: once }))).toEqual({ status: 400, reason: 'task_invalid' });
    expect(await c.sync({ plan: once, sourceKey: operationSourceKey(randomUUID()) })).toMatchObject({ state: 'active' });
  });
});

describe('endSourceWait', () => {
  it('ends the wait of its source with its proof, and what was written for it, in one write', async () => {
    const c = await fixture();
    const wait = await c.sync();
    await c.notice(wait.id, 1);
    const ended = await c.end();
    expect(ended).toMatchObject({ id: wait.id, state: 'resolved', outcome: 'resolved', proofRef: 'proof-1' });
    expect(ended!.endedAt).toBeInstanceOf(Date);
    expect(await c.pendingNotices()).toEqual([]);
  });

  it('keeps all of it when the write it is in fails', async () => {
    const c = await fixture();
    const wait = await c.sync();
    await c.notice(wait.id, 1);
    await expect(c.db.transaction(async tx => {
      await endSourceWait(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, sourceRevision: 1, outcome: 'resolved', proofRef: 'proof-1', actor: { agentId: c.worker.id } });
      throw new Error('The source change failed.');
    })).rejects.toThrow('The source change failed.');
    expect((await c.rows())[0]).toMatchObject({ state: 'active', generation: 1 });
    expect(await c.pendingNotices()).toHaveLength(1);
  });

  it('leaves every other source alone', async () => {
    const c = await fixture();
    await c.sync();
    expect(await c.end({ sourceKey: waitForSourceKey(randomUUID()) })).toBeNull();
    expect(await c.end({ kind: 'run', sourceKey: `run:${randomUUID()}` })).toBeNull();
    expect((await c.rows())[0]).toMatchObject({ state: 'active' });
  });

  it('refuses a callback older than what the wait has seen', async () => {
    const c = await fixture();
    await c.sync({ sourceRevision: 5 });
    expect(await refusal(c.end({ sourceRevision: 4 }))).toEqual({ status: 409, reason: 'task_changed' });
    expect((await c.rows())[0]).toMatchObject({ state: 'active' });
  });

  it('takes the same end twice as one, the first proof standing, and no other end after it', async () => {
    const c = await fixture();
    await c.sync();
    const first = await c.end();
    const logged = (await c.events()).length;
    expect(await c.end({ proofRef: 'proof-2' })).toEqual(first);
    expect((await c.events()).length).toBe(logged);
    expect(await refusal(c.end({ outcome: 'cancelled' }))).toEqual({ status: 409, reason: 'task_changed' });
  });

  it('ends a wait with no plan the same way', async () => {
    const c = await fixture();
    await c.db.transaction(tx => recordLegacyWait(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, sourceRevision: 1, sourceState: {}, actor: { agentId: c.worker.id } }));
    expect(await c.end({ outcome: 'cancelled' })).toMatchObject({ state: 'cancelled', outcome: 'cancelled' });
  });

  it('takes no end from an actor of another company', async () => {
    const c = await fixture();
    await c.sync();
    expect(await refusal(c.end({ actor: { agentId: c.stranger.id } }))).toEqual({ status: 403, reason: 'task_not_yours' });
  });

  it('ends every open wait of a task that closes, and only those', async () => {
    const c = await fixture();
    const other = await c.newTask(2);
    await c.sync();
    await c.sync({ sourceKey: waitForSourceKey(randomUUID()) });
    await c.end();
    const elsewhere = await c.sync({ taskId: other.id, sourceKey: waitForSourceKey(randomUUID()) });
    const ended = await c.db.transaction(tx => endTaskWaits(tx, { taskId: c.task.id, outcome: 'cancelled', proofRef: 'task-closed', actor: { agentId: c.head.id } }));
    expect(ended).toHaveLength(1);
    expect((await c.rows()).map(row => row.state).sort()).toEqual(['cancelled', 'resolved']);
    expect((await c.db.select().from(taskWaits).where(eq(taskWaits.id, elsewhere.id)))[0]).toMatchObject({ state: 'active' });
  });
});

describe('replanWait', () => {
  it('moves the owner in a new generation: the dates, the level and when it began stay', async () => {
    const c = await fixture();
    const wait = await c.sync();
    await c.db.update(taskWaits).set({ level: 2 }).where(eq(taskWaits.id, wait.id));
    await c.notice(wait.id, 1);
    const moved = await c.replan({ waitId: wait.id, expectedGeneration: 1, ownerBinding: { personId: c.ceo.id } });
    expect(moved).toMatchObject({ generation: 2, level: 2, ownerAgentId: null, ownerPersonId: c.ceo.id, attentionPersonId: c.ceo.id });
    expect(moved.ownerDueAt!.toISOString()).toBe(at(10));
    expect(moved.createdAt).toEqual(wait.createdAt);
    expect(await c.pendingNotices()).toEqual([]);
  });

  it('gives a new plan from the first level, and says why in the log', async () => {
    const c = await fixture();
    const wait = await c.sync();
    await c.db.update(taskWaits).set({ level: 2 }).where(eq(taskWaits.id, wait.id));
    const moved = await c.replan({ waitId: wait.id, expectedGeneration: 1, plan: c.plan({ ownerDueAt: at(14), headDueAt: at(15), decisionDueAt: at(16) }), reason: 'The host comes back at noon.' });
    expect(moved).toMatchObject({ generation: 2, level: 0 });
    expect(moved.ownerDueAt!.toISOString()).toBe(at(14));
    expect(moved.nextActionAt!.toISOString()).toBe(at(14));
    expect((await c.events()).at(-1)!.text).toContain('The host comes back at noon.');
  });

  it('refuses a generation it did not read, and a wait that ended', async () => {
    const c = await fixture();
    const wait = await c.sync();
    expect(await refusal(c.replan({ waitId: wait.id, expectedGeneration: 2, ownerBinding: { agentId: c.peer.id } }))).toEqual({ status: 409, reason: 'task_changed' });
    await c.end();
    expect(await refusal(c.replan({ waitId: wait.id, expectedGeneration: 1, ownerBinding: { agentId: c.peer.id } }))).toEqual({ status: 409, reason: 'task_closed' });
  });

  it('refuses a wait it does not know, and a strict input', async () => {
    const c = await fixture();
    expect(await refusal(c.replan({ waitId: randomUUID(), expectedGeneration: 1, ownerBinding: { agentId: c.peer.id } }))).toEqual({ status: 404, reason: 'task_unknown' });
    const wait = await c.sync();
    expect(await refusal(c.replan({ waitId: wait.id, expectedGeneration: 1 }))).toEqual({ status: 400, reason: 'task_invalid' });
  });

  it('wants a real owner, and a plan that may have no repeats only for an operation', async () => {
    const c = await fixture();
    const wait = await c.sync();
    expect(await refusal(c.replan({ waitId: wait.id, expectedGeneration: 1, ownerBinding: { agentId: c.stranger.id } }))).toEqual({ status: 400, reason: 'task_invalid' });
    const once = c.plan({ finalReview: { headAgentId: c.head.id, anchorAt: at(13), intervalMs: null } });
    expect(await refusal(c.replan({ waitId: wait.id, expectedGeneration: 1, plan: once }))).toEqual({ status: 400, reason: 'task_invalid' });
  });

  it('is for those who answer for the wait, not for whoever can name it', async () => {
    const c = await fixture();
    const wait = await c.sync();
    const by = (actor: Parameters<typeof replanWait>[1]['actor'], expectedGeneration: number) => c.replan({ waitId: wait.id, expectedGeneration, ownerBinding: { agentId: c.worker.id }, actor });
    expect(await refusal(by({ agentId: c.peer.id }, 1))).toEqual({ status: 403, reason: 'task_not_yours' });
    expect(await refusal(by({ agentId: c.stranger.id }, 1))).toEqual({ status: 403, reason: 'task_not_yours' });
    expect(await refusal(by({ personId: c.outsider.id }, 1))).toEqual({ status: 403, reason: 'task_not_yours' });
    expect(await by({ agentId: c.worker.id }, 1)).toMatchObject({ generation: 2 });
    expect(await by({ agentId: c.head.id }, 2)).toMatchObject({ generation: 3 });
    expect(await by({ agentId: c.orchestrator.id }, 3)).toMatchObject({ generation: 4 });
    expect(await by({ personId: c.ceo.id }, 4)).toMatchObject({ generation: 5 });
  });

  it('gives a wait with no plan a whole plan only', async () => {
    const c = await fixture();
    const legacy = await c.db.transaction(tx => recordLegacyWait(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, sourceRevision: 1, ownerBinding: { agentId: c.worker.id }, sourceState: {}, actor: { agentId: c.worker.id } }));
    expect(await refusal(c.replan({ waitId: legacy.id, expectedGeneration: 1, ownerBinding: { agentId: c.peer.id } }))).toEqual({ status: 400, reason: 'task_invalid' });
    const planned = await c.replan({ waitId: legacy.id, expectedGeneration: 1, ownerBinding: { agentId: c.peer.id }, plan: c.plan() });
    expect(planned).toMatchObject({ state: 'active', generation: 2, ownerAgentId: c.peer.id });
    expect(planned.createdAt).toEqual(legacy.createdAt);
  });
});

describe('recordLegacyWait', () => {
  it('keeps the facts it has and makes up no date, plan or alarm', async () => {
    const c = await fixture();
    const legacy = await c.db.transaction(tx => recordLegacyWait(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, sourceRevision: 0, ownerBinding: { agentId: c.worker.id }, sourceState: { stage: 'waiting' }, actor: { agentId: c.worker.id } }));
    expect(legacy).toMatchObject({
      state: 'legacy_needs_plan', generation: 1, level: 0, ownerAgentId: c.worker.id, plan: null, ownerDueAt: null, headDueAt: null, decisionDueAt: null, nextActionAt: null, nextReviewAt: null, sourceState: { stage: 'waiting' },
    });
    expect(await c.db.select().from(waitNotices)).toEqual([]);
  });

  it('keeps the one it has for a source', async () => {
    const c = await fixture();
    const input = { taskId: c.task.id, kind: 'external' as const, sourceKey: c.key, sourceRevision: 0, sourceState: {}, actor: { agentId: c.worker.id } };
    const first = await c.db.transaction(tx => recordLegacyWait(tx, input));
    expect(await c.db.transaction(tx => recordLegacyWait(tx, input))).toEqual(first);
    expect(await c.rows()).toHaveLength(1);
  });

  it('takes no key of another kind and no owner from elsewhere', async () => {
    const c = await fixture();
    const input = { taskId: c.task.id, kind: 'run' as const, sourceKey: c.key, sourceRevision: 0, sourceState: {}, actor: { agentId: c.worker.id } };
    expect(await refusal(c.db.transaction(tx => recordLegacyWait(tx, input)))).toEqual({ status: 400, reason: 'task_invalid' });
    const foreign = { ...input, kind: 'external' as const, ownerBinding: { agentId: c.stranger.id } };
    expect(await refusal(c.db.transaction(tx => recordLegacyWait(tx, foreign)))).toEqual({ status: 400, reason: 'task_invalid' });
  });
});

describe('setWaitStage', () => {
  it('marks a wait as come back without ending it, its owner, its dates and its generation staying', async () => {
    const c = await fixture();
    const wait = await c.sync({ sourceState: { stage: 'waiting', route: 'operations' } });
    await c.notice(wait.id, 1);
    const back = await c.db.transaction(tx => setWaitStage(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, stage: 'check_back' }));
    expect(back).toMatchObject({ state: 'active', generation: 1, ownerAgentId: c.worker.id, sourceRevision: 1, sourceState: { stage: 'check_back', route: 'operations' } });
    expect(back!.ownerDueAt!.toISOString()).toBe(at(10));
    expect(await c.pendingNotices()).toHaveLength(1);
  });

  it('has nothing to mark on a source with no open wait', async () => {
    const c = await fixture();
    expect(await c.db.transaction(tx => setWaitStage(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, stage: 'check_back' }))).toBeNull();
    await c.sync();
    await c.end();
    expect(await c.db.transaction(tx => setWaitStage(tx, { taskId: c.task.id, kind: 'external', sourceKey: c.key, stage: 'check_back' }))).toBeNull();
  });
});

describe('claimFinalReview', () => {
  const claim = (db: Db, waitId: string, expectedGeneration: number, hours: number) => db.transaction(tx => claimFinalReview(tx, { waitId, expectedGeneration, at: new Date(at(hours)) }));

  it('gives nothing before the date, and the review at the date once', async () => {
    const c = await fixture();
    const wait = await c.sync();
    expect(await claim(c.db, wait.id, 1, 12)).toBeNull();
    const first = await claim(c.db, wait.id, 1, 13);
    expect(first).toMatchObject({ ordinal: 1, skipped: 0 });
    expect(first!.wait.nextReviewAt!.toISOString()).toBe(at(14));
    expect(await claim(c.db, wait.id, 1, 13)).toBeNull();
  });

  it('steps along the anchored sequence after a late sweep, counts what it skipped and moves no promise', async () => {
    const c = await fixture();
    const wait = await c.sync();
    const late = await c.db.transaction(tx => claimFinalReview(tx, { waitId: wait.id, expectedGeneration: 1, at: new Date(Date.parse(at(16)) + 60_000) }));
    expect(late).toMatchObject({ ordinal: 1, skipped: 3 });
    expect(late!.wait.nextReviewAt!.toISOString()).toBe(at(17));
    expect(late!.wait.decisionDueAt!.toISOString()).toBe(at(12));
    expect((await c.events()).at(-1)!.data).toMatchObject({ wait: { id: wait.id, reviewOrdinal: 1, skipped: 3 } });
  });

  it('gives nothing for an old generation, an ended wait or one it does not know', async () => {
    const c = await fixture();
    const wait = await c.sync();
    await c.sync({ sourceRevision: 2, ownerBinding: { agentId: c.peer.id } });
    expect(await claim(c.db, wait.id, 1, 13)).toBeNull();
    await c.end({ sourceRevision: 2 });
    expect(await claim(c.db, wait.id, 2, 13)).toBeNull();
    expect(await claim(c.db, randomUUID(), 1, 13)).toBeNull();
  });

  /* The one signal of an external operation, seen from its wait: what its recovery case does across operations is its own. */
  describe('for a source that signals once', () => {
    async function operation() {
      const c = await fixture();
      const deadline = at(12);
      const plan = c.plan({ ownerDueAt: deadline, headDueAt: deadline, decisionDueAt: deadline, finalReview: { headAgentId: c.head.id, anchorAt: deadline, intervalMs: null }, provenance: { kind: 'source_contract', actor: { agentId: c.head.id }, ref: 'operation-1', revision: 1, origin: 'external' } });
      const wait = await c.sync({ sourceKey: operationSourceKey(randomUUID()), plan, sourceState: { nextActionAt: at(11) } });
      const sweep = (db: Db, hours: number) => db.transaction(async tx => {
        const step = await claimFinalReview(tx, { waitId: wait.id, expectedGeneration: wait.generation, at: new Date(at(hours)) });
        if (!step) return;
        await recordWaitNotice(tx, {
          companyId: c.company.id, agentId: c.head.id, dedupKey: `final:${wait.id}:${step.wait.generation}:${step.ordinal}`, waitId: wait.id, generation: step.wait.generation, level: step.wait.level, purpose: 'final_review', routeRevision: step.wait.routeRevision,
          message: { text: 'Past its date.' } as never, guard: { tasks: [{ id: c.task.id, version: c.task.version }] },
        });
      });
      return { ...c, wait, plan, sweep };
    }

    it('writes one notice past the date, at the top level, over two sweeps', async () => {
      const c = await operation();
      await c.sweep(c.db, 11);
      expect(await c.db.select().from(waitNotices)).toEqual([]);
      await c.sweep(c.db, 12);
      await c.sweep(c.db, 13);
      const notices = await c.db.select().from(waitNotices);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ waitId: c.wait.id, purpose: 'final_review', level: 3 });
      expect((await c.rows())[0]).toMatchObject({ state: 'active', reviewOrdinal: 1, nextReviewAt: null, level: 3 });
    });

    it('writes no second one after a restart, whatever a later sweep sees', async () => {
      const c = await operation();
      await c.sweep(c.db, 12);
      const { $client: client } = c.db as unknown as { $client: Parameters<typeof import('drizzle-orm/pglite').drizzle>[0] };
      const { drizzle } = await import('drizzle-orm/pglite');
      const restarted = drizzle(client as never) as unknown as Db;
      await c.sweep(restarted, 13);
      await c.sweep(restarted, 40);
      expect(await c.db.select().from(waitNotices)).toHaveLength(1);
    });

    it('stays one when a later revision or a new plan comes', async () => {
      const c = await operation();
      await c.sweep(c.db, 12);
      const later = await c.sync({ sourceKey: c.wait.sourceKey, sourceRevision: 2, plan: { ...c.plan, ownerDueAt: at(20), headDueAt: at(20), decisionDueAt: at(20) } });
      expect(later).toMatchObject({ reviewOrdinal: 1, nextReviewAt: null, generation: 2 });
      const replanned = await c.replan({ waitId: c.wait.id, expectedGeneration: 2, plan: { ...c.plan, ownerDueAt: at(21), headDueAt: at(21), decisionDueAt: at(21) } });
      expect(replanned).toMatchObject({ reviewOrdinal: 1, nextReviewAt: null });
      expect(await c.db.transaction(tx => claimFinalReview(tx, { waitId: c.wait.id, expectedGeneration: 3, at: new Date(at(30)) }))).toBeNull();
    });

    it('keeps every other source repeating: the database takes no active wait without a next review', async () => {
      const c = await fixture();
      const wait = await c.sync();
      await expect(c.db.update(taskWaits).set({ nextReviewAt: null, reviewOrdinal: 1 }).where(eq(taskWaits.id, wait.id))).rejects.toThrow();
      await expect(c.db.update(taskWaits).set({ nextReviewAt: null, reviewOrdinal: 0 }).where(and(eq(taskWaits.id, wait.id)))).rejects.toThrow();
    });
  });
});
