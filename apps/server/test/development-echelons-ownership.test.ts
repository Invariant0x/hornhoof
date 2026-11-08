import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { taskEvents } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { taskForWake } from '../src/modules/tasks/wake-state.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const submission = { summary: 'Keep totals.', evidence: 'Changed source and affected tests.', review: { baseCommit: BASE } };
const FIX = 'c'.repeat(40);

describe('candidate ownership across the public work commands', () => {
  it('delivers the review wake to the actual current owner while independent work starts', async () => {
    const f = await fixture();
    const checked = await submit(f.ctx, f.author.id, f.task.id, submission);
    const independent = await f.create({ title: 'Independent display', paths: ['ui/display.ts'] });
    expect(await taskForWake(f.db, checked.wakes[0]!)).toMatchObject({ id: f.task.id, assigneeAgentId: f.reviewer.id });
    expect(await f.detail(independent.task.id)).toMatchObject({ echelons: { stage: 'development', ownerAgentId: f.author.id } });
  });

  it('lets the checker submit its own fix with immutable parent and producer identity', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, submission);
    const input = (await f.detail()).echelons.candidateId;
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'Fixing the boundary case.', reviewedCommit: HEAD });
    f.atCommit(FIX);
    const fixed = await submit(f.ctx, f.reviewer.id, f.task.id, { ...submission, summary: 'Fix the boundary case.' });
    const detail = await f.detail();
    expect(fixed.task.assigneeAgentId).toBe(f.tester.id);
    expect(fixed.wakes.some(w => w.agentId === f.author.id)).toBe(false);
    const event = detail.log.filter(row => row.kind === 'submitted').at(-1);
    expect(event?.data).toMatchObject({ candidate: { parentId: input, commit: FIX, branch: 'task-1', producedBy: { agentId: f.reviewer.id, stage: 'review' } } });
    expect(detail.echelons.stages.find(step => step.stage === 'tests')?.inputCandidateId).toBe(detail.echelons.candidateId);
  });

  it('rejects a candidate outside the head-approved repository paths', async () => {
    const f = await fixture();
    f.atCommit(HEAD, ['secrets/outside.ts']);
    await expect(submit(f.ctx, f.author.id, f.task.id, submission)).rejects.toMatchObject({ status: 403 });
    expect((await f.detail()).echelons.ownerAgentId).toBe(f.author.id);
  });

  it('replays an acknowledged operation without creating another candidate or owner', async () => {
    const f = await fixture();
    const input = { ...submission, operationId: randomUUID() };
    const first = await submit(f.ctx, f.author.id, f.task.id, input);
    const repeated = await submit(f.ctx, f.author.id, f.task.id, input);
    expect(repeated.task.id).toBe(first.task.id);
    expect(repeated.task.assigneeAgentId).toBe(f.reviewer.id);
    expect(repeated.wakes).toEqual([]);
    const events = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(events).toHaveLength(1);
  });
});
