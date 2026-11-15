import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, requests, tasks } from '../src/db/schema.js';
import { BASE } from './development-echelons-fixture.js';
import { as } from './helpers.js';
import { releasing } from './turn-release-fixture.js';

const EXTRA = '7'.repeat(40);
const SIDE = '8'.repeat(40);
const TURNKEY_SHA = '9'.repeat(40);
const REL_SHA = 'c'.repeat(40);

const recorded = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe('the release step of a turn', () => {
  it('records the release of the open turn before main moves: its commit, main under it, its full run, its tasks and the approval', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    const approval = await f.approve();
    const result = await f.recordRelease({ runId: run.id });
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({
      turn: f.turn.number, commit: f.R, baseCommit: BASE, runId: run.id, approvalRequestId: approval.id,
      tasks: [expect.objectContaining({ number: f.task.number, verdicts: [expect.any(String)] })], covered: true,
    });
  });

  it('needs a person to approve that exact commit', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    await f.approve('6'.repeat(40));
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true });
  });

  it.each([
    ['a run that reused results', { reused: 3 }],
    ['a run with a failed part', { failedPart: true }],
    ['a run of another commit', { commit: EXTRA }],
    ['a run of another branch', { branch: 'task-1' }],
    ['a failed run', { status: 'failed' as const }],
  ])('refuses %s: a release needs a real full run on its exact commit', async (_what, run) => {
    const f = await releasing();
    const given = await f.fullRun(run);
    await f.approve();
    expect(await f.recordRelease({ runId: given.id })).toMatchObject({ isError: true, text: expect.stringContaining('full run') as unknown });
  });

  it('refuses a full run when a newer run of the same commit failed', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    await f.fullRun({ status: 'failed' });
    await f.approve();
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining('full run') as unknown });
  });

  it('refuses a commit that is not the head of the turn branch, or a main that already holds it', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    await f.approve();
    f.repo.heads[f.branch] = EXTRA;
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining(f.branch) as unknown });
    f.repo.heads[f.branch] = f.R;
    f.repo.heads.main = f.R;
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining('main') as unknown });
  });

  it('is asked only by the holder of the release task, while it is not paused', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    await f.approve();
    await f.db.update(tasks).set({ paused: { at: new Date().toISOString(), by: { personId: f.claude.ownerPersonId! } } as never }).where(eq(tasks.id, f.release.id));
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true });
    await f.db.update(tasks).set({ paused: null, assigneeAgentId: f.author.id }).where(eq(tasks.id, f.release.id));
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true });
  });
});

describe('whether everything a release brings was checked', () => {
  const coverage = async (change: (f: Awaited<ReturnType<typeof releasing>>) => Promise<void> | void) => {
    const f = await releasing();
    const run = await f.fullRun();
    await f.approve();
    await change(f);
    const result = await f.recordRelease({ runId: run.id });
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

  it('does not cover a release whose comparison came back cut short', async () => {
    expect(await coverage(f => { f.repo.cut.add(`${BASE}..${f.R}`); })).toMatchObject({ covered: false });
  });

  it('does not cover a candidate whose checker was switched off since', async () => {
    expect(await coverage(async f => { await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id)); })).toMatchObject({ covered: false });
  });
});

/* Autonomous release, by the switch of the people who run the department: a release whose every commit was checked needs no person to approve it,
   and its approval is the entry of the autonomous release log, with the full run and the checkers that passed it. */
