import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, jobs, people, stagingPlans, subscriptions, tasks, testParts, testRuns, turns, workspaceRepositories } from '../src/db/schema.js';
import { resolveRegisteredStagingPlan, type StagingPlanQuery } from '../src/modules/tasks/staging-plans.js';
import { createTestDb } from './helpers-db.js';

const SHA = 'a'.repeat(40);

async function fixture() {
  const db = await createTestDb();
  const [company] = await db.insert(companies).values({ name: 'Staging company' }).returning();
  const [person] = await db.insert(people).values({ companyId: company!.id, name: 'Owner', email: 'owner@example.test', status: 'active', scopeKind: 'company' }).returning();
  const [subscription] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'claude', kind: 'personal', label: 'Fixture plan', ownerPersonId: person!.id, status: 'ready' }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, kind: 'worker', name: 'Worker', model: '' }).returning();
  const [turn] = await db.insert(turns).values({ companyId: company!.id, number: 1, goal: 'Fixture turn' }).returning();
  const [task] = await db.insert(tasks).values({ companyId: company!.id, turnId: turn!.id, number: 1, title: 'Root check' }).returning();
  const [job] = await db.insert(jobs).values({ companyId: company!.id, subscriptionId: subscription!.id, agentId: agent!.id, taskId: task!.id, prompt: 'Fixture run', timeoutMs: 1000 }).returning();
  const [repository] = await db.insert(workspaceRepositories).values({ companyId: company!.id, canonicalUrl: 'https://git.example/team/project' }).returning();
  const [run] = await db.insert(testRuns).values({ companyId: company!.id, number: 1, taskId: task!.id, agentId: agent!.id, jobId: job!.id,
    kind: 'tests', branch: 'turn-1', commitSha: SHA, command: 'fixture root check', parts: 2, timeoutMs: 1000, status: 'passed', finishedAt: new Date() }).returning();
  const parts = await db.insert(testParts).values([2, 1].map(part => ({ companyId: company!.id, runId: run!.id, part, builtin: true,
    commit: SHA, status: 'passed' as const, exitCode: 0, finishedAt: new Date() }))).returning();
  const [plan] = await db.insert(stagingPlans).values({ companyId: company!.id, repositoryId: repository!.id, turnId: turn!.id, generation: 1,
    baseRef: 'turn-1', baseSha: SHA, requiredIntegrations: [{ kind: 'turn', ref: 'turn-1' }], healthRunId: run!.id, enabled: true }).returning();
  return { db, ctx: { db, companyId: company!.id }, company: company!, repository: repository!, turn: turn!, task: task!, run: run!, parts, plan: plan!,
    query: { repositoryId: repository!.id, turnId: turn!.id } };
}

