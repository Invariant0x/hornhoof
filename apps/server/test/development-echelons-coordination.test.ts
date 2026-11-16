import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskRoutes, tasks, turns } from '../src/db/schema.js';
import { loadTask, report, submit } from '../src/modules/tasks/engine.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { currentCandidate } from '../src/modules/tasks/echelons-candidates.js';
import { changeReport, testsFixture } from './development-echelons-verification.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

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
  return { ...f, group, child, candidate, misreported };
}

describe('coordination results in the required engine', () => {
  it('closes a checked aggregate with real child references and no invented code candidate', async () => {
    const f = await groupFixture(true);
    const moved = await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'Checked the child result and its recorded evidence.' });
    expect(moved.task.status).toBe('done');
    const detail = await f.detail(f.group.id);
    expect(detail.echelons).toMatchObject({ resultKind: 'coordination', phase: 'done', stage: null, stages: [], candidateId: null });
    expect(detail.log.findLast(event => event.kind === 'report')?.data).toMatchObject({ acceptedChildren: [{ taskId: f.child.id, candidateId: f.candidate.id, commit: HEAD }] });
  });
  it.each([false, true])('refuses an unaccepted or stale closed child (stale=%s)', async stale => {
    const f = await groupFixture(stale, stale);
    await expect(report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'Not enough evidence.' }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await loadTask(f.db, f.group.id)).status).not.toBe('done');
  });
  it('refuses a child whose Tests report no longer names its candidate', async () => {
    const f = await groupFixture(true);
    await f.misreported();
    await expect(report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'The child report changed.' }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await loadTask(f.db, f.group.id)).status).not.toBe('done');
  });
  it('closes over results accepted when reports still named test runs', async () => {
    const f = await groupFixture(true);
    const runs = (proof: Record<string, unknown>) => ({ ...proof, evidence: [{ runId: randomUUID(), commit: HEAD }] });
    await changeReport(f.db, f.child.id, 'verifiedCandidate', runs);
    await changeReport(f.db, f.child.id, 'acceptedCandidate', runs);
    expect((await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'Checked the child result.' })).task.status).toBe('done');
    const outer = (await f.create({ title: 'Outer checked group', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: outer.id }).where(eq(tasks.id, f.group.id));
    await changeReport(f.db, f.group.id, 'acceptedChildren', children => (children as unknown as Record<string, unknown>[]).map(runs));
    expect((await report(f.ctx, f.head.id, outer.id, { done: true, summary: 'Checked the nested results.' })).task.status).toBe('done');
  });
  it.each([false, true])('revalidates nested accepted results (changed report=%s)', async invalid => {
    const f = await groupFixture(true);
    await report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'Checked the child result.' });
    const outer = (await f.create({ title: 'Outer checked group', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await f.db.update(tasks).set({ parentId: outer.id }).where(eq(tasks.id, f.group.id));
    if (invalid) await f.misreported();
    const complete = () => report(f.ctx, f.head.id, outer.id, { done: true, summary: 'Checked the nested results.' });
    if (invalid) {
      await expect(complete().then(() => null)).rejects.toMatchObject({ status: 409 });
      expect((await loadTask(f.db, outer.id)).status).not.toBe('done');
    } else expect((await complete()).task.status).toBe('done');
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
