/* Strictly read-only live company data reader for the isometric world engine.
   Executes ONLY SELECT queries; never mutates any Hornhoof table. */

import {
  DEFAULT_STATUE_STAGES,
  STATUE_TASKS_PER_STAGE,
  TASK_ARRIVALS_MAX,
  TASK_ARRIVAL_WINDOW_MS,
  agentLevelFromAcceptedTasks,
  classifyAgentRole,
  departmentStageFromAcceptedTasks,
  departmentStatuesFromAcceptedTasks,
  deriveResidentLiveState,
  deriveWorldMode,
  flophouseStageFromCalls,
  goalMonumentProgress,
  houseStageFromLevel,
  machinePowerTier,
  nextLevelProgress,
  nextSubscriptionResetAt,
  outfitTierFromLevel,
  residenceStageFromAcceptedTasks,
  subscriptionFullness,
  type WorldLiveActiveCall,
  type WorldLiveAgent,
  type WorldLiveChildGoal,
  type WorldLiveCurrentTask,
  type WorldLiveDepartment,
  type WorldLiveGoal,
  type WorldLiveMachine,
  type WorldLiveSnapshot,
  type WorldLiveSubscription,
  type WorldLiveTaskFlow,
  type WorldRelocationRecord,
  type WorldRelocationStatus,
} from '@hornhoof/protocol/world';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { knowsAgentId, seesAgentId, viewerOf } from '../../auth/agent-view.js';
import { actsAsCeo } from '../../auth/decisions.js';
import type { Person } from '../../auth/session.js';
import {
  agents,
  companies,
  departments,
  goals,
  machines,
  nodes,
  oneShotCalls,
  subscriptions,
  tasks,
  teams,
  worldLayouts,
} from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentWork } from '../agents/work.js';
import { runningCalls } from '../calls/calls.js';
import { deptName } from '../departments/templates.js';
import { reworkTimes } from '../org/rework.js';
import { agentFailureStates } from '../tasks/failure-records.js';
import { seesTask } from '../tasks/visibility.js';

const MACHINE_ONLINE_WINDOW_MS = 5 * 60_000;

function rootGoalOf(
  goalId: string,
  parentById: ReadonlyMap<string, string | null>,
): string | null {
  let cur: string | null = goalId;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const parent: string | null = parentById.get(cur) ?? null;
    if (!parent) return cur;
    cur = parent;
  }
  return null;
}

