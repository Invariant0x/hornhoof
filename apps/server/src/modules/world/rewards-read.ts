/* Strictly read-only database reader for Stage 1 company achievements.
   Executes ONLY company-scoped SELECT queries projecting narrow scalar keys over non-prose columns. */

import { DEFAULT_COMPANY_THEME } from '@hornhoof/protocol/world';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
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
import { STOPPED_ON_PURPOSE } from '../conversation/constants.js';
import { worldPackForTheme } from './packs/index.js';
import { buildShowcaseRewards, type WorldRewardsView } from './rewards-catalogue.js';
import { computeCompanyRewards } from './rewards-compute.js';

type ActiveDepartmentAgent = {
  id: string;
  kind: string;
  departmentId: string;
  removedAt: null;
};

function isDepartmentEmployee(agent: {
  id: string;
  kind: string;
  departmentId: string | null;
  removedAt: Date | null;
}): agent is ActiveDepartmentAgent {
  return agent.removedAt === null && agent.kind !== 'assistant' && agent.departmentId !== null;
}

function collectSmokeDeptIds(
  lastEnded: readonly { agentId: string | null; hasFailure: boolean }[],
  deptByAgentId: ReadonlyMap<string, string>,
): Set<string> {
  const failedAgentIds = lastEnded.filter(r => r.hasFailure).map(r => r.agentId!);
  return new Set(failedAgentIds.map(id => deptByAgentId.get(id)!));
}

