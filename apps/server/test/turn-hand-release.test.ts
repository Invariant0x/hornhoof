import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, teams, turns } from '../src/db/schema.js';
import { loadTask, report } from '../src/modules/tasks/engine.js';
import { releaseRound } from '../src/modules/tasks/releases.js';
import { BASE } from './development-echelons-fixture.js';
import { ownDatabases } from './helpers.js';
import { readyInTurn, releasing } from './turn-release-fixture.js';

ownDatabases();

/* Main as it was released by hand, tagged v1.7.0 with no release recorded with release_turn. */
const TAGGED = '1'.repeat(40);
/* The work of a holder of turnkey work, made on TAGGED, as its department went on from the tag. */
const OWN = '2'.repeat(40);
/* OWN with the turn branch taken into it. */
const JOINED = '0'.repeat(40);
/* The turn branch with main taken into it, which its head releases. */
const RELEASED = '7'.repeat(40);
/* A turn branch that went on past what a candidate holds. */
const PAST = 'e'.repeat(40);
/* A commit of another line, which holds nothing the turn started from. */
const OTHER = '3'.repeat(40);

type Refusal = { status: number; message: string };
const refusal = (moving: Promise<unknown>) => moving.then(() => null, (err: Refusal) => err);

/* A department whose open turn started at v1.6.0, then main went on by hand to TAGGED and was tagged v1.7.0 with no
   release recorded before main moved: the turn stays open, as nothing of it was released. With rewritten, the history the
   tag holds is not the turn branch's own, so the tag does not hold the head of the turn branch. A member of a turnkey team
   then did its work on the tag, on its own branch. */
async function handReleased(options: { rewritten: boolean }) {
  const f = await releasing();
  f.repo.tags['v1.6.0'] = BASE;
  await releaseRound(f.ctx);
  f.repo.holds[TAGGED] = options.rewritten ? [BASE] : [f.R, BASE];
  f.repo.heads.main = TAGGED;
  f.repo.tags['v1.7.0'] = TAGGED;
  await releaseRound(f.ctx);
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const holder = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: 'Turnkey change', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  f.repo.holds[OWN] = [TAGGED, ...f.repo.holds[TAGGED]!];
  f.repo.heads[`task-${task.number}`] = OWN;
  const done = () => report(f.ctx, holder.id, task.id, { done: true, summary: 'Joined task-N to the turn branch after my own review, security check and tests.', turnkey: { commit: f.repo.heads[`task-${task.number}`]!, baseCommit: TAGGED } });
  const open = async () => (await f.db.select().from(turns).where(and(eq(turns.departmentId, f.task.departmentId!), eq(turns.status, 'open'))))[0]!;
  return { ...f, holder, work: task, own: `task-${task.number}`, done, open };
}

