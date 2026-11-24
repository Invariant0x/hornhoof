import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, approvalPolicies, departments, taskEvents, tasks } from '../src/db/schema.js';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { ask, closeTask, report } from '../src/modules/tasks/engine.js';
import { BASE } from './development-echelons-fixture.js';
import { as } from './helpers.js';
import { recorded as recordedFile } from './recorded-fixture.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { joinedAfterR, releasing, turnkeyAfterR } from './turn-release-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

const EXTRA = '7'.repeat(40);
const SIDE = '8'.repeat(40);
const STRAY = '2'.repeat(40);
/* The merge on top of the work of task-N after R, as joinedAfterR lays it. */
const TOP = '6'.repeat(40);

const requireApproval = (f: Awaited<ReturnType<typeof releasing>>) =>
  f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });

const recorded = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe('the release step of a turn', () => {
  it('records the release of the open turn before main moves: its commit, main under it, what its CI said, its tasks and the approval', async () => {
    const f = await releasing();
    const approval = await f.approve();
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({
      turn: f.turn.number, commit: f.R, baseCommit: BASE, ci: { state: 'green', checks: 3 }, approvalRequestId: approval.id,
      tasks: [expect.objectContaining({ number: f.task.number, verdicts: [expect.any(String)] })], covered: true,
    });
  });

  it('records a checked release without approval when the department has no commit rule', async () => {
    const f = await releasing();
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ commit: f.R, approvalRequestId: null, autonomousReleaseId: null });
  });

  it('does not rely on an autonomous approval when the commit rule needs none', async () => {
    const f = await releasing();
    await f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!));
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: null, autonomousReleaseId: null });
  });

  it('requires the exact commit when the department asks for approval, and accepts the orchestrator for the owner', async () => {
    const f = await releasing();
    await requireApproval(f);
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    await f.approve('6'.repeat(40));
    expect(await f.recordRelease()).toMatchObject({ isError: true });
    const { request } = await ask(f.ctx, f.head.id, f.release.id, { kind: 'approval', text: 'Approve the release commit.', commit: f.R });
    const [orchestrator] = await f.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const approved = await f.app.inject({
      method: 'POST', url: `/api/requests/${request.id}`, payload: { approve: true },
      headers: orchestratorHeaders(f.claude.ownerPersonId, orchestrator!.id),
    });
    expect(approved.statusCode).toBe(200);
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: request.id });
  });

  it("asks in its description for no run: the release relies on the repository's CI for the exact commit", async () => {
    const f = await releasing();
    const tool = (await f.client.listTools()).tools.find(found => found.name === 'release_turn')!;
    expect(tool.description).toMatch(/The release relies on the repository's CI for that exact commit, which Hornhoof reads from the repository's host, never from your word: green CI records it with no run/);
    expect(tool.description).not.toMatch(/whole run|run_tests|nothing reused/);
    expect(tool.inputSchema.properties).not.toHaveProperty('runId');
    expect(tool.inputSchema.properties?.commit).toMatchObject({ description: "The exact commit of the turn branch the repository's CI checked." });
  });

  it('refuses a commit the turn branch does not hold, or a main that already holds it', async () => {
    const f = await releasing();
    await f.approve();
    f.repo.heads[f.branch] = EXTRA;
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining(f.branch) as unknown });
    f.repo.heads[f.branch] = f.R;
    f.repo.heads.main = f.R;
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('main') as unknown });
  });

  /* The turn branch never stops for a release: work goes on joining it while the CI and the approval of R take their
     time, and the release takes only what R holds. */
  it('records a commit the turn branch went past, and leaves the results R does not hold to the next release', async () => {
    const f = await releasing();
    await f.approve();
    const late = await lateResult(f, EXTRA);
    expect(recorded((await f.recordRelease()).text)).toMatchObject({
      commit: f.R, tasks: [expect.objectContaining({ number: f.task.number })], left: [late.number],
    });
  });
});

/* Turnkey work that joined the turn after R: the turn branch went on from R to commit, its integration. */
async function lateResult(f: Awaited<ReturnType<typeof releasing>>, commit: string) {
  const { task } = await f.create({ title: 'Late change' });
  await f.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId: f.turn.id }).where(eq(tasks.id, task.id));
  await f.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'report', agentId: f.author.id, text: 'Done.', data: { done: true, integration: { branch: f.branch, commit, from: `task-${task.number}` } } });
  f.repo.heads[f.branch] = commit;
  f.repo.holds[commit] = [f.R, ...f.repo.holds[f.R]!];
  return task;
}

describe('the release step while the turn branch goes on', () => {

  it('is asked only by the holder of the release task, while it is not paused', async () => {
    const f = await releasing();
    await f.approve();
    await f.db.update(tasks).set({ paused: { at: new Date().toISOString(), by: { personId: f.claude.ownerPersonId! } } as never }).where(eq(tasks.id, f.release.id));
    expect(await f.recordRelease()).toMatchObject({ isError: true });
    await f.db.update(tasks).set({ paused: null, assigneeAgentId: f.author.id }).where(eq(tasks.id, f.release.id));
    expect(await f.recordRelease()).toMatchObject({ isError: true });
  });
});

