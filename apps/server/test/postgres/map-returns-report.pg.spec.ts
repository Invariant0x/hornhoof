import { and, eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentEvents, agents, jobs, machines, mapReturns, nodes, people, programDeliveries, subscriptions, tasks, teams } from '../../src/db/schema.js';
import { idOnly } from '../../src/db/selections.js';
import { appendTurnEvent } from '../../src/modules/events/store.js';
import { workStarts } from '../../src/modules/org/map-state.js';
import { reserveDelivery } from '../../src/modules/program-operator/deliveries.js';
import { createTask, report } from '../../src/modules/tasks/engine.js';
import { until } from '../helpers-basic.js';
import { RECORDED } from '../recorded-fixture.js';
import { backendPid, privatePostgres, runFixture } from './helpers.js';

async function installReportAndEventBarriers(pg: Awaited<ReturnType<typeof privatePostgres>>): Promise<void> {
  await pg.admin.query(`CREATE FUNCTION map_returns_report_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.returned_epoch IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock_shared(885, 2);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_map_returns_report_barrier BEFORE UPDATE ON map_returns FOR EACH ROW EXECUTE FUNCTION map_returns_report_barrier();
    CREATE FUNCTION turn_event_company_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'tool' THEN
        PERFORM pg_advisory_xact_lock_shared(885, 1);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_turn_event_company_barrier BEFORE INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION turn_event_company_barrier()`);
}

/* Waits for a state while the work it races still runs: when that work ends first, as when the report is refused, the test
   fails at once with what ended it instead of waiting for a state that can no longer come. */
async function whileRunning(running: Promise<unknown>, check: () => Promise<boolean>): Promise<void> {
  let ended: { error: unknown } | null = null;
  void running.then(() => { ended = { error: new Error('The report and the event ended before the barrier held them.') }; }, (error: unknown) => { ended = { error }; });
  await until(async () => {
    if (ended) throw ended.error;
    return check();
  });
}

it('commits the first subtask report in a running turn alongside its live tool event without deadlocking on map_returns', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [actorA, actorB] = fixture.actors;
  const [sub] = await pg.db.select(idOnly(subscriptions)).from(subscriptions);
  const [, head] = await pg.db.insert(agents).values([
    { companyId: fixture.companyId, subscriptionId: sub!.id, kind: 'orchestrator', name: 'Orchestrator', roleKey: 'ORCH', model: '' },
    { companyId: fixture.companyId, subscriptionId: sub!.id, departmentId: fixture.departmentId, kind: 'head', name: 'Head of development', roleKey: 'DEV-HEAD', model: '' },
  ]).returning();
  const { task: parent } = await createTask(actorA.ctx, { agentId: head!.id }, {
    title: 'Parent goal', brief: 'Coordinate', body: 'Coordinate', departmentId: fixture.departmentId, assigneeAgentId: head!.id, resultKind: 'coordination',
  });
  /* Its holder is in a turnkey team, so the subtask closes with its own report, not through Review and Tests. */
  const [team] = await pg.db.insert(teams).values({ companyId: fixture.companyId, departmentId: fixture.departmentId, name: 'Lane', turnkey: true }).returning();
  await pg.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, actorA.job.agentId));
  const { task: child } = await createTask(actorA.ctx, { agentId: head!.id }, {
    title: 'Child turnkey fix', brief: 'Fix bug', body: 'Fix bug', departmentId: fixture.departmentId, parentId: parent.id, assigneeAgentId: actorA.job.agentId, executor: true, small: true,
  });
  await pg.db.update(jobs).set({ taskId: child.id }).where(eq(jobs.id, actorA.job.id));
  await actorA.ctx.db.transaction(tx => workStarts(tx, { id: actorA.job.id, companyId: fixture.companyId, agentId: actorA.job.agentId, taskIds: [child.id] }));

  const [pidA, pidB] = await Promise.all([backendPid(actorA.pool), backendPid(actorB.pool)]);
  expect(pidA).not.toBe(pidB);
  await installReportAndEventBarriers(pg);

  const barrier = await pg.pool('report_barrier').connect();
  let pending: Promise<[Awaited<ReturnType<typeof report>>, boolean]> | undefined;
  try {
    await barrier.query('SELECT pg_advisory_lock(885, 1), pg_advisory_lock(885, 2)');
    pending = Promise.all([
      report(actorA.ctx, actorA.job.agentId, child.id, { done: true, summary: 'Verified on first report.', recorded: RECORDED }),
      appendTurnEvent(actorB.ctx, actorA.job.id, { kind: 'tool', name: 'report', input: '{"task":4}' }, sql`true`),
    ]);
    void pending.catch(() => {});
    await whileRunning(pending, async () => (await pg.admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND wait_event = 'advisory'",
      [[pidA, pidB]],
    )).rows.length === 2);
    await barrier.query('SELECT pg_advisory_unlock(885, 2)');
    await whileRunning(pending, async () => (await pg.admin.query<{ waiting: boolean }>(
      "SELECT (wait_event_type = 'Lock' AND wait_event = 'advisory') AS waiting FROM pg_stat_activity WHERE pid = $1",
      [pidA],
    )).rows[0]?.waiting !== true);
    await barrier.query('SELECT pg_advisory_unlock(885, 1)');

    const [moved] = await pending;
    expect(moved.task.status).toBe('done');
    const [line] = await pg.db.select().from(mapReturns).where(and(
      eq(mapReturns.companyId, fixture.companyId),
      eq(mapReturns.upstreamAgentId, head!.id),
      eq(mapReturns.downstreamAgentId, actorA.job.agentId),
    ));
    expect(line).toMatchObject({ workEpoch: 1, returnedEpoch: 1, sourceJobId: actorA.job.id, sourceTaskId: child.id });
    expect(await pg.db.select().from(agentEvents).where(eq(agentEvents.jobId, actorA.job.id))).toHaveLength(1);
  } finally {
    try { await barrier.query('SELECT pg_advisory_unlock_all()'); } finally {
      barrier.release(true);
      await pending?.catch(() => {});
    }
  }
});

