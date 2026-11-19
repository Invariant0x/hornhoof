import { describe, expect, it } from 'vitest';
import type { CommitWanted } from '../src/modules/testruns/refs.js';
import { submit } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const code = (review: object = {}) => ({ summary: 'Keep totals.', evidence: 'Focused checks passed.', review: { baseCommit: BASE, ...review } });
const NOT_OWN = 'The repository has no branch task-1 or task-1-... Push the task\'s branch, or name the branch to test.';

/* The fixture's repository has only the given branches and its main line at the base; the task's own branch name is not
   among them. */
async function onBranches(given: Record<string, string>) {
  const heads: Record<string, string> = { main: BASE, ...given };
  const f = await fixture();
  const asked: CommitWanted[] = [];
  f.ctx.readCommit = async (_repo, want) => {
    asked.push(want);
    if ('task' in want) return heads[`task-${want.task}`] ? { branch: `task-${want.task}`, commitSha: heads[`task-${want.task}`]! } : { problem: NOT_OWN };
    return heads[want.branch] ? { branch: want.branch, commitSha: heads[want.branch]! } : { problem: `The repository has no branch ${want.branch}.` };
  };
  return { ...f, asked };
}

describe('a submission names the exact source it hands forward', () => {
  it('takes the work from a branch the author names', async () => {
    const f = await onBranches({ 'task-717': HEAD });
    await submit(f.ctx, f.author.id, f.task.id, code({ branch: 'task-717' }));
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({ stage: 'review' });
    expect(detail.log.findLast(event => event.kind === 'submitted')?.data).toMatchObject({ candidate: { branch: 'task-717', commit: HEAD } });
  });

  it('refuses a submission whose branch cannot be read and says why, instead of recording an empty candidate', async () => {
    const f = await onBranches({ 'task-717': HEAD });
    await expect(submit(f.ctx, f.author.id, f.task.id, code()).then(() => null)).rejects.toMatchObject({ status: 409, message: NOT_OWN });
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({ stage: 'development', candidateId: null });
    expect(detail.log.some(event => event.kind === 'submitted')).toBe(false);
  });

  it('refuses a named commit that is not the head of its branch', async () => {
    const f = await onBranches({ 'task-717': HEAD });
    await expect(submit(f.ctx, f.author.id, f.task.id, code({ branch: 'task-717', commit: 'c'.repeat(40) })).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.stage).toBe('development');
    await submit(f.ctx, f.author.id, f.task.id, code({ branch: 'task-717', commit: HEAD }));
    expect((await f.detail()).echelons.stage).toBe('review');
  });

  it('refuses a submission when the repository cannot be read at all', async () => {
    const f = await fixture();
    f.ctx.readCommit = async () => { throw new Error('network down'); };
    await expect(submit(f.ctx, f.author.id, f.task.id, code()).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.candidateId).toBeNull();
  });

  it('keeps a repair on the branch of the candidate it repairs', async () => {
    const f = await onBranches({ 'task-717': HEAD });
    await submit(f.ctx, f.author.id, f.task.id, code({ branch: 'task-717' }));
    f.asked.length = 0;
    const repaired = 'c'.repeat(40);
    f.ctx.readCommit = async (_repo, want) => { f.asked.push(want); return 'branch' in want && want.branch === 'task-717' ? { branch: 'task-717', commitSha: repaired } : { problem: NOT_OWN }; };
    await submit(f.ctx, f.reviewer.id, f.task.id, { ...code(), summary: 'Repaired a finding.' });
    expect(f.asked).toEqual([{ branch: 'task-717' }]);
    expect((await f.detail()).log.findLast(event => event.kind === 'submitted')?.data).toMatchObject({ candidate: { branch: 'task-717', commit: repaired } });
  });
});
