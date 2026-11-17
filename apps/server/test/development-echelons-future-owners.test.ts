import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentInbox, agents, departments, jobs, teams } from '../src/db/schema.js';
import { cancel, leaveWork, loadTask, report, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { as } from './helpers.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('future stage owners when an employee leaves', () => {
  it('replaces a removed future reviewer without moving the current stage or waking the replacement', async () => {
    const f = await fixture();
    const replacement = await f.hire('Next reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const removed = await f.app.inject({ method: 'DELETE', url: `/api/agents/${f.reviewer.id}`, ...as(f.ceoToken) });
    expect(removed.statusCode, removed.body).toBe(204);
    const task = await f.detail();
    expect(task.echelons).toMatchObject({ stage: 'development', phase: 'active', ownerAgentId: f.author.id });
    expect(task.echelons.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', ownerAgentId: replacement.id, reason: null });
    expect(await f.db.select().from(jobs).where(and(eq(jobs.agentId, replacement.id), eq(jobs.taskId, f.task.id)))).toEqual([]);
  });

  it('uses the same role and scope, rejects weaker models, and prefers another provider', async () => {
    const f = await fixture();
    const authorRole = await f.hire('Another role', 'worker', 'DEV-BE', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ skills: f.reviewer.skills }).where(eq(agents.id, authorRole.id));
    await f.hire('Too weak', 'worker', 'DEV-REV', f.claude.id, 'claude-haiku-5-5');
    const [other] = await f.db.insert(departments).values({ companyId: f.task.companyId, templateKey: 'development', roleCode: 'OTHER' }).returning();
    const elsewhere = await f.hire('Another department', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ departmentId: other!.id }).where(eq(agents.id, elsewhere.id));
    const [team] = await f.db.insert(teams).values({ companyId: f.task.companyId, departmentId: f.task.departmentId!, name: 'Outside pipeline' }).returning();
    const member = await f.hire('Team reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ teamId: team!.id }).where(eq(agents.id, member.id));
    await f.hire('Same provider', 'worker', 'DEV-REV', f.codex.id, 'gpt-6.1-sol');
    const preferred = await f.hire('Other provider', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    expect((await f.app.inject({ method: 'DELETE', url: `/api/agents/${f.reviewer.id}`, ...as(f.ceoToken) })).statusCode).toBe(204);
    expect((await f.detail()).echelons.stages.find(step => step.stage === 'review')?.ownerAgentId).toBe(preferred.id);
  });

  it('sends the head one letter listing every unfilled future stage, without repeating it', async () => {
    const f = await fixture();
    const second = await f.create({ title: 'Second total' });
    expect((await f.app.inject({ method: 'DELETE', url: `/api/agents/${f.reviewer.id}`, ...as(f.ceoToken) })).statusCode).toBe(204);
    const letters = () => f.db.select().from(agentInbox).where(eq(agentInbox.agentId, f.head.id));
    const [letter] = await letters();
    expect(await letters()).toHaveLength(1);
    expect(letter!.text).toContain(`#${f.task.number}`);
    expect(letter!.text).toContain(`#${second.task.number}`);
    expect(letter!.text).toContain('review');
    expect(letter!.text).toContain('update_task, echelonStage and ownerAgentId');
    for (const id of [f.task.id, second.task.id]) {
      const detail = await f.detail(id);
      expect(detail.echelons).toMatchObject({ stage: 'development', ownerAgentId: f.author.id });
      expect(detail.echelons.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', ownerAgentId: null, reason: 'eligible_owner_required' });
    }
    await leaveWork(f.ctx, { agentId: f.head.id }, f.reviewer);
    expect(await letters()).toHaveLength(1);
  });

  it('replaces a planned Development executor and hands Architecture to that owner', async () => {
    const f = await fixture();
    await cancel(f.ctx, { agentId: f.head.id }, f.task.id, 'Plan this separately.');
    const planned = await f.create({ small: false, architectAgentId: f.head.id });
    const replacement = await f.hire('Next author', 'worker', 'DEV-BE', f.codex.id, 'gpt-6.1-sol');
    expect((await f.app.inject({ method: 'DELETE', url: `/api/agents/${f.author.id}`, ...as(f.ceoToken) })).statusCode).toBe(204);
    expect((await loadTask(f.db, planned.task.id)).executorAgentId).toBe(replacement.id);
    expect((await f.detail(planned.task.id)).echelons).toMatchObject({ stage: 'architecture', ownerAgentId: f.head.id });
    const opened = await report(f.ctx, f.head.id, planned.task.id, { done: true, summary: 'Keep the total and its rounding rules.' });
    expect(opened.task.assigneeAgentId).toBe(replacement.id);
    expect((await f.detail(planned.task.id)).echelons.stage).toBe('development');
  });

  it('leaves completed stages, immutable candidates and closed tasks as they were', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, { summary: 'Totals', evidence: 'Checked totals', review: { baseCommit: BASE } });
    await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Checked', reviewedCommit: HEAD });
    const before = (await f.detail()).echelons;
    const closed = await f.create({ title: 'Cancelled total' });
    await cancel(f.ctx, { agentId: f.head.id }, closed.task.id, 'Not needed.');
    const closedBefore = (await f.detail(closed.task.id)).echelons;
    expect((await f.app.inject({ method: 'DELETE', url: `/api/agents/${f.reviewer.id}`, ...as(f.ceoToken) })).statusCode).toBe(204);
    expect((await f.detail()).echelons).toEqual(before);
    expect((await f.detail(closed.task.id)).echelons).toEqual(closedBefore);
  });

  it('lets the head name a future checker without moving or waking the current owner', async () => {
    const f = await fixture();
    const replacement = await f.hire('Named reviewer', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    const moved = await updateTask(f.ctx, f.head.id, f.task.id, { echelonStage: 'review', ownerAgentId: replacement.id });
    expect(moved.task).toMatchObject({ assigneeAgentId: f.author.id, executorAgentId: f.author.id, status: f.task.status });
    expect(moved.wakes).toEqual([]);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'development', ownerAgentId: f.author.id });
    expect((await f.detail()).echelons.stages.find(step => step.stage === 'review')).toMatchObject({ status: 'pending', ownerAgentId: replacement.id });
  });

  it('refuses a producer, weaker checker, unavailable or out-of-scope owner, and stages that are not future pending work', async () => {
    const f = await fixture();
    const weak = await f.hire('Weak checker', 'worker', 'DEV-REV', f.claude.id, 'claude-haiku-5-5');
    const off = await f.hire('Off checker', 'worker', 'DEV-REV', f.claude.id, 'claude-opus-5-5');
    await f.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, off.id));
    const before = (await f.detail()).echelons;
    for (const ownerAgentId of [f.author.id, weak.id, off.id]) {
      await expect(updateTask(f.ctx, f.head.id, f.task.id, { echelonStage: 'review', ownerAgentId })).rejects.toMatchObject({ status: expect.any(Number) });
      expect((await f.detail()).echelons).toEqual(before);
    }
    for (const stage of ['architecture', 'development', 'security'] as const) {
      await expect(updateTask(f.ctx, f.head.id, f.task.id, { echelonStage: stage, ownerAgentId: f.reviewer.id })).rejects.toMatchObject({ status: 409 });
    }
    await expect(updateTask(f.ctx, f.head.id, f.task.id, { echelonStage: 'review' })).rejects.toMatchObject({ status: 400 });
    await expect(updateTask(f.ctx, f.author.id, f.task.id, { echelonStage: 'review', ownerAgentId: f.reviewer.id })).rejects.toMatchObject({ status: 403 });
  });
});
