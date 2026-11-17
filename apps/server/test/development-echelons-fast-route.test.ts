import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, teams } from '../src/db/schema.js';
import { report, submit, updateTask } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

describe('echelon route without idle handoffs', () => {
  it('collapses Architecture into Development when both belong to the same executor', async () => {
    const f = await fixture({ small: false });
    const detail = await f.detail();
    expect(detail.echelons).toMatchObject({
      stage: 'development',
      phase: 'active',
      ownerAgentId: f.author.id,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'architecture', status: 'skipped', reason: 'same_executor', ownerAgentId: null }),
        expect.objectContaining({ stage: 'development', status: 'active', ownerAgentId: f.author.id }),
      ]),
    });
    const moved = await submit(f.ctx, f.author.id, f.task.id, {
      summary: 'Implemented totals directly.', evidence: 'Focused totals check passed.', review: { baseCommit: BASE },
    });
    expect(moved.task.assigneeAgentId).toBe(f.reviewer.id);
  });

  it('keeps Architecture separate when a different employee designs the plan before Development', async () => {
    const f = await fixture({ small: false });
    const architect = await f.hire('Architect', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    const { task } = await f.create({ small: false, architectAgentId: architect.id, assigneeAgentId: f.author.id });
    expect((await f.detail(task.id)).echelons).toMatchObject({
      stage: 'architecture',
      phase: 'active',
      ownerAgentId: architect.id,
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'architecture', status: 'active', ownerAgentId: architect.id }),
        expect.objectContaining({ stage: 'development', status: 'pending', ownerAgentId: f.author.id }),
      ]),
    });
    const planned = await report(f.ctx, architect.id, task.id, { done: true, summary: 'Extract pure rounding helper and test boundaries.' });
    expect(planned.task).toMatchObject({ status: 'open', assigneeAgentId: f.author.id });
    expect((await f.detail(task.id)).echelons).toMatchObject({ stage: 'development', ownerAgentId: f.author.id });
  });

  it('assigns an eligible Security checker immediately on task creation and risk escalation', async () => {
    const f = await fixture();
    const { task } = await f.create({ riskClass: 'security', securityAgentId: undefined });
    expect((await f.detail(task.id)).echelons).toMatchObject({
      security: { required: true, reason: 'security' },
      stages: expect.arrayContaining([
        expect.objectContaining({ stage: 'security', status: 'pending', ownerAgentId: f.security.id }),
      ]),
    });

    const { task: laterRisk } = await f.create({ riskClass: 'none', securityAgentId: undefined });
    expect((await f.detail(laterRisk.id)).echelons.stages.find(s => s.stage === 'security')).toMatchObject({ status: 'skipped', ownerAgentId: null });
    await updateTask(f.ctx, f.head.id, laterRisk.id, { riskClass: 'access' });
    expect((await f.detail(laterRisk.id)).echelons.stages.find(s => s.stage === 'security')).toMatchObject({
      status: 'pending', ownerAgentId: f.security.id,
    });
  });

  it.each([
    { small: true, paths: ['logic/totals.ts'], file: 'logic/totals.ts' },
    { small: false, paths: ['docs/**'], file: 'docs/architecture.md' },
  ])('keeps Review mandatory after local author evidence ($file)', async ({ small, paths, file }) => {
    const f = await fixture({ small: true });
    const { task } = await f.create({ small, paths });
    const route = (await f.detail(task.id)).echelons;
    if (route.stage === 'architecture') await report(f.ctx, f.author.id, task.id, { done: true, summary: 'Keep the change local.' });
    f.atCommit(HEAD, [file]);
    const moved = await submit(f.ctx, f.author.id, task.id, {
      summary: 'Focused change.', evidence: 'check:author passed; CRAP 2; clean cherry-pick.', review: { baseCommit: BASE },
    });
    expect(moved.task.assigneeAgentId).toBe(f.reviewer.id);
    expect((await f.detail(task.id)).echelons).toMatchObject({ stage: 'review', phase: 'active' });
  });

  it('leaves turnkey team direct end-to-end routing completely unchanged', async () => {
    const f = await fixture({ small: false, riskClass: 'security' });
    const [team] = await f.db.insert(teams).values({
      companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Turnkey Lane', turnkey: true,
    }).returning();
    const player = await f.hire('Turnkey Dev', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, player.id));
    const { task } = await f.create({
      assigneeAgentId: player.id, architectAgentId: f.author.id, small: false, riskClass: 'security',
      reviewerAgentId: undefined, securityAgentId: undefined, testsAgentId: undefined,
    });
    expect((await f.detail(task.id)).echelons).toMatchObject({
      resultKind: 'turnkey', stage: null, stages: [], candidateId: null, security: { required: false },
    });
    f.ctx.readCommit = async (_repo, ref) => ({ branch: 'branch' in ref ? ref.branch : `task-${ref.task}`, commitSha: HEAD });
    const closed = await report(f.ctx, player.id, task.id, { done: true, summary: 'Completed end to end on task branch.' });
    expect(closed.task).toMatchObject({ status: 'done', assigneeAgentId: null });
  });
});
