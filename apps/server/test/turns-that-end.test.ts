import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { departments, tasks, turns } from '../src/db/schema.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { closeIdleTurns } from '../src/modules/tasks/turn-ends.js';
import { BASE } from './development-echelons-fixture.js';
import { releasing, serve, type Repository } from './turn-release-fixture.js';
import { call, company, text } from './turns-company.js';

/* A turn closes on the tag of its release. One that holds nothing for a release, of a department whose work is all done or
   cancelled and whose branch holds nothing main lacks, could never end that way: Hornhoof closes it by itself, with no version,
   and says so. One that holds accepted work never closes but by its release. Rows as Hornhoof keeps them on 18 Nov: Marketing's
   turn 24 with every task done or cancelled, Design's turn 30 with none, Operations' turn 28 holding #1323 accepted into it. */

const MAIN = 'a'.repeat(40);
const AHEAD = 'b'.repeat(40);
const SHOP = 'https://github.com/acme/shop.git';

async function setting() {
  const c = await company();
  const repo: Repository = { heads: { main: MAIN }, tags: {}, holds: { [AHEAD]: [MAIN] }, between: {}, cut: new Set() };
  serve(c.ctx, repo);
  const open = async (departmentId: string, number: number) =>
    (await c.db.insert(turns).values({ companyId: c.companyId, departmentId, number, goal: 'The next release.', status: 'open', openedAt: new Date() }).returning())[0]!;
  /* A task of a department as its work ended or goes on: in no turn, or accepted into one. */
  const work = async (departmentId: string, assigneeAgentId: string, status: 'done' | 'cancelled' | 'working', turnId: string | null = null, parentId?: string) => {
    const { task } = await createTask(c.ctx, { personId: c.ceo.id }, { title: 'Work', brief: '', body: '', departmentId, assigneeAgentId, parentId });
    const ended = status !== 'working';
    await c.db.update(tasks).set({ status, turnId, closedAt: ended ? new Date() : null, assigneeAgentId: ended ? null : assigneeAgentId }).where(eq(tasks.id, task.id));
    return task;
  };
  const keepsShop = () => c.db.update(departments).set({ repoUrl: SHOP }).where(eq(departments.id, c.dev.id));
  const row = async (id: string) => (await c.db.select().from(turns).where(eq(turns.id, id)))[0]!;
  return { ...c, repo, open, work, keepsShop, row };
}

const closedByItself = { status: 'closed', version: null, commit: null, closedBecause: expect.stringMatching(/^Hornhoof closed it by itself: /) };

describe('a turn that holds nothing for a release closes by itself', () => {
  it('closes, with no version and saying why, the turn of a department without a repository whose tasks are all done or cancelled, and one with no tasks', async () => {
    const s = await setting();
    const marketing = await s.open(s.sales.id, 24);
    const design = await s.open(s.design.id, 30);
    await s.work(s.sales.id, s.sara.id, 'done');
    await s.work(s.sales.id, s.sara.id, 'cancelled');
    await closeIdleTurns(s.ctx);
    expect(await s.row(marketing.id)).toMatchObject(closedByItself);
    expect(await s.row(design.id)).toMatchObject(closedByItself);
    expect((await s.row(marketing.id)).closedAt).not.toBeNull();
    expect((await s.row(marketing.id)).closedBecause).toBe('Hornhoof closed it by itself: every task of its department was done or cancelled, no result was accepted into it, and its department keeps no repository, so it had nothing to release.');
    expect((await s.get(s.ceoToken, `/api/turns/current?department=${s.sales.id}`)).json().turn).toBeNull();
    const listed = JSON.parse(text(await call(await s.tools(s.orchestrator), 'turns', {}))) as { number: number; status: string; closedBecause?: string }[];
    expect(listed.find(t => t.number === 24)).toMatchObject({ status: 'closed', closedBecause: (await s.row(marketing.id)).closedBecause });
  });

  it('closes the turn of a department with a repository whose work is all done when its branch holds nothing main lacks, or it has no branch', async () => {
    const s = await setting();
    await s.keepsShop();
    const turn = await s.open(s.dev.id, 31);
    await s.work(s.dev.id, s.hana.id, 'done');
    s.repo.heads['turn-31'] = MAIN;
    await closeIdleTurns(s.ctx);
    expect(await s.row(turn.id)).toMatchObject({ ...closedByItself, closedBecause: 'Hornhoof closed it by itself: every task of its department was done or cancelled, no result was accepted into it, and main holds everything turn-31 holds, so it had nothing to release.' });
    const branchless = await s.open(s.dev.id, 32);
    await closeIdleTurns(s.ctx);
    expect(await s.row(branchless.id)).toMatchObject({ ...closedByItself, closedBecause: expect.stringContaining('turn-32 is not in the repository') });
  });
});

describe('a turn that may still be released stays open', () => {
  it('keeps the turn holding a result accepted into it and not in main, as Operations\' turn 28 holds #1323, and one holding one main has, which only its release closes', async () => {
    const s = await setting();
    await s.keepsShop();
    const turn = await s.open(s.dev.id, 28);
    s.repo.heads['turn-28'] = AHEAD;
    const parent = await s.work(s.dev.id, s.hana.id, 'working');
    await s.work(s.dev.id, s.bruno.id, 'done', turn.id, parent.id);
    await s.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, parent.id));
    await closeIdleTurns(s.ctx);
    expect(await s.row(turn.id)).toMatchObject({ status: 'open', closedBecause: null });
    /* main went to the turn's head with no release recorded: the turn waits for its release, as a tag made by hand leaves it. */
    s.repo.heads.main = AHEAD;
    await closeIdleTurns(s.ctx);
    expect(await s.row(turn.id)).toMatchObject({ status: 'open', closedBecause: null });
  });

  it("keeps the turn whose branch holds what main lacks, whose department's work goes on, or whose repository cannot be read", async () => {
    const s = await setting();
    await s.keepsShop();
    const ahead = await s.open(s.dev.id, 41);
    s.repo.heads['turn-41'] = AHEAD;
    const going = await s.open(s.sales.id, 42);
    await s.work(s.sales.id, s.sara.id, 'done');
    await s.work(s.sales.id, s.sara.id, 'working');
    await closeIdleTurns(s.ctx);
    expect(await s.row(ahead.id)).toMatchObject({ status: 'open' });
    expect(await s.row(going.id)).toMatchObject({ status: 'open' });
    s.repo.heads['turn-41'] = MAIN;
    s.ctx.readBranches = async () => ({ problem: 'GitHub is not answering.' });
    await closeIdleTurns(s.ctx);
    expect(await s.row(ahead.id)).toMatchObject({ status: 'open' });
  });
});

describe('a release still closes its turn by its tag', () => {
  it('closes the turn on the tag of its recorded release with its version, and the next one stays open while the work of the release goes on', async () => {
    const f = await releasing();
    const round = () => minuteRound(f.ctx, new Date(), () => () => undefined);
    f.repo.tags['v1.6.0'] = BASE;
    await round();
    const run = await f.fullRun();
    await f.approve();
    expect((await f.recordRelease({ runId: run.id })).isError).toBe(false);
    f.repo.heads.main = f.R;
    f.repo.tags['v1.7.0'] = f.R;
    await round();
    await round();
    const [released, next] = await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!))).orderBy(asc(turns.number)).then(rows => rows.filter(row => row.number >= f.turn.number));
    expect(released).toMatchObject({ id: f.turn.id, status: 'closed', version: 'v1.7.0', commit: f.R, closedBecause: null });
    expect(next).toMatchObject({ status: 'open', baseVersion: 'v1.7.0', closedBecause: null });
  });
});
