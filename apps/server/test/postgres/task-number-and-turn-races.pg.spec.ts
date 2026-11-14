import { asc, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agents, subscriptions, tasks, turns } from '../../src/db/schema.js';
import { cancel, createTask, updateTask } from '../../src/modules/tasks/engine.js';
import { mergeTurn, planTurn, settle } from '../../src/modules/tasks/turns.js';
import { until } from '../helpers-basic.js';
import { backendPid, privatePostgres, runFixture, type PostgresFixture } from './helpers.js';

function waitingChecker(pg: PostgresFixture) {
  return async (pid: number, event?: string) => (await pg.admin.query<{ w: boolean }>(
    "SELECT (wait_event_type = 'Lock' AND ($2::text IS NULL OR wait_event = $2::text)) AS w FROM pg_stat_activity WHERE pid = $1",
    [pid, event ?? null],
  )).rows[0]?.w === true;
}

async function seedPlanners(pg: PostgresFixture, companyId: string, departmentId: string) {
  const [sub] = await pg.db.select({ id: subscriptions.id }).from(subscriptions);
  const [orchestrator, head] = await pg.db.insert(agents).values([
    { companyId, subscriptionId: sub!.id, kind: 'orchestrator', name: 'Orchestrator', roleKey: 'ORCH', model: '' },
    { companyId, subscriptionId: sub!.id, departmentId, kind: 'head', name: 'Head of development', roleKey: 'DEV-HEAD', model: '' },
  ]).returning();
  return { orchestrator: orchestrator!, head: head! };
}

async function installCancelledEventBarrier(pg: PostgresFixture, key: number): Promise<void> {
  await pg.admin.query(`CREATE FUNCTION cancel_event_barrier_${key}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'cancelled' THEN
        PERFORM pg_advisory_xact_lock_shared(886, ${key});
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_cancel_event_barrier_${key} BEFORE INSERT ON task_events FOR EACH ROW EXECUTE FUNCTION cancel_event_barrier_${key}()`);
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
    const rows = await pg.db.select({ number: tasks.number }).from(tasks).where(eq(tasks.companyId, fixture.companyId)).orderBy(asc(tasks.number));
    expect(rows.map(r => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  } finally {
    try { await barrier.query('SELECT pg_advisory_unlock_all()'); } finally {
      barrier.release(true);
      await created?.catch(() => {});
      await changed?.catch(() => {});
    }
  }
});

it('keeps a concurrently cancelled planned root task in its source turn during mergeTurn', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [actorA, actorB] = fixture.actors;
  const { orchestrator } = await seedPlanners(pg, fixture.companyId, fixture.departmentId);
  const by = { companyId: fixture.companyId, agentId: orchestrator.id, jobId: actorA.job.id };
  const openMove = await planTurn(actorA.ctx, by, {
    department: fixture.departmentId, title: 'Open turn', goal: 'Run', mode: 'echelons',
    tasks: [{ title: 'Running work', brief: 'Run', body: 'Run' }],
  });
  const sourceMove = await planTurn(actorA.ctx, by, {
    department: fixture.departmentId, title: 'Planned source', goal: 'Merge later', mode: 'echelons',
    tasks: [
      { title: 'Cancelled planned root', brief: 'Drop', body: 'Drop' },
      { title: 'Kept planned root', brief: 'Move', body: 'Move' },
    ],
  });
  const [cancelledRoot, keptRoot] = await pg.db.select().from(tasks).where(eq(tasks.turnId, sourceMove.turn.id)).orderBy(asc(tasks.number));

  const [pidA, pidB] = await Promise.all([backendPid(actorA.pool), backendPid(actorB.pool)]);
  expect(pidA).not.toBe(pidB);
  await installCancelledEventBarrier(pg, 2);
  const waiting = waitingChecker(pg);

  const barrier = await pg.pool('merge_turn_barrier').connect();
  let cancelling: Promise<unknown> | undefined;
  let merging: Promise<unknown> | undefined;
  try {
    await barrier.query('SELECT pg_advisory_lock(886, 2)');
    cancelling = cancel(actorA.ctx, { agentId: orchestrator.id }, cancelledRoot!.id, 'Dropped before merge.');
    void cancelling.catch(() => {});
    await until(() => waiting(pidA, 'advisory'));
    merging = mergeTurn(actorB.ctx, { companyId: fixture.companyId, agentId: orchestrator.id }, sourceMove.turn.number, openMove.turn.number);
    void merging.catch(() => {});
    await until(() => waiting(pidB));
    await barrier.query('SELECT pg_advisory_unlock(886, 2)');

    await Promise.all([cancelling, merging]);
    const [afterCancelled] = await pg.db.select().from(tasks).where(eq(tasks.id, cancelledRoot!.id));
    const [afterKept] = await pg.db.select().from(tasks).where(eq(tasks.id, keptRoot!.id));
    expect(afterCancelled).toMatchObject({ status: 'cancelled', turnId: sourceMove.turn.id });
    expect(afterKept).toMatchObject({ status: 'open', turnId: openMove.turn.id });
  } finally {
    try { await barrier.query('SELECT pg_advisory_unlock_all()'); } finally {
      barrier.release(true);
      await cancelling?.catch(() => {});
      await merging?.catch(() => {});
    }
  }
});

