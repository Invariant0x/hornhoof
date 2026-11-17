import { and, asc, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { agents, approvalPolicies, departments, tasks, testRuns, turnSnapshots, turns, waitNotices } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { loadTask } from '../src/modules/tasks/engine.js';
import { pipelineReport } from '../src/modules/tasks/pipeline-report.js';
import { deliverWaitNotices } from '../src/modules/tasks/wait-notices.js';
import { BASE } from './development-echelons-fixture.js';
import { as, ownDatabases } from './helpers.js';
import { releasing, turnkeyAfterR } from './turn-release-fixture.js';

ownDatabases();

const LATER = '4'.repeat(40);
const OTHER = '3'.repeat(40);

/* A turn whose start the server has seen, its release recorded before main moved, then main moved and tagged. */
async function released(options: { approval?: boolean; record?: boolean; tag?: string; at?: string; autonomous?: boolean; turnkey?: boolean } = {}) {
  const f = await releasing();
  const errors: string[] = [];
  const round = () => minuteRound(f.ctx, new Date(), what => () => { errors.push(what); });
  f.repo.tags['v1.6.0'] = BASE;
  await round();
  /* turnkey: the release also brings turnkey work its holder checked itself, joined to the turn branch after R. */
  const work = options.turnkey ? await turnkeyAfterR(f) : null;
  const commit = work?.head ?? f.R;
  const run = await f.fullRun({ commit });
  /* With autonomous release on, a release every commit of which was checked is approved by the log, by no person. */
  if (options.autonomous) {
    await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
    await f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!));
  } else if (options.approval !== false) await f.approve(commit);
  if (options.record !== false) expect((await f.recordRelease({ commit, runId: run.id })).isError).toBe(false);
  f.repo.heads.main = commit;
  f.repo.tags[options.tag ?? 'v1.7.0'] = options.at ?? commit;
  const departmentTurns = () => f.db.select().from(turns).where(eq(turns.departmentId, f.task.departmentId!)).orderBy(asc(turns.number));
  const open = async () => (await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open'))))[0]!;
  /* Another result of the turn, accepted after its release was recorded. */
  const lateResult = async () => {
    const { task } = await f.create({ title: 'Late change' });
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId: f.turn.id }).where(eq(tasks.id, task.id));
    return task;
  };
  return { ...f, round, errors, departmentTurns, open, lateResult, run, work, commit };
}

