/* Throwaway security probe, #1579 rerun under #1686 on 6be3dfe9 (#1623's B1 fix). Not for commit.
   Maps to zz-sec-1569-b1: S1 is its "stray commit" case, S2 its "unaccepted base" case; both now under all three rules.
   Change from the #1579 version: the holder's work starts as the server sees it (startTurnkeyWork), since a report with no
   work-start note is now named as 'unstarted'; new cases cover H5 of #1579 and the server's work-start bound. */
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

const STRAY = '1a'.repeat(20);
const UNACCEPTED = '2b'.repeat(20);
const OWN = '3c'.repeat(20);
const ON_TOP = '4d'.repeat(20);
const MERGE = '5e'.repeat(20);

type F = Awaited<ReturnType<typeof releasing>>;
type C = { sha: string; parents: string[] };

/* The repository as a graph: every commit holds its ancestors; main at BASE..c lists the commits that lead to c, oldest first. */
function graph(f: F, commits: C[], heads: Record<string, string>) {
  const all: C[] = [{ sha: f.R, parents: [BASE] }, ...commits];
  const ancestors = (sha: string, seen = new Set<string>()): Set<string> => {
    for (const p of all.find(c => c.sha === sha)?.parents ?? []) if (!seen.has(p)) { seen.add(p); ancestors(p, seen); }
    return seen;
  };
  for (const c of all) {
    const up = ancestors(c.sha);
    f.repo.holds[c.sha] = [...up];
    f.repo.between[`${BASE}..${c.sha}`] = all.filter(o => o.sha === c.sha || up.has(o.sha));
  }
  Object.assign(f.repo.heads, heads);
}

/* A turnkey holder with a task; its work starts (the server notes the turn head) unless started is false. */
async function turnkey(f: F, started = true) {
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const holder = await f.hire('Solo', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: 'Turnkey probe', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  if (started) await startTurnkeyWork(f, holder, task.id);
  const close = (commit: string, baseCommit: string) => report(f.ctx, holder.id, task.id, { done: true, summary: 'Checked it myself.', turnkey: { commit, baseCommit } });
  return { task, holder, branch: `task-${task.number}`, close };
}

const policy = (f: F) => f.db.insert(approvalPolicies).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, channel: 'commit', mode: 'every' });
const RULES = [
  ['autonomous release', async (f: F) => { await policy(f); await f.db.update(departments).set({ autonomousRelease: true }).where(eq(departments.id, f.task.departmentId!)); }],
  ['no commit rule', async (_f: F) => undefined],
  ['required commit rule', policy],
] as const;

const line = (sha: string) => `${sha} came in with no accepted candidate.`;
const openCard = async (f: F) => (await f.db.select().from(requests).where(and(eq(requests.taskId, f.release.id), eq(requests.status, 'open'))).orderBy(desc(requests.createdAt)).limit(1))[0]!;
const recorded = async (f: F, commit: string) => { const run = await f.fullRun({ commit }); return { run, result: await f.recordRelease({ commit, runId: run.id }) }; };

/* What the report tool tells the holder to name. */
async function contract(f: F): Promise<string> {
  const tool = (await f.client.listTools()).tools.find(t => t.name === 'report')!;
  const tk = (tool.inputSchema.properties as Record<string, { properties: Record<string, { description: string }> }>).turnkey!;
  return `${tool.description}\n${tk.properties.baseCommit!.description}\n${tk.properties.commit!.description}`;
}