async function readSmokeDepartments(
  ctx: Ctx,
  companyId: string,
  deptRows: readonly { id: string; parentId: string | null }[],
  agentRows: readonly { id: string; kind: string; departmentId: string | null; removedAt: Date | null }[],
): Promise<Set<string>> {
  const activeEmployees = agentRows.filter(isDepartmentEmployee);
  if (activeEmployees.length === 0) return new Set();
  const topDeptById = new Map(deptRows.map(d => [d.id, d.parentId ?? d.id]));
  const deptByAgentId = new Map(activeEmployees.map(a => [a.id, topDeptById.get(a.departmentId) ?? a.departmentId]));
  const lastEnded = await ctx.db
    .selectDistinctOn([jobs.agentId], {
      agentId: jobs.agentId,
      hasFailure: sql<boolean>`${jobs.status} = 'failed' and ${jobs.failure} is not null`,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.companyId, companyId),
        inArray(jobs.agentId, activeEmployees.map(a => a.id)),
        eq(jobs.kind, 'conversation'),
        inArray(jobs.status, ['done', 'failed']),
        or(isNull(jobs.error), notInArray(jobs.error, STOPPED_ON_PURPOSE)),
      ),
    )
    .orderBy(asc(jobs.agentId), desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`), desc(jobs.createdAt));
  return collectSmokeDeptIds(lastEnded, deptByAgentId);
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

  const doneTaskIds = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.companyId, companyId), eq(tasks.status, 'done')));
  const companyAgentIds = db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
  const releasedTurnIds = db
    .select({ id: turns.id })
    .from(turns)
    .where(
      and(
        eq(turns.companyId, companyId),
        eq(turns.status, 'closed'),
        isNull(turns.closedBecause),
        isNotNull(turns.version),
        isNotNull(turns.commit),
      ),
    );
  const passedTestRunIds = db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(
      and(
        eq(testRuns.companyId, companyId),
        eq(testRuns.kind, 'tests'),
        eq(testRuns.status, 'passed'),
        isNotNull(testRuns.commitSha),
      ),
    );
  const reachedGoalIds = db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.status, 'reached')));

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
      .where(
        and(
          eq(people.companyId, companyId),
          eq(people.isAgent, false),
          eq(people.status, 'active'),
          eq(people.isOwner, true),
        ),
      ),
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
        phase: sql<string | null>`${taskRoutes.state}->>'phase'`,
        resultKind: sql<string | null>`${taskRoutes.state}->>'resultKind'`,
        candidateId: sql<string | null>`${taskRoutes.state}->>'candidateId'`,
        stagesComplete: sql<boolean>`not exists (select 1 from jsonb_array_elements(coalesce(${taskRoutes.state}->'stages', '[]'::jsonb)) as elem where coalesce(elem->>'status', '') not in ('complete', 'skipped'))`,
      })
      .from(taskRoutes)
      .where(
        and(
          eq(taskRoutes.companyId, companyId),
          inArray(taskRoutes.taskId, doneTaskIds),
          sql`${taskRoutes.state}->>'phase' = 'done'`,
        ),
      ),
    db
      .select({
        uuid: taskEvents.uuid,
        taskId: taskEvents.taskId,
        kind: taskEvents.kind,
        hasText: sql<boolean>`length(btrim(${taskEvents.text})) > 0`,
        byOrchestrator: sql<boolean>`(${taskEvents.data}->'byOrchestrator') = 'true'::jsonb`,
        reportDone: sql<boolean>`(${taskEvents.data}->'done') = 'true'::jsonb`,
        testsRework: sql<boolean>`(${taskEvents.data}->'done') = 'false'::jsonb and (${taskEvents.data}#>>'{verification,rework}') = 'true'`,
        verdictFailed: sql<boolean>`(${taskEvents.data}->'pass') = 'false'::jsonb`,
        repairCandidate: sql<boolean>`jsonb_typeof(${taskEvents.data}#>'{candidate,parentId}') = 'string'`,
        acceptedCandidateId: sql<string | null>`coalesce(${taskEvents.data}#>>'{acceptedCandidate,candidateId}', ${taskEvents.data}#>>'{acceptedCandidate,id}')`,
        acceptedCandidateRev: sql<number | null>`case when (${taskEvents.data}#>>'{acceptedCandidate,routeRevision}') ~ '^[0-9]{1,9}$' then (${taskEvents.data}#>>'{acceptedCandidate,routeRevision}')::integer else null end`,
        acceptedDocumentId: sql<string | null>`coalesce(${taskEvents.data}#>>'{acceptedDocument,candidateId}', ${taskEvents.data}#>>'{acceptedDocument,id}')`,
        acceptedDocumentRev: sql<number | null>`case when (${taskEvents.data}#>>'{acceptedDocument,routeRevision}') ~ '^[0-9]{1,9}$' then (${taskEvents.data}#>>'{acceptedDocument,routeRevision}')::integer else null end`,
        hasRecordedArtifact: sql<boolean>`jsonb_typeof(${taskEvents.data}#>'{recorded,path}') = 'string' or jsonb_typeof(${taskEvents.data}#>'{recorded,file}') = 'string'`,
        hasIntegrationCommit: sql<boolean>`length(coalesce(${taskEvents.data}#>>'{integration,commit}', '')) > 0`,
        coordinationChildrenOk: sql<boolean>`case when jsonb_typeof(${taskEvents.data}->'acceptedChildren') <> 'array' or jsonb_array_length(${taskEvents.data}->'acceptedChildren') = 0 then true else exists (select 1 from jsonb_array_elements(${taskEvents.data}->'acceptedChildren') as child where jsonb_typeof(child) = 'object' and coalesce(child->>'unaccepted', 'false') <> 'true') end`,
      })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.companyId, companyId),
          inArray(taskEvents.taskId, doneTaskIds),
          or(
            and(eq(taskEvents.kind, 'done'), sql`(${taskEvents.data}->'byOrchestrator') = 'true'::jsonb`),
            and(
              eq(taskEvents.kind, 'report'),
              sql`(${taskEvents.data}->'done') = 'true'::jsonb or ((${taskEvents.data}->'done') = 'false'::jsonb and (${taskEvents.data}#>>'{verification,rework}') = 'true')`,
            ),
            and(
              eq(taskEvents.kind, 'verdict'),
              sql`(${taskEvents.data}->'pass') = 'false'::jsonb and length(btrim(${taskEvents.text})) > 0`,
            ),
            and(
              eq(taskEvents.kind, 'submitted'),
              sql`jsonb_typeof(${taskEvents.data}#>'{candidate,parentId}') = 'string'`,
            ),
            eq(taskEvents.kind, 'stuck'),
          ),
        ),
      )
      .orderBy(asc(taskEvents.id)),
    db
      .select({
        taskId: requests.taskId,
        kind: requests.kind,
        status: requests.status,
        answeredBy: requests.answeredBy,
      })
      .from(requests)
      .where(
        and(
          eq(requests.companyId, companyId),
          inArray(requests.taskId, doneTaskIds),
          inArray(requests.status, ['answered', 'approved', 'declined']),
          isNotNull(requests.answeredBy),
        ),
      ),
    db
      .select({
        id: jobs.id,
        taskId: jobs.taskId,
        agentId: jobs.agentId,
        subscriptionId: jobs.subscriptionId,
        status: jobs.status,
        error: jobs.error,
        hasFailure: sql<boolean>`${jobs.status} = 'failed' and ${jobs.failure} is not null`,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.companyId, companyId),
          eq(jobs.kind, 'conversation'),
          inArray(jobs.taskId, doneTaskIds),
        ),
      ),
    db
      .select({ silentJobId: sql<string>`${agentEvents.data}->>'silentJob'` })
      .from(agentEvents)
      .where(
        and(
          eq(agentEvents.companyId, companyId),
          eq(agentEvents.kind, 'message'),
          sql`${agentEvents.data} ? 'silentJob'`,
        ),
      ),
    db
      .select({
        agentId: agentChanges.agentId,
        beforeSubId: sql<string | null>`case when jsonb_typeof(${agentChanges.before}) = 'string' then nullif(${agentChanges.before} #>> '{}', '') else null end`,
        afterSubId: sql<string | null>`case when jsonb_typeof(${agentChanges.after}) = 'string' then nullif(${agentChanges.after} #>> '{}', '') else null end`,
        createdAt: agentChanges.createdAt,
      })
      .from(agentChanges)
      .where(
        and(
          eq(agentChanges.companyId, companyId),
          inArray(agentChanges.agentId, companyAgentIds),
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
      .where(
        and(
          eq(turns.companyId, companyId),
          eq(turns.status, 'closed'),
          isNull(turns.closedBecause),
          isNotNull(turns.version),
          isNotNull(turns.commit),
        ),
      )
      .orderBy(asc(turns.number)),
    db
      .select({ turnId: turnReleases.turnId, commit: turnReleases.commit })
      .from(turnReleases)
      .where(and(eq(turnReleases.companyId, companyId), inArray(turnReleases.turnId, releasedTurnIds))),
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
      .where(
        and(
          eq(testRuns.companyId, companyId),
          eq(testRuns.kind, 'tests'),
          inArray(testRuns.status, ['passed', 'failed']),
          isNotNull(testRuns.commitSha),
        ),
      )
      .orderBy(asc(testRuns.number)),
    db
      .select({
        runId: testParts.runId,
        status: testParts.status,
        commit: testParts.commit,
      })
      .from(testParts)
      .where(and(eq(testParts.companyId, companyId), inArray(testParts.runId, passedTestRunIds))),
    db
      .select({
        id: goals.id,
        number: goals.number,
        parentGoalId: goals.parentGoalId,
        status: goals.status,
        responsiblePersonId: goals.responsiblePersonId,
        createdByPersonId: goals.createdByPersonId,
        updatedAt: goals.updatedAt,
      })
      .from(goals)
      .where(and(eq(goals.companyId, companyId), inArray(goals.status, ['active', 'reached'])))
      .orderBy(asc(goals.number)),
    db
      .selectDistinctOn([goalEvents.goalId], {
        uuid: goalEvents.uuid,
        goalId: goalEvents.goalId,
        createdAt: goalEvents.createdAt,
      })
      .from(goalEvents)
      .where(
        and(
          eq(goalEvents.companyId, companyId),
          inArray(goalEvents.goalId, reachedGoalIds),
          or(
            and(eq(goalEvents.kind, 'status'), sql`${goalEvents.data}->>'toStatus' = 'reached'`),
            and(eq(goalEvents.kind, 'created'), sql`${goalEvents.data}->>'status' = 'reached'`),
          ),
        ),
      )
      .orderBy(asc(goalEvents.goalId), desc(goalEvents.id)),
  ]);

  const smokeDepartmentIds = await readSmokeDepartments(ctx, companyId, deptRows, agentRows);
  const silentJobIds = new Set(silentRows.map(r => r.silentJobId).filter((v): v is string => Boolean(v)));

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
      autoFallbacks: fallbackRows,
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