describe('the server closes a turn by the tag of its release', () => {
  it('closes a recorded release without an approval card when the department has no commit rule', async () => {
    const f = await released({ approval: false });
    await f.round();
    expect(await f.departmentTurns()).toContainEqual(expect.objectContaining({ id: f.turn.id, status: 'closed', commit: f.R }));
  });

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

  it('makes the branch of the next turn from the head of the one released, which it keeps as where the next one starts', async () => {
    const f = await released();
    f.repo.heads[f.branch] = LATER;
    f.repo.holds[LATER] = [f.R, ...f.repo.holds[f.R]!];
    await f.round();
    const next = await f.open();
    expect(next).toMatchObject({ startCommit: LATER, baseCommit: f.R });
    expect(f.repo.made).toEqual([{ branch: `turn-${next.number}`, commit: LATER }]);
    expect(f.repo.heads[f.branch]).toBe(LATER);
    expect(f.repo.heads.main).toBe(f.R);
    await f.round();
    expect(f.repo.made).toHaveLength(1);
  });

  it('leaves the branch of the next turn as it is when somebody made it already', async () => {
    const f = await released();
    const [{ last }] = await f.db.select({ last: sql<number>`max(${turns.number})` }).from(turns).where(eq(turns.companyId, f.task.companyId)) as [{ last: number }];
    f.repo.heads[`turn-${Number(last) + 1}`] = OTHER;
    await f.round();
    const next = await f.open();
    expect(next.number).toBe(Number(last) + 1);
    expect(f.repo.heads[`turn-${next.number}`]).toBe(OTHER);
    expect(f.repo.made).toBeUndefined();
    expect(next).toMatchObject({ startCommit: f.R });
  });

  it('closes the turn even when the branch of the next one cannot be made, and says why in the log', async () => {
    const f = await released();
    const warned: string[] = [];
    const warn = f.ctx.log.warn.bind(f.ctx.log);
    f.ctx.log.warn = ((...args: Parameters<typeof warn>) => { warned.push(String(args.at(-1))); return warn(...args); }) as typeof warn;
    f.repo.refusing = 'Hornhoof could not create the branch in https://github.com/acme/app.git: it answered 403, so its token may not push to it.';
    await f.round();
    const next = await f.open();
    expect(await f.db.select().from(turns).where(eq(turns.id, f.turn.id)).then(rows => rows[0])).toMatchObject({ status: 'closed', version: 'v1.7.0' });
    expect(f.repo.heads[`turn-${next.number}`]).toBeUndefined();
    expect(warned.join('\n')).toMatch(new RegExp(`turn-${next.number}.*403`));
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
    /* And the CEO hears once what is on record of the release, on a card that names the turn and its version. */
    expect((await f.db.select().from(waitNotices)).filter(n => n.dedupKey.startsWith(`turn_summary:${closed!.id}:`))).toHaveLength(1);
    await deliverWaitNotices(f.ctx);
    const cards = (await f.app.inject({ method: 'GET', url: '/api/wait-cards', ...as(f.ceoToken) })).json().cards;
    expect(cards).toEqual([expect.objectContaining({ about: 'turn_summary', taskId: f.task.id, turn: { number: f.turn.number, version: 'v1.7.0' }, tag: null })]);
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

  /* What the head of the department and the CEO were told of a version tag that released nothing. */
  const toldOfTag = async (f: Awaited<ReturnType<typeof released>>) => (await f.db.select().from(waitNotices)).filter(n => n.dedupKey.startsWith('release_tag:'));

  it.each<[string, { record?: boolean; at?: string }]>([
    ['with no recorded release', { record: false }],
    ['of another commit than the recorded release', { at: OTHER }],
  ])('tells the head of the department and the CEO once of a tag %s, and counts none of the turn as released', async (_what, options) => {
    const f = await released(options);
    f.repo.holds[OTHER] = [BASE];
    const at = options.at ?? f.R;
    await f.round();
    await f.round();
    expect(await f.open()).toMatchObject({ id: f.turn.id, status: 'open' });
    expect(await loadTask(f.db, f.task.id)).toMatchObject({ turnId: f.turn.id });
    const told = await toldOfTag(f);
    expect(told.map(n => n.agentId ?? n.personId).sort()).toEqual([f.head.id, f.claude.ownerPersonId].sort());
    const head = told.find(n => n.agentId === f.head.id)!;
    expect(head.message.notification).toEqual({ source: 'release_tag', tasks: [{ id: f.task.id, number: f.task.number }] });
    for (const words of ['v1.7.0', at, `Turn ${f.turn.number} stays open`, 'release_turn']) expect(head.message.text).toContain(words);
    const card = told.find(n => n.personId)!;
    expect(card.guard).toMatchObject({ turn: { id: f.turn.id, taskId: f.task.id }, tag: { version: 'v1.7.0', commit: at } });
    expect(card.message.text).toContain('not counted as released');
    /* The CEO sees it among their cards. */
    await deliverWaitNotices(f.ctx);
    const cards = (await f.app.inject({ method: 'GET', url: '/api/wait-cards', ...as(f.ceoToken) })).json().cards;
    expect(cards).toEqual([expect.objectContaining({ about: 'release_tag', taskId: f.task.id, number: f.task.number, turn: { number: f.turn.number, version: null }, tag: { version: 'v1.7.0', why: 'unrecorded' } })]);
  });

  it('tells them too when the full run its record relied on failed since, and keeps the turn open', async () => {
    const f = await released();
    await f.db.update(testRuns).set({ status: 'failed' }).where(eq(testRuns.id, f.run.id));
    await f.round();
    expect(await f.open()).toMatchObject({ id: f.turn.id });
    const told = await toldOfTag(f);
    expect(told).toHaveLength(2);
    expect(told.find(n => n.agentId)!.message.text).toContain('no longer stands');
    expect(told.find(n => n.personId)!.guard.tag).toEqual({ version: 'v1.7.0', commit: f.R, why: 'stale' });
  });

  it('closes the turn on the tag of a release the autonomous release log approved', async () => {
    const f = await released({ autonomous: true });
    await f.round();
    expect((await f.departmentTurns()).find(row => row.id === f.turn.id)).toMatchObject({ status: 'closed', version: 'v1.7.0', commit: f.R });
    expect(await toldOfTag(f)).toEqual([]);
  });

  it.each([
    ['the department turned autonomous release off', async (f: Awaited<ReturnType<typeof released>>) => { await f.db.update(departments).set({ autonomousRelease: false }).where(eq(departments.id, f.task.departmentId!)); }],
    ['a checker it relied on was switched off', async (f: Awaited<ReturnType<typeof released>>) => { await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id)); }],
  ])('keeps the turn of an autonomously approved release open, and tells them, when %s before the tag', async (_what, change) => {
    const f = await released({ autonomous: true });
    await change(f);
    await f.round();
    expect(await f.open()).toMatchObject({ id: f.turn.id, status: 'open' });
    const told = await toldOfTag(f);
    expect(told).toHaveLength(2);
    expect(told.find(n => n.personId)!.guard.tag).toEqual({ version: 'v1.7.0', commit: f.R, why: 'stale' });
  });

  it('closes the turn on the tag of an autonomous release that brings turnkey work its holder checked itself', async () => {
    const f = await released({ autonomous: true, turnkey: true });
    await f.round();
    expect((await f.departmentTurns()).find(row => row.id === f.turn.id)).toMatchObject({ status: 'closed', version: 'v1.7.0', commit: f.commit });
    expect(await loadTask(f.db, f.work!.task.id)).toMatchObject({ turnId: f.turn.id });
    expect(await toldOfTag(f)).toEqual([]);
  });

  it('keeps the turn of an autonomous release of turnkey work open, and tells them, when its holder was switched off before the tag', async () => {
    const f = await released({ autonomous: true, turnkey: true });
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.work!.holder.id));
    await f.round();
    expect(await f.open()).toMatchObject({ id: f.turn.id, status: 'open' });
    expect((await toldOfTag(f)).find(n => n.personId)!.guard.tag).toEqual({ version: 'v1.7.0', commit: f.commit, why: 'stale' });
  });

  it('tells nobody of a tag that releases its turn, of an older one or of one not named as a version', async () => {
    for (const options of [{}, { tag: 'v1.5.9' }, { tag: 'nightly' }]) {
      const f = await released(options);
      await f.round();
      expect(await toldOfTag(f)).toEqual([]);
    }
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
