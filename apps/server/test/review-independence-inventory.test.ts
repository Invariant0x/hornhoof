import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents, taskRoutes, tasks } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { reviewIndependenceInventory } from '../src/modules/tasks/review-independence.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const FIX = 'c'.repeat(40), LATER = 'f'.repeat(40);
const code = { summary: 'Change totals.', evidence: 'Named test.', review: { baseCommit: BASE } };

type Fixture = Awaited<ReturnType<typeof fixture>>;
type State = typeof taskRoutes.$inferSelect['state'];

async function changeState(f: Fixture, taskId: string, change: (state: State) => State): Promise<void> {
  const [route] = await f.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, taskId));
  await f.db.update(taskRoutes).set({ state: change(route!.state) }).where(eq(taskRoutes.taskId, taskId));
}

/* The old author-check skip as a route in flight before the switch-off still records it. */
const oldSkip = (state: State): State => ({ ...state, stages: state.stages.map(step => step.stage === 'review'
  ? { ...step, status: 'skipped' as const, reason: 'author_check_passed', inputCandidateId: state.candidateId, candidateId: null }
  : step) });

/* A task whose developer handed a candidate in and whose reviewer passed it, now at Tests. */
async function atTests(f: Fixture) {
  const { task } = await f.create({ small: true });
  f.atCommit(HEAD);
  await submit(f.ctx, f.author.id, task.id, code);
  await verdict(f.ctx, f.reviewer.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed.' });
  return { task, candidateId: (await f.detail(task.id)).echelons.candidateId! };
}

const everything = async (f: Fixture) => ({
  tasks: await f.db.select().from(tasks).orderBy(asc(tasks.id)),
  routes: await f.db.select().from(taskRoutes).orderBy(asc(taskRoutes.taskId)),
  events: await f.db.select().from(taskEvents).orderBy(asc(taskEvents.id)),
});

describe('the review independence inventory', () => {
  it('lists in-flight routes with the old skip or a Review by a producer of the lineage, and changes nothing', async () => {
    const f = await fixture();

    /* Before any candidate, the executor is the planned Review owner. */
    await changeState(f, f.task.id, state => ({ ...state, stages: state.stages.map(step => step.stage === 'review' ? { ...step, ownerAgentId: f.author.id } : step) }));

    const skipped = await atTests(f);
    await changeState(f, skipped.task.id, oldSkip);

    /* The original developer holds Review of its own candidate, as the old selection could leave it. */
    const current = await atTests(f);
    await changeState(f, current.task.id, state => ({ ...state, stages: state.stages.map(step => step.stage === 'review' ? { ...step, ownerAgentId: f.author.id } : step) }));

    /* A Review verdict recorded by the original developer on its own candidate. */
    const past = await atTests(f);
    await f.db.insert(taskEvents).values({ companyId: past.task.companyId, taskId: past.task.id, kind: 'verdict', agentId: f.author.id, text: 'Reviewed.',
      data: { pass: true, stage: 'review', candidateId: past.candidateId, reviewedCommit: HEAD } });

    /* Review fixed the developer's candidate and handed its fix on: a reviewer repairs what it received, so this is no finding. */
    const { task: repaired } = await f.create({ small: true });
    f.atCommit(HEAD);
    await submit(f.ctx, f.author.id, repaired.id, code);
    await verdict(f.ctx, f.reviewer.id, repaired.id, { pass: false, reviewedCommit: HEAD, comment: 'Fixing a boundary.' });
    f.atCommit(FIX);
    await submit(f.ctx, f.reviewer.id, repaired.id, { ...code, summary: 'Fix the boundary.' });
    expect((await f.detail(repaired.id)).echelons.stage).toBe('tests');

    /* Closed work keeps its record as it was and is not in flight. */
    const closed = await atTests(f);
    await changeState(f, closed.task.id, state => ({ ...oldSkip(state), phase: 'done' }));
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, closed.task.id));

    /* Security repaired the developer's candidate and Review reopened on the repair; the developer holds that Review, which
       checks a candidate grown from its own. */
    const { task: secured } = await f.create({ small: true, riskClass: 'security' });
    f.atCommit(HEAD);
    await submit(f.ctx, f.author.id, secured.id, code);
    await verdict(f.ctx, f.reviewer.id, secured.id, { pass: true, reviewedCommit: HEAD, comment: 'Reviewed.' });
    await changeState(f, secured.id, oldSkip);
    f.atCommit(FIX);
    await submit(f.ctx, f.security.id, secured.id, { ...code, summary: 'Repair in Security.' });
    const repair = (await f.detail(secured.id)).echelons;
    expect(repair).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id });
    await changeState(f, secured.id, state => ({ ...state, stages: state.stages.map(step => step.stage === 'review' ? { ...step, ownerAgentId: f.author.id } : step) }));

    /* Review repaired the developer's candidate, Tests returned it, and the developer's next candidate grew from that repair:
       the reviewer who repaired holds the Review of it, as the old selection would have left it. */
    const second = await f.hire('Second reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const { task: returned } = await f.create({ small: true });
    f.atCommit(HEAD);
    await submit(f.ctx, f.author.id, returned.id, code);
    await verdict(f.ctx, f.reviewer.id, returned.id, { pass: false, reviewedCommit: HEAD, comment: 'Fixing a boundary.' });
    f.atCommit(FIX);
    await submit(f.ctx, f.reviewer.id, returned.id, { ...code, summary: 'Fix the boundary.' });
    const back = (await f.detail(returned.id)).echelons;
    await report(f.ctx, f.tester.id, returned.id, { done: false, summary: 'The source needs fixing.', verification: { candidateId: back.candidateId!, revision: back.revision, delta: 'logic/totals.ts: handle the empty input.' } });
    f.atCommit(LATER);
    await submit(f.ctx, f.author.id, returned.id, { ...code, summary: 'Handle the empty input.' });
    const again = (await f.detail(returned.id)).echelons;
    expect(again).toMatchObject({ stage: 'review', ownerAgentId: second.id });
    await changeState(f, returned.id, state => ({ ...state, stages: state.stages.map(step => step.stage === 'review' ? { ...step, ownerAgentId: f.reviewer.id } : step) }));

    /* A Review verdict naming a candidate the task has no record of: every producer of the task counts. */
    const { task: unknown } = await f.create({ small: true });
    f.atCommit(HEAD);
    await submit(f.ctx, f.author.id, unknown.id, code);
    await verdict(f.ctx, f.reviewer.id, unknown.id, { pass: false, reviewedCommit: HEAD, comment: 'Fixing a boundary.' });
    f.atCommit(FIX);
    await submit(f.ctx, f.reviewer.id, unknown.id, { ...code, summary: 'Fix the boundary.' });
    const missing = '00000000-0000-4000-8000-000000000001';
    await f.db.insert(taskEvents).values({ companyId: unknown.companyId, taskId: unknown.id, kind: 'verdict', agentId: f.reviewer.id, text: 'Reviewed.',
      data: { pass: true, stage: 'review', candidateId: missing, reviewedCommit: FIX } });

    const before = await everything(f);
    const found = await reviewIndependenceInventory(f.db);
    expect(await everything(f)).toEqual(before);

    const row = (task: { id: string; number: number }, stage = 'tests', status = 'open') => ({ companyId: f.task.companyId, taskId: task.id, number: task.number, status, stage, phase: 'active' });
    expect(found).toEqual([
      { ...row(f.task, 'development'), oldReviewSkip: false, producerReviews: [{ agentId: f.author.id, candidateId: null, at: 'current' }] },
      { ...row(skipped.task), oldReviewSkip: true, producerReviews: [] },
      { ...row(current.task), oldReviewSkip: false, producerReviews: [{ agentId: f.author.id, candidateId: current.candidateId, at: 'current' }] },
      { ...row(past.task), oldReviewSkip: false, producerReviews: [{ agentId: f.author.id, candidateId: past.candidateId, at: 'past' }] },
      { ...row(secured, 'review', 'review'), oldReviewSkip: false, producerReviews: [{ agentId: f.author.id, candidateId: repair.candidateId, at: 'current' }] },
      { ...row(returned, 'review', 'review'), oldReviewSkip: false, producerReviews: [{ agentId: f.reviewer.id, candidateId: again.candidateId, at: 'current' }] },
      { ...row(unknown), oldReviewSkip: false, producerReviews: [{ agentId: f.reviewer.id, candidateId: missing, at: 'past' }] },
    ]);
  });

  it('finds nothing where every Review was independent', async () => {
    const f = await fixture();
    await atTests(f);
    expect(await reviewIndependenceInventory(f.db)).toEqual([]);
  });
});
