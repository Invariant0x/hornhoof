import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { approvalPolicies, jobs, requests, taskEvents, testRuns, turnReleases } from '../src/db/schema.js';
import { answer } from '../src/modules/tasks/engine.js';
import type { CiAt } from '../src/modules/testruns/github-ci.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { BASE } from './development-echelons-fixture.js';
import { releasing } from './turn-release-fixture.js';
import { released } from './turn-tag-close-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

const recorded = (text: string) => JSON.parse(text) as Record<string, unknown>;
const records = (f: Awaited<ReturnType<typeof releasing>>) => f.db.select().from(turnReleases).where(eq(turnReleases.turnId, f.turn.id));
const RED_LINK = 'https://github.com/acme/shop/actions/runs/7/job/9';

/* A release rests on the repository's own CI for the exact commit, as its host says it when the release is recorded: never on a
   run of Hornhoof's machines, and never on the caller's word. */
describe('the release of a turn on the repository\'s CI', () => {
  it('records on green CI with no run at all, asking the host of exactly that commit', async () => {
    const f = await releasing();
    expect(await f.db.select().from(testRuns)).toEqual([]);
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ commit: f.R, ci: { state: 'green', checks: 3 } });
    expect(recorded(result.text)).not.toHaveProperty('runId');
    expect(await records(f)).toEqual([expect.objectContaining({ commit: f.R, runId: null, ciState: 'green', ciChecks: 3 })]);
    expect(f.repo.asked).toEqual([f.R]);
  });

  it('records with no run where the repository has no CI, and says that it had none', async () => {
    const f = await releasing();
    f.repo.ci = { state: 'none', why: 'no check, no status and no workflow file belongs to this commit' };
    const result = await f.recordRelease();
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ commit: f.R, ci: { state: 'none' } });
    expect(await records(f)).toEqual([expect.objectContaining({ runId: null, ciState: 'none', ciChecks: null })]);
  });

  it.each<[string, CiAt, string[]]>([
    ['red CI, naming the failing check and its link', { state: 'red', check: 'test (3)', url: RED_LINK, outcome: 'failure' }, ['red on this commit', 'check test (3) ended with failure', RED_LINK]],
    ['CI still under way, naming the check that is not done', { state: 'pending', check: 'test (1)', url: RED_LINK, outcome: 'in_progress' }, ['has not finished on this commit', 'test (1) is in_progress', RED_LINK]],
    ['CI that ran checks and none succeeded', { state: 'idle', checks: 2 }, ['ran 2 checks', 'none succeeded']],
  ])('refuses %s, and records nothing', async (_what, ci, words) => {
    const f = await releasing();
    f.repo.ci = ci;
    const result = await f.recordRelease();
    expect(result).toMatchObject({ isError: true });
    for (const word of words) expect(result.text).toContain(word);
    expect(result.text).toContain(f.R);
    expect(await records(f)).toEqual([]);
  });

  it('records nothing and says so when the host cannot be read now', async () => {
    const f = await releasing();
    f.repo.ci = { state: 'unread', why: 'GitHub answered 502 when reading the checks' };
    const result = await f.recordRelease();
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('GitHub answered 502 when reading the checks') as unknown });
    expect(result.text).toContain(`Nothing was recorded for ${f.R}. Try again.`);
    expect(await records(f)).toEqual([]);
  });

  it("records nothing and says so, with when the limit ends, when GitHub's request limit is used up", async () => {
    const f = await releasing();
    f.repo.ci = { state: 'limited', limit: { remaining: 0, resetAt: Date.UTC(2026, 10, 24, 14, 10) } };
    const result = await f.recordRelease();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("The account's request limit is used up until 14:10 UTC. Try again after that.");
    expect(result.text).toContain('Nothing was recorded');
    expect(await records(f)).toEqual([]);
  });

  it('records nothing where the reader itself fails or the server has none', async () => {
    const f = await releasing();
    f.ctx.readCi = async () => { throw new Error('socket hang up'); };
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('Nothing was recorded') as unknown });
    f.ctx.readCi = undefined;
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('this server has no reader of the repository host') as unknown });
    expect(await records(f)).toEqual([]);
  });

  it('takes the answer of the host for the commit it was asked, never one for another commit', async () => {
    const f = await releasing();
    f.repo.ci = commit => (commit === f.R ? { state: 'red', check: 'test (1)', url: null, outcome: 'failure' } : { state: 'green', checks: 9 });
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('check test (1) ended with failure') as unknown });
    expect(f.repo.asked).toEqual([f.R]);
  });

  it('records again once CI is green on the commit', async () => {
    const f = await releasing();
    f.repo.ci = { state: 'pending', check: 'test (1)', url: null, outcome: 'queued' };
    expect(await f.recordRelease()).toMatchObject({ isError: true });
    f.repo.ci = { state: 'green', checks: 12 };
    expect(recorded((await f.recordRelease()).text)).toMatchObject({ ci: { state: 'green', checks: 12 } });
  });

  it('asks nobody about CI for a release it refuses on other grounds first', async () => {
    const f = await releasing();
    f.repo.heads.main = f.R;
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('already holds') as unknown });
    expect(f.repo.asked ?? []).toEqual([]);
  });

  it('takes no word of a caller for CI: a run id sent along changes nothing', async () => {
    const f = await releasing();
    f.repo.ci = { state: 'red', check: 'test (2)', url: null, outcome: 'failure' };
    const result = await f.recordRelease({ runId: '00000000-0000-4000-8000-000000000001', githubRunId: 1 });
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('check test (2) ended with failure') as unknown });
    expect(await records(f)).toEqual([]);
  });
});

