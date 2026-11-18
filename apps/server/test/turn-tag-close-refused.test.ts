import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { turnSnapshots, turns } from '../src/db/schema.js';
import { pipelineReport } from '../src/modules/tasks/pipeline-report.js';
import { ownDatabases } from './helpers.js';
import { released } from './turn-tag-close-fixture.js';

/* A trigger here refuses the snapshot of a turn, which changes more than rows, so each test opens a database of its own. */
ownDatabases();

describe('the server closes a turn by the tag of its release', () => {
  it('never keeps a turn from closing over its snapshot: the failure is logged and the turn rebuilds when it is read', async () => {
    const f = await released();
    await f.db.execute(sql`create function refuse_snapshot() returns trigger language plpgsql as $$ begin raise exception 'no snapshots'; end $$`);
    await f.db.execute(sql`create trigger no_snapshots before insert on turn_snapshots for each row execute function refuse_snapshot()`);
    const logged = vi.spyOn(f.ctx.log, 'error');
    await f.round();
    expect((await f.db.select().from(turns).where(eq(turns.id, f.turn.id)))[0]).toMatchObject({ status: 'closed', version: 'v1.7.0' });
    expect(await f.db.select().from(turnSnapshots)).toEqual([]);
    expect(logged.mock.calls.some(([, text]) => String(text).includes('snapshot'))).toBe(true);
    await f.db.execute(sql`drop trigger no_snapshots on turn_snapshots`);
    expect((await pipelineReport(f.db, f.task.companyId, f.turn.number)).turn).toMatchObject({ number: f.turn.number, source: 'rebuilt' });
  });
});
