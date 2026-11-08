import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents, taskRoutes, tasks } from '../src/db/schema.js';
import { loadTask, report, submit } from '../src/modules/tasks/engine.js';
import { routeOf } from '../src/modules/tasks/echelons-store.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

/* A reviewed child is an existing immutable result, never a fabricated commit of the group. */
async function groupFixture(accepted: boolean, stale = false) {
  const f = await fixture();
  const group = (await f.create({ title: 'Coordinate totals', assigneeAgentId: f.head.id, executor: false, ...{ resultKind: 'coordination' } })).task;
  const child = (await f.create({ title: 'Child totals', parentId: group.id })).task;
  const candidateId = randomUUID();
  const route = await routeOf(f.db, child);
  const candidate = { id: candidateId, parentId: null, revision: 2, baseCommit: BASE, commit: HEAD, branch: `task-${child.number}`, paths: ['logic/totals.ts'], producedBy: { agentId: f.author.id, subscriptionId: f.author.subscriptionId!, provider: 'codex', model: 'gpt-6.1-sol', capability: 2, stage: 'development' } };
  await f.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, child.id));
  await f.db.update(taskRoutes).set({ revision: 3, state: { ...route.state, stage: 'tests', phase: 'done', candidateId,
    stages: route.state.stages.map(step => ({ ...step, status: step.status === 'skipped' ? 'skipped' : 'complete' })),
  } }).where(eq(taskRoutes.taskId, child.id));
  await f.db.insert(taskEvents).values({ companyId: child.companyId, taskId: child.id, agentId: f.author.id, kind: 'submitted', data: { candidate } });
  if (accepted) await f.db.insert(taskEvents).values({ companyId: child.companyId, taskId: child.id, agentId: f.tester.id, kind: 'report', data: { acceptedCandidate: { candidateId: stale ? randomUUID() : candidateId, commit: HEAD, routeRevision: 3, evidence: [{ runId: randomUUID(), commit: HEAD }] } } });
  return { ...f, group, child, candidate };
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
