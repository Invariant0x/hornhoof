import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, departments, taskEvents, teams } from '../src/db/schema.js';
import { loadTask, report } from '../src/modules/tasks/engine.js';
import type { RefUpdate } from '../src/modules/repos/ref-push.js';
import { BASE } from './development-echelons-fixture.js';
import { prepareSharedDatabase } from './helpers-db.js';
import { prepareTemplates } from './templates-once.js';
import { releasing, startTurnkeyWork } from './turn-release-fixture.js';

await prepareSharedDatabase();
prepareTemplates();

/* #1964: a holder of turnkey work no longer fast-forwards the turn branch itself. It names the commit it checked, and Hornhoof
   takes it into the turn branch as a merge commit of its own, which names the task and has the candidate's own tree. R is the
   checked candidate of the turn, at the head of the turn branch before the turnkey work. */
const OWN = '4'.repeat(40);
const NEWER = '5'.repeat(40);
const FOREIGN = '1'.repeat(40);
const OWN_TREE = 'c'.repeat(40);
const WHO = { name: 'Ivan Korol', email: 'ivan@example.com' };

type Releasing = Awaited<ReturnType<typeof releasing>>;
type Commit = { sha: string; parents: string[] };

/* The commit a pack of one commit holds, as git's own object: its text, its tree and its parents. */
function commitOf(pack: Buffer): { sha: string; text: string; tree: string; parents: string[] } {
  let at = 12;
  while (pack[at++]! & 0x80);
  const text = inflateSync(pack.subarray(at, pack.length - 20)).toString('utf8');
  const sha = createHash('sha1').update(`commit ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
  const lines = text.split('\n');
  return { sha, text, tree: lines[0]!.slice('tree '.length), parents: lines.filter(l => l.startsWith('parent ')).map(l => l.slice('parent '.length)) };
}

/* A repository that takes a push as a host does: the ref moves only from the value the push names, and what the new commit holds
   is what its parents hold. pushes records every change asked. The trees are what the candidate and the commits hold. */
function pushing(f: Releasing, known: Commit[], answer?: (updates: readonly RefUpdate[]) => string | null) {
  const pushes: { updates: readonly RefUpdate[]; commit: ReturnType<typeof commitOf> | null }[] = [];
  const all = () => [{ sha: f.R, parents: [BASE] }, ...known];
  const holdsOf = (sha: string): string[] => {
    const c = all().find(found => found.sha === sha);
    return c ? [...new Set(c.parents.flatMap(p => [p, ...holdsOf(p)]))] : [];
  };
  const lay = () => {
    for (const c of all()) {
      f.repo.holds[c.sha] = holdsOf(c.sha);
      f.repo.between[`${BASE}..${c.sha}`] = all().filter(other => other.sha === c.sha || f.repo.holds[c.sha]!.includes(other.sha));
    }
  };
  f.ctx.readTreeSha = async (_repo, commit) => (commit === OWN ? OWN_TREE : null);
  f.ctx.pushRefs = async (_repo, updates, options) => {
    const commit = options?.pack ? commitOf(options.pack) : null;
    pushes.push({ updates, commit });
    const refused = answer?.(updates);
    if (refused) return { refs: Object.fromEntries(updates.map(u => [u.ref, refused])) };
    for (const { ref, old, next } of updates) {
      const branch = ref.replace('refs/heads/', '');
      if ((f.repo.heads[branch] ?? null) !== old) return { refs: { [ref]: 'stale info' } };
      if (next && commit) known.push({ sha: commit.sha, parents: commit.parents });
      if (next) f.repo.heads[branch] = next;
    }
    lay();
    return { refs: Object.fromEntries(updates.map(u => [u.ref, null])) };
  };
  lay();
  return { pushes, lay, commits: known };
}

/* A member of a turnkey team with a task of the turn's department, at work on it, with its work made on R and the turn branch
   still at R: it names the commit it checked and nothing more. */
async function turnkeyTask(f: Releasing, options: { author?: boolean } = {}) {
  if (options.author !== false) await f.db.update(departments).set({ repoAuthorName: WHO.name, repoAuthorEmail: WHO.email }).where(eq(departments.id, f.task.departmentId!));
  const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Lane', turnkey: true }).returning();
  const holder = await f.hire('Player', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
  await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, holder.id));
  const { task } = await f.create({ title: 'Turnkey change', assigneeAgentId: holder.id, reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined });
  await startTurnkeyWork(f, holder, task.id);
  const branch = `task-${task.number}`;
  const done = (checked = { commit: OWN, baseCommit: f.R }) => report(f.ctx, holder.id, task.id, { done: true, summary: 'My own review, security check and tests passed.', turnkey: checked });
  const closing = async () => (await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report'))))[0];
  return { task, holder, branch, done, closing };
}

const refusal = (moving: Promise<unknown>) => moving.then(() => null, (err: { status: number; message: string }) => err);
const recorded = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe('turnkey work reported with the turn branch not at its commit is taken in by Hornhoof as a merge commit of its own', () => {
  it('makes one merge commit naming the task, over the turn head and the commit checked, with its own tree, and records it', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const { pushes, commits } = pushing(f, [{ sha: OWN, parents: [f.R] }]);
    f.repo.heads[work.branch] = OWN;
    const closed = await work.done();
    expect(closed.task).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.updates).toEqual([{ ref: `refs/heads/${f.branch}`, old: f.R, next: expect.stringMatching(/^[0-9a-f]{40}$/) as unknown }]);
    const merge = pushes[0]!.commit!;
    expect(merge).toMatchObject({ tree: OWN_TREE, parents: [f.R, OWN] });
    expect(merge.text).toContain(`Take in ${work.branch} (#${work.task.number})`);
    expect(merge.text).toContain(`Signed-off-by: ${WHO.name} <${WHO.email}>`);
    expect(f.repo.heads[f.branch]).toBe(merge.sha);
    expect(commits.filter(c => c.parents.length > 1)).toEqual([{ sha: merge.sha, parents: [f.R, OWN] }]);
    expect((await work.closing())!.data).toMatchObject({ done: true, integration: { branch: f.branch, commit: OWN, merge: merge.sha, start: f.R, workStart: f.R, from: work.branch } });
  });

  it('is covered in a release as the commit its holder checked: the merge adds nothing of its own to the tree', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    pushing(f, [{ sha: OWN, parents: [f.R] }]);
    f.repo.heads[work.branch] = OWN;
    await work.done();
    const merge = f.repo.heads[f.branch]!;
    const run = await f.fullRun({ commit: merge });
    const result = await f.recordRelease({ commit: merge, runId: run.id });
    expect(result.isError).toBe(false);
    expect(recorded(result.text)).toMatchObject({ approvalRequestId: null, covered: true, uncovered: [] });
  });

  it('names a merge made on the turn branch that the report did not record, as before', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const { pushes, lay, commits } = pushing(f, [{ sha: OWN, parents: [f.R] }, { sha: FOREIGN, parents: [f.R] }]);
    f.repo.heads[work.branch] = OWN;
    await work.done();
    const merge = pushes[0]!.commit!.sha;
    /* Someone then merged a commit of nobody's straight into the turn branch, and a report is made to name that merge. */
    const forged = 'd'.repeat(40);
    commits.push({ sha: forged, parents: [merge, FOREIGN] });
    f.repo.heads[f.branch] = forged;
    lay();
    const [closed] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, work.task.id), eq(taskEvents.kind, 'report')));
    await f.db.update(taskEvents).set({ data: { ...closed!.data, integration: { ...(closed!.data.integration as Record<string, unknown>), merge: forged } } }).where(eq(taskEvents.id, closed!.id));
    const run = await f.fullRun({ commit: forged });
    const refused = await f.recordRelease({ commit: forged, runId: run.id });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain(`${forged} is a merge made outside every checked candidate.`);
  });

  it('refuses a commit that does not hold the turn branch, says to take the turn branch in first, and pushes nothing', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const { pushes } = pushing(f, [{ sha: OWN, parents: [f.R] }, { sha: NEWER, parents: [f.R] }]);
    f.repo.heads[work.branch] = OWN;
    f.repo.heads[f.branch] = NEWER;
    const refused = await refusal(work.done());
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining(`take ${f.branch} into ${work.branch}`) as unknown });
    expect(pushes).toHaveLength(0);
    expect(await loadTask(f.db, work.task.id)).toMatchObject({ status: expect.not.stringMatching(/done/) as unknown, turnId: null });
    expect(f.repo.heads[f.branch]).toBe(NEWER);
  });

  it('keeps the turn branch and the task as they were where the turn branch went on before the push, and says so', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const { pushes } = pushing(f, [{ sha: OWN, parents: [f.R] }], () => 'stale info');
    f.repo.heads[work.branch] = OWN;
    const refused = await refusal(work.done());
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('went on') as unknown });
    expect(pushes).toHaveLength(1);
    expect(f.repo.heads[f.branch]).toBe(f.R);
    expect(await loadTask(f.db, work.task.id)).toMatchObject({ status: expect.not.stringMatching(/done/) as unknown, turnId: null });
  });

  it('still takes a fast-forward its holder made, with no merge and no push', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const { pushes } = pushing(f, [{ sha: OWN, parents: [f.R] }]);
    f.repo.heads[work.branch] = OWN;
    f.repo.heads[f.branch] = OWN;
    expect((await work.done()).task).toMatchObject({ status: 'done', turnId: f.turn.id });
    expect(pushes).toHaveLength(0);
    expect((await work.closing())!.data.integration).not.toHaveProperty('merge');
  });

  it('refuses to make a merge nobody can sign when the department names no author for its commits, and pushes nothing', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f, { author: false });
    const { pushes } = pushing(f, [{ sha: OWN, parents: [f.R] }]);
    f.repo.heads[work.branch] = OWN;
    const refused = await refusal(work.done());
    expect(refused).toMatchObject({ status: 409, message: expect.stringContaining('author') as unknown });
    expect(pushes).toHaveLength(0);
    expect(f.repo.heads[f.branch]).toBe(f.R);
  });

  it('refuses when the tree of the commit cannot be read, and pushes nothing', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    const { pushes } = pushing(f, [{ sha: OWN, parents: [f.R] }]);
    f.ctx.readTreeSha = async () => null;
    f.repo.heads[work.branch] = OWN;
    expect(await refusal(work.done())).toMatchObject({ status: 409, message: expect.stringContaining('could not be read') as unknown });
    expect(pushes).toHaveLength(0);
  });

  it('takes work in no way where the repository takes no push from Hornhoof: the refusal is the fast-forward one as before', async () => {
    const f = await releasing();
    const work = await turnkeyTask(f);
    pushing(f, [{ sha: OWN, parents: [f.R] }]);
    f.ctx.pushRefs = undefined;
    f.repo.heads[work.branch] = OWN;
    expect(await refusal(work.done())).toMatchObject({ status: 409, message: expect.stringContaining(`fast-forward ${f.branch} to ${work.branch} first`) as unknown });
    expect(f.repo.heads[f.branch]).toBe(f.R);
  });
});
