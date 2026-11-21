import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, approvalPolicies, departments, requests, taskEvents, teams } from '../src/db/schema.js';
import { answer, report } from '../src/modules/tasks/engine.js';
import { BASE } from './development-echelons-fixture.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { releasing, startTurnkeyWork } from './turn-release-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

/* H7 of #1686 (Cypher's verdict on #1623): above where its work started, the first-parent line of task-N was its holder's word.
   A holder who built on a commit of another task's branch that the turn never took, and named the turn's commit under it as
   its start, against the report's words, had that commit credited as checked. Now the server names, for a person, a credited
   commit that another task's branch holds and no accepted result of that task brought; and it notes where task-N already
   stood as the work started, so a start under that is refused. R is the checked candidate of the turn, at the head of the turn
   branch as the work starts. */
const UNACCEPTED = '2b'.repeat(20);
const ABOVE = '6f'.repeat(20);
const OWN = '3c'.repeat(20);
const LATER = '7a'.repeat(20);
const SEEDED = '8e'.repeat(20);
const OTHER = 'task-77777';

type Releasing = Awaited<ReturnType<typeof releasing>>;
type Commit = { sha: string; parents: string[] };

/* The repository once its branches went to their heads: each commit holds its parents and what they hold, and main at
   BASE..each commit is the commits that lead there. */
function lay(f: Releasing, commits: Commit[], heads: Record<string, string>): void {
  const all = [{ sha: f.R, parents: [BASE] }, ...commits];
  const holds = (sha: string): string[] => {
    const c = all.find(found => found.sha === sha);
    return c ? [...new Set(c.parents.flatMap(p => [p, ...holds(p)]))] : [];
  };
  for (const c of all) {
    f.repo.holds[c.sha] = holds(c.sha);
    f.repo.between[`${BASE}..${c.sha}`] = all.filter(other => other.sha === c.sha || f.repo.holds[c.sha]!.includes(other.sha));
  }
  Object.assign(f.repo.heads, heads);
}

/* A member of a turnkey team with a task of the turn's department, at work on it as the repository stands now. */
async function turnkeyTask(f: Releasing, name = 'Player') {
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: `Lane ${name}`, turnkey: true }).returning();
  const holder = await f.hire(name, 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: `Turnkey change of ${name}`, assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  await startTurnkeyWork(f, holder, task.id);
  const branch = `task-${task.number}`;
  const done = (commit: string, baseCommit: string) =>
    report(f.ctx, holder.id, task.id, { done: true, summary: 'Fast-forwarded the turn branch after my own review, security check and tests.', turnkey: { commit, baseCommit } });
  return { task, holder, branch, done };
}

const requireApproval = (f: Releasing) =>
  f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
const RULES = [
  ['under autonomous release', async (f: Releasing) => { await requireApproval(f); await f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!)); }],
  ['with no commit rule', async () => undefined],
  ['under a commit rule that requires approval', requireApproval],
] as const;

const onOther = (task: number, commit: string, branch = OTHER) =>
  `#${task}: ${commit} is also on ${branch}, and no accepted result of that task brought it, so the checks of #${task}'s holder do not cover it.`;
const card = async (f: Releasing) => (await f.db.select().from(requests).where(and(eq(requests.taskId, f.release.id), eq(requests.status, 'open'))).orderBy(desc(requests.createdAt)).limit(1))[0]!;

/* The release of commit as its head records it: where Hornhoof refuses it for a person, the person approves the card the release
   tools opened, and the head records it again. What came back each time. */
async function released(f: Releasing, commit: string) {
  const run = await f.fullRun({ commit });
  const first = await f.recordRelease({ commit, runId: run.id });
  if (!first.isError) return { first, last: first };
  const asked = await f.call('ask_person', { task: f.release.number, question: `Release turn ${f.turn.number}: main to ${commit}.`, commit });
  expect(asked.isError, asked.text).toBe(false);
  await answer(f.ctx, { personId: f.claude.ownerPersonId }, (await card(f)).id, { approve: true });
  return { first, last: await f.recordRelease({ commit, runId: run.id }) };
}

const recorded = (text: string) => JSON.parse(text) as { covered: boolean; uncovered: string[] };

