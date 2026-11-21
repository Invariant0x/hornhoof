import type { Route } from '../routes';
import { humanStatus } from '../task-tree';
import { workingNow } from '../tracker';
import type { Department, Employee, GoalView, MachineView, Org, SubView, TaskLine } from '../types';
import { stateOf } from '../ui/subscription';
import type { DerivedGuideState, GuidePhase, GuideRecord, GuideSnapshot, GuideStep } from './types';

const TASK_RECOVERY_STATUSES = new Set(['paused', 'failure', 'stopped', 'waiting', 'waitingYou']);
type StepChoice = { step: GuideStep; phase: GuidePhase; anchors: string[] };

/* Confirmed work start uses the product's workingNow signal and matches the exact task.id. */
export function hasConfirmedWorkStart(taskId: string | null, tasks: TaskLine[] | undefined, org: Org | null): boolean {
  if (!taskId || !tasks || !org) return false;
  return workingNow(tasks, org).some(task => task.id === taskId);
}

function allEmployees(org: Org | null): Employee[] {
  return (org?.departments ?? []).flatMap(dept => dept.employees);
}

function isTaskQueued(taskId: string, org: Org | null): boolean {
  return allEmployees(org).some(emp => emp.status === 'queued' && emp.task?.id === taskId);
}

function empAttention(emp: Employee): boolean {
  return emp.status === 'off' || emp.status === 'waiting' || emp.failure !== null || emp.state === 'needs_subscription';
}

function isTaskRecovery(task: TaskLine | null, taskId: string, org: Org | null): boolean {
  if (task && TASK_RECOVERY_STATUSES.has(humanStatus(task))) return true;
  return allEmployees(org).some(emp => emp.task?.id === taskId && empAttention(emp));
}

function findWorkDepartment(record: GuideRecord, org: Org | null): Department | null {
  const departments = org?.departments ?? [];
  const saved = record.departmentId ? departments.find(d => d.id === record.departmentId) : undefined;
  return saved ?? departments.find(d => d.templateKey !== 'operations') ?? null;
}

function findTrackedGoal(record: GuideRecord, goals: GoalView[] | undefined, deptId: string | null): GoalView | null {
  const list = (goals ?? []).filter(g => g.status !== 'dropped');
  const saved = record.goalId ? list.find(g => g.id === record.goalId) : undefined;
  return saved ?? list.find(g => !deptId || !g.department || g.department.id === deptId) ?? null;
}

function findOrchestratorSub(subs: SubView[] | undefined, org: Org | null): SubView | null {
  return subs?.find(s => s.isOrchestrator) ?? org?.orchestrator?.subscription ?? null;
}

function hasOnlinePersonalMachine(orchSub: SubView | null, machines: MachineView[] | undefined): boolean {
  return Boolean(orchSub?.machines.some(m => m.online) || machines?.some(m => m.online && !m.serverInstall));
}

type PlanFacts = {
  orchSub: SubView | null;
  subState: ReturnType<typeof stateOf> | null;
  planReady: boolean;
  anyReadySub: boolean;
  machineOnline: boolean;
  isApi: boolean;
  isPersonal: boolean;
  isLater: boolean;
};

function inspectPlan(snap: GuideSnapshot): PlanFacts {
  const orchSub = findOrchestratorSub(snap.subs, snap.org);
  const subState = orchSub ? stateOf(orchSub, snap.now) : null;
  const planReady = subState === 'ready';
  const anyReadySub = planReady || Boolean(snap.subs?.some(s => stateOf(s, snap.now) === 'ready'));
  const kind = orchSub ? orchSub.kind : snap.record.mode;
  const isApi = kind === 'api_key';
  const isPersonal = kind === 'personal';
  const isLater = !orchSub && snap.record.mode === 'later';
  const machineOnline = isApi ? subState !== 'builtin_offline' : hasOnlinePersonalMachine(orchSub, snap.machines);
  return { orchSub, subState, planReady, anyReadySub, machineOnline, isApi, isPersonal, isLater };
}