/* Each shape returns the release commit, the commits that must be named and the commits that must not be. */
const SHAPES = [
  ['S1 stray commit pushed to the turn after the work started, then a plain fast-forward (zz-sec-1569-b1 stray)', async (f: F) => {
    const w = await turnkey(f);
    graph(f, [{ sha: STRAY, parents: [f.R] }, { sha: OWN, parents: [STRAY] }], { [f.branch]: OWN, [w.branch]: OWN });
    await w.close(OWN, STRAY);
    return { release: OWN, named: [STRAY], credited: [OWN] };
  }],
  ['S1b stray commit on the turn before the work started: a start under it is refused, the stray is named', async (f: F) => {
    graph(f, [{ sha: STRAY, parents: [f.R] }], { [f.branch]: STRAY });
    const w = await turnkey(f);
    graph(f, [{ sha: STRAY, parents: [f.R] }, { sha: OWN, parents: [STRAY] }], { [f.branch]: OWN, [w.branch]: OWN });
    await expect(w.close(OWN, f.R)).rejects.toMatchObject({ status: 409 });
    await expect(w.close(OWN, BASE)).rejects.toMatchObject({ status: 409 });
    await w.close(OWN, STRAY);
    return { release: OWN, named: [STRAY], credited: [OWN] };
  }],
  ['S2 built on an unaccepted commit of another branch, named as the contract says (zz-sec-1569-b1 unaccepted base, H5 of #1579)', async (f: F) => {
    const words = await contract(f);
    expect(words).toContain('commit right under your first own commit');
    expect(words).toContain("where you built on another branch's commit, that commit");
    expect(words).toContain('never a merge made on the turn branch');
    expect(words).not.toMatch(/commit of main or the turn branch/);
    const w = await turnkey(f);
    graph(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: OWN, parents: [UNACCEPTED] }], { 'task-77777': UNACCEPTED, [f.branch]: OWN, [w.branch]: OWN });
    await w.close(OWN, UNACCEPTED);
    return { release: OWN, named: [UNACCEPTED], credited: [OWN] };
  }],
  ['S3 commit pushed onto the checked tip before the report', async (f: F) => {
    const w = await turnkey(f);
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: ON_TOP, parents: [OWN] }], { [f.branch]: ON_TOP, [w.branch]: ON_TOP });
    await w.close(OWN, f.R);
    return { release: ON_TOP, named: [ON_TOP], credited: [OWN] };
  }],
  ['S4 stray commit laundered through a take-in merge second parent', async (f: F) => {
    const w = await turnkey(f);
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: STRAY, parents: [f.R] }, { sha: MERGE, parents: [OWN, STRAY] }], { [f.branch]: MERGE, [w.branch]: MERGE });
    await w.close(MERGE, f.R);
    return { release: MERGE, named: [STRAY], credited: [OWN, MERGE] };
  }],
  ['S4b take-in merge, holder names the second-parent stray as its start', async (f: F) => {
    const w = await turnkey(f);
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: STRAY, parents: [f.R] }, { sha: MERGE, parents: [OWN, STRAY] }], { [f.branch]: MERGE, [w.branch]: MERGE });
    await w.close(MERGE, STRAY);
    return { release: MERGE, named: [STRAY], credited: [OWN, MERGE] };
  }],
] as const;

describe('zz-sec-1579 B1 on 6be3dfe9: each shape is named at release and needs a person', () => {
  describe.each(RULES)('%s', (_rule, rule) => {
    it.each(SHAPES)('%s', async (_name, shape) => {
      const f = await releasing();
      await rule(f);
      const s = await shape(f);
      const { run, result: refused } = await recorded(f, s.release);
      expect(refused.isError, refused.text).toBe(true);
      for (const sha of s.named) expect(refused.text).toContain(line(sha));
      for (const sha of s.credited) expect(refused.text).not.toContain(sha + ' came in');
      expect(refused.text).not.toContain('is a merge made outside');
      expect(refused.text).not.toContain('is not on record');
      const asked = await f.call('ask_person', { task: f.release.number, question: `Release turn ${f.turn.number}: main to ${s.release}.`, commit: s.release });
      expect(asked.isError, asked.text).toBe(false);
      const card = await openCard(f);
      expect(card.unchecked).toEqual(s.named.map(commit => ({ kind: 'commit', commit })));
      await answer(f.ctx, { personId: f.claude.ownerPersonId }, card.id, { approve: true });
      const done = await f.recordRelease({ commit: s.release, runId: run.id });
      expect(done.isError, done.text).toBe(false);
      expect(JSON.parse(done.text)).toMatchObject({ approvalRequestId: card.id, autonomousReleaseId: null, covered: false, uncovered: s.named.map(line) });
    });
  });
});