describe('turnkey work built on a commit that another task\'s branch holds (H7 of #1686)', () => {
  describe.each(RULES)('%s', (_rule, rule) => {
    it('names the commit of the other branch it was built on, though its holder named the turn\'s commit under it (H5.1)', async () => {
      const f = await releasing();
      await rule(f);
      const work = await turnkeyTask(f);
      lay(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: OWN, parents: [UNACCEPTED] }], { [OTHER]: UNACCEPTED, [f.branch]: OWN, [work.branch]: OWN });
      await work.done(OWN, f.R);
      const { first, last } = await released(f, OWN);
      expect(first).toMatchObject({ isError: true });
      expect(first.text).toContain(onOther(work.task.number, UNACCEPTED));
      expect(recorded(last.text)).toMatchObject({ covered: false, uncovered: [onOther(work.task.number, UNACCEPTED)] });
    });

    it('names it where the other branch had it before the work started (H5.1b)', async () => {
      const f = await releasing();
      await rule(f);
      lay(f, [{ sha: UNACCEPTED, parents: [f.R] }], { [OTHER]: UNACCEPTED });
      const work = await turnkeyTask(f);
      lay(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: OWN, parents: [UNACCEPTED] }], { [OTHER]: UNACCEPTED, [f.branch]: OWN, [work.branch]: OWN });
      await work.done(OWN, f.R);
      const { first, last } = await released(f, OWN);
      expect(first.text).toContain(onOther(work.task.number, UNACCEPTED));
      expect(recorded(last.text)).toMatchObject({ covered: false, uncovered: [onOther(work.task.number, UNACCEPTED)] });
    });

    it('names every commit the other branch holds in the release, not only its head', async () => {
      const f = await releasing();
      await rule(f);
      const work = await turnkeyTask(f);
      lay(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: ABOVE, parents: [UNACCEPTED] }, { sha: OWN, parents: [ABOVE] }], { [OTHER]: ABOVE, [f.branch]: OWN, [work.branch]: OWN });
      await work.done(OWN, f.R);
      const { last } = await released(f, OWN);
      expect(recorded(last.text).uncovered.sort()).toEqual([onOther(work.task.number, UNACCEPTED), onOther(work.task.number, ABOVE)].sort());
    });

    /* Another task built on its checked commit (task-77778-follow-up), or went on from a commit of its line with work the
       release does not hold (task-77777): neither is a commit it built on. */
    it('keeps an honest holder\'s own line credited, though other tasks built on it', async () => {
      const f = await releasing();
      await rule(f);
      const work = await turnkeyTask(f);
      lay(f, [{ sha: OWN, parents: [f.R] }, { sha: LATER, parents: [OWN] }, { sha: UNACCEPTED, parents: [OWN] }], { [OTHER]: UNACCEPTED, 'task-77778-follow-up': LATER, [f.branch]: LATER, [work.branch]: LATER });
      await work.done(LATER, f.R);
      const { last } = await released(f, LATER);
      expect(last.isError, last.text).toBe(false);
      expect(recorded(last.text)).toMatchObject({ covered: true, uncovered: [] });
    });
  });

  /* Both started at R. The first landed its commit; the second built on it and named R, so its line holds the first's commit
     too, which the first's own accepted result brought. */
  it('names no commit that the accepted result of the task whose branch holds it brought', async () => {
    const f = await releasing();
    const first = await turnkeyTask(f, 'First');
    const second = await turnkeyTask(f, 'Second');
    lay(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: OWN, parents: [UNACCEPTED] }], { [f.branch]: UNACCEPTED, [first.branch]: UNACCEPTED, [second.branch]: OWN });
    await first.done(UNACCEPTED, f.R);
    f.repo.heads[f.branch] = OWN;
    await second.done(OWN, f.R);
    const { last } = await released(f, OWN);
    expect(last.isError, last.text).toBe(false);
    expect(recorded(last.text)).toMatchObject({ covered: true, uncovered: [] });
  });

  /* The first built on UNACCEPTED and honestly named UNACCEPTED as its start; the second built on the first and named R.
     Even with no third branch left, the first's own branch holds UNACCEPTED while its accepted line does not claim it,
     so the second cannot credit UNACCEPTED either. */
  it('still names an unaccepted commit under an earlier task when a later task names the turn commit beneath it', async () => {
    const f = await releasing();
    const first = await turnkeyTask(f, 'First');
    const second = await turnkeyTask(f, 'Second');
    lay(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: OWN, parents: [UNACCEPTED] }, { sha: LATER, parents: [OWN] }], { [f.branch]: OWN, [first.branch]: OWN, [second.branch]: LATER });
    await first.done(OWN, UNACCEPTED);
    f.repo.heads[f.branch] = LATER;
    await second.done(LATER, f.R);
    const { first: refused, last } = await released(f, LATER);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain(onOther(second.task.number, UNACCEPTED, first.branch));
    expect(recorded(last.text)).toMatchObject({ covered: false, uncovered: [onOther(second.task.number, UNACCEPTED, first.branch)] });
  });

  it('counts nothing of turnkey work as checked where the branches could not be read', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    lay(f, [{ sha: OWN, parents: [f.R] }], { [f.branch]: OWN, [work.branch]: OWN });
    await work.done(OWN, f.R);
    f.ctx.readBranches = async () => ({ problem: 'The repository could not be reached.' });
    const run = await f.fullRun({ commit: OWN });
    const refused = await f.recordRelease({ commit: OWN, runId: run.id });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain(`The commits of #${work.task.number} could not all be read.`);
    expect(refused.text).toContain(`${OWN} came in with no accepted candidate.`);
  });
});

