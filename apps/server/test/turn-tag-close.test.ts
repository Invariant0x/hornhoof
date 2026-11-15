import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { tasks, turnSnapshots, turns, waitNotices } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { loadTask } from '../src/modules/tasks/engine.js';
import { pipelineReport } from '../src/modules/tasks/pipeline-report.js';
import { BASE } from './development-echelons-fixture.js';
import { ownDatabases } from './helpers.js';
import { releasing } from './turn-release-fixture.js';

ownDatabases();

const LATER = '4'.repeat(40);
const OTHER = '3'.repeat(40);

/* A turn whose start the server has seen, its release recorded before main moved, then main moved and tagged. */
async function released(options: { record?: boolean; tag?: string; at?: string } = {}) {
  const f = await releasing();
  const errors: string[] = [];
  const round = () => minuteRound(f.ctx, new Date(), what => () => { errors.push(what); });
  f.repo.tags['v1.6.0'] = BASE;
  await round();
  const run = await f.fullRun();
  await f.approve();
  if (options.record !== false) expect((await f.recordRelease({ runId: run.id })).isError).toBe(false);
  f.repo.heads.main = f.R;
  f.repo.tags[options.tag ?? 'v1.7.0'] = options.at ?? f.R;
  const departmentTurns = () => f.db.select().from(turns).where(eq(turns.departmentId, f.task.departmentId!)).orderBy(asc(turns.number));
  const open = async () => (await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open'))))[0]!;
  /* Another result of the turn, accepted after its release was recorded. */
  const lateResult = async () => {
    const { task } = await f.create({ title: 'Late change' });
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId: f.turn.id }).where(eq(tasks.id, task.id));
    return task;
  };
  return { ...f, round, errors, departmentTurns, open, lateResult };
}

describe('the server closes a turn by the tag of its release', () => {
  it('takes the newest tag as where a turn starts on its first look, and closes nothing', async () => {
    const f = await releasing();
    f.repo.tags['v1.5.0'] = '2'.repeat(40);
    f.repo.tags['v1.6.0'] = BASE;
    await minuteRound(f.ctx, new Date(), () => () => undefined);
    expect(await f.openTurn()).toMatchObject({ id: f.turn.id, baseVersion: 'v1.6.0', baseCommit: BASE });
  });

  it('closes the turn on the tag of its recorded release and moves what the release left out to the next turn', async () => {
    const f = await released();
    const late = await f.lateResult();
    f.repo.heads[f.branch] = LATER;
    f.repo.holds[LATER] = [f.R, ...f.repo.holds[f.R]!];
    await f.round();
    const [closed, next] = await f.departmentTurns().then(rows => rows.filter(row => row.number >= f.turn.number));
    expect(closed).toMatchObject({ id: f.turn.id, status: 'closed', version: 'v1.7.0', commit: f.R });
    expect(closed!.closedAt).not.toBeNull();
    expect(next).toMatchObject({ status: 'open', baseVersion: 'v1.7.0', baseCommit: f.R, startCommit: LATER });
    expect(next!.number).toBeGreaterThan(f.turn.number);
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ turnId: f.turn.id });
    expect(await loadTask(f.db, late.id)).toMatchObject({ turnId: next!.id });
  });

  it('keeps the snapshot of the turn its tag closes, before the next one opens', async () => {
    const f = await released();
    await f.round();
    const [closed, next] = await f.departmentTurns().then(rows => rows.filter(row => row.number >= f.turn.number));
    const [snapshot] = await f.db.select().from(turnSnapshots).where(eq(turnSnapshots.turnId, closed!.id));
    expect(snapshot).toMatchObject({ companyId: f.task.companyId, source: 'closed' });
    expect(snapshot!.facts.whole.tasks.total).toBe(1);
    expect(snapshot!.createdAt.getTime()).toBeLessThanOrEqual(next!.openedAt!.getTime());
    expect(await f.db.select().from(turnSnapshots).where(eq(turnSnapshots.turnId, next!.id))).toEqual([]);
    /* And the CEO hears once what is on record of the release. */
    expect((await f.db.select().from(waitNotices)).filter(n => n.dedupKey.startsWith(`turn_summary:${closed!.id}:`))).toHaveLength(1);
  });

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

  it('does nothing more on a tag it already closed a turn by', async () => {
    const f = await released();
    await f.round();
    await f.round();
    const rows = await f.departmentTurns();
    expect(rows.filter(row => row.version === 'v1.7.0')).toHaveLength(1);
    expect(rows.filter(row => row.status === 'open')).toHaveLength(1);
  });

  it.each([
    ['with no recorded release', { record: false }],
    ['of another commit than the recorded release', { at: OTHER }],
    ['older than where the turn started', { tag: 'v1.5.9' }],
    ['not named as a version', { tag: 'nightly' }],
  ])('leaves the turn open on a tag %s', async (_what, options) => {
    const f = await released(options);
    f.repo.holds[OTHER] = [BASE];
    await f.round();
    expect(await f.open()).toMatchObject({ id: f.turn.id, status: 'open' });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ turnId: f.turn.id });
  });

  it('leaves the turn open on a tag that does not come from where the turn started', async () => {
    const f = await releasing();
    f.repo.tags['v1.6.0'] = OTHER;
    await minuteRound(f.ctx, new Date(), () => () => undefined);
    const run = await f.fullRun();
    await f.approve();
    await f.recordRelease({ runId: run.id });
    f.repo.heads.main = f.R;
    f.repo.tags['v1.7.0'] = f.R;
    await minuteRound(f.ctx, new Date(), () => () => undefined);
    expect(await f.openTurn()).toMatchObject({ id: f.turn.id });
  });

  it('waits a minute when a result joins the turn while the repository is read, then starts the next turn from a head that holds it', async () => {
    const f = await released();
    let late: Awaited<ReturnType<typeof f.lateResult>> | null = null;
    const read = f.ctx.readCommit;
    f.ctx.readCommit = async (repo, want) => {
      const at = await read(repo, want);
      if (!late && 'branch' in want && want.branch === f.branch) {
        late = await f.lateResult();
        f.repo.heads[f.branch] = LATER;
        f.repo.holds[LATER] = [f.R, ...f.repo.holds[f.R]!];
      }
      return at;
    };
    await f.round();
    expect(late).not.toBeNull();
    expect(await f.open()).toMatchObject({ id: f.turn.id });
    await f.round();
    const next = await f.open();
    expect(next).toMatchObject({ startCommit: LATER });
    expect(next.id).not.toBe(f.turn.id);
    expect(await loadTask(f.db, late!.id)).toMatchObject({ turnId: next.id });
  });
});
