/* Throwaway security probe, #1579 rerun under #1686 on 6be3dfe9. Not for commit. A merge made on the turn branch (first parent
   the turn, second the work), H5 case 3 of #1579. Maps to zz-sec-1569-b1's stray-commit case, reached through such a merge.
   Change from the #1579 version: the holder's work starts as the server sees it, and a stray already on the turn when the work
   started is added. */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, teams } from '../src/db/schema.js';
import { report } from '../src/modules/tasks/engine.js';
import { BASE } from './development-echelons-fixture.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { releasing, startTurnkeyWork } from './turn-release-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

const STRAY = '1a'.repeat(20);
const OWN = '3c'.repeat(20);
const JOIN = '6f'.repeat(20);

type F = Awaited<ReturnType<typeof releasing>>;
type C = { sha: string; parents: string[] };

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

async function turnkey(f: F) {
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const holder = await f.hire('Solo', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: 'Turnkey probe', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  await startTurnkeyWork(f, holder, task.id);
  const close = (commit: string, baseCommit: string) => report(f.ctx, holder.id, task.id, { done: true, summary: 'Checked it myself.', turnkey: { commit, baseCommit } });
  return { task, holder, branch: `task-${task.number}`, close };
}

const record = async (f: F, commit: string) => f.recordRelease({ commit, runId: (await f.fullRun({ commit })).id });

describe('zz-sec-1579 B1x on 6be3dfe9: a merge made on the turn branch, first parent the turn, second the work', () => {
  it('OBSERVE H5.3: stray pushed after the work started; the merge named as the checked commit credits the stray and names the own work', async () => {
    const f = await releasing();
    const w = await turnkey(f);
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: STRAY, parents: [f.R] }, { sha: JOIN, parents: [STRAY, OWN] }], { [f.branch]: JOIN, [w.branch]: JOIN });
    await w.close(JOIN, f.R);
    const result = await record(f, JOIN);
    console.log('OBSERVE_H5_3', JSON.stringify({ isError: result.isError, text: result.text.slice(0, 800) }));
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${OWN} came in with no accepted candidate.`);
    expect(result.text).not.toContain(`${STRAY} came in`);
  });

  it('stray already on the turn as the work started: the same merge named as the checked commit leaves the stray and the own work to a person', async () => {
    const f = await releasing();
    graph(f, [{ sha: STRAY, parents: [f.R] }], { [f.branch]: STRAY });
    const w = await turnkey(f);
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: STRAY, parents: [f.R] }, { sha: JOIN, parents: [STRAY, OWN] }], { [f.branch]: JOIN, [w.branch]: JOIN });
    await expect(w.close(JOIN, f.R)).rejects.toMatchObject({ status: 409 });
    await w.close(JOIN, STRAY);
    const result = await record(f, JOIN);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${STRAY} came in with no accepted candidate.`);
    expect(result.text).toContain(`${OWN} came in with no accepted candidate.`);
  });

  it('named as its own commit, as the contract says, leaves the merge and the stray to a person', async () => {
    const f = await releasing();
    const w = await turnkey(f);
    graph(f, [{ sha: OWN, parents: [f.R] }, { sha: STRAY, parents: [f.R] }, { sha: JOIN, parents: [STRAY, OWN] }], { [f.branch]: JOIN, [w.branch]: OWN });
    await w.close(OWN, f.R);
    const result = await record(f, JOIN);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`${STRAY} came in with no accepted candidate.`);
    expect(result.text).toContain(`${JOIN} is a merge made outside every checked candidate.`);
  });
});
