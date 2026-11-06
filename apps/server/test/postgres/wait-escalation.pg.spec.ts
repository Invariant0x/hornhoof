import { randomUUID } from 'node:crypto';
import type { WaitPlan } from '@hornhoof/protocol/waits';
import { and, eq, isNotNull, like } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { isUniqueViolation } from '../../src/db/errors.js';
import { agents, departments, people, requests, taskEvents, taskWaits, waitNotices } from '../../src/db/schema.js';
import { ask } from '../../src/modules/tasks/engine.js';
import { sweepWaits } from '../../src/modules/tasks/wait-escalation.js';
import { deliverWaitNotices } from '../../src/modules/tasks/wait-notices.js';
import { replanWait, syncSourceWaits, waitForSourceKey } from '../../src/modules/tasks/wait-state.js';
import { backendPid, privatePostgres, runFixture } from './helpers.js';

const HOUR = 3_600_000;
const after = (ms: number) => new Date(Date.now() + ms).toISOString();

async function late() {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [head] = await pg.db.insert(agents).values({ companyId: fixture.companyId, departmentId: fixture.departmentId, kind: 'head', name: 'Head', model: '' }).returning();
  const [one, two] = fixture.actors;
  const plan = (fromNow = 0): WaitPlan => ({
    version: 1, ownerDueAt: after(fromNow + HOUR), headDueAt: after(fromNow + 2 * HOUR), decisionDueAt: after(fromNow + 3 * HOUR),
    provenance: { kind: 'explicit_promise', actor: { agentId: head!.id }, ref: 'promise-1', revision: 1, origin: 'test' },
    finalReview: { headAgentId: head!.id, anchorAt: after(fromNow + 4 * HOUR), intervalMs: HOUR },
  });
  const wait = await pg.db.transaction(tx => syncSourceWaits(tx as never, {
    taskId: one.task.id, kind: 'external', sourceKey: waitForSourceKey(randomUUID()), sourceRevision: 1, ownerBinding: { agentId: one.job.agentId }, plan: plan(), sourceState: {}, actor: { agentId: one.job.agentId },
  }));
  const row = async () => (await pg.db.select().from(taskWaits).where(eq(taskWaits.id, wait.id)))[0]!;
  const notices = () => pg.db.select().from(waitNotices).where(eq(waitNotices.waitId, wait.id));
  const lines = (kind: 'wait_due' | 'wait_card') => pg.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, one.task.id), eq(taskEvents.kind, kind)));
  const at = (ms: number) => new Date(Date.now() + ms);
  return { pg, fixture, head: head!, one, two, plan, wait, row, notices, lines, at };
}

it('takes one step and writes one notice when two sweeps run at once across connections', async () => {
  const c = await late();
  const now = c.at(1.5 * HOUR);
  await Promise.all([sweepWaits(c.one.ctx, now), sweepWaits(c.two.ctx, now)]);
  expect(await c.row()).toMatchObject({ level: 1, generation: 1, nextActionAt: c.wait.headDueAt });
  expect(await c.notices()).toMatchObject([{ agentId: c.one.job.agentId, purpose: 'escalation', level: 1 }]);
  expect(await c.lines('wait_due')).toHaveLength(1);
});

it('gives each period of a final review to one of two sweeps, with one notice', async () => {
  const c = await late();
  const now = c.at(4.5 * HOUR);
  for (let level = 0; level < 3; level++) await sweepWaits(c.one.ctx, now);
  await c.pg.db.delete(waitNotices).where(eq(waitNotices.waitId, c.wait.id));
  await c.pg.db.update(taskWaits).set({ reviewOrdinal: 0, nextReviewAt: c.wait.nextReviewAt }).where(eq(taskWaits.id, c.wait.id));
  await Promise.all([sweepWaits(c.one.ctx, now), sweepWaits(c.two.ctx, now)]);
  expect(await c.row()).toMatchObject({ reviewOrdinal: 1 });
  expect(await c.notices()).toMatchObject([{ agentId: c.head.id, purpose: 'final_review:1' }]);
});

it('leaves a wait alone when someone gave it new dates while the sweep waited for the task', async () => {
  const c = await late();
  let inside!: () => void;
  let letGo!: () => void;
  const entered = new Promise<void>(done => { inside = done; });
  const held = new Promise<void>(done => { letGo = done; });
  const replanned = c.one.ctx.db.transaction(async tx => {
    await replanWait(tx, { waitId: c.wait.id, expectedGeneration: 1, plan: c.plan(5 * HOUR), reason: 'A new promise.', actor: { agentId: c.head.id } });
    inside();
    await held;
  });
  await entered;
  const sweepPid = await backendPid(c.two.pool);
  const swept = sweepWaits(c.two.ctx, c.at(1.5 * HOUR));
  const blockers = async () => (await c.pg.admin.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [sweepPid])).rows[0]!.blockers;
  await expect.poll(blockers).not.toEqual([]);
  letGo();
  await Promise.all([replanned, swept]);
  expect(await c.row()).toMatchObject({ level: 0, generation: 2 });
  expect(await c.notices()).toEqual([]);
  expect(await c.lines('wait_due')).toEqual([]);
});

it('hands a person one card, with one line in the log, when two connections deliver at once', async () => {
  const c = await late();
  const [olga] = await c.pg.db.insert(people).values({ companyId: c.fixture.companyId, name: 'Olga', email: 'olga@example.test', status: 'active', scopeKind: 'company' }).returning();
  await c.pg.db.update(departments).set({ ownerPersonId: olga!.id }).where(eq(departments.id, c.fixture.departmentId));
  const now = c.at(3.5 * HOUR);
  for (let level = 0; level < 3; level++) await sweepWaits(c.one.ctx, now);
  expect(await c.row()).toMatchObject({ level: 3, finalDecisionPersonId: olga!.id });
  await Promise.all([deliverWaitNotices(c.one.ctx, now), deliverWaitNotices(c.two.ctx, now)]);
  const cards = await c.pg.db.select().from(waitNotices).where(and(eq(waitNotices.personId, olga!.id), isNotNull(waitNotices.deliveredAt)));
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ acknowledgedAt: null, purpose: 'escalation', level: 3 });
  expect(await c.lines('wait_card')).toHaveLength(1);
});

it('lets one of two say a goal is in danger at once, and writes one card', async () => {
  const c = await late();
  const ref = { kind: 'turn' as const, id: randomUUID() };
  const say = (actor: typeof c.one) => ask(actor.ctx, actor.job.agentId, actor.task.id, { kind: 'question', text: 'Missed goal.', topic: 'task', goal: { ref, impact: 'missed' } }).then(() => null, (error: unknown) => error);
  const refused = (await Promise.all([say(c.one), say(c.two)])).filter(Boolean);
  expect(refused).toHaveLength(1);
  expect(isUniqueViolation(refused[0])).toBe(true);
  expect(await c.pg.db.select().from(requests).where(eq(requests.goalRefId, ref.id))).toHaveLength(1);
  expect(await c.pg.db.select().from(waitNotices).where(like(waitNotices.purpose, 'goal_risk:%'))).toHaveLength(1);
});
