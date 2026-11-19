import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, taskEvents, taskRoutes, tasks, turns } from '../src/db/schema.js';
import { agentIdentity } from '../src/modules/tasks/echelons-assign.js';
import { report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { backOn } from '../src/modules/tasks/wake.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const FIX = 'c'.repeat(40), MAIN = 'd'.repeat(40), MERGED = 'e'.repeat(40), LATER = 'f'.repeat(40);
const OWN = ['logic/totals.ts'], TEST = ['test/totals.test.ts'], FROM_MAIN = ['logic/rates.ts'];
const code = { summary: 'Change totals.', evidence: 'Named test.', review: { baseCommit: BASE } };
const pass = (reviewedCommit: string) => ({ pass: true, reviewedCommit, comment: 'Reviewed.' });

type Fixture = Awaited<ReturnType<typeof fixture>>;

/* The route as the old policy left it in flight: Review skipped on an author receipt for the candidate it holds now. */
async function withOldSkip(f: Pick<Fixture, 'db'>, taskId: string): Promise<void> {
  const [route] = await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, taskId));
  const state = route!.state;
  const stages = state.stages.map(step => step.stage === 'review'
    ? { ...step, status: 'skipped' as const, reason: 'author_check_passed', inputCandidateId: state.candidateId, candidateId: null, ownerAgentId: null }
    : step);
  await f.db.update(taskRoutes).set({ state: { ...state, stages } }).where(eq(taskRoutes.taskId, taskId));
}

/* A legacy route at Security or Tests. The developer also holds the review skill, as a person can set on any employee card,
   and runs another provider than every checker, so a selection that compares only with a repair producer prefers it. */
async function legacy(at: 'security' | 'tests', paths = OWN, skip = true) {
  const f = await fixture({ autoReviewer: true });
  await f.db.update(agents).set({ skills: [...f.author.skills, 'dev-review-diff'] }).where(eq(agents.id, f.author.id));
  const { task } = await f.create({ small: true, paths, riskClass: at === 'security' ? 'security' : 'none' });
  f.atCommit(HEAD, paths);
  const detail = async () => (await f.detail(task.id)).echelons;
  await submit(f.ctx, f.author.id, task.id, code);
  expect(await detail()).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
  await verdict(f.ctx, f.reviewer.id, task.id, pass(HEAD));
  expect(await detail()).toMatchObject({ stage: at });
  if (skip) await withOldSkip(f, task.id);
  return { ...f, task, detail, reviewStep: async () => (await detail()).stages.find(step => step.stage === 'review') };
}

/* What a live route looks like where the old selection already gave the reopened Review to the original developer. */
async function assignedToAuthor(f: Pick<Fixture, 'db' | 'task' | 'author'>, taskId: string): Promise<void> {
  const identity = await agentIdentity(f.db, f.task.companyId, f.author.id);
  const [route] = await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, taskId));
  const state = route!.state;
  await f.db.update(taskRoutes).set({ state: { ...state, assignment: identity, stages: state.stages.map(step => step.stage === 'review' ? { ...step, ownerAgentId: f.author.id } : step) } })
    .where(eq(taskRoutes.taskId, taskId));
  await f.db.update(tasks).set({ assigneeAgentId: f.author.id, status: 'review' }).where(eq(tasks.id, taskId));
}