describe('whether everything a release brings was checked', () => {
  /* The person approves the release as it stands, on a card that names what it brings that no check covers. */
  const coverage = async (change: (f: Awaited<ReturnType<typeof releasing>>) => Promise<void> | void) => {
    const f = await releasing();
    await change(f);
    await f.approve();
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    return recorded(result.text);
  };

  it('covers a release whose every commit is of a candidate its checkers passed', async () => {
    expect(await coverage(() => undefined)).toMatchObject({ covered: true, uncovered: [] });
  });

  it('does not cover a merge made on the turn branch outside every candidate', async () => {
    const result = await coverage(f => {
      f.repo.heads.main = EXTRA;
      f.repo.holds[f.R] = [BASE, EXTRA, SIDE];
      f.repo.between[`${EXTRA}..${f.R}`] = [{ sha: SIDE, parents: [EXTRA] }, { sha: BASE, parents: [EXTRA, SIDE] }, { sha: f.R, parents: [BASE] }];
    });
    expect(result).toMatchObject({ covered: false, baseCommit: EXTRA });
    expect(result.uncovered).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`${BASE}.*merge`)), expect.stringContaining(SIDE)]));
  });

  it('does not cover a commit no accepted candidate brought', async () => {
    const result = await coverage(f => {
      f.repo.heads.main = EXTRA;
      f.repo.holds[f.R] = [BASE, EXTRA];
      f.repo.between[`${EXTRA}..${f.R}`] = [{ sha: BASE, parents: [EXTRA] }, { sha: f.R, parents: [BASE] }];
    });
    expect(result).toMatchObject({ covered: false, uncovered: [expect.stringContaining(BASE)] });
  });

  it('covers a release by its commits where GitHub listed only 300 of the files it brings', async () => {
    expect(await coverage(f => { (f.repo.capped ??= new Set()).add(`${BASE}..${f.R}`); })).toMatchObject({ covered: true, uncovered: [] });
  });

  it('does not cover a release whose comparison came back cut short', async () => {
    expect(await coverage(f => { f.repo.cut.add(`${BASE}..${f.R}`); })).toMatchObject({ covered: false });
  });

  it('does not cover a candidate whose checker was switched off since', async () => {
    expect(await coverage(async f => { await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id)); })).toMatchObject({ covered: false });
  });
});

/* Autonomous release, by the switch of the people who run the department: a release whose every commit was checked needs no person to approve it,
   and its approval is the entry of the autonomous release log, with the CI result and the checkers that passed it. */
