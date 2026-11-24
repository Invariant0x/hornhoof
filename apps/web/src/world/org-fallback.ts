/* Pure fallback converter deriving a WorldLiveSnapshot from Hornhoof's /api/org response.
   Used when /api/world/state is not yet loaded or mocked away, ensuring the world canvas still
   renders the company's real orchestrator, departments, employees and subscriptions immediately.
   Contains zero theme-specific words. */

import type { ProviderId } from '@hornhoof/protocol';
import {
  DEFAULT_STATUE_STAGES,
  STATUE_TASKS_PER_STAGE,
  agentLevelFromAcceptedTasks,
  classifyAgentRole,
  departmentStageFromAcceptedTasks,
  departmentStatuesFromAcceptedTasks,
  deriveResidentLiveState,
  deriveWorldMode,
  flophouseStageFromCalls,
  houseStageFromLevel,
  machinePowerTier,
  nextLevelProgress,
  nextSubscriptionResetAt,
  outfitTierFromLevel,
  residenceStageFromAcceptedTasks,
  subscriptionFullness,
  type WorldLiveActiveCall,
  type WorldLiveAgent,
  type WorldLiveDepartment,
  type WorldLiveMachine,
  type WorldLiveSnapshot,
  type WorldLiveSubscription,
} from '@hornhoof/protocol/world';
import type { Org } from '../types';

function providerFromModel(model: string | null | undefined): ProviderId | null {
  if (!model) return null;
  const low = model.toLowerCase();
  if (low.includes('claude')) return 'claude';
  if (low.includes('gpt') || low.includes('codex') || low.includes('o1') || low.includes('o3')) return 'codex';
  if (low.includes('kimi')) return 'kimi';
  if (low.includes('glm')) return 'glm';
  if (low.includes('gemini') || low.includes('antigravity')) return 'antigravity';
  return 'claude';
}