describe('Review of a legacy route after a repair is never given to a producer', () => {
  it('gives Review of a Security repair to an independent reviewer, not the original developer', async () => {
    const f = await legacy('security');
    f.atCommit(FIX);
    const moved = await submit(f.ctx, f.security.id, f.task.id, { ...code, summary: 'Repair in Security.' });
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
    expect(moved.task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it('refuses a Review verdict and a Review repair from the original developer it was already given to', async () => {
    const f = await legacy('security');
    f.atCommit(FIX);
    await submit(f.ctx, f.security.id, f.task.id, { ...code, summary: 'Repair in Security.' });
    await assignedToAuthor(f, f.task.id);
    const before = await f.detail();
    await expect(verdict(f.ctx, f.author.id, f.task.id, pass(FIX))).rejects.toMatchObject({ status: 409 });
    await expect(verdict(f.ctx, f.author.id, f.task.id, { pass: false, reviewedCommit: FIX, comment: 'Needs a change.' })).rejects.toMatchObject({ status: 409 });
    f.atCommit(LATER);
    await expect(submit(f.ctx, f.author.id, f.task.id, { ...code, summary: 'My own repair.' })).rejects.toMatchObject({ status: 409 });
    expect(await f.detail()).toEqual(before);
    expect((await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.agentId, f.author.id), eq(taskEvents.kind, 'verdict'))))).toEqual([]);
  });

  it('gives Review of a Tests repair to an independent reviewer', async () => {
    const f = await legacy('tests', [...OWN, ...TEST]);
    f.atCommit(FIX, [...OWN, ...TEST]);
    const compare = f.ctx.readCompare!;
    f.ctx.readCompare = (repo, refs, timeout) => refs.base === HEAD && refs.head === FIX
      ? Promise.resolve({ complete: true, baseSha: HEAD, headSha: FIX, paths: TEST, diff: '' })
      : compare(repo, refs, timeout);
    await submit(f.ctx, f.tester.id, f.task.id, { ...code, summary: 'Fix a test.' });
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  });

  it('gives Review of a main take-in at Tests to an independent reviewer', async () => {
    const f = await legacy('tests');
    const [turn] = await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open')));
    const turnBranch = `turn-${turn!.number}`;
    f.ctx.readCommit = async (_repo, want) => {
      const branch = 'branch' in want ? want.branch : 'task-1';
      return { branch, commitSha: branch === 'main' || branch === turnBranch ? MAIN : MERGED };
    };
    const changes: Record<string, string[]> = { [`${BASE}..${MAIN}`]: FROM_MAIN, [`${MAIN}..${MERGED}`]: OWN, [`${HEAD}..${MERGED}`]: FROM_MAIN };
    f.ctx.readCompare = async (_repo, refs) => {
      const paths = changes[`${refs.base}..${refs.head}`];
      return paths ? { complete: true, baseSha: refs.base, headSha: refs.head, paths, diff: '@@ -1 +1 @@\n-old\n+new' } : { complete: false, reason: 'not-an-ancestor' };
    };
    await submit(f.ctx, f.tester.id, f.task.id, { summary: 'Took the main line in.', evidence: 'Merged origin/main.', review: { baseCommit: MAIN } });
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  });

  it('waits at Review when every employee able to review produced a candidate of the task', async () => {
    const f = await legacy('security');
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    f.atCommit(FIX);
    const moved = await submit(f.ctx, f.security.id, f.task.id, { ...code, summary: 'Repair in Security.' });
    expect(moved.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    expect(await f.reviewStep()).toMatchObject({ status: 'pending', ownerAgentId: null, reason: 'eligible_owner_required' });
  });

  it('resumes a waiting Review with an independent reviewer, never with a producer', async () => {
    const f = await legacy('security');
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    f.atCommit(FIX);
    await submit(f.ctx, f.security.id, f.task.id, { ...code, summary: 'Repair in Security.' });
    await backOn(f.ctx, { agentId: f.head.id }, f.author.id);
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    await f.db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, f.reviewer.id));
    await backOn(f.ctx, { agentId: f.head.id }, f.reviewer.id);
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id });
  });

  it('refuses the head giving the current Review to the original developer', async () => {
    const f = await legacy('security');
    f.atCommit(FIX);
    await submit(f.ctx, f.security.id, f.task.id, { ...code, summary: 'Repair in Security.' });
    const before = await f.detail();
    await expect(updateTask(f.ctx, f.head.id, f.task.id, { ownerAgentId: f.author.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('cannot review it') as unknown });
    expect(await f.detail()).toEqual(before);
  });

  it('refuses the head naming the original developer as the future reviewer of a candidate grown from its own', async () => {
    const f = await legacy('tests', [...OWN, ...TEST], false);
    f.atCommit(FIX, [...OWN, ...TEST]);
    const compare = f.ctx.readCompare!;
    f.ctx.readCompare = (repo, refs, timeout) => refs.base === HEAD && refs.head === FIX
      ? Promise.resolve({ complete: true, baseSha: HEAD, headSha: FIX, paths: TEST, diff: '' })
      : compare(repo, refs, timeout);
    await submit(f.ctx, f.tester.id, f.task.id, { ...code, summary: 'Fix a test.' });
    const atTests = await f.detail();
    expect(atTests).toMatchObject({ stage: 'tests', ownerAgentId: f.tester.id });
    await report(f.ctx, f.tester.id, f.task.id, { done: false, summary: 'The source needs fixing.', verification: { candidateId: atTests.candidateId!, revision: atTests.revision, delta: 'logic/totals.ts: handle the empty input.' } });
    const before = await f.detail();
    expect(before).toMatchObject({ stage: 'development', ownerAgentId: f.author.id });
    await expect(updateTask(f.ctx, f.head.id, f.task.id, { echelonStage: 'review', ownerAgentId: f.author.id })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('cannot review it') as unknown });
    expect(await f.detail()).toEqual(before);
  });
});

