import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, taskEvents, taskRoutes, tasks, turns } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { closeTask, report, submit } from '../src/modules/tasks/engine.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { currentCandidate } from '../src/modules/tasks/echelons-candidates.js';
import { changeReport, testsFixture } from './development-echelons-verification.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { RECORDED } from './recorded-fixture.js';

/* Exercise a real child handoff, Tests report and authorized acceptance, not synthetic receipts. */
async function groupFixture(accepted: boolean, stale = false) {
  const f = await testsFixture();
  const group = (await f.create({ title: 'Coordinate totals', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
  const child = f.task;
  /* The department's open turn, which the child joins as its head accepts it into turn-17. */
  await f.db.update(turns).set({ number: 17, goal: 'Keep totals correct.' }).where(and(eq(turns.departmentId, child.departmentId!), eq(turns.status, 'open')));
  await f.db.update(tasks).set({ parentId: group.id }).where(eq(tasks.id, child.id));
  f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: f.finalCommit });
  await report(f.ctx, f.tester.id, child.id, f.verified());
  const ready = (await f.detail()).echelons;
  if (accepted) await report(f.ctx, f.head.id, child.id, { done: true, summary: 'Observed the checked child in turn-17.', acceptance: { candidateId: ready.candidateId!, revision: ready.revision, integrationCommit: f.finalCommit } });
  else {
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, child.id));
    const route = await routeOf(f.db, child);
    await f.db.update(taskRoutes).set({ state: { ...route.state, phase: 'done' } }).where(eq(taskRoutes.taskId, child.id));
  }
  const route = await routeOf(f.db, child);
  const candidate = await currentCandidate(f.db, child, route);
  if (stale) await f.db.update(taskRoutes).set({ revision: route.revision + 1 }).where(eq(taskRoutes.taskId, child.id));
  /* The Tests report of the child names another commit than its candidate. */
  const misreported = () => changeReport(f.db, child.id, 'verifiedCandidate', proof => ({ ...proof, commit: 'd'.repeat(40) }));
  const closedOver = () => reported(f, group.id);
  return { ...f, group, child, candidate, misreported, closedOver };
}

/* What the report that closed a group says of the children it closed over. */
async function reported(f: { db: Db }, groupId: string) {
  const log = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, groupId)).orderBy(asc(taskEvents.id));
  return log.findLast(event => event.kind === 'report' && 'acceptedChildren' in event.data)?.data.acceptedChildren;
}

