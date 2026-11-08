import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, turns } from '../src/db/schema.js';
import { submit, updateTask } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Keep totals.', evidence: 'Changed source and tests.', review: { baseCommit: BASE } };

describe('head decisions on the current route', () => {
  it('reassigns waiting Review without changing its candidate or returning it to Development', async () => {
    const f = await fixture();
    await f.db.update(agents).set({ model: 'claude-haiku-5-5' }).where(eq(agents.id, f.reviewer.id));
    await submit(f.ctx, f.author.id, f.task.id, code);
    const before = (await f.detail()).echelons;
    const other = await f.hire('Another reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const moved = await updateTask(f.ctx, f.head.id, f.task.id, { ...{ ownerAgentId: other.id } });
    expect(moved.task.assigneeAgentId).toBe(other.id);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', phase: 'active', candidateId: before.candidateId, ownerAgentId: other.id });
    expect(moved.wakes.map(w => w.agentId)).toEqual([other.id]);
  });
  it('refuses a worker changing its own route assignment', async () => {
    const f = await fixture();
    await expect(updateTask(f.ctx, f.author.id, f.task.id, { ...{ ownerAgentId: f.reviewer.id } }).then(() => null)).rejects.toMatchObject({ status: 403 });
  });
  it('applies explicit Cleanup to the department turn and to new tasks of that turn', async () => {
    const f = await fixture();
    const [turn] = await f.db.insert(turns).values({ companyId: f.task.companyId, number: 1, title: 'Totals', goal: 'Correct totals', status: 'open', createdByAgentId: f.head.id }).returning();
    const first = (await f.create({ title: 'Turn first' })).task;
    const second = (await f.create({ title: 'Turn second' })).task;
    expect(first.turnId).toBe(turn!.id);
    await updateTask(f.ctx, f.head.id, first.id, { ...{ cleanup: true, cleanupForTurn: true } });
    const third = (await f.create({ title: 'Turn third' })).task;
    for (const task of [first, second, third]) expect((await f.detail(task.id)).echelons.stages.map(step => step.stage)).toEqual(['architecture', 'development', 'review', 'cleanup', 'security', 'tests']);
    expect((await f.detail()).echelons.stages.some(step => step.stage === 'cleanup')).toBe(false);
  });
});