export async function readWorldLiveState(ctx: Ctx, me: Person): Promise<WorldLiveSnapshot> {
  const { db } = ctx;
  const now = ctx.clock();
  const companyId = me.companyId;

  const [company] = await db
    .select({ id: companies.id, name: companies.name, template: companies.template })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) {
    throw new ApiError(404, 'not_found', 'Company not found.');
  }

  const [viewer, access] = await Promise.all([viewerOf(db, me), accessOf(db, me)]);

  const [
    machineRows,
    nodeRows,
    deptRows,
    teamRows,
    agentRows,
    subRows,
    goalRows,
    taskRows,
    callRows,
    layoutRows,
    workState,
    liveRunningCalls,
    deptReworkMap,
  ] = await Promise.all([
    db
      .select({
        id: machines.id,
        hostname: machines.hostname,
        networkId: machines.networkId,
        cores: machines.cores,
        memory: machines.memory,
        reportAt: machines.reportAt,
        path: machines.path,
      })
      .from(machines)
      .where(and(eq(machines.companyId, companyId), isNull(machines.revokedAt)))
      .orderBy(asc(machines.createdAt)),
    db
      .select({ id: nodes.id, machineId: nodes.machineId, subscriptionId: nodes.subscriptionId })
      .from(nodes)
      .where(eq(nodes.companyId, companyId)),
    db
      .select({
        id: departments.id,
        name: departments.name,
        templateKey: departments.templateKey,
        parentId: departments.parentId,
        roleCode: departments.roleCode,
        position: departments.position,
      })
      .from(departments)
      .where(eq(departments.companyId, companyId))
      .orderBy(asc(departments.position), asc(departments.createdAt)),
    db
      .select({ id: teams.id, turnkey: teams.turnkey })
      .from(teams)
      .where(eq(teams.companyId, companyId)),
    db
      .select({
        id: agents.id,
        name: agents.name,
        kind: agents.kind,
        model: agents.model,
        roleKey: agents.roleKey,
        departmentId: agents.departmentId,
        productId: agents.productId,
        teamId: agents.teamId,
        nodeId: agents.nodeId,
        builtinMachine: agents.builtinMachine,
        subscriptionId: agents.subscriptionId,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), isNull(agents.removedAt), ne(agents.kind, 'assistant')))
      .orderBy(asc(agents.createdAt)),
    db
      .select({
        id: subscriptions.id,
        label: subscriptions.label,
        provider: subscriptions.provider,
        kind: subscriptions.kind,
        status: subscriptions.status,
        limits: subscriptions.limits,
        limitsUpdatedAt: subscriptions.limitsUpdatedAt,
      })
      .from(subscriptions)
      .where(and(eq(subscriptions.companyId, companyId), isNull(subscriptions.removedAt)))
      .orderBy(asc(subscriptions.createdAt)),
    db
      .select({
        id: goals.id,
        number: goals.number,
        departmentId: goals.departmentId,
        parentGoalId: goals.parentGoalId,
        title: goals.title,
        targetValue: goals.targetValue,
        currentValue: goals.currentValue,
        unit: goals.unit,
        status: goals.status,
      })
      .from(goals)
      .where(and(eq(goals.companyId, companyId), ne(goals.status, 'dropped')))
      .orderBy(asc(goals.number)),
    db
      .select({
        id: tasks.id,
        status: tasks.status,
        departmentId: tasks.departmentId,
        productId: tasks.productId,
        assigneeAgentId: tasks.assigneeAgentId,
        executorAgentId: tasks.executorAgentId,
        goalId: tasks.goalId,
        closedAt: tasks.closedAt,
        createdAt: tasks.createdAt,
        createdByPersonId: tasks.createdByPersonId,
        createdByAgentId: tasks.createdByAgentId,
      })
      .from(tasks)
      .where(eq(tasks.companyId, companyId)),
    db
      .select({ id: oneShotCalls.id, departmentId: oneShotCalls.departmentId })
      .from(oneShotCalls)
      .where(eq(oneShotCalls.companyId, companyId)),
    db
      .select({
        packId: worldLayouts.packId,
        seed: worldLayouts.seed,
        layout: worldLayouts.layout,
        relocations: worldLayouts.relocations,
      })
      .from(worldLayouts)
      .where(eq(worldLayouts.companyId, companyId)),
    agentWork(db, companyId),
    runningCalls(ctx, companyId),
    reworkTimes(db, companyId, new Date(now), access),
  ]);

  /* Map products to their top-level department so accepted tasks aggregate cleanly at department level. */
  const topDeptById = new Map<string, string>();
  for (const d of deptRows) {
    topDeptById.set(d.id, d.parentId ?? d.id);
  }
  const topDepts = deptRows.filter(d => d.parentId === null);

  /* Machine lookup via nodeId or builtinMachine networkId. */
  const nodeMachineById = new Map<string, string>();
  for (const n of nodeRows) {
    nodeMachineById.set(n.id, n.machineId);
  }
  const machineByNetworkId = new Map<string, string>();
  for (const m of machineRows) {
    if (m.networkId) machineByNetworkId.set(m.networkId, m.id);
  }

  const liveMachines: WorldLiveMachine[] = machineRows.map((m, idx) => {
    const power = machinePowerTier(m.cores, m.memory);
    const online = Boolean(
      m.path !== null || (m.reportAt && now - m.reportAt.getTime() <= MACHINE_ONLINE_WINDOW_MS),
    );
    return {
      id: m.id,
      hostname: m.hostname || `machine-${idx + 1}`,
      cores: m.cores,
      memory: m.memory,
      powerTier: power.tier,
      hubSpan: power.span,
      online,
      isDefault: idx === 0,
    };
  });

  /* Subscriptions & remaining limits fullness. */
  const liveSubscriptions: WorldLiveSubscription[] = subRows.map(s => {
    const full = subscriptionFullness(
      { status: s.status, limits: s.limits, limitsUpdatedAt: s.limitsUpdatedAt },
      now,
    );
    return {
      id: s.id,
      label: s.label,
      provider: s.provider,
      kind: s.kind,
      status: s.status,
      fullness: full.fullness,
      exhausted: full.exhausted,
      active: full.active,
      resetsAt: nextSubscriptionResetAt(s.limits, s.limitsUpdatedAt, now),
    };
  });
  const subById = new Map(liveSubscriptions.map(s => [s.id, s]));
  const readySubscriptionsCount = liveSubscriptions.filter(s => s.active).length;

  /* Aggregate ONLY accepted (status === 'done') tasks: rework returns and cancelled tasks never count. */
  let acceptedTasksTotal = 0;
  const acceptedByAgent = new Map<string, number>();
  const acceptedByDept = new Map<string, number>();
  const taskById = new Map(taskRows.map(t => [t.id, t]));

  const goalParentById = new Map<string, string | null>(goalRows.map(g => [g.id, g.parentGoalId]));
  const goalTasksTotal = new Map<string, number>();
  const goalTasksDone = new Map<string, number>();

  for (const t of taskRows) {
    if (t.goalId && t.status !== 'cancelled') {
      const root = rootGoalOf(t.goalId, goalParentById);
      if (root) {
        goalTasksTotal.set(root, (goalTasksTotal.get(root) ?? 0) + 1);
        if (t.status === 'done') {
          goalTasksDone.set(root, (goalTasksDone.get(root) ?? 0) + 1);
        }
      }
    }

    if (t.status !== 'done') continue;
    acceptedTasksTotal++;

    const creditAgentId = t.executorAgentId ?? t.assigneeAgentId;
    if (creditAgentId) {
      acceptedByAgent.set(creditAgentId, (acceptedByAgent.get(creditAgentId) ?? 0) + 1);
    }
    const topDeptId = t.departmentId
      ? (topDeptById.get(t.departmentId) ?? t.departmentId)
      : t.productId
        ? (topDeptById.get(t.productId) ?? null)
        : null;
    if (topDeptId) {
      acceptedByDept.set(topDeptId, (acceptedByDept.get(topDeptId) ?? 0) + 1);
    }
  }

  /* One-shot calls totals (company-wide and per department). */
  const callsByDept = new Map<string, number>();
  for (const c of callRows) {
    const topDeptId = c.departmentId ? (topDeptById.get(c.departmentId) ?? c.departmentId) : null;
    if (topDeptId) {
      callsByDept.set(topDeptId, (callsByDept.get(topDeptId) ?? 0) + 1);
    }
  }

  /* Company agents visible to this viewer (personal assistants excluded by query and knowsAgentId). */
  const visibleEmployees = agentRows.filter(a => knowsAgentId(viewer, a.id));
  const nonOrchestratorEmployees = visibleEmployees.filter(a => a.kind !== 'orchestrator');
  const turnkeyTeamIds = new Set(teamRows.filter(t => t.turnkey).map(t => t.id));
  const machineOnlineById = new Map(liveMachines.map(m => [m.id, m.online]));
  const failureMap = await agentFailureStates(
    ctx,
    companyId,
    visibleEmployees.map(a => a.id),
  );

  const worldMode = deriveWorldMode({
    template: company.template,
    departmentsCount: topDepts.length,
    employeesCount: nonOrchestratorEmployees.length,
    readySubscriptionsCount,
  });
  const allRestingNoSubscription = worldMode === 'no_subscription';

  const headByDept = new Map<string, string>();
  const deptHasSmoke = new Set<string>();
  const deptHasStuckTask = new Set<string>();
  for (const t of taskRows) {
    if (t.status === 'blocked' || t.status === 'waiting') {
      const topD = t.departmentId ? (topDeptById.get(t.departmentId) ?? t.departmentId) : null;
      if (topD) deptHasStuckTask.add(topD);
    }
  }
  const defaultMachineId = liveMachines[0]?.id ?? null;

  const liveAgents: WorldLiveAgent[] = visibleEmployees.map(a => {
    const topDeptId = a.departmentId ? (topDeptById.get(a.departmentId) ?? a.departmentId) : null;
    if (a.kind === 'head' && topDeptId) {
      headByDept.set(topDeptId, a.id);
    }
    const accepted = acceptedByAgent.get(a.id) ?? 0;
    const progress = nextLevelProgress(accepted);
    const sub = a.subscriptionId ? (subById.get(a.subscriptionId) ?? null) : null;
    const byNode = typeof a.nodeId === 'string' ? (nodeMachineById.get(a.nodeId) ?? null) : null;
    const byBuiltin = typeof a.builtinMachine === 'string' ? (machineByNetworkId.get(a.builtinMachine) ?? null) : null;
    const resolvedMachineId = byNode ?? byBuiltin ?? defaultMachineId;
    const machineOnline = resolvedMachineId ? (machineOnlineById.get(resolvedMachineId) ?? true) : true;

    const isTurnkey = Boolean(a.teamId && turnkeyTeamIds.has(a.teamId));
    const roleInfo = classifyAgentRole({
      kind: a.kind as 'orchestrator' | 'head' | 'worker',
      roleKey: a.roleKey,
      isTurnkey,
    });
    const work = workState.doing({ id: a.id, subscriptionId: a.subscriptionId });
    const hasFailedTurn = Boolean(failureMap.get(a.id)?.failure);
    if (hasFailedTurn && topDeptId) {
      deptHasSmoke.add(topDeptId);
    }
    const waitingForHuman = work.status === 'waiting';
    if (waitingForHuman && topDeptId) {
      deptHasStuckTask.add(topDeptId);
    }
    const isWorking = work.status === 'working' || work.status === 'queued';
    const recentlyLeveledUp = !isWorking && accepted > 0 && accepted === progress.currentThreshold;
    const liveState = deriveResidentLiveState({
      machineOnline,
      allRestingNoSubscription,
      subscriptionExhausted: sub !== null && sub.exhausted,
      hasFailedTurn,
      waitingForHuman,
      isWorking,
      recentlyLeveledUp,
    });

    const visibleTask: WorldLiveCurrentTask | null =
      work.task && seesTask(viewer, work.task)
        ? {
            id: work.task.id,
            number: work.task.number,
            title: work.task.title,
            goalId: work.task.goalId,
          }
        : null;

    return {
      id: a.id,
      name: a.name,
      kind: a.kind as 'orchestrator' | 'head' | 'worker',
      model: a.model,
      roleKey: a.roleKey,
      isTurnkey,
      roleClass: roleInfo.roleClass,
      archetype: roleInfo.archetype,
      outfitTier: outfitTierFromLevel(progress.level),
      liveState,
      currentTask: visibleTask,
      hasRecentRework: Boolean(topDeptId && deptReworkMap.has(topDeptId) && roleInfo.inspectsStones),
      talkingToAgentId: null,
      departmentId: topDeptId,
      machineId: resolvedMachineId,
      subscriptionId: a.subscriptionId,
      provider: sub?.provider ?? null,
      acceptedTasks: accepted,
      level: progress.level,
      houseStage: houseStageFromLevel(progress.level, 10),
      nextLevelRemaining: progress.remaining,
      resting: allRestingNoSubscription || (sub !== null && sub.exhausted),
    };
  });

  const agentById = new Map(liveAgents.map(a => [a.id, a]));
  const rawOrchestrator = liveAgents.find(a => a.kind === 'orchestrator') ?? null;
  /* Viewers who cannot open the orchestrator still see the ruler residence on the map without exposing its internal agent UUID. */
  const orchestrator = rawOrchestrator
    ? seesAgentId(viewer, rawOrchestrator.id)
      ? rawOrchestrator
      : { ...rawOrchestrator, id: 'ruler', currentTask: null }
    : null;

  const liveDepartments: WorldLiveDepartment[] = topDepts.map(d => {
    const accepted = acceptedByDept.get(d.id) ?? 0;
    return {
      id: d.id,
      name: deptName(d) || d.roleCode,
      templateKey: d.templateKey,
      roleCode: d.roleCode,
      acceptedTasks: accepted,
      stage: departmentStageFromAcceptedTasks(accepted, 10),
      statues: departmentStatuesFromAcceptedTasks(accepted, DEFAULT_STATUE_STAGES, STATUE_TASKS_PER_STAGE),
      oneShotCallsCount: callsByDept.get(d.id) ?? 0,
      headAgentId: headByDept.get(d.id) ?? null,
      hasSmoke: deptHasSmoke.has(d.id),
      hasStuckTask: deptHasStuckTask.has(d.id),
      hasRecentRework: deptReworkMap.has(d.id),
    };
  });

  const activeCalls: WorldLiveActiveCall[] = liveRunningCalls
    .filter(c => knowsAgentId(viewer, c.by))
    .map(c => {
      const caller = agentById.get(c.by);
      const topDeptId = c.departmentId ? (topDeptById.get(c.departmentId) ?? c.departmentId) : (caller?.departmentId ?? null);
      return {
        id: c.id,
        callerAgentId: c.by,
        departmentId: topDeptId,
        taskNumber: c.task,
        judge: c.judge,
        machineId: caller?.machineId ?? defaultMachineId,
        provider: caller?.provider ?? null,
      };
    });

  /* Top-level goals (monuments): count child goals & tasks, identify the primary company goal. */
  const topGoals = goalRows.filter(g => g.parentGoalId === null);
  const childTotals = new Map<string, { total: number; reached: number; list: WorldLiveChildGoal[] }>();
  for (const g of goalRows) {
    if (!g.parentGoalId) continue;
    const root = rootGoalOf(g.id, goalParentById);
    if (!root || root === g.id) continue;
    const acc = childTotals.get(root) ?? { total: 0, reached: 0, list: [] };
    acc.total++;
    if (g.status === 'reached') acc.reached++;
    acc.list.push({
      id: g.id,
      number: g.number,
      title: g.title,
      status: g.status === 'reached' ? 'reached' : 'active',
    });
    childTotals.set(root, acc);
  }
  const primaryGoalId =
    topGoals.find(g => g.departmentId === null && g.status === 'active')?.id ??
    topGoals.find(g => g.departmentId === null)?.id ??
    topGoals[0]?.id ??
    null;

  const liveGoals: WorldLiveGoal[] = topGoals.map(g => {
    const children = childTotals.get(g.id) ?? { total: 0, reached: 0, list: [] };
    const tasksTotal = goalTasksTotal.get(g.id) ?? 0;
    const tasksDone = goalTasksDone.get(g.id) ?? 0;
    const monument = goalMonumentProgress({
      status: g.status,
      targetValue: g.targetValue,
      currentValue: g.currentValue,
      childGoalsTotal: children.total,
      childGoalsReached: children.reached,
      tasksTotal,
      tasksDone,
    });
    return {
      id: g.id,
      number: g.number,
      title: g.title,
      departmentId: g.departmentId,
      status: g.status as 'active' | 'reached',
      targetValue: g.targetValue,
      currentValue: g.currentValue,
      unit: g.unit,
      childGoalsTotal: children.total,
      childGoalsReached: children.reached,
      childGoals: children.list,
      tasksTotal,
      tasksDone,
      progress: monument.progress,
      stage: monument.stage,
      reached: monument.reached,
      celebrating: monument.celebrating,
      isPrimary: g.id === primaryGoalId,
    };
  });

  /* Reconcile stored God's Word relocation orders purely in memory against live task status. */
  const storedLayoutRow = layoutRows[0] ?? null;
  const relocations: WorldRelocationRecord[] = (storedLayoutRow?.relocations ?? []).map(rel => {
    const linked = taskById.get(rel.taskId);
    const taskStatus = linked?.status ?? 'cancelled';
    let status: WorldRelocationStatus = 'pending';
    let resolvedAt: string | null = null;
    if (taskStatus === 'done') {
      status = 'applied';
      resolvedAt = linked?.closedAt?.toISOString() ?? null;
    } else if (taskStatus === 'cancelled') {
      status = 'cancelled';
      resolvedAt = linked?.closedAt?.toISOString() ?? null;
    }
    return {
      ...rel,
      taskStatus,
      status,
      resolvedAt,
    };
  });

  const residence = residenceStageFromAcceptedTasks(acceptedTasksTotal, 5);
  const canRelocateAny = actsAsCeo(me) || access.whole;
  const relocatableDepartmentIds = topDepts
    .filter(d => canRelocateAny || canReach(access, { departmentId: d.id, parentId: null }))
    .map(d => d.id);

  return {
    generatedAt: new Date(now).toISOString(),
    company: {
      id: company.id,
      name: company.name,
      template: company.template,
      seed: storedLayoutRow?.seed || company.id,
      worldMode,
      acceptedTasksTotal,
      residenceStage: residence.stage,
      residenceTierKey: residence.tierKey,
      allRestingNoSubscription,
      oneShotCallsTotal: callRows.length,
      flophouseStage: flophouseStageFromCalls(callRows.length, 6),
    },
    orchestrator,
    machines: liveMachines,
    departments: liveDepartments,
    agents: liveAgents.filter(a => a.kind !== 'orchestrator'),
    subscriptions: liveSubscriptions,
    goals: liveGoals,
    activeCalls,
    taskFlow: taskFlowOf(
      taskRows.filter(t => seesTask(viewer, t)),
      now,
    ),
    relocations,
    savedLayout: storedLayoutRow?.layout ?? null,
    permissions: {
      canRelocateAny,
      relocatableDepartmentIds,
    },
  };
}

/* The queue and the recent arrivals of the tasks a viewer sees (#2006): open ones wait in the yard; every task but a
   cancelled one created in the window came by boat. */
function taskFlowOf(rows: readonly { status: string; createdAt: Date }[], now: number): WorldLiveTaskFlow {
  const arrivals = rows
    .filter(t => t.status !== 'cancelled' && now - t.createdAt.getTime() <= TASK_ARRIVAL_WINDOW_MS)
    .map(t => t.createdAt.getTime())
    .sort((a, b) => a - b)
    .slice(-TASK_ARRIVALS_MAX)
    .map(ms => new Date(ms).toISOString());
  return { open: rows.filter(t => t.status === 'open').length, arrivals };
}

/* Re-exported canonical level check so callers share one implementation across server and web. */
export { agentLevelFromAcceptedTasks };