describe('a passing verdict on a route that still carries the old skip', () => {
  it('reopens Review at that verdict instead of moving on to Tests', async () => {
    const f = await legacy('security');
    const candidateId = (await f.detail()).candidateId;
    const moved = await verdict(f.ctx, f.security.id, f.task.id, pass(HEAD));
    expect(moved.task).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
    const state = await f.detail();
    expect(state).toMatchObject({ stage: 'review', phase: 'active', candidateId, ownerAgentId: f.reviewer.id });
    expect(state.stages.find(step => step.stage === 'security')).toMatchObject({ status: 'pending' });
    expect(state.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'active', reason: null });
    const [event] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'verdict'), eq(taskEvents.agentId, f.security.id)));
    expect(event?.data).toMatchObject({ pass: true, stage: 'security', reviewRequired: { candidateId } });
  });

  it('waits for independent Review even where the department normally allows unstaffed checks to skip', async () => {
    const f = await legacy('security');
    await f.db.update(departments).set({ templateKey: 'design' }).where(eq(departments.id, f.task.departmentId!));
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));

    const moved = await verdict(f.ctx, f.security.id, f.task.id, pass(HEAD));

    expect(moved.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    expect(await f.reviewStep()).toMatchObject({ status: 'pending', reason: 'eligible_owner_required' });
  });
});

describe('a Tests return on a route that used the old skip', () => {
  it('waits for independent Review on resubmission where the department normally allows unstaffed checks to skip', async () => {
    const f = await legacy('tests');
    const atTests = await f.detail();
    /* The old policy recorded the skip on the submission it let past Review. */
    const [submitted] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted'), eq(taskEvents.agentId, f.author.id)));
    await f.db.update(taskEvents).set({ data: { ...submitted!.data, authorCheckSkip: { receiptId: randomUUID(), candidateId: atTests.candidateId, reason: 'author_check_passed' } } })
      .where(eq(taskEvents.id, submitted!.id));
    await f.db.update(departments).set({ templateKey: 'design' }).where(eq(departments.id, f.task.departmentId!));
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    await report(f.ctx, f.tester.id, f.task.id, { done: false, summary: 'The source needs fixing.', verification: { candidateId: atTests.candidateId!, revision: atTests.revision, delta: 'logic/totals.ts: handle the empty input.' } });
    expect(await f.reviewStep()).toMatchObject({ status: 'pending', reason: null });
    f.atCommit(FIX);

    const moved = await submit(f.ctx, f.author.id, f.task.id, { ...code, summary: 'Handle the empty input.' });

    expect(moved.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(await f.detail()).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
    expect(await f.reviewStep()).toMatchObject({ status: 'pending', reason: 'eligible_owner_required' });
  });
});

describe('Review after a Tests return', () => {
  it('never goes to a reviewer who produced an earlier candidate of the task', async () => {
    const f = await fixture({ autoReviewer: true });
    const second = await f.hire('Second reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const { task } = await f.create({ small: true });
    const detail = async () => (await f.detail(task.id)).echelons;
    await submit(f.ctx, f.author.id, task.id, code);
    expect(await detail()).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
    await verdict(f.ctx, f.reviewer.id, task.id, { pass: false, reviewedCommit: HEAD, comment: 'Fixing a boundary.' });
    f.atCommit(FIX);
    await submit(f.ctx, f.reviewer.id, task.id, { ...code, summary: 'Fix the boundary.' });
    const atTests = await detail();
    expect(atTests.stage).toBe('tests');
    await report(f.ctx, f.tester.id, task.id, { done: false, summary: 'The source needs fixing.', verification: { candidateId: atTests.candidateId!, revision: atTests.revision, delta: 'logic/totals.ts: handle the empty input.' } });
    f.atCommit(LATER);
    const moved = await submit(f.ctx, f.author.id, task.id, { ...code, summary: 'Handle the empty input.' });
    expect(moved.task.assigneeAgentId).toBe(second.id);
    expect(await detail()).toMatchObject({ stage: 'review', ownerAgentId: second.id });
  });
});