describe('coordination results in the required engine', () => {
  it('closes a checked aggregate with real child references and no invented code candidate', async () => {
    const f = await groupFixture(true);
    const moved = await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'Checked the child result and its recorded evidence.', recorded: RECORDED });
    expect(moved.task.status).toBe('done');
    const detail = await f.detail(f.group.id);
    expect(detail.echelons).toMatchObject({ resultKind: 'coordination', phase: 'done', stage: null, stages: [], candidateId: null });
    expect(detail.log.findLast(event => event.kind === 'report')?.data).toMatchObject({ acceptedChildren: [{ taskId: f.child.id, candidateId: f.candidate.id, commit: HEAD }] });
  });
  /* A closed child never holds its group open, whichever way it closed: one whose result no proof holds any more is kept in the
     report as closed without an accepted result, saying how it stood and who closed it, and is taken for accepted by nobody. */
  it.each([false, true])('closes over an unaccepted or stale closed child, recorded as not accepted (stale=%s)', async stale => {
    const f = await groupFixture(stale, stale);
    expect((await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'The child is closed.', recorded: RECORDED })).task.status).toBe('done');
    expect(await f.closedOver()).toEqual([{ taskId: f.child.id, unaccepted: { status: 'done', phase: 'done', closedBy: stale ? { agentId: f.head.id } : null } }]);
  });
  it('closes over a child whose Tests report no longer names its candidate, recorded as not accepted', async () => {
    const f = await groupFixture(true);
    await f.misreported();
    expect((await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'The child report changed.', recorded: RECORDED })).task.status).toBe('done');
    expect(await f.closedOver()).toEqual([{ taskId: f.child.id, unaccepted: { status: 'done', phase: 'done', closedBy: { agentId: f.head.id } } }]);
  });
  /* As in a company whose child task was closed by hand in its database: its status changed, and nothing else. */
  it('closes over a child closed directly in the database midway through its route', async () => {
    const f = await testsFixture();
    const group = (await f.create({ title: 'Coordinate totals', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: group.id }).where(eq(tasks.id, f.task.id));
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date('2026-11-17T12:00:00.000Z') }).where(eq(tasks.id, f.task.id));
    expect((await report(f.ctx, f.head.id, group.id, { done: true, summary: 'The child is closed.', recorded: RECORDED })).task.status).toBe('done');
    expect(await reported(f, group.id)).toEqual([{ taskId: f.task.id, unaccepted: { status: 'done', phase: 'active', closedBy: null } }]);
  });
  it('closes over a child the orchestrator closed, recorded as closed by it', async () => {
    const f = await testsFixture();
    const [orchestrator] = await f.db.select().from(agents).where(and(eq(agents.companyId, f.task.companyId), eq(agents.kind, 'orchestrator')));
    const group = (await f.create({ title: 'Coordinate totals', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: group.id }).where(eq(tasks.id, f.task.id));
    await closeTask(f.ctx, { agentId: orchestrator!.id }, f.task.id, { status: 'done', why: 'Closed by hand; the work is over.' });
    expect((await report(f.ctx, f.head.id, group.id, { done: true, summary: 'The child is closed.', recorded: RECORDED })).task.status).toBe('done');
    expect(await reported(f, group.id)).toEqual([{ taskId: f.task.id, unaccepted: { status: 'done', phase: 'done', closedBy: { agentId: orchestrator!.id } } }]);
  });
  it('closes over a group closed directly in the database before its children', async () => {
    const f = await groupFixture(true);
    const outer = (await f.create({ title: 'Outer checked group', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: outer.id }).where(eq(tasks.id, f.group.id));
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date('2026-11-17T12:00:00.000Z') }).where(eq(tasks.id, f.group.id));
    expect((await report(f.ctx, f.head.id, outer.id, { done: true, summary: 'The inner group is closed.', recorded: RECORDED })).task.status).toBe('done');
    expect(await reported(f, outer.id)).toEqual([{ taskId: f.group.id, unaccepted: { status: 'done', phase: 'active', closedBy: null } }]);
  });
  it('closes over results accepted when reports still named test runs', async () => {
    const f = await groupFixture(true);
    const runs = (proof: Record<string, unknown>) => ({ ...proof, evidence: [{ runId: randomUUID(), commit: HEAD }] });
    await changeReport(f.db, f.child.id, 'verifiedCandidate', runs);
    await changeReport(f.db, f.child.id, 'acceptedCandidate', runs);
    expect((await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'Checked the child result.', recorded: RECORDED })).task.status).toBe('done');
    const outer = (await f.create({ title: 'Outer checked group', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: outer.id }).where(eq(tasks.id, f.group.id));
    await changeReport(f.db, f.group.id, 'acceptedChildren', children => (children as unknown as Record<string, unknown>[]).map(runs));
    expect((await report(f.ctx, f.head.id, outer.id, { done: true, summary: 'Checked the nested results.', recorded: RECORDED })).task.status).toBe('done');
  });
  it.each([false, true])('revalidates nested accepted results (changed report=%s)', async invalid => {
    const f = await groupFixture(true);
    await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'Checked the child result.', recorded: RECORDED });
    const outer = (await f.create({ title: 'Outer checked group', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: outer.id }).where(eq(tasks.id, f.group.id));
    if (invalid) await f.misreported();
    expect((await report(f.ctx, f.head.id, outer.id, { done: true, summary: 'Checked the nested results.', recorded: RECORDED })).task.status).toBe('done');
    /* A group whose accepted results changed since it closed is closed without an accepted result now. */
    expect(await reported(f, outer.id)).toEqual([invalid
      ? { taskId: f.group.id, unaccepted: { status: 'done', phase: 'done', closedBy: { agentId: f.head.id } } }
      : { taskId: f.group.id, children: [{ taskId: f.child.id, candidateId: f.candidate.id, commit: HEAD }] }]);
  });
  it('refuses to hide executable work behind a coordination name', async () => {
    const f = await fixture();
    await expect(report(f.ctx, f.author.id, f.task.id, { done: true, summary: 'Coordination, actually code.' })).rejects.toMatchObject({ status: 400 });
  });
  it('does not accept a code candidate for a coordination-only result', async () => {
    const f = await fixture();
    const group = (await f.create({ title: 'Group', ...{ resultKind: 'coordination' } })).task;
    await expect(submit(f.ctx, f.author.id, group.id, { summary: 'Code cannot bypass Review.', evidence: 'Code.', review: { baseCommit: BASE } }).then(() => null)).rejects.toMatchObject({ status: 400 });
  });
});