describe('the approval card of a release', () => {
  /* The card as ask_person with the commit opens it: Hornhoof writes what the checks say under the words of the asker. */
  const cardOf = async (f: Awaited<ReturnType<typeof releasing>>) => {
    await f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
    const asked = await f.call('ask_person', { task: f.release.number, question: `Release turn ${f.turn.number}: main to ${f.R}.`, commit: f.R });
    expect(asked.isError, asked.text).toBe(false);
    const rows = await f.db.select().from(requests).where(eq(requests.taskId, f.release.id));
    return { text: rows.at(-1)!.text, id: rows.at(-1)!.id, said: asked.text };
  };

  it("names what the repository's CI says of the commit, not a run number", async () => {
    const f = await releasing();
    const card = await cardOf(f);
    expect(card.text).toContain("Hornhoof checked as this was asked. The repository's CI is green on this commit: 3 checks passed.");
    expect(card.text).not.toMatch(/test run/i);
    expect(card.said).toContain("The repository's CI is green on this commit: 3 checks passed.");
    expect(f.repo.asked).toContain(f.R);
  });

  it('names red CI, with the failing check and its link, where the commit is red', async () => {
    const f = await releasing();
    f.repo.ci = { state: 'red', check: 'test (3)', url: RED_LINK, outcome: 'failure' };
    expect((await cardOf(f)).text).toContain(`The repository's CI is red on this commit: check test (3) ended with failure (${RED_LINK}).`);
  });

  it('says there is no CI for a repository with none', async () => {
    const f = await releasing();
    f.repo.ci = { state: 'none', why: 'no workflow file' };
    expect((await cardOf(f)).text).toContain('No passed test run checked this commit. The repository has no CI.');
  });

  it('says to whoever asked, as the person approves it, what CI says then', async () => {
    const f = await releasing();
    const card = await cardOf(f);
    f.repo.ci = { state: 'pending', check: 'test (2)', url: null, outcome: 'queued' };
    await answer(f.ctx, { personId: f.claude.ownerPersonId }, card.id, { approve: true });
    const events = await f.db.select().from(taskEvents).where(eq(taskEvents.taskId, f.release.id));
    expect(events.map(e => e.text).join('\n')).toContain(`Approved ${f.R}. The repository's CI has not finished on this commit: test (2) is queued.`);
  });
});

