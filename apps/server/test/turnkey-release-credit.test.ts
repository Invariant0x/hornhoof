import { and, desc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, approvalPolicies, departments, jobs, requests, taskEvents, teams } from '../src/db/schema.js';
import { answer, report } from '../src/modules/tasks/engine.js';
import { BASE } from './development-echelons-fixture.js';
import { mcp } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { releasing, startTurnkeyWork } from './turn-release-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

/* The shapes of B1 in #1569: turnkey work was credited with every commit down the first parents of the commit its branch was at
   as its holder reported, so a commit someone else made under that, or on top of it before the report, reached main as checked.
   R is the checked candidate of the turn, at the head of the turn branch before the turnkey work. */
const FOREIGN = '1'.repeat(40);
const OWN = '4'.repeat(40);
const ON_TOP = '9'.repeat(40);
const TAKEN_IN = '3'.repeat(40);
const JOIN = 'd'.repeat(40);

type Releasing = Awaited<ReturnType<typeof releasing>>;
type Commit = { sha: string; parents: string[] };

/* Says what the repository holds once the turn branch and task-N went to their heads: each commit holds its parents and
   what they hold, and main at BASE..each head is the commits that lead there. */
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

/* A member of a turnkey team with a task of the turn's department, at work on it as the turn branch stands now, before its
   holder reports it. */
async function turnkeyTask(f: Releasing) {
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const holder = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: 'Turnkey change', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  await startTurnkeyWork(f, holder, task.id);
  const branch = `task-${task.number}`;
  const done = (checked?: { commit: string; baseCommit: string }) =>
    report(f.ctx, holder.id, task.id, { done: true, summary: 'Fast-forwarded the turn branch after my own review, security check and tests.', ...(checked ? { turnkey: checked } : {}) });
  return { task, holder, branch, done };
}

/* 1. A commit pushed straight to the turn branch on R, and turnkey work its holder branched from the turn there and took in
      by fast-forward. */
async function strayUnder(f: Releasing) {
  const work = await turnkeyTask(f);
  lay(f, [{ sha: FOREIGN, parents: [f.R] }, { sha: OWN, parents: [FOREIGN] }], { [f.branch]: OWN, [work.branch]: OWN });
  await work.done({ commit: OWN, baseCommit: FOREIGN });
  return { ...work, release: OWN };
}

/* 2. Turnkey work built on a commit of another agent's branch the turn never took, then taken in by fast-forward. */
async function unacceptedUnder(f: Releasing) {
  const work = await turnkeyTask(f);
  lay(f, [{ sha: FOREIGN, parents: [f.R] }, { sha: OWN, parents: [FOREIGN] }], { 'task-other': FOREIGN, [f.branch]: OWN, [work.branch]: OWN });
  await work.done({ commit: OWN, baseCommit: FOREIGN });
  return { ...work, release: OWN };
}

/* 3. The holder checked OWN and fast-forwarded the turn branch to it; before it reported, a commit was pushed on top of it to
      both task-N and the turn branch. */
async function pushedOnTop(f: Releasing) {
  const work = await turnkeyTask(f);
  lay(f, [{ sha: OWN, parents: [f.R] }, { sha: ON_TOP, parents: [OWN] }], { [f.branch]: ON_TOP, [work.branch]: ON_TOP });
  await work.done({ commit: OWN, baseCommit: f.R });
  return { ...work, release: ON_TOP };
}

/* The take-in shape: the holder took the turn branch, with a commit pushed straight to it, into task-N, then fast-forwarded the
   turn branch to that merge. The commit came in through the merge's other side. */
async function takenInOverStray(f: Releasing) {
  const work = await turnkeyTask(f);
  lay(f, [{ sha: OWN, parents: [f.R] }, { sha: FOREIGN, parents: [f.R] }, { sha: TAKEN_IN, parents: [OWN, FOREIGN] }], { [f.branch]: TAKEN_IN, [work.branch]: TAKEN_IN });
  await work.done({ commit: TAKEN_IN, baseCommit: f.R });
  return { ...work, release: TAKEN_IN };
}

/* What the report tool asks the holder to name as turnkey.baseCommit. */
async function contractOfStart(f: Releasing): Promise<string> {
  const tool = (await f.client.listTools()).tools.find(found => found.name === 'report')!;
  const turnkey = (tool.inputSchema.properties as Record<string, { properties: Record<string, { description: string }> }>).turnkey!;
  return `${tool.description}\n${turnkey.properties.baseCommit!.description}`;
}

/* 2, as #1579 found it: built on a commit of another agent's branch the turn never took, with the start named as the report
      contract says: the commit right under the holder's first own commit, which is that commit, not the turn's. */
async function unacceptedNamedByContract(f: Releasing) {
  const contract = await contractOfStart(f);
  expect(contract).toContain('the commit right under your first own commit');
  expect(contract).not.toMatch(/commit of main or the turn branch/);
  return unacceptedUnder(f);
}

