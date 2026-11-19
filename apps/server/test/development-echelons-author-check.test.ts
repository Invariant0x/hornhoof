import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { taskEvents } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { verified } from './development-echelons-verification.js';

const FIX = 'c'.repeat(40);
const SOURCE = 'd'.repeat(40);

async function scenario({ small = false, paths = ['logic/totals.ts'], riskClass = 'none', scope = paths }: {
  small?: boolean; paths?: string[]; riskClass?: 'none' | 'security' | 'access' | 'money' | 'data'; scope?: string[];
}) {
  const f = await fixture();
  const { task } = await f.create({ small, paths: scope, riskClass });
  f.atCommit(HEAD, paths);
  const handIn = () => submit(f.ctx, f.author.id, task.id, {
    summary: 'Change totals.', evidence: 'check:author passed; CRAP 2; clean cherry-pick.', review: { baseCommit: BASE },
  });
  const detail = async () => (await f.detail(task.id)).echelons;
  const receipt = async ({ commit = HEAD, crap = 2, cherryPick = null, fromAuthor = false }: {
    commit?: string; crap?: number | null; cherryPick?: string | null; fromAuthor?: boolean;
  } = {}) => {
    const [event] = await f.db.insert(taskEvents).values({
      companyId: task.companyId, taskId: task.id, kind: 'comment',
      agentId: fromAuthor ? f.author.id : null, text: 'Author check completed.',
      data: { authorCheckReceipt: {
        pin: { taskId: task.id, agentId: f.author.id, branch: 'task-1', baseCommit: BASE, commit, repoUrlHash: hashToken('https://github.com/acme/shop.git'), paths },
        crap, cherryPick, routeRevision: (await detail()).revision,
      } },
    }).returning();
    return event!.uuid;
  };
  return { ...f, task, handIn, detail, receipt };
}

describe('exact author-check receipts replace only Review', () => {
  it.each([
    { small: true, paths: ['logic/totals.ts'], cherryPick: null },
    { small: false, paths: ['docs/changelog.txt', 'docs/design/guide.md'], cherryPick: null },
    { small: false, paths: ['logic/totals.ts'], cherryPick: SOURCE },
  ])('advances an eligible exact candidate and logs its receipt (%j)', async ({ small, paths, cherryPick }) => {
    const f = await scenario({ small, paths });
    const receiptId = await f.receipt({ cherryPick });
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.tester.id);
    const state = await f.detail();
    expect(state.stages.find(step => step.stage === 'review')).toMatchObject({
      status: 'skipped', reason: 'author_check_passed', inputCandidateId: state.candidateId,
    });
    const [event] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(event?.data.authorCheckSkip).toEqual({ receiptId, candidateId: state.candidateId, reason: 'author_check_passed' });
  });

  it.each([
    { small: false, paths: ['README.md'] },
    { small: false, paths: ['docs/plan.md', 'README.md'] },
    { small: false, paths: ['logic/totals.ts'] },
    { small: true, crap: 10 },
    { small: true, crap: null },
    { small: true, commit: FIX },
    { small: false, cherryPick: SOURCE, fromAuthor: true },
  ])('keeps Review for an ineligible, unproved or forged change (%j)', async options => {
    const f = await scenario(options);
    await f.receipt(options);
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it('requires the receipt even when the author says the check passed', async () => {
    const f = await scenario({ small: true });
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it.each(['security', 'access', 'money', 'data'] as const)('hands off to Security when Review is skipped for %s risk', async riskClass => {
    const f = await scenario({ small: true, riskClass });
    await f.receipt();
    expect((await f.handIn()).task.assigneeAgentId).toBe(f.security.id);
    expect(await f.detail()).toMatchObject({ stage: 'security', security: { required: true } });
  });

  it.each([false, true])('drops a shortcut after a source return (new receipt: %s)', async newReceipt => {
    const f = await scenario({ small: true });
    await f.receipt();
    await f.handIn();
    const state = await f.detail();
    await report(f.ctx, f.tester.id, f.task.id, {
      done: false, summary: 'The source needs fixing.',
      verification: { candidateId: state.candidateId!, revision: state.revision, delta: 'logic/totals.ts: handle the empty input.' },
    });
    expect((await f.detail()).stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', reason: null });
    f.atCommit(FIX);
    if (newReceipt) await f.receipt({ commit: FIX });
    expect((await f.handIn()).task.assigneeAgentId).toBe(newReceipt ? f.tester.id : f.reviewer.id);
  });

  it('routes a Tests repair of a previously skipped candidate through Review', async () => {
    const f = await scenario({ small: true, scope: ['logic/totals.ts', 'test/totals.test.ts'] });
    await f.receipt();
    await f.handIn();
    f.atCommit(FIX, ['logic/totals.ts', 'test/totals.test.ts']);
    const compare = f.ctx.readCompare!;
    f.ctx.readCompare = (repo, refs, timeout) => refs.base === HEAD && refs.head === FIX
      ? Promise.resolve({ complete: true, baseSha: HEAD, headSha: FIX, paths: ['test/totals.test.ts'], diff: '' })
      : compare(repo, refs, timeout);
    const moved = await submit(f.ctx, f.tester.id, f.task.id, {
      summary: 'Fix a test.', evidence: 'Named test.', review: { baseCommit: BASE },
    });
    expect(moved.task.assigneeAgentId).toBe(f.reviewer.id);
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'active' });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, reviewedCommit: FIX, comment: 'Reviewed the repair.' });
    expect(await f.detail()).toMatchObject({ stage: 'tests', ownerAgentId: f.tester.id });
    await report(f.ctx, f.tester.id, f.task.id, verified(await f.detail()));
    expect(await f.detail()).toMatchObject({ phase: 'ready' });
  });

  it('returns a Security repair to Review and still requires Security for that SHA', async () => {
    const f = await scenario({ small: true, riskClass: 'security' });
    await f.receipt();
    await f.handIn();
    f.atCommit(FIX);
    await submit(f.ctx, f.security.id, f.task.id, {
      summary: 'Repair the source in Security.', evidence: 'Named test.', review: { baseCommit: BASE },
    });
    expect(await f.detail()).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, reviewedCommit: FIX, comment: 'Reviewed the repair.' });
    expect(await f.detail()).toMatchObject({ stage: 'security', ownerAgentId: f.security.id });
    await verdict(f.ctx, f.security.id, f.task.id, { pass: true, reviewedCommit: FIX, comment: 'Verified the repair.' });
    expect(await f.detail()).toMatchObject({ stage: 'tests', ownerAgentId: f.tester.id });
  });

  it.each([true, false])('acceptance verifies the linked receipt (valid: %s)', async valid => {
    const f = await scenario({ small: true });
    const receiptId = await f.receipt();
    await f.handIn();
    await report(f.ctx, f.tester.id, f.task.id, verified(await f.detail()));
    const state = await f.detail();
    if (!valid) await f.db.update(taskEvents).set({ data: {} }).where(eq(taskEvents.uuid, receiptId));
    const result = report(f.ctx, f.head.id, f.task.id, {
      done: true, summary: 'Accept the checked result.',
      acceptance: { candidateId: state.candidateId!, revision: state.revision, integrationCommit: HEAD },
    });
    if (valid) expect((await result).task.status).toBe('done');
    else await expect(result).rejects.toMatchObject({ status: 409 });
  });
});