describe('private registered staging plan reader', () => {
  it('returns the registered root with complete native health, not a caller plan or a moving ref', async () => {
    const f = await fixture();
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ version: 1, planId: f.plan.id, generation: 1,
      companyId: f.company.id, repositoryId: f.repository.id, turnId: f.turn.id, baseRef: 'turn-1', baseSha: SHA,
      requiredIntegrations: [{ kind: 'turn', ref: 'turn-1' }],
      health: { checkedCommitSha: SHA, runId: f.run.id, partIds: [f.parts[1]!.id, f.parts[0]!.id] } });
  });

  it('returns copied values and never allocates a batch, workspace or execution slot', async () => {
    const f = await fixture(), result = await resolveRegisteredStagingPlan(f.ctx, f.query);
    expect(result).toHaveProperty('planId', f.plan.id);
    if ('planId' in result) result.requiredIntegrations.length = 0;
    expect((await f.db.select().from(stagingPlans))[0]!.requiredIntegrations).toEqual([{ kind: 'turn', ref: 'turn-1' }]);
    for (const table of ['staging_batches', 'staging_trials', 'staging_operations', 'task_workspaces', 'author_workspace_slots']) {
      expect((await f.db.$client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    }
  });

  it('does not disclose a registered root to another company or a guessed repository', async () => {
    const f = await fixture();
    expect(await resolveRegisteredStagingPlan({ ...f.ctx, companyId: randomUUID() }, f.query)).toEqual({ code: 'integration_plan_missing', retryable: true });
    expect(await resolveRegisteredStagingPlan(f.ctx, { ...f.query, repositoryId: randomUUID() })).toEqual({ code: 'integration_plan_missing', retryable: true });
  });

  it('does not select the latest turn for null turnId or an unregistered urgent lane', async () => {
    const f = await fixture();
    for (const query of [{ ...f.query, turnId: null }, { ...f.query, turnId: null, urgentLaneId: randomUUID() }]) {
      expect(await resolveRegisteredStagingPlan(f.ctx, query)).toEqual({ code: 'integration_plan_missing', retryable: true });
    }
  });

  it.each([
    { repositoryId: 'https://git.example/private', turnId: randomUUID() },
    { repositoryId: randomUUID(), turnId: '../turn' },
    { repositoryId: randomUUID(), turnId: randomUUID(), ready: true },
  ])('refuses a malformed or caller-authorized query: %j', async query => {
    const f = await fixture();
    expect(await resolveRegisteredStagingPlan(f.ctx, query as StagingPlanQuery)).toEqual({ code: 'binding_stale', retryable: false });
  });

  it.each([
    { baseRef: 'main' },
    { requiredIntegrations: [{ kind: 'turn' as const, ref: 'turn-2' }] },
    { requiredIntegrations: [{ kind: 'main' as const, ref: 'main' }] },
  ])('refuses policy outside its registered normal turn: %j', async change => {
    const f = await fixture(); await f.db.update(stagingPlans).set(change);
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'integration_plan_missing', retryable: true });
  });

  it.each(['disabled', 'closed', 'missing'] as const)('refuses a %s registered root', async state => {
    const f = await fixture();
    if (state === 'disabled') await f.db.update(stagingPlans).set({ enabled: false });
    if (state === 'closed') await f.db.update(turns).set({ status: 'closed', closedAt: new Date() });
    if (state === 'missing') await f.db.delete(stagingPlans);
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'integration_plan_missing', retryable: true });
  });

  it('reports a fully bound red native check without turning setup or cancellation into a culprit', async () => {
    const f = await fixture();
    await f.db.update(testRuns).set({ status: 'failed' });
    await f.db.update(testParts).set({ status: 'failed', exitCode: 1, error: 'failed' }).where(eq(testParts.part, 1));
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'turn_branch_red', retryable: true });
  });

  it.each([
    { name: 'unfinished run', table: 'test_runs', assignment: "status='running'" },
    { name: 'missing run settlement', table: 'test_runs', assignment: 'finished_at=NULL' },
    { name: 'work command', table: 'test_runs', assignment: "kind='work'" },
    { name: 'wrong pin', table: 'test_runs', assignment: `commit_sha='${'b'.repeat(40)}'` },
    { name: 'wrong part pin', table: 'test_parts', assignment: `commit='${'b'.repeat(40)}'` },
    { name: 'stopped part', table: 'test_parts', assignment: "status='stopped',exit_code=NULL" },
    { name: 'error disguised as passed', table: 'test_parts', assignment: "error='node unavailable'" },
    { name: 'missing part settlement', table: 'test_parts', assignment: 'finished_at=NULL' },
  ])('keeps $name health unknown', async ({ table, assignment }) => {
    const f = await fixture(); await f.db.$client.exec(`UPDATE ${table} SET ${assignment}`);
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'turn_health_unknown', retryable: true });
  });

  it('requires all native parts and an explicitly registered health run', async () => {
    const f = await fixture();
    await f.db.delete(testParts).where(eq(testParts.part, 1));
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'turn_health_unknown', retryable: true });
    await f.db.update(stagingPlans).set({ healthRunId: null });
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'turn_health_unknown', retryable: true });
  });

  it('refuses native proof from another company or turn', async () => {
    const f = await fixture();
    const [other] = await f.db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    await f.db.update(testParts).set({ companyId: other!.id });
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'turn_health_unknown', retryable: true });
    await f.db.update(testParts).set({ companyId: f.company.id });
    await f.db.update(tasks).set({ turnId: null });
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toEqual({ code: 'turn_health_unknown', retryable: true });
  });

  it('takes only the current generation and preserves the exact registered pin', async () => {
    const f = await fixture(); await f.db.update(stagingPlans).set({ isCurrent: false });
    const [next] = await f.db.insert(stagingPlans).values({ ...f.plan, id: randomUUID(), generation: 2, isCurrent: true }).returning();
    expect(await resolveRegisteredStagingPlan(f.ctx, f.query)).toMatchObject({ planId: next!.id, generation: 2, baseSha: SHA });
  });
});