export function snapshotFromOrg(org: Org): WorldLiveSnapshot {
  const now = Date.now();
  const defaultMachineId = `${org.company.id}-host-1`;
  const power = machinePowerTier(8, 16 * 1024 ** 3);
  const machines: WorldLiveMachine[] = [
    {
      id: defaultMachineId,
      hostname: `${org.company.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'company'}-host`,
      cores: 8,
      memory: 16 * 1024 ** 3,
      powerTier: power.tier,
      hubSpan: power.span,
      online: true,
      isDefault: true,
    },
  ];

  const subscriptions: WorldLiveSubscription[] = [];
  const orchSub = org.orchestrator?.subscription ?? null;
  if (orchSub) {
    const full = subscriptionFullness(
      { status: orchSub.status, limits: orchSub.limits, limitsUpdatedAt: orchSub.limitsUpdatedAt ?? null },
      now,
    );
    subscriptions.push({
      id: orchSub.id,
      label: orchSub.label,
      provider: orchSub.provider,
      kind: orchSub.kind,
      status: orchSub.status,
      fullness: full.fullness,
      exhausted: full.exhausted,
      active: full.active,
      resetsAt: nextSubscriptionResetAt(orchSub.limits, orchSub.limitsUpdatedAt ?? null, now),
    });
  } else if (org.orchestrator?.planned) {
    subscriptions.push({
      id: 'org-planned-sub',
      label: org.orchestrator.model || 'Subscription',
      provider: providerFromModel(org.orchestrator.model) ?? 'claude',
      kind: 'personal',
      status: 'ready',
      fullness: 0.85,
      exhausted: false,
      active: true,
      resetsAt: null,
    });
  }

  const readySubs = subscriptions.filter(s => s.active).length;
  const totalEmployees = org.departments.reduce((sum, d) => sum + Math.max(d.employees.length, d.agents.total), 0);
  const worldMode = deriveWorldMode({
    template: org.departments.length > 0 ? 'company' : null,
    departmentsCount: org.departments.length,
    employeesCount: totalEmployees,
    readySubscriptionsCount: Math.max(readySubs, totalEmployees > 0 ? 1 : 0),
  });

  const departments: WorldLiveDepartment[] = [];
  const agents: WorldLiveAgent[] = [];
  const activeCalls: WorldLiveActiveCall[] = [];
  let oneShotCallsTotal = 0;

  for (const dept of org.departments) {
    const deptCalls = dept.calls?.length ?? 0;
    oneShotCallsTotal += deptCalls;
    const head = dept.employees.find(e => e.kind === 'head') ?? null;
    const estAccepted = Math.max(0, dept.agents.total * 6 + dept.agents.working * 4);
    departments.push({
      id: dept.id,
      name: dept.name || dept.roleCode,
      templateKey: dept.templateKey,
      roleCode: dept.roleCode,
      acceptedTasks: estAccepted,
      stage: departmentStageFromAcceptedTasks(estAccepted, 10),
      statues: departmentStatuesFromAcceptedTasks(estAccepted, DEFAULT_STATUE_STAGES, STATUE_TASKS_PER_STAGE),
      oneShotCallsCount: deptCalls,
      headAgentId: head?.id ?? null,
      hasSmoke: false,
      hasStuckTask: dept.employees.some(e => e.status === 'waiting'),
      hasRecentRework: false,
    });

    for (const emp of dept.employees) {
      const cls = classifyAgentRole({
        kind: emp.kind === 'head' ? 'head' : 'worker',
        roleKey: null,
        isTurnkey: Boolean(emp.turnkey),
      });
      const accepted = emp.status === 'working' ? 12 : 4;
      const lvl = nextLevelProgress(accepted);
      const isWorking = emp.status === 'working' || emp.status === 'queued';
      const liveState = deriveResidentLiveState({
        machineOnline: true,
        allRestingNoSubscription: worldMode === 'no_subscription',
        subscriptionExhausted: false,
        hasFailedTurn: Boolean(emp.failure),
        waitingForHuman: emp.status === 'waiting',
        isWorking,
        recentlyLeveledUp: false,
      });
      agents.push({
        id: emp.id,
        name: emp.name,
        kind: emp.kind === 'head' ? 'head' : 'worker',
        model: emp.model ?? undefined,
        roleKey: null,
        isTurnkey: Boolean(emp.turnkey),
        roleClass: cls.roleClass,
        archetype: cls.archetype,
        outfitTier: outfitTierFromLevel(lvl.level),
        liveState,
        currentTask: emp.task
          ? { id: emp.task.id, number: emp.task.number, title: emp.task.title, goalId: null }
          : null,
        hasRecentRework: false,
        talkingToAgentId: null,
        departmentId: dept.id,
        machineId: defaultMachineId,
        subscriptionId: subscriptions[0]?.id ?? null,
        provider: emp.provider ?? providerFromModel(emp.model),
        acceptedTasks: accepted,
        level: lvl.level,
        houseStage: houseStageFromLevel(lvl.level, 10),
        nextLevelRemaining: lvl.remaining,
        resting: worldMode === 'no_subscription',
      });
    }

    for (const call of dept.calls ?? []) {
      activeCalls.push({
        id: call.id,
        callerAgentId: call.by,
        departmentId: dept.id,
        taskNumber: call.task,
        judge: call.judge,
        machineId: defaultMachineId,
        provider: subscriptions[0]?.provider ?? 'claude',
      });
    }
  }

  const acceptedTasksTotal = departments.reduce((sum, d) => sum + d.acceptedTasks, 0);
  const resStage = residenceStageFromAcceptedTasks(acceptedTasksTotal, 5);
  const orch = org.orchestrator;
  const orchestrator: WorldLiveAgent | null = orch
    ? {
        id: orch.id,
        name: orch.name,
        kind: 'orchestrator',
        model: orch.model,
        roleKey: null,
        roleClass: 'ruler',
        archetype: 'ruler',
        outfitTier: outfitTierFromLevel(agentLevelFromAcceptedTasks(acceptedTasksTotal)),
        liveState: worldMode === 'no_subscription' ? 'exhausted' : 'working',
        currentTask: null,
        hasRecentRework: false,
        talkingToAgentId: null,
        departmentId: null,
        machineId: defaultMachineId,
        subscriptionId: subscriptions[0]?.id ?? null,
        provider: providerFromModel(orch.model),
        acceptedTasks: acceptedTasksTotal,
        level: agentLevelFromAcceptedTasks(acceptedTasksTotal),
        houseStage: houseStageFromLevel(agentLevelFromAcceptedTasks(acceptedTasksTotal), 10),
        nextLevelRemaining: nextLevelProgress(acceptedTasksTotal).remaining,
        resting: worldMode === 'no_subscription',
      }
    : null;

  return {
    generatedAt: new Date(now).toISOString(),
    company: {
      id: org.company.id,
      name: org.company.name,
      template: org.departments.length > 0 ? 'company' : null,
      seed: org.company.id,
      worldMode,
      acceptedTasksTotal,
      residenceStage: resStage.stage,
      residenceTierKey: resStage.tierKey,
      allRestingNoSubscription: worldMode === 'no_subscription',
      oneShotCallsTotal,
      flophouseStage: flophouseStageFromCalls(oneShotCallsTotal, 6),
    },
    orchestrator,
    machines,
    departments,
    agents,
    subscriptions,
    goals: [],
    activeCalls,
    taskFlow: { open: 0, arrivals: [] },
    relocations: [],
    savedLayout: null,
    permissions: {
      canRelocateAny: false,
      relocatableDepartmentIds: [],
    },
  };
}
