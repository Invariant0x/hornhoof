import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskRoutes, tasks, testParts, turns } from '../src/db/schema.js';
import { loadTask, report, submit } from '../src/modules/tasks/engine.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { currentCandidate } from '../src/modules/tasks/echelons-candidates.js';
import { testsFixture } from './development-echelons-verification.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

/* Exercise a real child handoff, bound Tests run and authorized acceptance, not synthetic receipts. */
async function groupFixture(accepted: boolean, stale = false) {
  const f = await testsFixture();
  const group = (await f.create({ title: 'Coordinate totals', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
  const child = f.task;
  const [turn] = await f.db.insert(turns).values({ companyId: child.companyId, number: 17, goal: 'Keep totals correct.', status: 'open', openedAt: new Date() }).returning();
  await f.db.update(tasks).set({ parentId: group.id, turnId: turn!.id }).where(eq(tasks.id, child.id));
  f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: f.finalCommit });
  const run = await f.run();
  await report(f.ctx, f.tester.id, child.id, f.verified([run.id]));
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
  return { ...f, group, child, candidate, checkedRun: run };
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
  it('refuses child evidence that became invalid after acceptance', async () => {
    const f = await groupFixture(true);
    await f.db.update(testParts).set({ status: 'failed', exitCode: 1 }).where(eq(testParts.runId, f.checkedRun.id));
    await expect(report(f.ctx, f.head.id, f.group.id, { done: true, summary: 'The child receipt changed.' }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await loadTask(f.db, f.group.id)).status).not.toBe('done');
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
