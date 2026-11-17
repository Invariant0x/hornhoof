import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, tasks } from '../src/db/schema.js';
import { BASE } from './development-echelons-fixture.js';
import { as } from './helpers.js';
import { releasing } from './turn-release-fixture.js';

const EXTRA = '7'.repeat(40);
const SIDE = '8'.repeat(40);

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

  /* After the first run of a release, a run of it takes what that release proved and runs what failed or changed. */
  it('asks in its description for a whole run of the turn branch, which may take what its release proved', async () => {
    const f = await releasing();
    const tool = (await f.client.listTools()).tools.find(found => found.name === 'release_turn')!;
    expect(tool.description).toMatch(/runId a passed whole run of it: the first run of its release, or a later one that took only what its release proved/);
    expect(tool.description).not.toMatch(/nothing reused/);
    expect(tool.inputSchema.properties?.runId).toMatchObject({ description: 'A passed whole run of that commit.' });
  });

  it('takes a later run of the release that took the green results of its release', async () => {
    const f = await releasing();
    const run = await f.fullRun({ reused: 3 });
    await f.approve();
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: false });
  });

  it('takes a later run of the release that ran nothing, as every test file kept its green result', async () => {
    const f = await releasing();
    const run = await f.fullRun({ reused: 5, parts: 0 });
    await f.approve();
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: false });
  });

  it.each([
    ['a run with no part that took nothing', { parts: 0 }],
    ['a run that took results from before releases were kept', { reused: 3, ofRelease: false }],
    ['a run of one suite', { reused: 3, suite: 'server' }],
    ['a run with a failed part', { failedPart: true }],
    ['a run of another commit', { commit: EXTRA }],
    ['a run of another branch', { branch: 'task-1' }],
    ['a failed run', { status: 'failed' as const }],
  ])('refuses %s: a release needs a whole run of its own on its exact commit', async (_what, run) => {
    const f = await releasing();
    const given = await f.fullRun(run);
    await f.approve();
    expect(await f.recordRelease({ runId: given.id })).toMatchObject({ isError: true, text: expect.stringContaining('whole run') as unknown });
  });

  it('refuses a full run when a newer run of the same commit failed', async () => {
    const f = await releasing();
    const run = await f.fullRun();
    await f.fullRun({ status: 'failed' });
    await f.approve();
    expect(await f.recordRelease({ runId: run.id })).toMatchObject({ isError: true, text: expect.stringContaining('whole run') as unknown });
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
});
