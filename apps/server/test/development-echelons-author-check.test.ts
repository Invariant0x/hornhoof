import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, taskEvents, taskRoutes } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { verified } from './development-echelons-verification.js';

const FIX = 'c'.repeat(40);
const SOURCE = 'd'.repeat(40);

async function scenario({ small = false, paths = ['logic/totals.ts'], riskClass = 'none', autoReviewer = false }: {
  small?: boolean; paths?: string[]; riskClass?: 'none' | 'security' | 'access' | 'money' | 'data'; autoReviewer?: boolean;
}) {
  const f = await fixture({ autoReviewer });
  const { task } = await f.create({ small, paths, riskClass });
  f.atCommit(HEAD, paths);
  const handIn = () => submit(f.ctx, f.author.id, task.id, {
    summary: 'Change totals.', evidence: 'check:author passed; CRAP 2; clean cherry-pick.', review: { baseCommit: BASE },
  });
  const detail = async () => (await f.detail(task.id)).echelons;
  const receipt = async ({ commit = HEAD, crap = 2, cherryPick = null }: {
    commit?: string; crap?: number | null; cherryPick?: string | null;
  } = {}) => {
    const [event] = await f.db.insert(taskEvents).values({
      companyId: task.companyId, taskId: task.id, kind: 'comment',
      text: 'Author check completed.',
      data: { authorCheckReceipt: {
        pin: { taskId: task.id, agentId: f.author.id, branch: 'task-1', baseCommit: BASE, commit, repoUrlHash: hashToken('https://github.com/acme/shop.git'), paths },
        crap, cherryPick, routeRevision: (await detail()).revision,
      } },
    }).returning();
    return event!.uuid;
  };
  return { ...f, task, handIn, detail, receipt };
}

describe('Review is required regardless of author-check evidence', () => {
  it.each([
    { small: true, paths: ['logic/totals.ts'], cherryPick: null },
    { small: false, paths: ['docs/changelog.txt', 'docs/design/guide.md'], cherryPick: null },
    { small: false, paths: ['logic/totals.ts'], cherryPick: SOURCE },
  ])('sends a formerly eligible candidate to Review (%j)', async ({ small, paths, cherryPick }) => {
    const f = await scenario({ small, paths });
    await f.receipt({ cherryPick });
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.reviewer.id);
    const state = await f.detail();
    expect(state.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'active', reason: null });
    const [event] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(event?.data).not.toHaveProperty('authorCheckSkip');
  });

  it.each([2, 0, null])('never uses older author-check scores to advance a small task (%s)', async crap => {
    const f = await scenario({ small: true });
    await f.receipt({ crap });
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it.each(['none', 'security'] as const)('assigns an independent Review before the %s repair path', async riskClass => {
    const f = await scenario({ small: true, riskClass, autoReviewer: true });
    await f.db.update(agents).set({ skills: [...f.author.skills, 'dev-review-diff'] }).where(eq(agents.id, f.author.id));
    await f.receipt();
    await f.handIn();
    expect(await f.detail()).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed the change.' });
    expect(await f.detail()).toMatchObject({ stage: riskClass === 'none' ? 'tests' : 'security' });
  });

  it.each(['security', 'access', 'money', 'data'] as const)('requires Review and then Security for %s risk', async riskClass => {
    const f = await scenario({ small: true, riskClass });
    await f.receipt();
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.reviewer.id);
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed the change.' });
    expect(await f.detail()).toMatchObject({ stage: 'security', ownerAgentId: f.security.id, security: { required: true } });
  });

  it.each([false, true])('runs Review again after Tests returns a source repair (new receipt: %s)', async newReceipt => {
    const f = await scenario({ small: true });
    await f.receipt();
    await f.handIn();
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed the change.' });
    const state = await f.detail();
    await report(f.ctx, f.tester.id, f.task.id, {
      done: false, summary: 'The source needs fixing.',
      verification: { candidateId: state.candidateId!, revision: state.revision, delta: 'logic/totals.ts: handle the empty input.' },
    });
    expect((await f.detail()).stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', reason: null });
    f.atCommit(FIX);
    if (newReceipt) await f.receipt({ commit: FIX });
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it.each(['tests', 'acceptance'] as const)('reopens Review at %s for a candidate whose route used the old skip', async at => {
    const f = await scenario({ small: true });
    await f.handIn();
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed the change.' });
    if (at === 'acceptance') await report(f.ctx, f.tester.id, f.task.id, verified(await f.detail()));
    const [route] = await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, f.task.id));
    const state = route!.state;
    const stages = state.stages.map(step => step.stage === 'review'
      ? { ...step, status: 'skipped' as const, reason: 'author_check_passed', inputCandidateId: state.candidateId }
      : step);
    await f.db.update(taskRoutes).set({ state: { ...state, stages } }).where(eq(taskRoutes.taskId, f.task.id));
    const moved = at === 'tests'
      ? await report(f.ctx, f.tester.id, f.task.id, verified(await f.detail()))
      : await report(f.ctx, f.head.id, f.task.id, {
        done: true, summary: 'Accept the checked result.',
        acceptance: { candidateId: state.candidateId!, revision: route!.revision, integrationCommit: HEAD },
      });
    expect(moved.task).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'active', candidateId: state.candidateId });
  });
});
