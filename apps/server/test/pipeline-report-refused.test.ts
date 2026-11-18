import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { turnSnapshots } from '../src/db/schema.js';
import { departmentPipeline, pipelineReport } from '../src/modules/tasks/pipeline-report.js';
import { setLease, ownDatabases } from './helpers.js';
import { company, closedTurn } from './pipeline-report-fixture.js';

/* A trigger here refuses the snapshot of a turn, and a test ends the lease of the database: a truncate undoes neither, so each test opens a database of its own. */
ownDatabases();

describe('the snapshot of a turn', () => {
  it('answers when the database refuses to keep it, as on a copy that may only read, and keeps it at a later read', async () => {
    const c = await company();
    const { seven } = await closedTurn(c);
    await c.db.execute(sql`create function refuse_snapshot() returns trigger language plpgsql as $$ begin raise exception 'only reads here'; end $$`);
    await c.db.execute(sql`create trigger no_snapshots before insert on turn_snapshots for each row execute function refuse_snapshot()`);

    const report = await pipelineReport(c.db, c.companyId, 7);
    expect(report.turn).toMatchObject({ number: 7, status: 'closed', source: 'rebuilt' });
    expect(await c.db.select().from(turnSnapshots)).toEqual([]);
    /* Read inside a transaction, as a tool reads, the refusal leaves that transaction to go on. */
    const inside = await c.db.transaction(async tx => ({ read: await pipelineReport(tx, c.companyId, 7), kept: await tx.select().from(turnSnapshots) }));
    expect(inside.read.turn).toMatchObject({ number: 7, source: 'rebuilt' });
    expect(inside.kept).toEqual([]);

    await c.db.execute(sql`drop trigger no_snapshots on turn_snapshots`);
    await pipelineReport(c.db, c.companyId, 7);
    const [kept] = await c.db.select().from(turnSnapshots).where(eq(turnSnapshots.turnId, seven.id));
    expect(kept!.source).toBe('rebuilt');
  });
  it('answers on a machine that does not lead, whose database refuses the write only as it commits, and keeps it once it leads', async () => {
    const c = await company();
    const { seven } = await closedTurn(c);
    await setLease(c.db, { until: '-infinity' });

    const report = await pipelineReport(c.db, c.companyId, 7);
    expect(report.turn).toMatchObject({ number: 7, status: 'closed', source: 'rebuilt' });
    expect((await departmentPipeline(c.db, c.companyId, c.dev.id, 7)).turn).toMatchObject({ number: 7, source: 'rebuilt' });
    expect(await c.db.select().from(turnSnapshots)).toEqual([]);

    await setLease(c.db, { until: 'infinity' });
    await pipelineReport(c.db, c.companyId, 7);
    const [kept] = await c.db.select().from(turnSnapshots).where(eq(turnSnapshots.turnId, seven.id));
    expect(kept!.source).toBe('rebuilt');
  });
});
