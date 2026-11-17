import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, subscriptions, taskEvents } from '../src/db/schema.js';
import { report, submit, verdict } from '../src/modules/tasks/engine.js';
import { BASE, HEAD, fixture } from './development-echelons-fixture.js';
import { testsFixture } from './development-echelons-verification.js';
import { as } from './helpers.js';

const code = { summary: 'Keep totals.', evidence: 'Changed tests passed.', review: { baseCommit: BASE } };

describe('one current assignment under retries and identity changes', () => {
  it('acknowledges both concurrent copies of one submission but commits one candidate', async () => {
    const f = await fixture();
    const input = { ...code, operationId: randomUUID() };
    const results = await Promise.allSettled([submit(f.ctx, f.author.id, f.task.id, input), submit(f.ctx, f.author.id, f.task.id, input)]);
    expect(results.map(value => value.status)).toEqual(['fulfilled', 'fulfilled']);
    const events = await f.db.select().from(taskEvents).where(and(eq(taskEvents.taskId, f.task.id), eq(taskEvents.kind, 'submitted')));
    expect(events).toHaveLength(1);
    expect((await f.detail()).echelons.ownerAgentId).toBe(f.reviewer.id);
  });
  it('does not accept the checking assignment after its subscription changes', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    const [plan] = await f.db.insert(subscriptions).values({ companyId: f.task.companyId, provider: 'claude', kind: 'personal', label: 'Another plan', ownerPersonId: f.claude.ownerPersonId, status: 'ready' }).returning();
    await f.db.update(agents).set({ subscriptionId: plan!.id }).where(eq(agents.id, f.reviewer.id));
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Old assignment.', reviewedCommit: HEAD }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons.stage).toBe('review');
  });
  it('does not accept a checker whose required skill was removed after handoff', async () => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    await f.db.update(agents).set({ skills: [] }).where(eq(agents.id, f.reviewer.id));
    await expect(verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'I no longer have this ability.', reviewedCommit: HEAD }).then(() => null)).rejects.toMatchObject({ status: 409 });
  });
  it.each(['subscription', 'skill'])('refuses a repair submission after the checking %s changes', async changed => {
    const f = await fixture();
    await submit(f.ctx, f.author.id, f.task.id, code);
    const candidateId = (await f.detail()).echelons.candidateId;
    if (changed === 'skill') await f.db.update(agents).set({ skills: [] }).where(eq(agents.id, f.reviewer.id));
    else await f.db.update(agents).set({ subscriptionId: f.codex.id }).where(eq(agents.id, f.reviewer.id));
    f.atCommit('c'.repeat(40));
    await expect(submit(f.ctx, f.reviewer.id, f.task.id, { ...code, summary: 'Repair from a stale assignment.' }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect((await f.detail()).echelons).toMatchObject({ stage: 'review', candidateId });
  });

  /* The card changes after the checker's identity was read and before its result commits. */
  const changeModelBeforeCommit = (f: { db: { transaction: unknown }; app: { inject: (request: object) => Promise<{ statusCode: number }> }; ceoToken: string }, agentId: string) => {
    const db = f.db as { transaction: (...args: unknown[]) => Promise<unknown> };
    const transaction = db.transaction.bind(db);
    const changed = { done: false };
    db.transaction = async (...args: unknown[]) => {
      db.transaction = transaction;
      const response = await f.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, payload: { model: 'claude-haiku-5-5' }, ...as(f.ceoToken) });
      changed.done = response.statusCode === 200;
      return transaction(...args);
    };
    return changed;
  };
  it.each(['review', 'security'] as const)('refuses a %s PASS whose checker model changes before the verdict commits', async stage => {
    const f = await fixture({ riskClass: stage === 'security' ? 'security' : 'none' });
    await submit(f.ctx, f.author.id, f.task.id, code);
    if (stage === 'security') await verdict(f.ctx, f.reviewer.id, f.task.id, { pass: true, comment: 'Review passed.', reviewedCommit: HEAD });
    const checker = stage === 'security' ? f.security : f.reviewer;
    const changed = changeModelBeforeCommit(f, checker.id);
    await expect(verdict(f.ctx, checker.id, f.task.id, { pass: true, comment: 'Stale checker.', reviewedCommit: HEAD }).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect(changed.done).toBe(true);
    expect((await f.detail()).echelons.stage).toBe(stage);
  });
  it('refuses a Tests certification whose tester model changes before the report commits', async () => {
    const f = await testsFixture();
    const changed = changeModelBeforeCommit(f, f.tester.id);
    await expect(report(f.ctx, f.tester.id, f.task.id, f.verified()).then(() => null)).rejects.toMatchObject({ status: 409 });
    expect(changed.done).toBe(true);
    expect((await f.detail()).echelons).toMatchObject({ stage: 'tests', phase: 'active' });
  });
});