it('commits head createTask alongside concurrent agent delivery reservation without company-agent lock deadlock', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [actorA, actorB] = fixture.actors;
  const [person] = await pg.db.select(idOnly(people)).from(people);
  const [sub] = await pg.db.select(idOnly(subscriptions)).from(subscriptions);
  const [head] = await pg.db.insert(agents).values({
    companyId: fixture.companyId, subscriptionId: sub!.id, departmentId: fixture.departmentId, kind: 'head', name: 'Head of development', roleKey: 'DEV-HEAD', model: '',
  }).returning();
  const [machine] = await pg.db.insert(machines).values({
    companyId: fixture.companyId, personId: person!.id, machineKey: 'fixture-machine', hostname: 'fixture-node', os: 'linux', arch: 'x64',
  }).returning();
  const [node] = await pg.db.insert(nodes).values({
    companyId: fixture.companyId, machineId: machine!.id, subscriptionId: sub!.id, status: 'ready',
  }).returning();
  await pg.db.update(jobs).set({ nodeId: node!.id }).where(eq(jobs.id, actorA.job.id));

  const [pidA, pidB] = await Promise.all([backendPid(actorA.pool), backendPid(actorB.pool)]);
  expect(pidA).not.toBe(pidB);
  await pg.admin.query(`CREATE FUNCTION create_task_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(885, 3);
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_create_task_barrier BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION create_task_barrier();
    CREATE FUNCTION delivery_company_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock_shared(885, 4);
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_delivery_company_barrier BEFORE INSERT ON program_deliveries FOR EACH ROW EXECUTE FUNCTION delivery_company_barrier()`);

  const barrier = await pg.pool('create_barrier').connect();
  let pending: Promise<[Awaited<ReturnType<typeof createTask>>, Awaited<ReturnType<typeof reserveDelivery>>]> | undefined;
  try {
    await barrier.query('SELECT pg_advisory_lock(885, 3), pg_advisory_lock(885, 4)');
    pending = Promise.all([
      createTask(actorA.ctx, { agentId: head!.id }, {
        title: 'Assigned task', brief: 'Fix', body: 'Fix', departmentId: fixture.departmentId, assigneeAgentId: actorA.job.agentId, executor: true, small: true,
      }),
      reserveDelivery(actorB.ctx.db, {
        companyId: fixture.companyId, agentId: actorA.job.agentId, jobId: actorA.job.id, nodeId: node!.id, kind: 'live', words: 'Go on.', reference: 'live:1',
      }),
    ]);
    void pending.catch(() => {});
    await until(async () => (await pg.admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND wait_event = 'advisory'",
      [[pidA, pidB]],
    )).rows.length === 2);
    await barrier.query('SELECT pg_advisory_unlock(885, 3)');
    await until(async () => (await pg.admin.query<{ waiting: boolean }>(
      "SELECT (wait_event_type = 'Lock' AND wait_event = 'advisory') AS waiting FROM pg_stat_activity WHERE pid = $1",
      [pidA],
    )).rows[0]?.waiting !== true);
    await barrier.query('SELECT pg_advisory_unlock(885, 4)');

    const [created, delivery] = await pending;
    expect(created.task.assigneeAgentId).toBe(actorA.job.agentId);
    expect(delivery.ordinal).toBe(1);
    expect(await pg.db.select().from(programDeliveries).where(eq(programDeliveries.id, delivery.id))).toHaveLength(1);
    expect(await pg.db.select().from(tasks).where(eq(tasks.id, created.task.id))).toHaveLength(1);
  } finally {
    try { await barrier.query('SELECT pg_advisory_unlock_all()'); } finally {
      barrier.release(true);
      await pending?.catch(() => {});
    }
  }
});
