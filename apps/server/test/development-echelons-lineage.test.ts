import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const FIX = 'c'.repeat(40);
const code = { summary: 'Keep totals.', evidence: 'Affected checks.', review: { baseCommit: BASE } };
const pass = { pass: true, comment: 'Checked the assigned source.', reviewedCommit: HEAD };

async function submitted() {
  const f = await fixture();
  await submit(f.ctx, f.author.id, f.task.id, code);
  const [event] = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
  return { ...f, event: event! };
}

describe('a repair preserves the assigned candidate history', () => {
  it.each(['base', 'branch', 'ancestry'] as const)('refuses a repair that changes its %s', async problem => {
    const f = await submitted();
    const candidateId = (await f.detail()).echelons.candidateId;
    f.atCommit(FIX);
    if (problem === 'branch') f.ctx.readCommit = async () => ({ branch: 'unrelated-fork', commitSha: FIX });
    if (problem === 'ancestry') {
      const compare = f.ctx.readCompare!;
      f.ctx.readCompare = async (repo, refs, timeout) => refs.base === HEAD ? { complete: false, reason: 'not-an-ancestor' } : compare(repo, refs, timeout);
    }
    const review = { baseCommit: problem === 'base' ? HEAD : BASE };
    await expect(submit(f.ctx, f.reviewer.id, f.task.id, { ...code, review }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', ownerAgentId: f.reviewer.id, candidateId });
    expect((await f.detail()).log.filter(row => row.kind === 'submitted')).toHaveLength(1);
  });

  it('proves a repair holds the candidate by the line of a comparison whose files GitHub capped at 300', async () => {
    const f = await submitted();
    f.atCommit(FIX);
    const compare = f.ctx.readCompare!;
    f.ctx.readCompare = async (repo, refs, timeout) => refs.base === HEAD ? { complete: false, reason: 'too-many-files', lineage: { baseSha: HEAD, headSha: refs.head, commits: [] } } : compare(repo, refs, timeout);
    await submit(f.ctx, f.reviewer.id, f.task.id, code);
    expect((await f.detail()).log.findLast(row => row.kind === 'submitted')?.data).toMatchObject({ candidate: { commit: FIX, baseCommit: BASE } });
  });

  it('ignores a comment that copies a candidate identity over the immutable submission', async () => {
    const f = await submitted();
    const candidate = f.event.data.candidate as Record<string, unknown>;
    await f.db.insert(taskEvents).values({ companyId: f.task.companyId, taskId: f.task.id, kind: 'comment', agentId: f.reviewer.id, text: 'An untrusted copied candidate.', data: { candidate: { ...candidate, commit: FIX } } });
    expect((await verdict(f.ctx, f.reviewer.id, f.task.id, pass)).task.assigneeAgentId).toBe(f.tester.id);
  });

  it('does not accept a submission event attributed to someone other than its producer', async () => {
    const f = await submitted();
    await f.db.update(taskEvents).set({ agentId: f.reviewer.id }).where(eq(taskEvents.id, f.event.id));
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, pass).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.stage).toBe('review');
  });
});
