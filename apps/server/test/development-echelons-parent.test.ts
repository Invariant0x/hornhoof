import { describe, expect, it } from 'vitest';
import { loadTask, report, submit } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';
import { RECORDED } from './recorded-fixture.js';

async function parentFixture() {
  const f = await fixture();
  const parent = (await f.create({ title: 'Own executable integration', assigneeAgentId: f.head.id, executor: false, resultKind: 'code', small: true })).task;
  f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: 'b'.repeat(40) });
  return { ...f, parent };
}

describe('a parent with its own executable result', () => {
  it('cannot close through report just because the old executor pointer is empty', async () => {
    const f = await parentFixture();
    expect(f.parent.executorAgentId).toBeNull();
    await expect(report(f.ctx, f.head.id, f.parent.id, { done: true, summary: 'This group also produced code.' }).then(() => null)).rejects.toMatchObject({ status: 400 });
    expect((await loadTask(f.db, f.parent.id)).status).not.toBe('done');
    expect((await f.detail(f.parent.id)).echelons).toMatchObject({ resultKind: 'code', stage: 'development', phase: 'active' });
  });
  it('submits its own code to Review after its checked children close', async () => {
    const f = await parentFixture();
    const child = (await f.create({ title: 'Checked coordination', parentId: f.parent.id, assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    await report(f.ctx, f.head.id, child.id, { done: true, summary: 'Checked the referenced results.', recorded: RECORDED });
    const moved = await submit(f.ctx, f.head.id, f.parent.id, { summary: 'Own integration implementation.', evidence: 'Affected checks.', review: { baseCommit: BASE } });
    expect(moved.task.assigneeAgentId).toBe(f.reviewer.id);
    expect((await f.detail(f.parent.id)).echelons).toMatchObject({ resultKind: 'code', stage: 'review', phase: 'active', candidateId: expect.any(String) });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.reviewer.id]);
  });
});