describe('where task-N already stood as its work started', () => {
  it('is noted with the turn branch and main, and none is noted where task-N was not made yet', async () => {
    const f = await releasing();
    const fresh = await turnkeyTask(f, 'Fresh');
    const [freshStart] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, fresh.task.id), eq(taskEvents.kind, 'status')));
    expect(freshStart!.data).toMatchObject({ start: { turn: f.turn.number, turnHead: f.R, main: BASE, taskHead: null } });
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane Seeded', turnkey: true }).returning();
    const holder = await f.hire('Seeded', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
    const { task } = await f.create({ title: 'Turnkey change on a made branch', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
    lay(f, [{ sha: SEEDED, parents: [f.R] }], { [`task-${task.number}`]: SEEDED });
    await startTurnkeyWork(f, holder, task.id);
    const [started] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'status')));
    expect(started!.data).toMatchObject({ start: { turn: f.turn.number, turnHead: f.R, main: BASE, taskHead: SEEDED } });
  });

  it('refuses a start that does not hold it, and the commit task-N stood on goes to a person', async () => {
    const f = await releasing();
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
    const holder = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
    const { task } = await f.create({ title: 'Turnkey change on a made branch', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
    const branch = `task-${task.number}`;
    lay(f, [{ sha: SEEDED, parents: [f.R] }], { [branch]: SEEDED });
    await startTurnkeyWork(f, holder, task.id);
    lay(f, [{ sha: SEEDED, parents: [f.R] }, { sha: OWN, parents: [SEEDED] }], { [f.branch]: OWN, [branch]: OWN });
    const done = (baseCommit: string) => report(f.ctx, holder.id, task.id, { done: true, summary: 'Checked it myself.', turnkey: { commit: OWN, baseCommit } });
    await expect(done(f.R)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${f.R} does not hold ${SEEDED}, where ${branch} was as your work on #${task.number} started`) as unknown });
    await done(SEEDED);
    const { first, last } = await released(f, OWN);
    expect(first.text).toContain(`${SEEDED} came in with no accepted candidate.`);
    expect(recorded(last.text)).toMatchObject({ covered: false, uncovered: [`${SEEDED} came in with no accepted candidate.`] });
  });

  it('leaves the work unstarted where task-N could not be read as it started', async () => {
    const f = await releasing();
    const read = f.ctx.readCommit!;
    f.ctx.readCommit = async (at, want) => { if ('task' in want) throw new Error('The repository could not be reached.'); return read(at, want); };
    const work = await turnkeyTask(f);
    f.ctx.readCommit = read;
    const [started] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.task.id), eq(taskEvents.kind, 'status')));
    expect(started!.data).not.toHaveProperty('start');
  });

  it('leaves the work unstarted where a tag stands in the name of task-N as it started, and refuses that tag at hand-in (H1)', async () => {
    const f = await releasing();
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane Tagged', turnkey: true }).returning();
    const holder = await f.hire('Tagged', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
    const { task } = await f.create({ title: 'Turnkey change on a tagged name', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
    f.repo.tags[`task-${task.number}`] = SEEDED;
    await startTurnkeyWork(f, holder, task.id);
    const [started] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'status')));
    expect(started!.data).not.toHaveProperty('start');
    await expect(report(f.ctx, holder.id, task.id, { done: true, summary: 'Checked it myself.', turnkey: { commit: SEEDED, baseCommit: f.R } }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining(`The branch of #${task.number} could not be read`) as unknown });
  });
});