describe('the release step with autonomous release on', () => {
  const autonomous = async (f: Awaited<ReturnType<typeof releasing>>, on = true) => {
    await requireApproval(f);
    await f.db.update(departments).set({ autonomousRelease: on }).where(eq(departments.id, f.task.departmentId!));
  };
  const journal = async (f: Awaited<ReturnType<typeof releasing>>) =>
    (await f.app.inject({ method: 'GET', url: '/api/autonomous-releases', ...as(f.ceoToken) })).json().entries as Record<string, unknown>[];

  it('approves a release every commit of which was checked by itself, and logs it with the CI result and its checkers', async () => {
    const f = await releasing();
    await autonomous(f);
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    const record = recorded(result.text);
    expect(record).toMatchObject({ turn: f.turn.number, commit: f.R, baseCommit: BASE, ci: { state: 'green', checks: 3 }, approvalRequestId: null, autonomousReleaseId: expect.any(String), covered: true });
    expect(await journal(f)).toEqual([expect.objectContaining({
      id: record.autonomousReleaseId, taskNumber: f.release.number, agentName: f.head.name, commitSha: f.R, baseCommitSha: BASE,
      testRunId: null, testRunNumber: null, ciState: 'green', ciChecks: 3, reviewerName: f.reviewer.name, verdictStage: 'review',
    })]);
  });

  it('still asks a person for a release that brings a commit nobody checked, and logs nothing', async () => {
    const f = await releasing();
    await autonomous(f);
    f.repo.cut.add(`${BASE}..${f.R}`);
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    expect(await journal(f)).toEqual([]);
  });

  it('approves no release on red CI, and logs nothing', async () => {
    const f = await releasing();
    await autonomous(f);
    f.repo.ci = { state: 'red', check: 'test (3)', url: 'https://github.com/acme/shop/actions/runs/7/job/9', outcome: 'failure' };
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('check test (3) ended with failure') as unknown });
    expect(await journal(f)).toEqual([]);
  });

  it('still asks a person while autonomous release is off', async () => {
    const f = await releasing();
    await autonomous(f, false);
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    expect(await journal(f)).toEqual([]);
  });

  it('approves a checked release by itself while unchecked work that joined the turn after it waits for the next one', async () => {
    const f = await releasing();
    await autonomous(f);
    const late = await lateResult(f, EXTRA);
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: null, autonomousReleaseId: expect.any(String), covered: true, uncovered: [], left: [late.number] });
  });

  it("says in its description that a turnkey holder's own checks cover its work under autonomous release", async () => {
    const f = await releasing();
    const tool = (await f.client.listTools()).tools.find(found => found.name === 'release_turn')!;
    expect(tool.description).toMatch(/With autonomous release on, proof of each change can satisfy the approval rule.*an independent checker or, for turnkey work, the holder's own review, security check and tests/);
  });

  /* A member of a turnkey team does its task whole with its own review, security check and tests, and calls no checker:
     those cover its work, the first-parent line from the commit it named down to where its branch started. */
  it('approves by itself a release that brings turnkey work its holder checked itself, and logs the holder with the checkers', async () => {
    const f = await releasing();
    await autonomous(f);
    const work = await turnkeyAfterR(f);
    const result = await f.recordRelease({ commit: work.head });
    expect(result).toMatchObject({ isError: false });
    expect(recorded(result.text)).toMatchObject({
      commit: work.head, approvalRequestId: null, autonomousReleaseId: expect.any(String), covered: true, uncovered: [], left: [],
      tasks: [expect.objectContaining({ number: f.task.number }), expect.objectContaining({ number: work.task.number, commit: work.own })],
    });
    expect(await journal(f)).toEqual([expect.objectContaining({ commitSha: work.head, testRunId: null, ciState: 'green', reviewerName: `${f.reviewer.name}, ${work.holder.name}`, verdictStage: 'review, turnkey' })]);
  });

  /* A merge made on the turn branch is on no first-parent line of a commit a turnkey holder checked: a person sees it too. */
  it.each([
    ['took in from the turn branch', true, ''],
    ['was made on, under the merge that joined it', false, ` ${TOP} is a merge made outside every checked candidate.`],
  ])('still asks a person for a commit pushed straight to the turn branch that turnkey work %s, and logs nothing', async (_how, taken, join) => {
    const f = await releasing();
    await autonomous(f);
    const work = await turnkeyAfterR(f, { sha: STRAY, taken });
    const result = await f.recordRelease({ commit: work.head });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    expect(result.text.split('this one brings what was not: ')[1]).toBe(`${STRAY} came in with no accepted candidate.${join}`);
    expect(await journal(f)).toEqual([]);
  });

  it('still asks a person when the holder of turnkey work was switched off since, and logs nothing', async () => {
    const f = await releasing();
    await autonomous(f);
    const work = await turnkeyAfterR(f);
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, work.holder.id));
    expect(await f.recordRelease({ commit: work.head })).toMatchObject({ isError: true, text: expect.stringContaining(`#${work.task.number}`) as unknown });
    expect(await journal(f)).toEqual([]);
  });

  it('still asks a person for work that is not turnkey and joined the turn branch with no checked candidate', async () => {
    const f = await releasing();
    await autonomous(f);
    const { task } = await f.create({ title: 'Unchecked change' });
    const joined = joinedAfterR(f, task.number);
    await f.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null, turnId: f.turn.id }).where(eq(tasks.id, task.id));
    await f.db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, kind: 'report', agentId: f.author.id, text: 'Done.', data: { done: true, integration: { branch: f.branch, commit: joined.own, from: `task-${task.number}` } } });
    expect(await f.recordRelease({ commit: joined.head })).toMatchObject({ isError: true, text: expect.stringContaining(`#${task.number}`) as unknown });
    expect(await journal(f)).toEqual([]);
  });

  /* Work closed past its route, by the orchestrator or by hand in the database, is accepted by nobody: a release takes its proof
     from the records of each result, never from the report of the group that closed over it. */
  it.each(['the orchestrator', 'hand in the database'])('still asks a person for work closed by %s, also once its group closed over it, and logs nothing', async how => {
    const f = await releasing();
    await autonomous(f);
    const group = (await f.create({ title: 'Coordinate the late change', assigneeAgentId: f.head.id, executor: false, resultKind: 'coordination' })).task;
    const { task } = await f.create({ title: 'Late change', parentId: group.id });
    const joined = joinedAfterR(f, task.number);
    if (how === 'the orchestrator') {
      const [orchestrator] = await f.db.select().from(agents).where(and(eq(agents.companyId, task.companyId), eq(agents.kind, 'orchestrator')));
      await closeTask(f.ctx, { agentId: orchestrator!.id }, task.id, { status: 'done', why: 'Closed by hand; the work is over.' });
    } else await f.db.update(tasks).set({ status: 'done', closedAt: new Date('2026-11-17T12:00:00.000Z'), turnId: f.turn.id }).where(eq(tasks.id, task.id));
    expect((await report(f.ctx, f.head.id, group.id, { done: true, summary: 'Closed over the late change.', ...(await recordedFile(f.ctx, group.id, f.head.id)) })).task.status).toBe('done');
    const result = await f.recordRelease({ commit: joined.head });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    expect(result.text.split('this one brings what was not: ')[1]).toContain(joined.own);
    expect(await journal(f)).toEqual([]);
  });

  it("takes a person's approval of the commit where there is one, and logs nothing", async () => {
    const f = await releasing();
    await autonomous(f);
    const approval = await f.approve();
    const result = await f.recordRelease();
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: approval.id, autonomousReleaseId: null });
    expect(await journal(f)).toEqual([]);
  });
});