/* 4. A commit pushed straight to the turn branch before the work started: the holder branched from it, and a start named
      under it is refused, as the server noted the turn branch there when the work started. */
async function strayBeforeStart(f: Releasing) {
  lay(f, [{ sha: FOREIGN, parents: [f.R] }], { [f.branch]: FOREIGN });
  const work = await turnkeyTask(f);
  lay(f, [{ sha: FOREIGN, parents: [f.R] }, { sha: OWN, parents: [FOREIGN] }], { [f.branch]: OWN, [work.branch]: OWN });
  await expect(work.done({ commit: OWN, baseCommit: f.R })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${f.R} does not hold ${FOREIGN}, where ${f.branch} was as your work on #${work.task.number} started`) as unknown });
  await work.done({ commit: OWN, baseCommit: FOREIGN });
  return { ...work, release: OWN };
}

const requireApproval = (f: Releasing) =>
  f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
const rules = [
  ['under autonomous release', async (f: Releasing) => { await requireApproval(f); await f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!)); }],
  ['with no commit rule', async () => undefined],
  ['under a commit rule that requires approval', requireApproval],
] as const;
const recorded = (text: string) => JSON.parse(text) as Record<string, unknown>;
const card = async (f: Releasing) => (await f.db.select().from(requests).where(and(eq(requests.taskId, f.release.id), eq(requests.status, 'open'))).orderBy(desc(requests.createdAt)).limit(1))[0]!;

describe('a release credits turnkey work with only the first-parent line from the commit its holder checked to where it started', () => {
  describe.each(rules)('%s', (_rule, rule) => {
    it.each([
      ['a commit pushed straight to the turn branch under it, taken in by fast-forward', strayUnder, FOREIGN],
      ["a commit of another agent's branch it was built on", unacceptedUnder, FOREIGN],
      ["a commit of another agent's branch it was built on, with the start named as the report contract says", unacceptedNamedByContract, FOREIGN],
      ['a commit pushed straight to the turn branch before its work started, refusing a start named under it', strayBeforeStart, FOREIGN],
      ['a commit pushed on top of the commit its holder checked, before the report', pushedOnTop, ON_TOP],
      ['a commit pushed straight to the turn branch that its holder took in by a merge', takenInOverStray, FOREIGN],
    ])('names %s, and records the release only once a person approved the card that names it', async (_shape, shape, foreign) => {
      const f = await releasing();
      await rule(f);
      const work = await shape(f);
      const run = await f.fullRun({ commit: work.release });
      const refused = await f.recordRelease({ commit: work.release, runId: run.id });
      expect(refused).toMatchObject({ isError: true });
      expect(refused.text).toContain(`${foreign} came in with no accepted candidate.`);
      const asked = await f.call('ask_person', { task: f.release.number, question: `Release turn ${f.turn.number}: main to ${work.release}.`, commit: work.release });
      expect(asked.isError).toBe(false);
      await answer(f.ctx, { personId: f.claude.ownerPersonId }, (await card(f)).id, { approve: true });
      const result = await f.recordRelease({ commit: work.release, runId: run.id });
      expect(recorded(result.text)).toMatchObject({ autonomousReleaseId: null, covered: false, uncovered: [`${foreign} came in with no accepted candidate.`] });
    });
  });

  it('still covers every commit on the first-parent line of the checked commit by its holder\'s own checks', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const SECOND = '2'.repeat(40);
    lay(f, [{ sha: OWN, parents: [f.R] }, { sha: SECOND, parents: [OWN] }], { [f.branch]: SECOND, [work.branch]: SECOND });
    await work.done({ commit: SECOND, baseCommit: f.R });
    const run = await f.fullRun({ commit: SECOND });
    const result = await f.recordRelease({ commit: SECOND, runId: run.id });
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: null, covered: true, uncovered: [], tasks: expect.arrayContaining([expect.objectContaining({ number: work.task.number, commit: SECOND })]) as unknown });
  });

  it('names a merge made on the turn branch that joined the work there, as it is on no first-parent line of a checked commit', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    lay(f, [{ sha: OWN, parents: [f.R] }, { sha: FOREIGN, parents: [f.R] }, { sha: JOIN, parents: [FOREIGN, OWN] }], { [f.branch]: JOIN, [work.branch]: OWN });
    await work.done({ commit: OWN, baseCommit: f.R });
    const run = await f.fullRun({ commit: JOIN });
    const refused = await f.recordRelease({ commit: JOIN, runId: run.id });
    expect(refused.text).toContain(`${JOIN} is a merge made outside every checked candidate.`);
    expect(refused.text).toContain(`${FOREIGN} came in with no accepted candidate.`);
  });

  it('counts nothing of turnkey work whose report named no commit it checked, as before this was asked', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    lay(f, [{ sha: OWN, parents: [f.R] }], { [f.branch]: OWN, [work.branch]: OWN });
    await work.done({ commit: OWN, baseCommit: f.R });
    const [closed] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.task.id), eq(taskEvents.kind, 'report')));
    const integration = { ...(closed!.data.integration as Record<string, unknown>) };
    delete integration.start;
    await f.db.update(taskEvents).set({ data: { ...closed!.data, integration } }).where(eq(taskEvents.id, closed!.id));
    const run = await f.fullRun({ commit: OWN });
    const refused = await f.recordRelease({ commit: OWN, runId: run.id });
    expect(refused.text).toContain(`#${work.task.number} was closed before turnkey work named the commit its holder checked and where it started, so none of its commits counts as checked.`);
    expect(refused.text).toContain(`${OWN} came in with no accepted candidate.`);
  });

  it('counts nothing of turnkey work whose start the server could not note as it began', async () => {
    const f = await releasing();
    const read = f.ctx.readCommit;
    f.ctx.readCommit = async () => { throw new Error('The repository could not be reached.'); };
    const work = await turnkeyTask(f);
    f.ctx.readCommit = read;
    lay(f, [{ sha: OWN, parents: [f.R] }], { [f.branch]: OWN, [work.branch]: OWN });
    await work.done({ commit: OWN, baseCommit: f.R });
    const run = await f.fullRun({ commit: OWN });
    const refused = await f.recordRelease({ commit: OWN, runId: run.id });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain(`#${work.task.number}: where this turnkey work started is not on record, so none of its commits counts as checked.`);
    expect(refused.text).toContain(`${OWN} came in with no accepted candidate.`);
  });
});

