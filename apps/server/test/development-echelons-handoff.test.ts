import { taskForWake } from '../src/modules/tasks/wake-state.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents } from '../src/db/schema.js';
import { submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const submitted = { summary: 'Keep totals.', evidence: 'The changed source and tests are on the task branch.', review: { baseCommit: BASE } };
const passed = { pass: true, comment: 'Checked the candidate and its callers.', reviewedCommit: HEAD };

describe('forward handoff and instructions 205/206', () => {
  it('keeps equal-capability Review available on the same subscription and provider', async () => {
    const f = await fixture({ authorProvider: 'claude' });
    await submit(f.ctx, f.author.id, f.task.id, submitted);
    const moved = await verdict(f.ctx, f.reviewer.id, f.task.id, passed);
    expect(moved.task.assigneeAgentId).toBe(f.tester.id);
    expect(await f.detail()).toMatchObject({ echelons: { stage: 'tests', phase: 'active' } });
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.tester.id]);
  });

  it.each(['claude-haiku-5-5', 'unclassified-model'])('waits for an eligible reviewer instead of assigning %s', async model => {
    const f = await fixture();
    await f.db.update(agents).set({ model }).where(eq(agents.id, f.reviewer.id));
    const moved = await submit(f.ctx, f.author.id, f.task.id, submitted);
    expect(moved.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(await f.detail()).toMatchObject({ echelons: { stage: 'review', phase: 'waiting', ownerAgentId: null } });
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.head.id]);
  });

  it('asks the actual head for a missing checker when the task creator is its author', async () => {
    const f = await fixture({ creator: 'author', reviewerModel: 'unclassified-model' });
    const moved = await submit(f.ctx, f.author.id, f.task.id, submitted);
    expect(moved.task.assigneeAgentId).toBeNull();
    expect(moved.wakes.map(wake => wake.agentId)).toEqual([f.head.id]);
    expect(await taskForWake(f.db, moved.wakes[0]!)).toMatchObject({ id: f.task.id });
  });

  it('prefers an eligible different provider without requiring one', async () => {
    const f = await fixture({ authorProvider: 'claude', autoReviewer: true });
    const crossProvider = await f.hire('Other provider', 'worker', 'DEV-REV', f.codex.id, 'gpt-6.1-sol');
    const moved = await submit(f.ctx, f.author.id, f.task.id, submitted);
    expect(moved.task.assigneeAgentId).toBe(crossProvider.id);
  });

  it.each(['gpt-6.2-sol', 'gpt-6.2-astra'])('lets an author on %s hand in and picks a reviewer on it', async model => {
    const f = await fixture({ autoReviewer: true });
    await f.db.update(agents).set({ model }).where(eq(agents.id, f.author.id));
    await f.db.update(agents).set({ subscriptionId: f.codex.id, model }).where(eq(agents.id, f.reviewer.id));
    const moved = await submit(f.ctx, f.author.id, f.task.id, submitted);
    expect(moved.task).toMatchObject({ status: 'review', assigneeAgentId: f.reviewer.id });
    expect(await f.detail()).toMatchObject({ echelons: { stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id } });
  });

  it('picks a reviewer on gpt-6.2-sol over one of the same provider as the author', async () => {
    const f = await fixture({ authorProvider: 'claude', autoReviewer: true });
    const crossProvider = await f.hire('Other provider', 'worker', 'DEV-REV', f.codex.id, 'gpt-6.2-sol');
    const moved = await submit(f.ctx, f.author.id, f.task.id, submitted);
    expect(moved.task.assigneeAgentId).toBe(crossProvider.id);
  });

  it('still refuses a hand-in from an author on a model with no known capability', async () => {
    const f = await fixture();
    await f.db.update(agents).set({ model: 'gpt-6.2-unclassified' }).where(eq(agents.id, f.author.id));
    await expect(submit(f.ctx, f.author.id, f.task.id, submitted)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('known capability policy') });
    expect(await f.detail()).toMatchObject({ status: 'open', assignee: { id: f.author.id }, echelons: { stage: 'development', candidateId: null } });
  });

  it('hands risky work to Security immediately after Review', async () => {
    const f = await fixture({ riskClass: 'security' });
    await submit(f.ctx, f.author.id, f.task.id, submitted);
    const moved = await verdict(f.ctx, f.reviewer.id, f.task.id, passed);
    expect(moved.task.assigneeAgentId).toBe(f.security.id);
    expect(await f.detail()).toMatchObject({ echelons: { stage: 'security', phase: 'active', ownerAgentId: f.security.id } });
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.security.id]);
  });

  it('retains a review finding with its checker and never wakes the author', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, submitted);
    const moved = await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: false, comment: 'I am fixing the boundary case.', reviewedCommit: HEAD });
    expect(moved.task).toMatchObject({ status: 'working', assigneeAgentId: f.reviewer.id });
    expect(await f.detail()).toMatchObject({ echelons: { stage: 'review', phase: 'active', ownerAgentId: f.reviewer.id } });
    expect(moved.wakes.some(w => w.agentId === f.author.id)).toBe(false);
  });

  it('records one immutable Development candidate and gives Review that identity', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, submitted);
    const detail = await f.detail();
    const event = detail.log.find(row => row.kind === 'submitted');
    expect(event?.data).toMatchObject({ candidate: {
      id: expect.any(String), parentId: null, baseCommit: BASE, commit: HEAD, branch: 'task-1',
      producedBy: { agentId: f.author.id, stage: 'development', model: 'gpt-6.1-sol', provider: 'codex' },
    } });
    const candidate = (event!.data as { candidate: { id: string } }).candidate;
    expect(detail.echelons).toMatchObject({ candidateId: candidate.id, stages: expect.arrayContaining([
      expect.objectContaining({ stage: 'review', inputCandidateId: candidate.id }),
    ]) });
  });
});
