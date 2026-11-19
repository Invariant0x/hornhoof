import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, taskRoutes } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

/* Re-check probe of #1494 on bf3763dd: a route still carrying the old author-check skip, as one in flight before the
   switch-off would. When a Security repair sends it back to Review, the original author of the unreviewed change must not
   become the Review owner. The test states the safe behaviour, so it fails while that path is open. */
const FIX = 'c'.repeat(40);

describe('a stale route with the old skip', () => {
  it('does not give Review of a Security repair to the original author', async () => {
    const f = await fixture({ autoReviewer: true });
    await f.db.update(agents).set({ skills: [...f.author.skills, 'dev-review-diff'] }).where(eq(agents.id, f.author.id));
    const { task } = await f.create({ small: true, paths: ['logic/totals.ts'], riskClass: 'security' });
    const detail = async () => (await f.detail(task.id)).echelons;
    await submit(f.ctx, f.author.id, task.id, { summary: 'Change totals.', evidence: 'Named test.', review: { baseCommit: BASE } });
    const reviewer = (await detail()).stages.find(step => step.stage === 'review')?.ownerAgentId;
    expect(reviewer).not.toBe(f.author.id);
    await verdict(f.ctx, reviewer!, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed.' });
    expect(await detail()).toMatchObject({ stage: 'security' });
    /* The route as the old policy left it: Review skipped on a receipt for this candidate. */
    const [route] = await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, task.id));
    const state = route!.state;
    const stages = state.stages.map(step => step.stage === 'review'
      ? { ...step, status: 'skipped' as const, reason: 'author_check_passed', inputCandidateId: state.candidateId, candidateId: null, ownerAgentId: null }
      : step);
    await f.db.update(taskRoutes).set({ state: { ...state, stages } }).where(eq(taskRoutes.taskId, task.id));
    f.atCommit(FIX);
    await submit(f.ctx, f.security.id, task.id, { summary: 'Repair in Security.', evidence: 'Named test.', review: { baseCommit: BASE } });
    const after = await detail();
    expect(after.stage).toBe('review');
    expect(after.stages.find(step => step.stage === 'review')?.ownerAgentId).not.toBe(f.author.id);
  });
});
