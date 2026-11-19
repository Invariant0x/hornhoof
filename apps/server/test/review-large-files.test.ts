import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskEvents } from '../src/db/schema.js';
import { submit } from '../src/modules/tasks/engine.js';
import { readCompare } from '../src/modules/testruns/compare.js';
import { BASE, FIRST, fixture } from './review-fixture.js';

/* GitHub's comparison of the base and the candidate, as its API answers it. */
const comparison = (files: object[]) => ({ base_commit: { sha: BASE }, commits: [{ sha: FIRST }], total_commits: 1, status: 'ahead', files });
const answering = (body: object) => vi.stubGlobal('fetch', async () => Response.json(body));

afterEach(() => { vi.unstubAllGlobals(); });

describe('a candidate with a file too large for GitHub to show', () => {
  it('hands in a candidate whose file GitHub left without a patch, with every path and the true count of changed lines', async () => {
    const f = await fixture();
    f.ctx.readCompare = readCompare;
    /* A database snapshot of a migration: GitHub lists the file and its counts, but no patch. */
    answering(comparison([{ filename: 'logic/totals.ts', additions: 16641, deletions: 0 }]));
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } });
    expect((await f.event('submitted')).data.review).toMatchObject({ commit: FIRST, source: { baseCommit: BASE, commit: FIRST, paths: ['logic/totals.ts'], changedLines: 16641 } });
  });

  it('names a file GitHub left without a patch in the diff, and counts its lines', async () => {
    answering(comparison([
      { filename: 'logic/totals.ts', patch: '@@ -3 +3 @@\n-old\n+new', additions: 1, deletions: 1 },
      { filename: 'logic/snapshot.json', previous_filename: 'logic/old-snapshot.json', additions: 16641, deletions: 3 },
    ]));
    expect(await readCompare({ url: 'https://github.com/acme/shop.git', token: '' }, { base: BASE, head: FIRST })).toEqual({
      complete: true, baseSha: BASE, headSha: FIRST, paths: ['logic/totals.ts', 'logic/snapshot.json', 'logic/old-snapshot.json'],
      diff: '@@ -3 +3 @@\n-old\n+new\nGitHub shows no patch of logic/snapshot.json: 16641 lines added, 3 removed.',
      omitted: [{ path: 'logic/snapshot.json', additions: 16641, deletions: 3 }],
      commits: [{ sha: FIRST, parents: [] }],
    });
  });

  it('still takes a patch GitHub cut short, or a list of 300 files, for no comparison, which proves only the line', async () => {
    const repo = { url: 'https://github.com/acme/shop.git', token: '' };
    const lineage = { baseSha: BASE, headSha: FIRST, commits: [{ sha: FIRST, parents: [] }] };
    answering(comparison([{ filename: 'logic/totals.ts', patch: '@@ -3 +3 @@\n+new', additions: 5, deletions: 0 }]));
    expect(await readCompare(repo, { base: BASE, head: FIRST })).toEqual({ complete: false, reason: 'incomplete-comparison', lineage });
    answering(comparison(Array.from({ length: 300 }, (_, i) => ({ filename: `logic/f${i}.ts`, patch: '+a', additions: 1, deletions: 0 }))));
    expect(await readCompare(repo, { base: BASE, head: FIRST })).toEqual({ complete: false, reason: 'too-many-files', lineage });
    answering({ base_commit: { sha: BASE }, commits: [{ sha: FIRST }], total_commits: 1, status: 'ahead' });
    expect(await readCompare(repo, { base: BASE, head: FIRST })).toEqual({ complete: false, reason: 'incomplete-comparison' });
  });

  it('refuses plainly a candidate whose change has more files than GitHub lists, and records nothing', async () => {
    const f = await fixture();
    f.ctx.readCompare = readCompare;
    answering(comparison(Array.from({ length: 300 }, (_, i) => ({ filename: `logic/f${i}.ts`, patch: '+a', additions: 1, deletions: 0 }))));
    await expect(submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 409,
      message: `GitHub lists at most 300 files of a comparison, and the change from ${BASE} to ${FIRST} has that many or more, so it cannot be read whole. Check that review.baseCommit is the commit the change starts from, or hand in a smaller change.` });
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')))).toEqual([]);
  });

  it('refuses a candidate whose file without a patch lies outside the paths the head approved, and records nothing', async () => {
    const f = await fixture();
    f.ctx.readCompare = readCompare;
    answering(comparison([
      { filename: 'logic/totals.ts', patch: '@@ -3 +3 @@\n-old\n+new', additions: 1, deletions: 1 },
      { filename: 'deploy/secrets.json', additions: 20000, deletions: 0 },
    ]));
    await expect(submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 403 });
    answering(comparison([{ filename: 'logic/totals.ts', previous_filename: 'deploy/old.json', additions: 0, deletions: 0 }]));
    await expect(submit(f.ctx, f.author.id, f.task.id, { summary: 'Done', evidence: 'Checks', review: { baseCommit: BASE } })).rejects.toMatchObject({ status: 403 });
    expect(await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')))).toEqual([]);
  });
});
