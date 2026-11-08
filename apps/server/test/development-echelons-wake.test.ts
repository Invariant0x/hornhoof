import { describe, expect, it } from 'vitest';
import { loadTask, submit } from '../src/modules/tasks/engine.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { BASE, fixture } from './development-echelons-fixture.js';

describe('required-route wake identity', () => {
  it('keeps the actual stage and candidate instead of a numeric gate snapshot', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Keep totals.', evidence: 'Changed tests.', review: { baseCommit: BASE } });
    const task = await loadTask(f.db, f.task.id);
    const route = (await f.detail()).echelons;
    const wake = taskWakeOf(task, { why: 'review' }, route);
    expect(wake).toMatchObject({ stage: 'review', candidateId: route.candidateId, version: task.version });
    expect(wake).not.toHaveProperty('merging');
  });
});