it('closes a planned turn whose sole task is cancelled concurrently with settle and opens the following planned turn', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [actorA, actorB] = fixture.actors;
  const { orchestrator, head } = await seedPlanners(pg, fixture.companyId, fixture.departmentId);
  const by = { companyId: fixture.companyId, agentId: orchestrator.id, jobId: actorA.job.id };
  const firstMove = await planTurn(actorA.ctx, by, {
    department: fixture.departmentId, title: 'Turn one', goal: 'Finish', mode: 'echelons',
    tasks: [{ title: 'Closing root', brief: 'Finish', body: 'Finish' }],
  });
  const secondMove = await planTurn(actorA.ctx, by, {
    department: fixture.departmentId, title: 'Turn two', goal: 'Will be cancelled', mode: 'echelons',
    tasks: [{ title: 'Sole planned root', brief: 'Drop', body: 'Drop' }],
  });
  const thirdMove = await planTurn(actorA.ctx, by, {
    department: fixture.departmentId, title: 'Turn three', goal: 'Should start', mode: 'echelons',
    tasks: [{ title: 'Next planned root', brief: 'Start', body: 'Start' }],
  });
  const [closingRoot] = await pg.db.select().from(tasks).where(eq(tasks.turnId, firstMove.turn.id));
  const [solePlanned] = await pg.db.select().from(tasks).where(eq(tasks.turnId, secondMove.turn.id));
  const [nextPlanned] = await pg.db.select().from(tasks).where(eq(tasks.turnId, thirdMove.turn.id));
  const closedFirst = await cancel(actorA.ctx, { agentId: orchestrator.id }, closingRoot!.id, 'Finished first turn.');

  const [pidA, pidB] = await Promise.all([backendPid(actorA.pool), backendPid(actorB.pool)]);
  expect(pidA).not.toBe(pidB);
  await installCancelledEventBarrier(pg, 3);
  const waiting = waitingChecker(pg);

  const barrier = await pg.pool('settle_turn_barrier').connect();
  let cancelling: Promise<unknown> | undefined;
  let settling: Promise<Awaited<ReturnType<typeof settle>>> | undefined;
  try {
    await barrier.query('SELECT pg_advisory_lock(886, 3)');
    cancelling = cancel(actorA.ctx, { agentId: orchestrator.id }, solePlanned!.id, 'Cancelled before turn two opened.');
    void cancelling.catch(() => {});
    await until(() => waiting(pidA, 'advisory'));
    settling = settle(actorB.ctx, closedFirst.task);
    void settling.catch(() => {});
    await until(() => waiting(pidB));
    await barrier.query('SELECT pg_advisory_unlock(886, 3)');

    const [, settled] = await Promise.all([cancelling, settling]);
    const turnRows = await pg.db.select({ number: turns.number, status: turns.status }).from(turns).where(eq(turns.companyId, fixture.companyId)).orderBy(asc(turns.number));
    expect(turnRows).toEqual([
      { number: firstMove.turn.number, status: 'closed' },
      { number: secondMove.turn.number, status: 'closed' },
      { number: thirdMove.turn.number, status: 'open' },
    ]);
    const [startedNext] = await pg.db.select().from(tasks).where(eq(tasks.id, nextPlanned!.id));
    expect(startedNext).toMatchObject({ status: 'open', assigneeAgentId: head.id });
    expect(settled?.note).toContain(`Turn ${thirdMove.turn.number}`);
  } finally {
    try { await barrier.query('SELECT pg_advisory_unlock_all()'); } finally {
      barrier.release(true);
      await cancelling?.catch(() => {});
      await settling?.catch(() => {});
    }
  }
});
