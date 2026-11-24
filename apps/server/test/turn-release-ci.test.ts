import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, approvalPolicies, ciDispatches, jobs, requests, taskEvents, testRuns, turnReleases, turns } from '../src/db/schema.js';
import { answer } from '../src/modules/tasks/engine.js';
import { releaseCiRound } from '../src/modules/tasks/release-ci-round.js';
import type { CiAt } from '../src/modules/testruns/github-ci.js';
import type { Dispatched } from '../src/modules/testruns/github-dispatch.js';
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
    ['CI that ran jobs and none succeeded', { state: 'idle', checks: 2 }, ['ran 2 jobs', 'none succeeded']],
    ['a commit that took every workflow file away where its default branch has CI', { state: 'stripped', branch: 'main' }, ['keeps no workflow file', 'main has CI', 'no CI can run on it']],
    ['a repository whose release workflow cannot be told, never as one with no CI', { state: 'unnamed', why: 'More than one workflow was going on when the latest version release was made: Images (a.yml); Installer site (b.yml). Hornhoof does not guess which one releases.' }, ["release workflow can't be told", 'Images (a.yml); Installer site (b.yml)']],
    ['a repository whose host is not read, never as one with no CI', { state: 'unsupported', why: 'the repository is not on github.com, the only host whose CI is read' }, ["CI can't be read", 'not on github.com']],
  ])('refuses %s, and records nothing', async (_what, ci, words) => {
    const f = await releasing();
    f.repo.ci = ci;
    const result = await f.recordRelease();
    expect(result).toMatchObject({ isError: true });
    for (const word of words) expect(result.text).toContain(word);
    expect(result.text).toContain(f.R);
    expect(await records(f)).toEqual([]);
    expect(f.repo.dispatched ?? []).toEqual([]);
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


const absent: CiAt = { state: 'absent' };
type Fixture = Awaited<ReturnType<typeof releasing>>;
const dispatches = (f: Fixture) => f.db.select().from(ciDispatches).where(eq(ciDispatches.commit, f.R));
/* The words the holder was sent: the service messages the server wrote to it. */
const toldHolder = async (f: Fixture) => (await f.db.select().from(agentEvents).where(eq(agentEvents.agentId, f.head.id))).map(e => JSON.stringify(e.data)).join('\n');

/* No GitHub Actions run is on the commit yet, as on a turn branch the push of which starts none: the server starts the
   repository's release workflow itself, on the turn branch, once for each commit. */
describe('CI the server starts for a release', () => {
  it('keeps a request that waits for CI honest by the schema: one for each commit, one of three states, settled only once it ended or was recorded', async () => {
    const f = await releasing();
    const base = { companyId: f.task.companyId, turnId: f.turn.id, taskId: f.release.id, agentId: f.head.id, branch: f.branch, workflow: 'Release' };
    await f.db.insert(ciDispatches).values({ ...base, commit: f.R });
    await expect(f.db.insert(ciDispatches).values({ ...base, commit: f.R })).rejects.toThrow();
    const other = 'b'.repeat(40);
    for (const bad of [{ commit: 'main' }, { commit: other, state: 'amber' }, { commit: other, state: 'ended' }, { commit: other, settledAt: new Date() }, { commit: other, state: 'recorded', settledAt: new Date() }]) {
      await expect(f.db.insert(ciDispatches).values({ ...base, ...bad }), JSON.stringify(bad)).rejects.toThrow();
    }
  });

  it('starts the release workflow on the turn branch at that exact commit, answers that CI started, and records nothing yet', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    const result = await f.recordRelease();
    expect(result.isError, result.text).toBe(false);
    expect(recorded(result.text)).toMatchObject({ recorded: false, commit: f.R, turn: f.turn.number, ci: { state: 'started', workflow: 'Release (.github/workflows/release.yml)', run: 4242, url: 'https://github.com/acme/shop/actions/runs/4242' } });
    expect(recorded(result.text).next).toContain("CI started, run 4242; the release records when it's green.");
    expect(f.repo.dispatched).toEqual([{ branch: f.branch, commit: f.R }]);
    expect(await records(f)).toEqual([]);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'waiting', workflow: 'Release (.github/workflows/release.yml)', runId: 4242, branch: f.branch, taskId: f.release.id, agentId: f.head.id, releaseId: null, settledAt: null })]);
  });

  it('starts it once for a commit: asked again, it says CI was started and starts nothing', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    await f.recordRelease();
    const again = await f.recordRelease();
    expect(again.isError, again.text).toBe(false);
    expect(recorded(again.text)).toMatchObject({ recorded: false, ci: { state: 'started', run: 4242 } });
    expect(recorded(again.text).next).toContain('CI was started on this commit already, run 4242; the release records when it\'s green.');
    expect(f.repo.dispatched).toHaveLength(1);
    expect(await dispatches(f)).toHaveLength(1);
  });

  it('starts it once for a commit even where two holders ask in one moment', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    await Promise.all([f.recordRelease(), f.recordRelease()]);
    expect(f.repo.dispatched).toHaveLength(1);
    expect(await dispatches(f)).toHaveLength(1);
  });

  it('starts nothing for a commit the turn branch has gone past: CI starts on the head of a branch only', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    const head = 'e'.repeat(40);
    f.repo.heads[f.branch] = head;
    f.repo.holds[head] = [f.R, BASE];
    const result = await f.recordRelease();
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('CI starts on the head of a branch only') as unknown });
    expect(result.text).toContain(`Record the head of ${f.branch} (${head}) instead.`);
    expect(f.repo.dispatched ?? []).toEqual([]);
    expect(await dispatches(f)).toEqual([]);
  });

  it.each<[string, Dispatched, string]>([
    ['no workflow to start', { state: 'refused', why: 'No workflow of the repository can be started by hand (workflow_dispatch) with a latest run that was green.' }, 'No workflow of the repository can be started by hand'],
    ['a token that cannot start workflows', { state: 'refused', why: 'GitHub refused to start the workflow (403: Resource not accessible by integration). The repository token cannot start workflows: it needs the permission actions: write.' }, 'it needs the permission actions: write'],
    ['more than one workflow to start', { state: 'refused', why: 'More than one workflow can be started by hand and was green on the default branch last: Release (a.yml); Images (b.yml). Hornhoof does not guess which one releases.' }, 'Release (a.yml); Images (b.yml)'],
    ['a host that cannot be read', { state: 'unread', why: 'GitHub answered 502 when reading the checks' }, 'Try again.'],
    ['a used up request limit', { state: 'limited', limit: { remaining: 0, resetAt: Date.UTC(2026, 10, 24, 14, 10) } }, 'until 14:10 UTC'],
    ['a host that is not read', { state: 'unsupported', why: 'the repository is not on github.com' }, "CI can't be read"],
  ])('records nothing and keeps nothing where the dispatch meets %s, and starts again once it can', async (_what, dispatch, words) => {
    const f = await releasing();
    f.repo.ci = absent;
    f.repo.dispatch = dispatch;
    const result = await f.recordRelease();
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining(words) as unknown });
    expect(result.text).toContain('Nothing was started');
    expect(await records(f)).toEqual([]);
    expect(await dispatches(f)).toEqual([]);
    f.repo.dispatch = undefined;
    expect(recorded((await f.recordRelease()).text)).toMatchObject({ recorded: false, ci: { state: 'started' } });
  });

  it('keeps the request, and starts nothing again, where the request went out and its outcome is not known', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    f.repo.dispatch = { state: 'unsure', workflow: 'Release (.github/workflows/release.yml)', why: "GitHub didn't answer whether the workflow was started" };
    const first = await f.recordRelease();
    expect(first.isError, first.text).toBe(false);
    expect(recorded(first.text)).toMatchObject({ recorded: false, ci: { state: 'started', run: null } });
    expect(recorded(first.text).next).toContain("CI started; the release records when it's green.");
    await f.recordRelease();
    expect(f.repo.dispatched).toHaveLength(1);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'waiting', runId: null })]);
  });

  it('refuses where the server has no way to start CI, and where the dispatcher itself fails', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    f.ctx.dispatchCi = async () => { throw new Error('socket hang up'); };
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining('Nothing was started') as unknown });
    f.ctx.dispatchCi = undefined;
    expect(await f.recordRelease()).toMatchObject({ isError: true, text: expect.stringContaining("no way to start the repository's CI") as unknown });
    expect(await dispatches(f)).toEqual([]);
  });

  it('refuses a commit that was started before and ended with no result, naming why, and starts nothing again', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    await f.recordRelease();
    await f.db.update(ciDispatches).set({ state: 'ended', note: 'no GitHub Actions run appeared.', settledAt: new Date() }).where(eq(ciDispatches.commit, f.R));
    const result = await f.recordRelease();
    expect(result).toMatchObject({ isError: true, text: expect.stringContaining('ended with no result: no GitHub Actions run appeared.') as unknown });
    expect(result.text).toContain(`Push a new commit to ${f.branch}`);
    expect(f.repo.dispatched).toHaveLength(1);
  });

  it('records a started commit by hand once CI is green on it, and the round then marks the request recorded, once', async () => {
    const f = await releasing();
    f.repo.ci = absent;
    await f.recordRelease();
    f.repo.ci = { state: 'green', checks: 7 };
    expect((await f.recordRelease()).isError).toBe(false);
    await releaseCiRound(f.ctx);
    const [made] = await records(f);
    expect(await records(f)).toHaveLength(1);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'recorded', releaseId: made!.id })]);
  });
});