describe('a holder refused after a release made by hand hears why the turn is open and what unblocks it', () => {
  it('names the tag without a release record, the step its head takes, and its own step: take the turn branch in first', async () => {
    const f = await handReleased({ rewritten: true });
    expect(await f.open()).toMatchObject({ id: f.turn.id, baseVersion: 'v1.6.0' });
    const refused = await refusal(f.done());
    expect(refused).toMatchObject({ status: 409 });
    for (const words of [
      `${f.branch} does not hold ${OWN}`,
      `Turn ${f.turn.number} is still open: v1.7.0 was tagged on ${TAGGED} with no release recorded with release_turn`,
      `take main into ${f.branch}`,
      `${f.own} does not hold ${f.R}, the head of ${f.branch}`,
      `take ${f.branch} into ${f.own} first, then fast-forward ${f.branch} to it and report done`,
    ]) expect(refused!.message).toContain(words);
    expect(refused!.message).not.toContain(`fast-forward ${f.branch} to ${f.own} first`);
    expect(await loadTask(f.db, f.work.id)).toMatchObject({ status: expect.not.stringMatching(/done/) as unknown, turnId: null });
    /* The step it names works: the turn branch taken into the work, then the turn branch fast-forwarded to it. */
    f.repo.holds[JOINED] = [OWN, f.R, ...f.repo.holds[OWN]!];
    f.repo.heads[f.own] = f.repo.heads[f.branch] = JOINED;
    expect((await f.done()).task).toMatchObject({ status: 'done', turnId: f.turn.id });
  });

  it('says to fast-forward the turn branch where the work holds its head, and records the completion once it does', async () => {
    const f = await handReleased({ rewritten: false });
    const refused = await refusal(f.done());
    expect(refused!.message).toContain(`v1.7.0 was tagged on ${TAGGED}`);
    expect(refused!.message).toContain(`fast-forward ${f.branch} to ${f.own} first, so the release takes it, then report done.`);
    expect(refused!.message).not.toContain('first, then fast-forward');
    f.repo.heads[f.branch] = OWN;
    expect((await f.done()).task).toMatchObject({ status: 'done', turnId: f.turn.id });
  });

  it('names a step for the head that releases the turn: main taken into the turn branch, its CI, release_turn and the tag', async () => {
    const f = await handReleased({ rewritten: true });
    f.repo.holds[RELEASED] = [f.R, TAGGED, BASE];
    f.repo.heads[f.branch] = RELEASED;
    await f.approve(RELEASED);
    expect(await f.recordRelease({ commit: RELEASED })).toMatchObject({ isError: false });
    f.repo.heads.main = RELEASED;
    f.repo.tags['v1.7.1'] = RELEASED;
    /* Before the minute round closes the turn on it, the tag of a recorded release is no tag made by hand. */
    const meanwhile = await refusal(f.done());
    expect(meanwhile!.message).toContain(`${f.branch} does not hold ${OWN}`);
    expect(meanwhile!.message).not.toContain('was tagged');
    await releaseRound(f.ctx);
    const next = await f.open();
    expect(next).toMatchObject({ baseVersion: 'v1.7.1', startCommit: RELEASED });
    expect(next.id).not.toBe(f.turn.id);
    /* The holder's work now goes into the next turn, and no tag holds it up any more. */
    const refused = await refusal(f.done());
    expect(refused!.message).toContain(`turn-${next.number} does not hold ${OWN}`);
    expect(refused!.message).not.toContain('was tagged');
  });

  it('names the tag of its own line only, and refuses as before, with no word of a tag, where there is none or the tags cannot be read', async () => {
    const f = await handReleased({ rewritten: false });
    /* A newer version tag that does not come from where the turn started is not of its line, as the minute round reads it. */
    f.repo.tags['v1.8.0'] = OTHER;
    const named = (await refusal(f.done()))!.message;
    expect(named).toContain(`v1.7.0 was tagged on ${TAGGED}`);
    expect(named).not.toContain('v1.8.0');
    delete f.repo.tags['v1.7.0'];
    expect((await refusal(f.done()))!.message).toBe(`${f.branch} does not hold ${OWN}: fast-forward ${f.branch} to ${f.own} first, so the release takes it, then report done.`);
    f.repo.tags['v1.7.0'] = TAGGED;
    f.ctx.readTags = async () => ({ problem: 'The repository could not be reached.' });
    expect((await refusal(f.done()))!.message).not.toContain('was tagged');
    f.ctx.readTags = async () => { throw new Error('The repository could not be reached.'); };
    expect((await refusal(f.done()))!.message).not.toContain('was tagged');
  });
});

describe('a head accepting a candidate into a turn left open by a tag made by hand', () => {
  it('hears the same of the tag, and to take the turn branch into the candidate and have it checked where it went on', async () => {
    const f = await readyInTurn();
    f.repo.tags['v1.6.0'] = BASE;
    await releaseRound(f.ctx);
    f.repo.holds[TAGGED] = [BASE];
    f.repo.heads.main = TAGGED;
    f.repo.tags['v1.7.0'] = TAGGED;
    await releaseRound(f.ctx);
    f.repo.holds[PAST] = [BASE];
    f.repo.heads[f.branch] = PAST;
    const refused = await refusal(f.accept());
    expect(refused).toMatchObject({ status: 409 });
    for (const words of [
      `${f.branch} does not hold ${f.finalCommit}`,
      `Turn ${f.turn.number} is still open: v1.7.0 was tagged on ${TAGGED}`,
      `the candidate does not hold ${PAST}, the head of ${f.branch}`,
      `take ${f.branch} into the candidate and have that checked`,
    ]) expect(refused!.message).toContain(words);
  });
});