describe('the release step with autonomous release on', () => {
  const autonomous = async (f: Awaited<ReturnType<typeof releasing>>, on = true) => {
    await f.db.update(departments).set({ autonomousRelease: on }).where(eq(departments.id, f.task.departmentId!));
  };
  const journal = async (f: Awaited<ReturnType<typeof releasing>>) =>
    (await f.app.inject({ method: 'GET', url: '/api/autonomous-releases', ...as(f.ceoToken) })).json().entries as Record<string, unknown>[];

  it('approves a release every commit of which was checked by itself, and logs it with the full run and its checkers', async () => {
    const f = await releasing();
    await autonomous(f);
    const run = await f.fullRun();
    const result = await f.recordRelease({ runId: run.id });
    expect(result.isError).toBe(false);
    const record = recorded(result.text);
    expect(record).toMatchObject({ turn: f.turn.number, commit: f.R, baseCommit: BASE, runId: run.id, approvalRequestId: null, autonomousReleaseId: expect.any(String), covered: true });
    expect(await journal(f)).toEqual([expect.objectContaining({
      id: record.autonomousReleaseId, taskNumber: f.release.number, agentName: f.head.name, commitSha: f.R, baseCommitSha: BASE,
      testRunId: run.id, testRunNumber: run.number, reviewerName: f.reviewer.name, verdictStage: 'review',
    })]);
  });

  it('still asks a person for a release that brings a commit nobody checked, and logs nothing', async () => {
    const f = await releasing();
    await autonomous(f);
    const run = await f.fullRun();
    f.repo.cut.add(`${BASE}..${f.R}`);
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    expect(await journal(f)).toEqual([]);
  });

  it('still asks a person while autonomous release is off', async () => {
    const f = await releasing();
    await autonomous(f, false);
    const run = await f.fullRun();
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining('approv') as unknown });
    expect(await journal(f)).toEqual([]);
  });

  it("takes a person's approval of the commit where there is one, and logs nothing", async () => {
    const f = await releasing();
    await autonomous(f);
    const run = await f.fullRun();
    const approval = await f.approve();
    const result = await f.recordRelease({ runId: run.id });
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: approval.id, autonomousReleaseId: null });
    expect(await journal(f)).toEqual([]);
  });

  it('approves a pure turnkey turn when autonomous release is on and the turnkey executor is active, logging stage turnkey', async () => {
    const f = await releasing();
    await autonomous(f);
    await f.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, f.task.id));
    const { solo, task: tk } = await f.acceptTurnkey(TURNKEY_SHA, BASE);
    const run = await f.fullRun({ commit: TURNKEY_SHA });
    const result = await f.recordRelease({ commit: TURNKEY_SHA, runId: run.id });
    expect(result.isError).toBe(false);
    const record = recorded(result.text);
    expect(record).toMatchObject({
      turn: f.turn.number,
      commit: TURNKEY_SHA,
      baseCommit: BASE,
      runId: run.id,
      approvalRequestId: null,
      autonomousReleaseId: expect.any(String),
      covered: true,
      uncovered: [],
      tasks: [{ number: tk.number, commit: TURNKEY_SHA, verdicts: [] }],
    });
    expect(await journal(f)).toEqual([
      expect.objectContaining({
        id: record.autonomousReleaseId,
        taskNumber: f.release.number,
        agentName: f.head.name,
        commitSha: TURNKEY_SHA,
        baseCommitSha: BASE,
        testRunId: run.id,
        testRunNumber: run.number,
        reviewerAgentId: solo.id,
        reviewerName: solo.name,
        verdictStage: 'turnkey',
      }),
    ]);
  });

  it('approves a mixed turn of checked echelon work and active turnkey work, listing both in the journal', async () => {
    const f = await releasing();
    await autonomous(f);
    const { solo } = await f.acceptTurnkey(TURNKEY_SHA, f.R);
    const run = await f.fullRun({ commit: TURNKEY_SHA });
    const result = await f.recordRelease({ commit: TURNKEY_SHA, runId: run.id });
    expect(result.isError).toBe(false);
    const record = recorded(result.text);
    expect(record).toMatchObject({
      commit: TURNKEY_SHA,
      covered: true,
      uncovered: [],
      autonomousReleaseId: expect.any(String),
    });
    expect(await journal(f)).toEqual([
      expect.objectContaining({
        id: record.autonomousReleaseId,
        commitSha: TURNKEY_SHA,
        reviewerAgentId: null,
        reviewerName: `${f.reviewer.name}, ${solo.name}`,
        verdictStage: 'review, turnkey',
      }),
    ]);
  });

  it('covers the release commit or merge of an active turnkey release task whose task branch stands at the turn head', async () => {
    const f = await releasing();
    await autonomous(f);
    const { solo } = await f.acceptTurnkey(TURNKEY_SHA, BASE);
    const { relSolo, relTask, relCall } = await f.turnkeyReleaseTask();
    f.repo.heads[`task-${relTask.number}`] = REL_SHA;
    f.repo.heads[f.branch] = REL_SHA;
    f.repo.holds[REL_SHA] = [TURNKEY_SHA, f.R, BASE];
    f.repo.between[`${BASE}..${REL_SHA}`] = [
      { sha: f.R, parents: [BASE] },
      { sha: TURNKEY_SHA, parents: [BASE] },
      { sha: REL_SHA, parents: [f.R, TURNKEY_SHA] },
    ];
    const run = await f.fullRun({ commit: REL_SHA });
    const result = await relCall('release_turn', { task: relTask.number, commit: REL_SHA, runId: run.id });
    expect(result.isError).toBe(false);
    const record = recorded(result.text);
    expect(record).toMatchObject({
      commit: REL_SHA,
      covered: true,
      uncovered: [],
      autonomousReleaseId: expect.any(String),
    });
    expect(await journal(f)).toEqual([
      expect.objectContaining({
        id: record.autonomousReleaseId,
        taskNumber: relTask.number,
        agentName: relSolo.name,
        commitSha: REL_SHA,
        reviewerAgentId: null,
        reviewerName: `${f.reviewer.name}, ${solo.name}, ${relSolo.name}`,
        verdictStage: 'review, turnkey',
      }),
    ]);
  });

  it('refuses autonomous release when a turnkey author or turnkey release holder is switched off or removed', async () => {
    const f1 = await releasing();
    await autonomous(f1);
    await f1.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, f1.task.id));
    const { solo } = await f1.acceptTurnkey(TURNKEY_SHA, BASE);
    const run1 = await f1.fullRun({ commit: TURNKEY_SHA });
    await f1.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, solo.id));
    expect(await f1.recordRelease({ commit: TURNKEY_SHA, runId: run1.id })).toMatchObject({
      isError: true,
      text: expect.stringContaining('approv') as unknown,
    });
    await f1.db.update(agents).set({ switchedOffAt: null, removedAt: new Date() }).where(eq(agents.id, solo.id));
    expect(await f1.recordRelease({ commit: TURNKEY_SHA, runId: run1.id })).toMatchObject({
      isError: true,
      text: expect.stringContaining('approv') as unknown,
    });
    expect(await journal(f1)).toEqual([]);

    const f2 = await releasing();
    await autonomous(f2);
    const { relSolo, relTask, relCall } = await f2.turnkeyReleaseTask();
    f2.repo.heads[`task-${relTask.number}`] = REL_SHA;
    f2.repo.heads[f2.branch] = REL_SHA;
    f2.repo.holds[REL_SHA] = [f2.R, BASE];
    f2.repo.between[`${BASE}..${REL_SHA}`] = [{ sha: f2.R, parents: [BASE] }, { sha: REL_SHA, parents: [f2.R] }];
    const run2 = await f2.fullRun({ commit: REL_SHA });
    await f2.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, relSolo.id));
    expect(await relCall('release_turn', { task: relTask.number, commit: REL_SHA, runId: run2.id })).toMatchObject({
      isError: true,
      text: expect.stringContaining('approv') as unknown,
    });
    expect(await journal(f2)).toEqual([]);
  });

  it('still refuses an extraneous commit or merge outside accepted tasks when the release task is coordination or its task branch is not at R', async () => {
    const f = await releasing();
    await autonomous(f);
    await f.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, f.task.id));
    await f.acceptTurnkey(TURNKEY_SHA, BASE);
    f.repo.heads[f.branch] = REL_SHA;
    f.repo.holds[REL_SHA] = [TURNKEY_SHA, SIDE, BASE];
    f.repo.between[`${BASE}..${REL_SHA}`] = [
      { sha: TURNKEY_SHA, parents: [BASE] },
      { sha: SIDE, parents: [BASE] },
      { sha: REL_SHA, parents: [TURNKEY_SHA, SIDE] },
    ];
    const run = await f.fullRun({ commit: REL_SHA });
    expect(await f.recordRelease({ commit: REL_SHA, runId: run.id })).toMatchObject({
      isError: true,
      text: expect.stringContaining('approv') as unknown,
    });

    const { relTask, relCall } = await f.turnkeyReleaseTask();
    f.repo.heads[`task-${relTask.number}`] = TURNKEY_SHA;
    expect(await relCall('release_turn', { task: relTask.number, commit: REL_SHA, runId: run.id })).toMatchObject({
      isError: true,
      text: expect.stringContaining('approv') as unknown,
    });
    expect(await journal(f)).toEqual([]);
  });

  it('still refuses a mixed turn when the checker of its non-turnkey task was switched off, even with active turnkey work on top', async () => {
    const f = await releasing();
    await autonomous(f);
    await f.acceptTurnkey(TURNKEY_SHA, f.R);
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, f.reviewer.id));
    const run = await f.fullRun({ commit: TURNKEY_SHA });
    expect(await f.recordRelease({ commit: TURNKEY_SHA, runId: run.id })).toMatchObject({
      isError: true,
      text: expect.stringContaining('approv') as unknown,
    });
    expect(await journal(f)).toEqual([]);
  });

  it('tells the release holder to record with release_turn without opening a card when the turn head already passes autonomous release', async () => {
    const f = await releasing();
    await autonomous(f);
    await f.db.update(tasks).set({ turnId: null }).where(eq(tasks.id, f.task.id));
    await f.acceptTurnkey(TURNKEY_SHA, BASE);
    const run = await f.fullRun({ commit: TURNKEY_SHA });

    const asked = await f.call('ask_person', {
      task: f.release.number,
      question: 'Approve turn release?',
      commit: TURNKEY_SHA,
    });
    expect(asked.isError).toBe(false);
    expect(asked.text).not.toContain('waits for a person');
    expect(asked.text).toContain('release_turn');

    const requested = await f.call('request_approval', {
      task: f.release.number,
      channel: 'commit',
      kind: 'turn-release',
      text: 'Approve turn release?',
      commit: TURNKEY_SHA,
    });
    expect(requested.isError).toBe(false);
    expect(requested.text).not.toContain('waits for a person');
    expect(requested.text).toContain('release_turn');

    expect(await f.db.select().from(requests).where(eq(requests.taskId, f.release.id))).toEqual([]);
    expect(await journal(f)).toEqual([]);
    expect((await f.recordRelease({ commit: TURNKEY_SHA, runId: run.id })).isError).toBe(false);
    expect(await journal(f)).toHaveLength(1);
  });
});