describe('zz-sec-1579 B1 on 6be3dfe9: the report pins what it names, and the server notes where the work started', () => {
  it('refuses a commit task-N does not hold, a start the commit does not hold, and a commit the turn does not hold', async () => {
    const f = await releasing();
    const w = await turnkey(f);
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: STRAY, parents: [f.R] }], { [f.branch]: f.R, [w.branch]: OWN });
    await expect(w.close(STRAY, f.R)).rejects.toMatchObject({ status: 409 });
    await expect(w.close(OWN, STRAY)).rejects.toMatchObject({ status: 409 });
    await expect(w.close(OWN, f.R)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail(w.task.id)).status).not.toBe('done');
  });

  it('refuses a start below where the turn was as the work started (main named while the work started at R)', async () => {
    const f = await releasing();
    const w = await turnkey(f);
    graph(f, [{ sha: STRAY, parents: [f.R] }, { sha: OWN, parents: [STRAY] }], { [f.branch]: OWN, [w.branch]: OWN });
    await expect(w.close(OWN, BASE)).rejects.toMatchObject({ status: 409, message: expect.stringContaining(`${BASE} does not hold ${f.R}`) as unknown });
    expect((await f.detail(w.task.id)).status).not.toBe('done');
  });

  it('keeps the named commit, start and work start on the record, not the branch tip', async () => {
    const f = await releasing();
    const w = await turnkey(f);
    const [started] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, w.task.id), eq(taskEvents.kind, 'status')));
    expect(started!.data).toMatchObject({ toStatus: 'working', start: { turn: f.turn.number, turnHead: f.R, main: BASE } });
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: ON_TOP, parents: [OWN] }], { [f.branch]: ON_TOP, [w.branch]: ON_TOP });
    await w.close(OWN, f.R);
    const [closed] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, w.task.id), eq(taskEvents.kind, 'report')));
    expect(closed!.data.integration).toMatchObject({ commit: OWN, start: f.R, workStart: f.R });
  });

  it('names work whose start the server has no note of, and credits none of it, under every rule', async () => {
    for (const [, rule] of RULES) {
      const f = await releasing();
      await rule(f);
      const w = await turnkey(f, false);
      graph(f, [{ sha: OWN, parents: [f.R] }], { [f.branch]: OWN, [w.branch]: OWN });
      await w.close(OWN, f.R);
      const { result } = await recorded(f, OWN);
      expect(result.isError, result.text).toBe(true);
      expect(result.text).toContain(`#${w.task.number}: where this turnkey work started is not on record, so none of its commits counts as checked.`);
      expect(result.text).toContain(line(OWN));
    }
  });

  it('refuses turnkey on a report that is not turnkey work', async () => {
    const f = await releasing();
    await expect(report(f.ctx, f.head.id, f.release.id, { done: true, summary: 'x', turnkey: { commit: f.R, baseCommit: BASE } })).rejects.toMatchObject({ status: 400 });
  });
});

describe('zz-sec-1579 B1 on 6be3dfe9: what is still the holder\'s word (observation, trust model)', () => {
  it('OBSERVE H5.1: built on an unaccepted commit and naming the turn commit under it, against the new contract, still credits that commit', async () => {
    const f = await releasing();
    const w = await turnkey(f);
    graph(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: OWN, parents: [UNACCEPTED] }], { 'task-77777': UNACCEPTED, [f.branch]: OWN, [w.branch]: OWN });
    await w.close(OWN, f.R);
    const { result } = await recorded(f, OWN);
    console.log('OBSERVE_H5_1', JSON.stringify({ isError: result.isError, text: result.text.slice(0, 600) }));
    expect(result.isError, result.text).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ covered: true, uncovered: [] });
  });

  it('OBSERVE H5.1b: the same with the unaccepted commit made before the work started on another branch', async () => {
    const f = await releasing();
    graph(f, [{ sha: UNACCEPTED, parents: [f.R] }], { 'task-77777': UNACCEPTED });
    const w = await turnkey(f);
    graph(f, [{ sha: UNACCEPTED, parents: [f.R] }, { sha: OWN, parents: [UNACCEPTED] }], { 'task-77777': UNACCEPTED, [f.branch]: OWN, [w.branch]: OWN });
    await w.close(OWN, f.R);
    const { result } = await recorded(f, OWN);
    console.log('OBSERVE_H5_1B', JSON.stringify({ isError: result.isError, text: result.text.slice(0, 600) }));
    expect(JSON.parse(result.text)).toMatchObject({ covered: true, uncovered: [] });
  });

  it('OBSERVE H5.2: a stray pushed to the turn after the work started, rebased under the work, with the work-start commit named, is credited', async () => {
    const f = await releasing();
    const w = await turnkey(f);
    graph(f, [{ sha: STRAY, parents: [f.R] }, { sha: OWN, parents: [STRAY] }], { [f.branch]: OWN, [w.branch]: OWN });
    await w.close(OWN, f.R);
    const { result } = await recorded(f, OWN);
    console.log('OBSERVE_H5_2', JSON.stringify({ isError: result.isError, text: result.text.slice(0, 600) }));
    expect(JSON.parse(result.text)).toMatchObject({ covered: true, uncovered: [] });
  });
});