function collectDone(snap: GuideSnapshot, plan: PlanFacts, flags: { dept: boolean; head: boolean; goal: boolean; task: boolean; work: boolean }): GuideStep[] {
  const done = new Set<GuideStep>(['company', 'account', ...snap.record.done]);
  const pairs: [GuideStep, boolean][] = [
    ['plan', plan.planReady],
    ['machine', plan.isApi ? plan.planReady : plan.machineOnline],
    ['department', flags.dept],
    ['staff', flags.head],
    ['goal', flags.goal],
    ['task', flags.task],
    ['work', flags.work],
  ];
  for (const [step, ok] of pairs) if (ok) done.add(step);
  return [...done];
}

function connectingChoice(plan: PlanFacts): StepChoice | null {
  const conn = plan.orchSub?.connecting?.state;
  if (conn === 'connecting') return { step: 'plan', phase: 'loading', anchors: ['Subscriptions.status', 'Nav.subscriptions'] };
  if (conn === 'failed' || conn === 'too_long') {
    return { step: 'plan', phase: 'recovery', anchors: ['Subscriptions.retry', 'Subscriptions.signIn', 'Subscriptions.status', 'Nav.subscriptions'] };
  }
  return null;
}

function waitingMachineChoice(snap: GuideSnapshot): StepChoice {
  if (snap.route.kind === 'subscriptions') {
    return { step: 'plan', phase: 'waiting_machine', anchors: ['Subscriptions.status', 'Nav.machines'] };
  }
  const phase: GuidePhase = snap.record.done.includes('machine') ? 'recovery' : 'guidance';
  return { step: 'machine', phase, anchors: ['Machines.status', 'Machines.connect', 'Nav.machines'] };
}

function personalPlanStep(snap: GuideSnapshot, plan: PlanFacts): StepChoice | null {
  const connecting = connectingChoice(plan);
  if (connecting) return connecting;
  if (plan.subState === 'waiting_machine' || (!plan.machineOnline && !plan.planReady)) return waitingMachineChoice(snap);
  if (plan.subState === 'needs_login') {
    return { step: 'plan', phase: 'needs_login', anchors: ['Subscriptions.signIn', 'Subscriptions.status', 'Nav.subscriptions'] };
  }
  if (plan.subState === 'needs_setup') {
    return { step: 'plan', phase: 'needs_setup', anchors: ['Subscriptions.status', 'Nav.subscriptions'] };
  }
  return { step: 'plan', phase: 'recovery', anchors: ['Subscriptions.status', 'Subscriptions.signIn', 'Nav.subscriptions'] };
}

function planAnchorsForSubs(subs: SubView[] | undefined, mode: GuideRecord['mode']): string[] {
  const hasUnassigned = Boolean(subs?.some(s => s.place.kind === 'company' && !s.isOrchestrator));
  const connectOrder = mode === 'api_key' ? ['Subscriptions.connectApi', 'Subscriptions.connect'] : ['Subscriptions.connect', 'Subscriptions.connectApi'];
  return [...(hasUnassigned ? ['Subscriptions.orchestrator'] : []), ...connectOrder, 'Subscriptions.status', 'Nav.subscriptions'];
}

function laterNeedsPlan(snap: GuideSnapshot, plan: PlanFacts, dept: Department | null, hasHead: boolean): boolean {
  if (!plan.isLater) return false;
  if (snap.route.kind === 'subscriptions') return true;
  if (snap.subs === undefined || plan.anyReadySub || !dept) return false;
  return !hasHead || dept.employees.every(e => e.state === 'needs_subscription');
}

function resolvePlanBlocker(snap: GuideSnapshot, plan: PlanFacts, dept: Department | null, hasHead: boolean): StepChoice | null {
  if (plan.planReady) return null;
  if (plan.isApi && plan.subState === 'builtin_offline') {
    return { step: 'plan', phase: 'recovery', anchors: ['Subscriptions.status', 'Nav.subscriptions'] };
  }
  if (plan.isPersonal) return personalPlanStep(snap, plan);
  if (snap.record.done.includes('plan') && snap.subs !== undefined && !plan.anyReadySub) {
    return { step: 'plan', phase: 'recovery', anchors: planAnchorsForSubs(snap.subs, snap.record.mode) };
  }
  if (laterNeedsPlan(snap, plan, dept, hasHead)) {
    return { step: 'plan', phase: 'guidance', anchors: planAnchorsForSubs(snap.subs, snap.record.mode) };
  }
  return null;
}

