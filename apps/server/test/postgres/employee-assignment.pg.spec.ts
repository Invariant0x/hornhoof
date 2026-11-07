import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agentChanges, agentEvents, agents, jobs } from '../../src/db/schema.js';
import { setAssignment } from '../../src/modules/agents/assignment.js';
import type { ToolJob } from '../../src/modules/tools/job.js';
import { backendPid, privatePostgres, runFixture } from './helpers.js';

it('commits both concurrent assignments by one head to different workers without losing either audit record', async () => {
  const pg = await privatePostgres();
  const fixture = await runFixture(pg);
  const [head] = await pg.db.insert(agents).values({ companyId: fixture.companyId, departmentId: fixture.departmentId, kind: 'head', name: 'Assignment head', roleKey: 'DEV-HEAD', model: '' }).returning();
  const job: ToolJob = { ...fixture.actors[0].job, agentId: head!.id, agentKind: 'head', roleKey: 'DEV-HEAD' };
  await pg.db.update(jobs).set({ agentId: head!.id }).where(eq(jobs.id, job.id));
  const pids = await Promise.all(fixture.actors.map(actor => backendPid(actor.pool)));
  expect(new Set(pids).size).toBe(2);

  /* The last AFTER trigger waits after the FK has taken KEY SHARE on the head. Both calls reach that real boundary. */
  await pg.admin.query(`CREATE FUNCTION assignment_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind = 'applied' AND NEW.data->>'action' = 'set_employee_assignment' THEN
        PERFORM pg_advisory_xact_lock_shared(707, 707);
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER zz_assignment_barrier AFTER INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION assignment_barrier()`);
  const barrier = await pg.pool('assignment_barrier').connect();
  let pending: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    await barrier.query('SELECT pg_advisory_lock(707, 707)');
    pending = Promise.allSettled(fixture.actors.map((actor, index) => setAssignment(actor.ctx, job, { employee: actor.job.agentId, assignment: `Assignment ${index + 1}` })));
    await expect.poll(async () => {
      const rows = await pg.admin.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type = 'Lock' AND wait_event = 'advisory'", [pids]);
      return rows.rows;
    }, { timeout: 3000, interval: 10 }).toHaveLength(2);
    await barrier.query('SELECT pg_advisory_unlock(707, 707)');
    const results = await pending;
    expect(results).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
    for (const [index, actor] of fixture.actors.entries()) {
      const [worker] = await pg.db.select().from(agents).where(eq(agents.id, actor.job.agentId));
      expect(worker!.overrides.base).toBe(`Assignment ${index + 1}`);
      expect(await pg.db.select().from(agentChanges).where(eq(agentChanges.agentId, actor.job.agentId))).toMatchObject([{ field: 'prompt', after: { base: `Assignment ${index + 1}` } }]);
    }
    const events = await pg.db.select().from(agentEvents).where(eq(agentEvents.agentId, head!.id));
    expect(events).toHaveLength(2);
    expect(events.map(event => (event.data as { employee: string }).employee).sort()).toEqual(fixture.actors.map(actor => actor.job.agentId).sort());
  } finally {
    try { await barrier.query('SELECT pg_advisory_unlock_all()'); } finally {
      barrier.release(true);
      await pending;
    }
  }
});
