import { asc, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agents, subscriptions, tasks } from '../../src/db/schema.js';
import { idOnly, only } from '../../src/db/selections.js';
import { createTask, updateTask } from '../../src/modules/tasks/engine.js';
import { until } from '../helpers-basic.js';
import { backendPid, privatePostgres, runFixture, type PostgresFixture } from './helpers.js';

function waitingChecker(pg: PostgresFixture) {
  return async (pid: number, event?: string) => (await pg.admin.query<{ w: boolean }>(
    "SELECT (wait_event_type = 'Lock' AND ($2::text IS NULL OR wait_event = $2::text)) AS w FROM pg_stat_activity WHERE pid = $1",
    [pid, event ?? null],
  )).rows[0]?.w === true;
}

async function seedPlanners(pg: PostgresFixture, companyId: string, departmentId: string) {
  const [sub] = await pg.db.select(idOnly(subscriptions)).from(subscriptions);
  const [orchestrator, head] = await pg.db.insert(agents).values([
    { companyId, subscriptionId: sub!.id, kind: 'orchestrator', name: 'Orchestrator', roleKey: 'ORCH', model: '' },
    { companyId, subscriptionId: sub!.id, departmentId, kind: 'head', name: 'Head of development', roleKey: 'DEV-HEAD', model: '' },
  ]).returning();
  return { orchestrator: orchestrator!, head: head! };
}

it('numbers an independent part and a concurrent createTask without a duplicate task number', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [actorA, actorB] = fixture.actors;
  const { head } = await seedPlanners(pg, fixture.companyId, fixture.departmentId);
  const { task: parent } = await createTask(actorA.ctx, { agentId: head.id }, {
    title: 'Parent goal', brief: 'Coordinate', body: 'Coordinate', departmentId: fixture.departmentId, assigneeAgentId: head.id, resultKind: 'coordination',
  });
  const { task: api } = await createTask(actorA.ctx, { agentId: head.id }, {
    title: 'Checkout API', brief: 'API', body: 'API', departmentId: fixture.departmentId, parentId: parent.id, assigneeAgentId: actorA.job.agentId, executor: true,
  });
  const { task: docs } = await createTask(actorA.ctx, { agentId: head.id }, {
    title: 'Docs', brief: 'Docs', body: 'Docs', departmentId: fixture.departmentId, parentId: parent.id, assigneeAgentId: actorB.job.agentId, executor: true, after: [api.id], independentNone: 'Genuine dependency for the probe.',
  });

  const [pidA, pidB] = await Promise.all([backendPid(actorA.pool), backendPid(actorB.pool)]);
  expect(pidA).not.toBe(pidB);
  await pg.admin.query(`CREATE FUNCTION independent_number_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(886, 1);
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_independent_number_barrier BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION independent_number_barrier()`);
  const waiting = waitingChecker(pg);

  const barrier = await pg.pool('independent_number_barrier').connect();
  let created: Promise<unknown> | undefined;
  let changed: Promise<unknown> | undefined;
  try {
    await barrier.query('SELECT pg_advisory_lock(886, 1)');
    created = createTask(actorA.ctx, { agentId: head.id }, {
      title: 'Assigned task', brief: 'Fix', body: 'Fix', departmentId: fixture.departmentId, assigneeAgentId: actorA.job.agentId, executor: true, small: true,
    });
    void created.catch(() => {});
    await until(() => waiting(pidA, 'advisory'));
    changed = updateTask(actorB.ctx, head.id, docs.id, {
      independentPart: { title: 'Examples', brief: 'Independent.', body: 'Write examples.', executor: actorA.job.agentId },
    });
    void changed.catch(() => {});
    await until(() => waiting(pidB));
    await barrier.query('SELECT pg_advisory_unlock(886, 1)');

    const results = await Promise.allSettled([created, changed]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await pg.db.select(only(tasks, 'number')).from(tasks).where(eq(tasks.companyId, fixture.companyId)).orderBy(asc(tasks.number));
    expect(rows.map(r => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  } finally {
    try { await barrier.query('SELECT pg_advisory_unlock_all()'); } finally {
      barrier.release(true);
      await created?.catch(() => {});
      await changed?.catch(() => {});
    }
  }
});