/* H1 of #1569: a tag of the turn branch's name, as a ref written where the branch was deleted, holds no release. */
describe('the turn branch of a release', () => {
  it('is read by branch alone: a tag of its name in place of the branch is no release of it', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    f.repo.tags[f.branch] = f.R;
    delete f.repo.heads[f.branch];
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining(`${f.branch} does not hold ${f.R}, or it could not be read`) as unknown });
  });
});

describe('the report that closes turnkey work', () => {
  it('names the commit its holder checked and where its branch started, and keeps both', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    lay(f, [{ sha: OWN, parents: [f.R] }], { [f.branch]: OWN, [work.branch]: OWN });
    await expect(work.done()).rejects.toMatchObject({ status: 400, message: expect.stringContaining('turnkey.commit') as unknown });
    await work.done({ commit: OWN, baseCommit: f.R });
    const [closed] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.task.id), eq(taskEvents.kind, 'report')));
    expect(closed!.data).toMatchObject({ done: true, integration: { branch: f.branch, commit: OWN, start: f.R, workStart: f.R, from: work.branch } });
  });

  it('is refused for a commit its own branch does not hold, or one that does not hold the commit named as its start', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    lay(f, [{ sha: OWN, parents: [f.R] }, { sha: FOREIGN, parents: [f.R] }], { [f.branch]: OWN, [work.branch]: OWN });
    await expect(work.done({ commit: FOREIGN, baseCommit: f.R })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${work.branch} is at ${OWN}, which does not hold ${FOREIGN}`) as unknown });
    await expect(work.done({ commit: OWN, baseCommit: FOREIGN })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${OWN} does not hold ${FOREIGN}`) as unknown });
    expect((await f.detail(work.task.id)).status).not.toBe('done');
  });

  it('notes where the turn branch and main were as the work started, and holds a start named later than that', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const [started] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.task.id), eq(taskEvents.kind, 'status')));
    expect(started!.data).toMatchObject({ toStatus: 'working', start: { turn: f.turn.number, turnHead: f.R, main: BASE } });
    const SECOND = '2'.repeat(40);
    lay(f, [{ sha: FOREIGN, parents: [f.R] }, { sha: OWN, parents: [FOREIGN] }, { sha: SECOND, parents: [OWN] }], { [f.branch]: SECOND, [work.branch]: SECOND });
    await work.done({ commit: SECOND, baseCommit: OWN });
    const [closed] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.task.id), eq(taskEvents.kind, 'report')));
    expect(closed!.data).toMatchObject({ integration: { commit: SECOND, start: OWN, workStart: f.R } });
  });

  it('takes the commit and its start through the report tool', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    lay(f, [{ sha: OWN, parents: [f.R] }], { [f.branch]: OWN, [work.branch]: OWN });
    const token = 'turnkey-holder-tool-token-0123456789abcdef01234';
    await f.db.insert(jobs).values({ companyId: f.task.companyId, agentId: work.holder.id, subscriptionId: work.holder.subscriptionId!, taskId: work.task.id, kind: 'conversation', prompt: 'Work', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    const client = await mcp(f.app, token);
    const tool = (await client.listTools()).tools.find(found => found.name === 'report')!;
    expect(tool.description).toContain('turnkey');
    const result = await client.callTool({ name: 'report', arguments: { task: work.task.number, done: true, summary: 'Fast-forwarded the turn branch after my own checks.', turnkey: { commit: OWN, baseCommit: f.R } } }) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect((await f.detail(work.task.id)).status).toBe('done');
  });
});