function workPhaseOf(snap: GuideSnapshot, taskId: string, trackedTask: TaskLine | null, workConfirmed: boolean): GuidePhase {
  if (workConfirmed) return 'working';
  if (snap.tasksFailure !== null || snap.orgFailure !== null) return 'unavailable';
  if (isTaskRecovery(trackedTask, taskId, snap.org)) return 'recovery';
  if (isTaskQueued(taskId, snap.org)) return 'queued';
  return 'created';
}

function nextWorkspaceStep(dept: Department | null, hasHead: boolean, goal: GoalView | null): StepChoice {
  if (!dept) return { step: 'department', phase: 'guidance', anchors: ['AgentWindow.structureApply', 'Map.orchestrator', 'Nav.map'] };
  if (!hasHead) return { step: 'staff', phase: 'guidance', anchors: ['StaffCard.hire', 'Department.hire', `Map.department:${dept.id}`, 'Nav.map'] };
  if (!goal) return { step: 'goal', phase: 'guidance', anchors: ['GoalForm.title', 'Tracker.newGoal', 'Tracker.create', 'Nav.tasks'] };
  return { step: 'task', phase: 'guidance', anchors: ['NewTask.title', 'Tracker.newTask', 'Tracker.create', 'Nav.tasks'] };
}

function resolveEntities(snap: GuideSnapshot) {
  const dept = findWorkDepartment(snap.record, snap.org);
  const deptId = dept ? dept.id : null;
  const hasHead = Boolean(dept && dept.employees.some(e => e.kind === 'head'));
  const goal = findTrackedGoal(snap.record, snap.goals, deptId);
  const goalId = goal ? goal.id : null;
  const taskId = snap.record.taskId;
  const trackedTask = taskId && snap.tasks ? snap.tasks.find(t => t.id === taskId) ?? null : null;
  const taskAccessible = taskId !== null && (snap.tasks === undefined || trackedTask !== null);
  const workConfirmed = snap.record.workConfirmed || hasConfirmedWorkStart(taskId, snap.tasks, snap.org);
  return { dept, deptId, hasHead, goal, goalId, taskId, trackedTask, taskAccessible, workConfirmed };
}

/* Pure state derivation for the first-run guide after Setup. */
export function deriveGuideState(snap: GuideSnapshot): DerivedGuideState {
  const plan = inspectPlan(snap);
  const e = resolveEntities(snap);
  const done = collectDone(snap, plan, { dept: Boolean(e.dept), head: e.hasHead, goal: Boolean(e.goal), task: Boolean(e.taskId), work: e.workConfirmed });
  const base = { done, departmentId: e.deptId, goalId: e.goalId, taskId: e.taskId, workConfirmed: e.workConfirmed, taskAccessible: e.taskAccessible };

  if (e.workConfirmed || e.taskId) {
    return { ...base, step: 'work', phase: workPhaseOf(snap, e.taskId ?? '', e.trackedTask, e.workConfirmed), anchors: ['TaskPanel.workStatus', 'Nav.tasks'] };
  }
  const blocker = resolvePlanBlocker(snap, plan, e.dept, e.hasHead);
  return { ...base, ...(blocker ?? nextWorkspaceStep(e.dept, e.hasHead, e.goal)) };
}

/* Permitted route to navigate to when the person clicks "Resume guide". */
export function resumeTargetRoute(state: DerivedGuideState): Route {
  if (state.step === 'machine') return { kind: 'machines' };
  if (state.step === 'plan') return { kind: 'subscriptions' };
  if (state.step === 'department') return { kind: 'map' };
  if (state.step === 'staff' && state.departmentId) return { kind: 'department', id: state.departmentId };
  if (state.step === 'work' && state.taskId && state.taskAccessible) return { kind: 'tasks', id: state.taskId };
  return state.departmentId ? { kind: 'tasks', department: state.departmentId } : { kind: 'tasks' };
}
