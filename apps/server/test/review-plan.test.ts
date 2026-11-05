import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, subscriptions, taskEvents, tasks, turns } from '../src/db/schema.js';
import { createTask, submit } from '../src/modules/tasks/engine.js';
import { setUpCompany, testApp } from './helpers.js';

const BASE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const LEFT = 'a'.repeat(40);
const RIGHT = 'b'.repeat(40);

async function fixture({ lines = 801, independent = true, sources = true, integrator = false } = {}) {
  const { app, db } = await testApp();
  await setUpCompany(app);
  const ctx = app.ctx;
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const [ceo] = await db.select().from(people);
  const [claude] = await db.select().from(subscriptions);
  const [codex] = await db.insert(subscriptions).values({ companyId, provider: 'openai_api', kind: 'api', label: 'Other vendor', ownerPersonId: ceo!.id, status: 'ready' }).returning();
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'worker' | 'head', roleKey: string, sub = claude!.id) =>
    (await db.insert(agents).values({ companyId, name, kind, roleKey, departmentId: dev!.id, subscriptionId: sub, model: '' }).returning())[0]!;
  const head = await hire('Head', 'head', 'DEV-HEAD');
  const left = await hire('Left author', 'worker', 'DEV-BE');
  const right = await hire('Right author', 'worker', 'DEV-FE', independent ? codex!.id : claude!.id);
  const reviewClaude = await hire('Claude reviewer', 'worker', 'DEV-REV');
  const reviewCodex = independent ? await hire('Codex reviewer', 'worker', 'DEV-REV', codex!.id) : null;
  const [third] = integrator ? await db.insert(subscriptions).values({ companyId, provider: 'kimi', kind: 'personal', label: 'Integration', ownerPersonId: ceo!.id, status: 'ready' }).returning() : [];
  const integrationReviewer = third ? await hire('Integrator', 'worker', 'DEV-REV', third.id) : null;
  await db.insert(turns).values({ companyId, number: 9, title: 'Checkout', goal: 'Checkout', status: 'open', openedAt: new Date() });
  const parent = (await createTask(ctx, { personId: ceo!.id }, { title: 'Checkout', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: head.id })).task;
  const member = async (author: string, title: string) => (await createTask(ctx, { agentId: head.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: parent.id, assigneeAgentId: author, executor: true, gates: [], inTurnReview: true })).task;
  const first = await member(left.id, 'Checkout API');
  const second = await member(right.id, 'Checkout page');
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: 'task' in want ? want.task === first.number ? LEFT : RIGHT : HEAD });
  const diff = (n: number) => Array.from({ length: n }, (_, i) => `+value${i}`).join('\n');
  ctx.readCompare = async (_repo, refs) => ({ complete: true, baseSha: BASE, headSha: refs.head === LEFT ? LEFT : refs.head === RIGHT ? RIGHT : HEAD, paths: ['apps/shop/cart.ts', 'packages/protocol/src/index.ts'], diff: diff(refs.head.startsWith('turn-') ? lines : 401) });
  const merge = async (author: string, id: string) => {
    await submit(ctx, author, id, { summary: 'Done', evidence: 'Checks', ...(sources ? { review: { baseCommit: BASE } } : {}) });
    return submit(ctx, author, id, { summary: 'Merged', evidence: 'Merge SHA' });
  };
  await merge(left.id, first.id);
  const moved = await merge(right.id, second.id);
  const [review] = await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.title, 'Review of turn 9')));
  const [made] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, review!.id), eq(taskEvents.kind, 'created')));
  return { ctx, db, moved, review: review!, made: made!, first, second, left, right, reviewClaude, reviewCodex, integrationReviewer };
}

type Assignment = { reviewerId: string; taskId: string; baseCommit: string; commit: string; paths: string[]; commonContracts: string[] };
type Plan = { threshold: number; large: boolean; assignments: Assignment[]; integrationReviewerId: string | null; degraded: string[] };

describe('reviewing vertical task slices', () => {
  it('distributes 801 lines by task ranges to reviewers of other vendors even in the same file', async () => {
    const { made, first, second, reviewClaude, reviewCodex } = await fixture();
    expect(made.data.reviewPlan).toMatchObject({ threshold: 800, large: true });
    const plan = made.data.reviewPlan as Plan;
    expect(plan.assignments).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewerId: reviewCodex!.id, taskId: first.id, baseCommit: BASE, commit: LEFT, paths: ['apps/shop/cart.ts', 'packages/protocol/src/index.ts'] }),
      expect.objectContaining({ reviewerId: reviewClaude.id, taskId: second.id, baseCommit: BASE, commit: RIGHT }),
    ]));
    expect(plan.assignments.every(a => a.commonContracts.includes('packages/protocol/src/index.ts'))).toBe(true);
    expect(plan.assignments).toHaveLength(2);
  });

  it('keeps the 800-line boundary explicit rather than claiming a measured optimum', async () => {
    const { made } = await fixture({ lines: 800 });
    expect(made.data.reviewPlan).toMatchObject({ threshold: 800, large: false });
  });

  it('assigns the common-contract connections to an independent integration reviewer', async () => {
    const { made, review, integrationReviewer } = await fixture({ integrator: true });
    expect(made.data.reviewPlan).toMatchObject({ integrationReviewerId: integrationReviewer!.id });
    expect(review.panel).toContain(integrationReviewer!.id);
  });

  it('records unavailable independent review and never gives an author vendor its own slice', async () => {
    const { made, review, moved } = await fixture({ independent: false });
    const plan = made.data.reviewPlan as Plan;
    expect(plan).toMatchObject({ assignments: [], integrationReviewerId: null });
    expect(plan.degraded).toContain('independent-reviewer-unavailable');
    expect(review.panel).toEqual([]);
    expect(moved.wakes.some(w => w.why === 'switched' && w.text?.includes('independent'))).toBe(true);
  });

  it('shows incomplete task inventories as degraded without inventing a combined ownership directory', async () => {
    const { made, first, second } = await fixture({ sources: false });
    const plan = made.data.reviewPlan as Plan;
    expect(plan.degraded).toContain('source-inventory-unavailable');
    expect(new Set(plan.assignments.map(a => a.taskId))).toEqual(new Set([first.id, second.id]));
    expect(plan.assignments.every(a => a.paths.length === 0)).toBe(true);
  });
});
