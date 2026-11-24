/* Strictly read-only database reader for Stage 1 company achievements.
   Executes ONLY company-scoped SELECT queries over non-prose columns on GET requests. */

import { DEFAULT_COMPANY_THEME } from '@hornhoof/protocol/world';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import {
  agentChanges,
  agentEvents,
  agents,
  companies,
  departments,
  goalEvents,
  goals,
  jobs,
  people,
  requests,
  subscriptions,
  taskEvents,
  taskRoutes,
  tasks,
  testParts,
  testRuns,
  turnReleases,
  turns,
} from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentFailureStates } from '../tasks/failure-records.js';
import { worldPackForTheme } from './packs/index.js';
import { buildShowcaseRewards, type WorldRewardsView } from './rewards-catalogue.js';
import { computeCompanyRewards } from './rewards-compute.js';

const RELEVANT_TASK_EVENTS = ['done', 'report', 'verdict', 'submitted', 'stuck'] as const;

function asOptionalId(val: unknown): string | null {
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function isActiveEmployee(agent: { kind: string; removedAt: Date | null }): boolean {
  return agent.removedAt === null && agent.kind !== 'assistant';
}

async function readSmokeDepartments(
  ctx: Ctx,
  companyId: string,
  deptRows: readonly { id: string; parentId: string | null }[],
  agentRows: readonly { id: string; kind: string; departmentId: string | null; removedAt: Date | null }[],
): Promise<Set<string>> {
  const topDeptById = new Map(deptRows.map(d => [d.id, d.parentId ?? d.id]));
  const activeEmployees = agentRows.filter(isActiveEmployee);
  const failureMap = await agentFailureStates(ctx, companyId, activeEmployees.map(a => a.id));
  const smokeDepts = new Set<string>();
  for (const agent of activeEmployees) {
    if (agent.departmentId && failureMap.get(agent.id)?.failure) {
      smokeDepts.add(topDeptById.get(agent.departmentId) ?? agent.departmentId);
    }
  }
  return smokeDepts;
}

export async function readCompanyRewards(
  ctx: Ctx,
  companyId: string,
  viewerPersonId: string,
): Promise<WorldRewardsView> {
  const { db } = ctx;
  const [company] = await db.select({ theme: companies.theme }).from(companies).where(eq(companies.id, companyId));
  if (!company) {
    throw new ApiError(404, 'not_found', 'Company not found');
  }

  const [
    deptRows,
    personRows,
    agentRows,
    subRows,
    taskRows,
    routeRows,
    taskEventRows,
    requestRows,
    jobRows,
    silentRows,
    fallbackRows,
    turnRows,
    releaseRows,
    runRows,
    partRows,
    goalRows,
    goalEventRows,
  ] = await Promise.all([
    db
      .select({ id: departments.id, parentId: departments.parentId })
      .from(departments)
      .where(eq(departments.companyId, companyId)),
    db
      .select({ id: people.id, isOwner: people.isOwner })
      .from(people)
      .where(and(eq(people.companyId, companyId), eq(people.isAgent, false), eq(people.status, 'active'))),
    db
      .select({
        id: agents.id,
        kind: agents.kind,
        departmentId: agents.departmentId,
        removedAt: agents.removedAt,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
    db
      .select({ id: subscriptions.id, provider: subscriptions.provider })
      .from(subscriptions)
      .where(eq(subscriptions.companyId, companyId)),
    db
      .select({
        id: tasks.id,
        number: tasks.number,
        status: tasks.status,
        parentId: tasks.parentId,
        departmentId: tasks.departmentId,
        productId: tasks.productId,
        assigneeAgentId: tasks.assigneeAgentId,
        executorAgentId: tasks.executorAgentId,
        goalId: tasks.goalId,
        responsiblePersonId: tasks.responsiblePersonId,
        createdByPersonId: tasks.createdByPersonId,
        closedAt: tasks.closedAt,
      })
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .orderBy(asc(tasks.number)),
    db
      .select({
        taskId: taskRoutes.taskId,
        revision: taskRoutes.revision,
        state: taskRoutes.state,
      })
      .from(taskRoutes)
      .where(eq(taskRoutes.companyId, companyId)),
    db
      .select({
        id: taskEvents.id,
        uuid: taskEvents.uuid,
        taskId: taskEvents.taskId,
        kind: taskEvents.kind,
        personId: taskEvents.personId,
        hasText: sql<boolean>`length(btrim(${taskEvents.text})) > 0`,
        data: sql<Record<string, unknown>>`${taskEvents.data} - 'evidence'`,
        createdAt: taskEvents.createdAt,
      })
      .from(taskEvents)
      .where(and(eq(taskEvents.companyId, companyId), inArray(taskEvents.kind, RELEVANT_TASK_EVENTS)))
      .orderBy(asc(taskEvents.id)),
    db
      .select({
        id: requests.id,
        taskId: requests.taskId,
        kind: requests.kind,
        audience: requests.audience,
        status: requests.status,
        hasAnswer: sql<boolean>`length(btrim(coalesce(${requests.answer}, ''))) > 0`,
        answeredBy: requests.answeredBy,
        answeredAt: requests.answeredAt,
      })
      .from(requests)
      .where(eq(requests.companyId, companyId)),
    db
      .select({
        id: jobs.id,
        taskId: jobs.taskId,
        agentId: jobs.agentId,
        subscriptionId: jobs.subscriptionId,
        status: jobs.status,
        error: jobs.error,
        hasFailure: sql<boolean>`${jobs.failure} is not null`,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(and(eq(jobs.companyId, companyId), eq(jobs.kind, 'conversation'), isNotNull(jobs.taskId))),
    db
      .select({ silentJobId: sql<string>`${agentEvents.data}->>'silentJob'` })
      .from(agentEvents)
      .where(and(eq(agentEvents.companyId, companyId), sql`${agentEvents.data} ? 'silentJob'`)),
    db
      .select({
        agentId: agentChanges.agentId,
        before: agentChanges.before,
        after: agentChanges.after,
        createdAt: agentChanges.createdAt,
      })
      .from(agentChanges)
      .where(
        and(
          eq(agentChanges.companyId, companyId),
          eq(agentChanges.field, 'subscription'),
          isNull(agentChanges.personId),
          eq(agentChanges.byOrchestrator, false),
          isNull(agentChanges.actingAgentId),
        ),
      ),
    db
      .select({
        id: turns.id,
        number: turns.number,
        status: turns.status,
        closedBecause: turns.closedBecause,
        version: turns.version,
        commit: turns.commit,
        closedAt: turns.closedAt,
        createdAt: turns.createdAt,
      })
      .from(turns)
      .where(eq(turns.companyId, companyId))
      .orderBy(asc(turns.number)),
    db
      .select({ turnId: turnReleases.turnId, commit: turnReleases.commit })
      .from(turnReleases)
      .where(eq(turnReleases.companyId, companyId)),
    db
      .select({
        id: testRuns.id,
        number: testRuns.number,
        status: testRuns.status,
        commitSha: testRuns.commitSha,
        parts: testRuns.parts,
        createdAt: testRuns.createdAt,
        finishedAt: testRuns.finishedAt,
      })
      .from(testRuns)
      .where(and(eq(testRuns.companyId, companyId), eq(testRuns.kind, 'tests')))
      .orderBy(asc(testRuns.number)),
    db
      .select({
        runId: testParts.runId,
        status: testParts.status,
        commit: testParts.commit,
      })
      .from(testParts)
      .where(eq(testParts.companyId, companyId)),
    db
      .select({
        id: goals.id,
        number: goals.number,
        parentGoalId: goals.parentGoalId,
        status: goals.status,
        targetValue: goals.targetValue,
        responsiblePersonId: goals.responsiblePersonId,
        createdByPersonId: goals.createdByPersonId,
        updatedAt: goals.updatedAt,
      })
      .from(goals)
      .where(eq(goals.companyId, companyId))
      .orderBy(asc(goals.number)),
    db
      .select({
        uuid: goalEvents.uuid,
        goalId: goalEvents.goalId,
        kind: goalEvents.kind,
        personId: goalEvents.personId,
        data: goalEvents.data,
        createdAt: goalEvents.createdAt,
      })
      .from(goalEvents)
      .where(eq(goalEvents.companyId, companyId))
      .orderBy(asc(goalEvents.id)),
  ]);

  const smokeDepartmentIds = await readSmokeDepartments(ctx, companyId, deptRows, agentRows);
  const silentJobIds = new Set(silentRows.map(r => r.silentJobId).filter((v): v is string => Boolean(v)));
  const autoFallbacks = fallbackRows.map(row => ({
    agentId: row.agentId,
    beforeSubId: asOptionalId(row.before),
    afterSubId: asOptionalId(row.after),
    createdAt: row.createdAt,
  }));

  const computed = computeCompanyRewards(
    {
      departments: deptRows,
      people: personRows,
      agents: agentRows,
      subscriptions: subRows,
      smokeDepartmentIds,
      tasks: taskRows,
      routes: routeRows,
      taskEvents: taskEventRows,
      requests: requestRows,
      jobs: jobRows,
      silentJobIds,
      autoFallbacks,
      turns: turnRows,
      turnReleases: releaseRows,
      testRuns: runRows,
      testParts: partRows,
      goals: goalRows,
      goalEvents: goalEventRows,
    },
    viewerPersonId,
  );

  const rawTheme = company.theme || DEFAULT_COMPANY_THEME;
  const activePack = worldPackForTheme(ctx.worldPacks, rawTheme);
  const showcase = buildShowcaseRewards(rawTheme, activePack?.id ?? null, computed.earned);

  return {
    ...computed,
    showcase,
  };
}
