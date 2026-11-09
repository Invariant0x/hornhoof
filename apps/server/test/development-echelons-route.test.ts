import { describe, expect, it } from 'vitest';
import { cancel, submit } from '../src/modules/tasks/engine.js';
import { BASE, fixture } from './development-echelons-fixture.js';

describe('the only Development work route', () => {
  it('starts small work at Development with a required pending Review', async () => {
    const { author, detail } = await fixture();
    expect(await detail()).toMatchObject({
      echelons: {
        stage: 'development', phase: 'active', ownerAgentId: author.id,
        stages: expect.arrayContaining([
          expect.objectContaining({ stage: 'architecture', status: 'skipped' }),
          expect.objectContaining({ stage: 'development', status: 'active' }),
          expect.objectContaining({ stage: 'review', status: 'pending' }),
        ]),
      },
    });
  });

  it('hands code to Review even when the head did not supply old gates', async () => {
    const { ctx, task, author, reviewer, detail } = await fixture();
    const moved = await submit(ctx, author.id, task.id, { summary: 'Keep totals.', evidence: 'Changed source ready for review.', review: { baseCommit: BASE } });
    expect(moved.task).toMatchObject({ status: 'review', assigneeAgentId: reviewer.id });
    expect(await detail()).toMatchObject({ echelons: { stage: 'review', ownerAgentId: reviewer.id } });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([reviewer.id]);
  });

  it('ends the route of a cancelled task and of the work under it as cancelled', async () => {
    const { ctx, task, head, create, detail } = await fixture();
    const { task: child } = await create({ title: 'Keep tax totals', parentId: task.id });
    await cancel(ctx, { agentId: head.id }, task.id, 'Not needed any more.');
    for (const id of [task.id, child.id]) expect((await detail(id)).echelons).toMatchObject({ phase: 'cancelled' });
  });
});
