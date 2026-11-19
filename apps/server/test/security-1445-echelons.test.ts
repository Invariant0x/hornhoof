import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, taskEvents } from '../src/db/schema.js';
import { submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

/* Security probe of #1445 against d877a6a4 (#1217): once a checker repairs a candidate whose Review was skipped on an author
   receipt, the repair goes to Review. That Review covers the author's own unreviewed change, so its author must not be its owner.
   The test states the safe behaviour, so it fails while the hole is open. */
const FIX = 'c'.repeat(40);

async function skippedReview(riskClass: 'none' | 'security') {
  const f = await fixture({ autoReviewer: true });
  /* The author also holds the review skill, as a person can set on any employee card. */
  await f.db.update(agents).set({ skills: [...f.author.skills, 'dev-review-diff'] }).where(eq(agents.id, f.author.id));
  const { task } = await f.create({ small: true, paths: ['logic/totals.ts', 'test/totals.test.ts'], riskClass });
  const detail = async () => (await f.detail(task.id)).echelons;
  await f.db.insert(taskEvents).values({
    companyId: task.companyId, taskId: task.id, kind: 'comment', agentId: null, text: 'Author check completed.',
    data: { authorCheckReceipt: {
      pin: { taskId: task.id, agentId: f.author.id, branch: 'task-1', baseCommit: BASE, commit: HEAD, repoUrlHash: hashToken('https://github.com/acme/shop.git'), paths: ['logic/totals.ts'] },
      crap: 2, cherryPick: null, routeRevision: (await detail()).revision,
    } },
  });
  await submit(f.ctx, f.author.id, task.id, { summary: 'Change totals.', evidence: 'check:author passed.', review: { baseCommit: BASE } });
  expect((await detail()).stages.find(step => step.stage === 'review')).toMatchObject({ status: 'skipped', reason: 'author_check_passed' });
  return { ...f, task, detail };
}

describe('a repair of a skipped-Review candidate is never reviewed by its original author', () => {
  it('after a Security repair', async () => {
    const f = await skippedReview('security');
    f.atCommit(FIX);
    await submit(f.ctx, f.security.id, f.task.id, { summary: 'Repair in Security.', evidence: 'Named test.', review: { baseCommit: BASE } });
    const state = await f.detail();
    expect(state.stage).toBe('review');
    expect(state.stages.find(step => step.stage === 'review')?.ownerAgentId).not.toBe(f.author.id);
  });

  it('after a Tests repair', async () => {
    const f = await skippedReview('none');
    f.atCommit(FIX, ['logic/totals.ts', 'test/totals.test.ts']);
    const compare = f.ctx.readCompare!;
    f.ctx.readCompare = (repo, refs, timeout) => refs.base === HEAD && refs.head === FIX
      ? Promise.resolve({ complete: true, baseSha: HEAD, headSha: FIX, paths: ['test/totals.test.ts'], diff: '' })
      : compare(repo, refs, timeout);
    await submit(f.ctx, f.tester.id, f.task.id, { summary: 'Fix a test.', evidence: 'Named test.', review: { baseCommit: BASE } });
    const state = await f.detail();
    expect(state.stage).toBe('review');
    expect(state.stages.find(step => step.stage === 'review')?.ownerAgentId).not.toBe(f.author.id);
  });
});