describe('a record of a release', () => {
  const closedTurns = (f: Awaited<ReturnType<typeof released>>) => f.departmentTurns().then(rows => rows.filter(row => row.id === f.turn.id));

  it('closes its turn on the tag of a release recorded on green CI, with no run on record anywhere, never stale', async () => {
    const f = await released();
    expect(await f.db.select().from(testRuns)).toEqual([]);
    expect(await records(f)).toEqual([expect.objectContaining({ commit: f.R, runId: null, ciState: 'green', ciChecks: 3 })]);
    await f.round();
    expect(await closedTurns(f)).toEqual([expect.objectContaining({ status: 'closed', version: 'v1.7.0', commit: f.R })]);
    expect(f.errors).toEqual([]);
  });

  it('closes its turn on the tag of a release recorded where the repository has no CI', async () => {
    const f = await released({ record: false });
    /* The fixture moved main and tagged it already: record before that, as a holder does. */
    f.repo.heads.main = BASE;
    f.repo.ci = { state: 'none', why: 'no workflow file' };
    expect((await f.recordRelease()).isError).toBe(false);
    f.repo.heads.main = f.R;
    await f.round();
    expect(await closedTurns(f)).toEqual([expect.objectContaining({ status: 'closed', commit: f.R })]);
  });

  it('closes its turn though CI has turned red since it was recorded, as the host said it of that exact commit when it was', async () => {
    const f = await released();
    f.repo.ci = { state: 'red', check: 'test (2)', url: null, outcome: 'failure' };
    await f.round();
    expect(await closedTurns(f)).toEqual([expect.objectContaining({ status: 'closed' })]);
  });

  /* An installation that updates with a turn open before it: its records name a run, and the run may be long gone or since failed. */
  it('from before releases relied on CI, naming a run that failed since, still closes its turn on the tag', async () => {
    const f = await released({ record: false });
    await f.approve();
    const [job] = await f.db.select().from(jobs).where(eq(jobs.taskId, f.release.id));
    const [run] = await f.db.insert(testRuns).values({
      companyId: f.task.companyId, number: 9001, taskId: f.release.id, agentId: f.head.id, jobId: job!.id, departmentId: f.task.departmentId!,
      branch: f.branch, commitSha: f.R, command: '', parts: 2, timeoutMs: 600000, status: 'failed', finishedAt: new Date(),
    }).returning();
    const [approval] = await f.db.select().from(requests).where(eq(requests.taskId, f.release.id));
    await f.db.insert(turnReleases).values({ companyId: f.task.companyId, turnId: f.turn.id, commit: f.R, baseCommitSha: BASE, runId: run!.id, tasks: [], taskId: f.release.id, approvalRequestId: approval!.id, requestedByAgentId: f.head.id, covered: true, uncovered: [] });
    await f.round();
    expect(await closedTurns(f)).toEqual([expect.objectContaining({ status: 'closed', version: 'v1.7.0', commit: f.R })]);
  });

  it('names neither a run nor a CI result: it stands for nothing, and the turn stays open on its tag', async () => {
    const f = await released({ record: false });
    await f.approve();
    await f.db.insert(turnReleases).values({ companyId: f.task.companyId, turnId: f.turn.id, commit: f.R, baseCommitSha: BASE, tasks: [], taskId: f.release.id, requestedByAgentId: f.head.id, covered: true, uncovered: [] });
    await f.round();
    expect(await closedTurns(f)).toEqual([expect.objectContaining({ status: 'open' })]);
  });

  it('is kept honest by the schema: a CI result names its checks only where green, and a record names no run with one', async () => {
    const f = await released({ record: false });
    const base = { companyId: f.task.companyId, turnId: f.turn.id, commit: f.R, baseCommitSha: BASE, tasks: [], taskId: f.release.id, covered: true, uncovered: [] };
    for (const ci of [{ ciState: 'green' as const, ciChecks: 0 }, { ciState: 'green' as const, ciChecks: null }, { ciState: 'none' as const, ciChecks: 2 }, { ciState: 'amber', ciChecks: null }, { ciState: null, ciChecks: 3 }]) {
      await expect(f.db.insert(turnReleases).values({ ...base, ...ci }), JSON.stringify(ci)).rejects.toThrow();
    }
  });
});
