import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents, taskRoutes, tasks } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { reviewIndependenceInventory } from '../src/modules/tasks/review-independence.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const FIX = 'c'.repeat(40);
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

    const before = await everything(f);
    const found = await reviewIndependenceInventory(f.db);
    expect(await everything(f)).toEqual(before);

    const row = (task: { id: string; number: number }) => ({ companyId: f.task.companyId, taskId: task.id, number: task.number, status: 'open', stage: 'tests', phase: 'active' });
    expect(found).toEqual([
      { ...row(skipped.task), oldReviewSkip: true, producerReviews: [] },
      { ...row(current.task), oldReviewSkip: false, producerReviews: [{ agentId: f.author.id, candidateId: current.candidateId, at: 'current' }] },
      { ...row(past.task), oldReviewSkip: false, producerReviews: [{ agentId: f.author.id, candidateId: past.candidateId, at: 'past' }] },
    ]);
  });

  it('finds nothing where every Review was independent', async () => {
    const f = await fixture();
    await atTests(f);
    expect(await reviewIndependenceInventory(f.db)).toEqual([]);
  });
});
