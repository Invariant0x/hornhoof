import { taskForWake } from '../src/modules/tasks/wake-state.js';
import { describe, expect, it } from 'vitest';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

const code = { summary: 'Keep totals.', evidence: 'Changed totals and tests.', review: { baseCommit: BASE } };
const pass = { pass: true, comment: 'Checked the assigned candidate.', reviewedCommit: HEAD };

describe('stage decisions without a return to the author', () => {
  it('records the Architecture plan before opening Development', async () => {
    const f = await fixture({ small: false });
    const moved = await report(f.ctx, f.author.id, f.task.id, { done: true, summary: 'Change logic/totals.ts and prove the boundary case with a focused test.' });
    expect(moved.task.status).not.toBe('done');
    expect(await f.detail()).toMatchObject({ echelons: { stage: 'development', ownerAgentId: f.author.id, stages: expect.arrayContaining([expect.objectContaining({ stage: 'architecture', status: 'complete' })]) } });
  });
  it('lets Review add Security when it discovers a risk', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    const moved = await verdict(f.ctx, f.reviewer.id, f.task.id, { ...pass, ...{ security: 'Totals include untrusted input.' } });
    expect(moved.task.assigneeAgentId).toBe(f.security.id);
    expect(await f.detail()).toMatchObject({ echelons: { stage: 'security', security: { required: true, reason: 'Totals include untrusted input.', addedBy: f.reviewer.id } } });
  });
  it.each([undefined, 'author'] as const)('escalates a wrong goal to the actual head when its creator is %s', async creator => {
    const f = await fixture({ creator });
    await submit(f.ctx, f.author.id, f.task.id, code);
    const moved = await verdict(f.ctx, f.reviewer.id, f.task.id, { ...pass, pass: false, comment: 'The requested total is missing; this implements a different goal.', ...{ escalate: true } });
    expect(moved.task.assigneeAgentId).toBeNull();
    expect((await f.detail()).echelons.phase).toBe('escalated');
    expect(moved.wakes.map(w => w.agentId)).toEqual([f.head.id]);
    expect(await taskForWake(f.db, moved.wakes[0]!)).toMatchObject({ id: f.task.id });
  });
});