describe('the minute round for a release that waits for CI', () => {
  const started = async () => {
    const f = await releasing();
    f.repo.ci = absent;
    await f.recordRelease();
    return f;
  };

  it('records the release when CI is green on the exact commit, with no run, tells the holder, and answers its next ask with that record', async () => {
    const f = await started();
    f.repo.ci = { state: 'green', checks: 5 };
    await releaseCiRound(f.ctx);
    const [made] = await records(f);
    expect(made).toMatchObject({ commit: f.R, runId: null, ciState: 'green', ciChecks: 5, requestedByAgentId: f.head.id, taskId: f.release.id });
    expect(await records(f)).toHaveLength(1);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'recorded', releaseId: made!.id })]);
    expect(await toldHolder(f)).toContain(`CI is green on ${f.R} and the release of it is recorded.`);
    await releaseCiRound(f.ctx);
    const again = await f.recordRelease();
    expect(recorded(again.text)).toMatchObject({ release: made!.id, commit: f.R, ci: { state: 'green', checks: 5 } });
    expect(await records(f)).toHaveLength(1);
  });

  it('records where the repository turned out to have no CI, as a release does', async () => {
    const f = await started();
    f.repo.ci = { state: 'none', why: 'nothing' };
    await releaseCiRound(f.ctx);
    expect(await records(f)).toEqual([expect.objectContaining({ ciState: 'none', ciChecks: null })]);
  });

  it('does not say the release is recorded where the read that records it saw no run yet: the request waits on and starts nothing twice', async () => {
    const f = await started();
    let reads = 0;
    f.repo.ci = () => (++reads === 1 ? { state: 'green', checks: 5 } : absent);
    await releaseCiRound(f.ctx);
    expect(await records(f)).toEqual([]);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'waiting' })]);
    expect(await toldHolder(f)).not.toContain('is recorded');
    expect(f.repo.dispatched).toHaveLength(1);
  });

  it.each<[string, CiAt]>([
    ['still under way', { state: 'pending', check: 'Release / test', url: null, outcome: 'in_progress' }],
    ['not listed yet', absent],
    ['not readable now', { state: 'unread', why: 'GitHub answered 502 when reading the checks' }],
    ['not answered while the limit is used up', { state: 'limited', limit: { remaining: 0, resetAt: Date.UTC(2026, 10, 24, 14, 10) } }],
  ])('waits on while CI is %s, and records nothing', async (_what, ci) => {
    const f = await started();
    f.repo.ci = ci;
    await releaseCiRound(f.ctx);
    expect(await records(f)).toEqual([]);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'waiting' })]);
  });

  it.each<[string, CiAt, string]>([
    ['red', { state: 'red', check: 'Release / test (2)', url: RED_LINK, outcome: 'failure' }, `check Release / test (2) ended with failure (${RED_LINK})`],
    ['run with nothing that succeeded', { state: 'idle', checks: 2 }, 'none succeeded'],
    ['stripped of its workflows', { state: 'stripped', branch: 'main' }, 'keeps no workflow file'],
    ['without a release workflow Hornhoof can name', { state: 'unnamed', why: 'No workflow of the repository can be started by hand.' }, "release workflow can't be told"],
  ])('ends the request, records nothing and tells the holder why, where CI is %s', async (_what, ci, words) => {
    const f = await started();
    f.repo.ci = ci;
    await releaseCiRound(f.ctx);
    expect(await records(f)).toEqual([]);
    const [row] = await dispatches(f);
    expect(row).toMatchObject({ state: 'ended' });
    expect(row!.note).toContain(words);
    expect(await toldHolder(f)).toContain(`CI on ${f.R} ended with no release recorded`);
    f.repo.ci = { state: 'green', checks: 3 };
    await releaseCiRound(f.ctx);
    expect(await records(f)).toEqual([]);
  });

  it('ends the request where no run appeared on the commit in twenty minutes', async () => {
    const f = await started();
    f.repo.ci = absent;
    f.ctx.clock = () => Date.now() + 19 * 60_000;
    await releaseCiRound(f.ctx);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'waiting' })]);
    f.ctx.clock = () => Date.now() + 21 * 60_000;
    await releaseCiRound(f.ctx);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'ended', note: expect.stringContaining('no GitHub Actions run appeared') as unknown })]);
  });

  it('ends the request where the turn was released meanwhile, and records nothing', async () => {
    const f = await started();
    f.repo.ci = { state: 'green', checks: 3 };
    await f.db.update(turns).set({ status: 'closed', closedAt: new Date() }).where(eq(turns.id, f.turn.id));
    await releaseCiRound(f.ctx);
    expect(await records(f)).toEqual([]);
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'ended' })]);
  });

  it('ends the request with the refusal of release_turn where the release can no longer be recorded', async () => {
    const f = await started();
    f.repo.ci = { state: 'green', checks: 3 };
    f.repo.heads.main = f.R;
    await releaseCiRound(f.ctx);
    expect(await records(f)).toEqual([]);
    const [row] = await dispatches(f);
    expect(row).toMatchObject({ state: 'ended' });
    expect(row!.note).toContain('already holds');
    expect(await toldHolder(f)).toContain('already holds');
  });

  it('does not let one request that fails keep another from being looked at', async () => {
    const f = await started();
    f.ctx.readCi = async () => { throw new Error('socket hang up'); };
    await expect(releaseCiRound(f.ctx)).resolves.toBeUndefined();
    expect(await dispatches(f)).toEqual([expect.objectContaining({ state: 'waiting' })]);
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
    expect(card.text).toContain("Hornhoof checked as this was asked. The repository's CI is green on this commit: 3 jobs passed.");
    expect(card.text).not.toMatch(/test run/i);
    expect(card.said).toContain("The repository's CI is green on this commit: 3 jobs passed.");
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
