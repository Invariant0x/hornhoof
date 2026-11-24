/* Pure, deterministic Stage 1 company achievement computation.
   Reads only verified Hornhoof scalar records; zero side effects, zero invented data, zero currency. */

import { STATUE_TASKS_PER_STAGE, agentLevelThreshold } from '@hornhoof/protocol/world';
import { modelProvider } from '../tasks/echelons-policy.js';
import {
  ACHIEVEMENT_CATALOGUE,
  DEPT_STAGE_TWO_TASKS,
  FIRST_TIER_RATIO,
  MUDBRICK_AGENT_COUNT,
  RESIDENCE_STAGE_TWO_TASKS,
  STATUE_ALLEY_TASKS,
  STEADY_NILE_DAYS_PER_WEEK,
  STEADY_NILE_WEEKS,
  type AchievementCatalogueEntry,
  type EarnedAchievementView,
  type RewardRecordRef,
  type WorldRewardsView,
} from './rewards-catalogue.js';

const SHA40_RE = /^[0-9a-f]{40}$/;
const SEMVER_RE = /^v\d+\.\d+\.\d+$/;

export type RawDepartmentRow = { id: string; parentId: string | null };
export type RawPersonRow = { id: string; isOwner: boolean };
export type RawAgentRow = { id: string; kind: string; removedAt: Date | null };
export type RawSubscriptionRow = { id: string; provider: string };

export type RawTaskRow = {
  id: string;
  number: number;
  status: string;
  parentId: string | null;
  departmentId: string | null;
  productId: string | null;
  assigneeAgentId: string | null;
  executorAgentId: string | null;
  goalId: string | null;
  responsiblePersonId: string | null;
  createdByPersonId: string | null;
  closedAt: Date | null;
};

export type RawTaskRouteRow = {
  taskId: string;
  revision: number;
  phase: string | null;
  resultKind: string | null;
  candidateId: string | null;
  stagesComplete: boolean;
};

export type RawTaskEventRow = {
  uuid: string;
  taskId: string;
  kind: string;
  hasText: boolean;
  byOrchestrator: boolean;
  reportDone: boolean;
  testsRework: boolean;
  verdictFailed: boolean;
  repairCandidate: boolean;
  acceptedCandidateId: string | null;
  acceptedCandidateRev: number | null;
  acceptedDocumentId: string | null;
  acceptedDocumentRev: number | null;
  hasRecordedArtifact: boolean;
  hasIntegrationCommit: boolean;
  coordinationChildrenOk: boolean;
};

export type RawRequestRow = {
  taskId: string;
  kind: string;
  status: string;
  answeredBy: string | null;
};

export type RawJobRow = {
  id: string;
  taskId: string | null;
  agentId: string | null;
  subscriptionId: string;
  status: string;
  error: string | null;
  hasFailure: boolean;
  createdAt: Date;
};

export type RawTurnRow = {
  id: string;
  number: number;
  status: string;
  closedBecause: string | null;
  version: string | null;
  commit: string | null;
  closedAt: Date | null;
  createdAt: Date;
};

export type RawTurnReleaseRow = { turnId: string; commit: string };

export type RawTestRunRow = {
  id: string;
  number: number;
  status: string;
  commitSha: string | null;
  parts: number;
  createdAt: Date;
  finishedAt: Date | null;
};

export type RawTestPartRow = {
  runId: string;
  status: string;
  commit: string | null;
};

export type RawGoalRow = {
  id: string;
  number: number;
  parentGoalId: string | null;
  status: 'active' | 'reached' | 'dropped';
  responsiblePersonId: string;
  createdByPersonId: string | null;
  updatedAt: Date;
};

export type RawGoalEventRow = {
  uuid: string;
  goalId: string;
  createdAt: Date;
};

export type RawFallbackRow = {
  agentId: string;
  beforeSubId: string | null;
  afterSubId: string | null;
  createdAt: Date;
};

export type RewardsComputeInput = {
  departments: readonly RawDepartmentRow[];
  people: readonly RawPersonRow[];
  agents: readonly RawAgentRow[];
  subscriptions: readonly RawSubscriptionRow[];
  smokeDepartmentIds: ReadonlySet<string>;
  tasks: readonly RawTaskRow[];
  routes: readonly RawTaskRouteRow[];
  taskEvents: readonly RawTaskEventRow[];
  requests: readonly RawRequestRow[];
  jobs: readonly RawJobRow[];
  silentJobIds: ReadonlySet<string>;
  autoFallbacks: readonly RawFallbackRow[];
  turns: readonly RawTurnRow[];
  turnReleases: readonly RawTurnReleaseRow[];
  testRuns: readonly RawTestRunRow[];
  testParts: readonly RawTestPartRow[];
  goals: readonly RawGoalRow[];
  goalEvents: readonly RawGoalEventRow[];
};

type VerifiedTask = {
  task: RawTaskRow;
  topDeptId: string | null;
  creditAgentId: string | null;
  earnedAtMs: number;
  record: RewardRecordRef;
};

type VerifiedRecordMoment = {
  atMs: number;
  record: RewardRecordRef;
};

type VerifiedGoal = {
  goal: RawGoalRow;
  atMs: number;
  record: RewardRecordRef;
};

type EarnedHit = {
  earnedAtMs: number;
  record: RewardRecordRef;
};

function compareMoments(aMs: number, bMs: number, aNum: number, bNum: number): number {
  const diff = aMs - bMs;
  return diff !== 0 ? diff : aNum - bNum;
}

function addSetItem<K, V>(map: Map<K, Set<V>>, key: K, val: V): Set<V> {
  let set = map.get(key);
  if (!set) {
    set = new Set<V>();
    map.set(key, set);
  }
  set.add(val);
  return set;
}

function pushListItem<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const list = map.get(key);
  if (list) list.push(val);
  else map.set(key, [val]);
}

function matchesAcceptedArtifact(
  artifactId: string | null,
  artifactRev: number | null,
  route: RawTaskRouteRow,
): boolean {
  return Boolean(artifactId && artifactId === route.candidateId && artifactRev === route.revision);
}

function isStagedKindAccepted(route: RawTaskRouteRow, report: RawTaskEventRow): boolean {
  if (!route.stagesComplete) return false;
  return route.resultKind === 'code'
    ? matchesAcceptedArtifact(report.acceptedCandidateId, report.acceptedCandidateRev, route)
    : matchesAcceptedArtifact(report.acceptedDocumentId, report.acceptedDocumentRev, route);
}

function isRouteProvedByReport(route: RawTaskRouteRow, report: RawTaskEventRow): boolean {
  const kind = route.resultKind;
  if (kind === 'code' || kind === 'document') return isStagedKindAccepted(route, report);
  if (!report.hasText) return false;
  if (kind === 'turnkey') return report.hasIntegrationCommit || report.hasRecordedArtifact;
  return kind === 'coordination' && report.hasRecordedArtifact && report.coordinationChildrenOk;
}

function resolveTopDeptId(task: RawTaskRow, topDeptById: ReadonlyMap<string, string>): string | null {
  const rawId = task.departmentId ?? task.productId;
  return rawId ? (topDeptById.get(rawId) ?? rawId) : null;
}

function taskTouchesAssistant(task: RawTaskRow, assistantIds: ReadonlySet<string>): boolean {
  const assigned = task.assigneeAgentId ? assistantIds.has(task.assigneeAgentId) : false;
  const executed = task.executorAgentId ? assistantIds.has(task.executorAgentId) : false;
  return assigned || executed;
}

function isEligibleDoneTask(task: RawTaskRow, bypassedIds: ReadonlySet<string>, assistantIds: ReadonlySet<string>): boolean {
  if (task.status !== 'done' || !task.closedAt || bypassedIds.has(task.id)) return false;
  return !taskTouchesAssistant(task, assistantIds);
}

function indexClosingEvents(events: readonly RawTaskEventRow[]): {
  bypassedIds: Set<string>;
  latestReportByTask: Map<string, RawTaskEventRow>;
} {
  const bypassedIds = new Set<string>();
  const latestReportByTask = new Map<string, RawTaskEventRow>();
  for (const ev of events) {
    if (ev.kind === 'done' && ev.byOrchestrator) bypassedIds.add(ev.taskId);
    else if (ev.kind === 'report' && ev.reportDone) latestReportByTask.set(ev.taskId, ev);
  }
  return { bypassedIds, latestReportByTask };
}

function buildVerifiedTask(
  task: RawTaskRow,
  route: RawTaskRouteRow | undefined,
  report: RawTaskEventRow | undefined,
  topDeptById: ReadonlyMap<string, string>,
): VerifiedTask | null {
  if (!route || route.phase !== 'done' || !report || !isRouteProvedByReport(route, report)) return null;
  return {
    task,
    topDeptId: resolveTopDeptId(task, topDeptById),
    creditAgentId: task.executorAgentId ?? task.assigneeAgentId,
    earnedAtMs: task.closedAt!.getTime(),
    record: { kind: 'task', id: task.id, number: task.number, eventId: report.uuid },
  };
}

function extractVerifiedTasks(
  input: RewardsComputeInput,
  topDeptById: ReadonlyMap<string, string>,
  assistantIds: ReadonlySet<string>,
): VerifiedTask[] {
  const routeByTask = new Map(input.routes.map(r => [r.taskId, r]));
  const { bypassedIds, latestReportByTask } = indexClosingEvents(input.taskEvents);
  const verified: VerifiedTask[] = [];
  for (const task of input.tasks) {
    if (!isEligibleDoneTask(task, bypassedIds, assistantIds)) continue;
    const built = buildVerifiedTask(task, routeByTask.get(task.id), latestReportByTask.get(task.id), topDeptById);
    if (built) verified.push(built);
  }
  return verified.sort((a, b) => compareMoments(a.earnedAtMs, b.earnedAtMs, a.task.number, b.task.number));
}

function hasTurnReleaseTag(turn: RawTurnRow): boolean {
  if (!turn.version || !SEMVER_RE.test(turn.version)) return false;
  return Boolean(turn.commit && SHA40_RE.test(turn.commit));
}

function isReleasedTurn(turn: RawTurnRow, releaseKeys: ReadonlySet<string>): boolean {
  if (turn.status !== 'closed' || turn.closedBecause !== null || !hasTurnReleaseTag(turn)) return false;
  return releaseKeys.has(`${turn.id}:${turn.commit}`);
}

function extractVerifiedTurns(input: RewardsComputeInput): VerifiedRecordMoment[] {
  const releaseKeys = new Set(input.turnReleases.map(r => `${r.turnId}:${r.commit}`));
  const out: VerifiedRecordMoment[] = [];
  for (const turn of input.turns) {
    if (!isReleasedTurn(turn, releaseKeys)) continue;
    const at = turn.closedAt ?? turn.createdAt;
    out.push({
      atMs: at.getTime(),
      record: { kind: 'turn', id: turn.id, number: turn.number, commit: turn.commit!, version: turn.version! },
    });
  }
  return out.sort((a, b) => compareMoments(a.atMs, b.atMs, a.record.number, b.record.number));
}

function runMomentMs(run: RawTestRunRow): number {
  return (run.finishedAt ?? run.createdAt).getTime();
}

function isValidCommitRun(run: RawTestRunRow, wantStatus: string): run is RawTestRunRow & { commitSha: string } {
  return run.status === wantStatus && Boolean(run.commitSha && SHA40_RE.test(run.commitSha));
}

function partMatchesRun(part: RawTestPartRow, commitSha: string): boolean {
  return part.status === 'passed' && (!part.commit || part.commit === commitSha);
}

function runPartsAllPassed(run: RawTestRunRow & { commitSha: string }, parts: readonly RawTestPartRow[]): boolean {
  if (run.parts <= 0) return parts.every(p => p.status === 'passed');
  if (parts.length !== run.parts) return false;
  return parts.every(p => partMatchesRun(p, run.commitSha));
}

function collectLatestFailedChecks(runs: readonly RawTestRunRow[]): Map<string, number> {
  const latestFailBySha = new Map<string, number>();
  for (const run of runs) {
    if (!isValidCommitRun(run, 'failed')) continue;
    const prev = latestFailBySha.get(run.commitSha) ?? -1;
    latestFailBySha.set(run.commitSha, Math.max(prev, runMomentMs(run)));
  }
  return latestFailBySha;
}

function canRecordPassedRun(
  run: RawTestRunRow,
  byCommit: ReadonlyMap<string, VerifiedRecordMoment>,
  latestFailBySha: ReadonlyMap<string, number>,
  partsByRun: ReadonlyMap<string, RawTestPartRow[]>,
): run is RawTestRunRow & { commitSha: string } {
  if (!isValidCommitRun(run, 'passed') || byCommit.has(run.commitSha)) return false;
  const failedAt = latestFailBySha.get(run.commitSha);
  if (failedAt !== undefined && failedAt >= runMomentMs(run)) return false;
  return runPartsAllPassed(run, partsByRun.get(run.id) ?? []);
}

function extractVerifiedChecks(input: RewardsComputeInput): VerifiedRecordMoment[] {
  const partsByRun = new Map<string, RawTestPartRow[]>();
  for (const part of input.testParts) pushListItem(partsByRun, part.runId, part);
  const latestFailBySha = collectLatestFailedChecks(input.testRuns);
  const byCommit = new Map<string, VerifiedRecordMoment>();
  const sorted = [...input.testRuns].sort((a, b) => compareMoments(runMomentMs(a), runMomentMs(b), a.number, b.number));

  for (const run of sorted) {
    if (!canRecordPassedRun(run, byCommit, latestFailBySha, partsByRun)) continue;
    byCommit.set(run.commitSha, {
      atMs: runMomentMs(run),
      record: { kind: 'check', id: run.id, number: run.number, commit: run.commitSha },
    });
  }
  return [...byCommit.values()].sort((a, b) => compareMoments(a.atMs, b.atMs, a.record.number, b.record.number));
}

function extractVerifiedGoals(input: RewardsComputeInput): VerifiedGoal[] {
  const latestReachedByGoal = new Map(input.goalEvents.map(ev => [ev.goalId, ev]));
  const out: VerifiedGoal[] = [];
  for (const goal of input.goals) {
    if (goal.status !== 'reached') continue;
    const ev = latestReachedByGoal.get(goal.id);
    const at = ev ? ev.createdAt : goal.updatedAt;
    out.push({
      goal,
      atMs: at.getTime(),
      record: { kind: 'goal', id: goal.id, number: goal.number, ...(ev ? { eventId: ev.uuid } : {}) },
    });
  }
  return out.sort((a, b) => compareMoments(a.atMs, b.atMs, a.goal.number, b.goal.number));
}

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pickEarliestHit(a: EarnedHit | null, b: EarnedHit | null): EarnedHit | null {
  if (!a) return b;
  if (!b) return a;
  return b.earnedAtMs < a.earnedAtMs ? b : a;
}

function firstMatchingTaskHit(
  acceptedTasks: readonly VerifiedTask[],
  predicate: (item: VerifiedTask) => boolean,
): EarnedHit | null {
  for (const item of acceptedTasks) {
    if (predicate(item)) return { earnedAtMs: item.earnedAtMs, record: item.record };
  }
  return null;
}

function evalThresholdByGroup(
  acceptedTasks: readonly VerifiedTask[],
  keyFn: (item: VerifiedTask) => string | null,
  threshold: number,
  neededGroups = 1,
): EarnedHit | null {
  const counts = new Map<string, number>();
  let qualified = 0;
  for (const item of acceptedTasks) {
    const key = keyFn(item);
    if (!key) continue;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (next === threshold && ++qualified >= neededGroups) {
      return { earnedAtMs: item.earnedAtMs, record: item.record };
    }
  }
  return null;
}

function evalCompanyTaskCount(acceptedTasks: readonly VerifiedTask[], threshold: number): EarnedHit | null {
  const target = acceptedTasks[threshold - 1];
  return target ? { earnedAtMs: target.earnedAtMs, record: target.record } : null;
}

function isFailedTaskJob(job: RawJobRow): job is RawJobRow & { taskId: string } {
  return Boolean(job.taskId && job.status === 'failed' && job.hasFailure);
}

function evalFirefighter(
  acceptedTasks: readonly VerifiedTask[],
  jobs: readonly RawJobRow[],
  smokeDepts: ReadonlySet<string>,
): EarnedHit | null {
  const failedTaskIds = new Set(jobs.filter(isFailedTaskJob).map(j => j.taskId));
  return firstMatchingTaskHit(
    acceptedTasks,
    item => failedTaskIds.has(item.task.id) && !(item.topDeptId && smokeDepts.has(item.topDeptId)),
  );
}

function evalGongHeard(
  acceptedTasks: readonly VerifiedTask[],
  taskEvents: readonly RawTaskEventRow[],
  jobs: readonly RawJobRow[],
  silentJobIds: ReadonlySet<string>,
): EarnedHit | null {
  const stuckTaskIds = new Set(taskEvents.filter(e => e.kind === 'stuck').map(e => e.taskId));
  for (const job of jobs) {
    if (job.taskId && silentJobIds.has(job.id)) stuckTaskIds.add(job.taskId);
  }
  return firstMatchingTaskHit(acceptedTasks, item => stuckTaskIds.has(item.task.id));
}

function isDistinctProviderMove(fb: RawFallbackRow, providerBySub: ReadonlyMap<string, string>): boolean {
  if (!fb.beforeSubId || !fb.afterSubId) return false;
  const beforeProv = providerBySub.get(fb.beforeSubId);
  const afterProv = providerBySub.get(fb.afterSubId);
  return Boolean(beforeProv && afterProv && beforeProv !== afterProv);
}

function indexFallbackMoves(
  fallbacks: readonly RawFallbackRow[],
  providerBySub: ReadonlyMap<string, string>,
): Map<string, { afterSubId: string; ms: number }[]> {
  const map = new Map<string, { afterSubId: string; ms: number }[]>();
  for (const fb of fallbacks) {
    if (isDistinctProviderMove(fb, providerBySub)) {
      pushListItem(map, fb.agentId, { afterSubId: fb.afterSubId!, ms: fb.createdAt.getTime() });
    }
  }
  return map;
}

function jobRanOnFallbackMove(
  job: RawJobRow,
  movesByAgent: ReadonlyMap<string, readonly { afterSubId: string; ms: number }[]>,
): boolean {
  if (!job.agentId) return false;
  const moves = movesByAgent.get(job.agentId);
  return Boolean(moves && moves.some(m => m.afterSubId === job.subscriptionId && job.createdAt.getTime() >= m.ms));
}

function buildBackupTaskIds(
  jobs: readonly RawJobRow[],
  fallbacks: readonly RawFallbackRow[],
  subscriptions: readonly RawSubscriptionRow[],
): Set<string> {
  const providerBySub = new Map(subscriptions.map(s => [s.id, modelProvider(s.provider)]));
  const movesByAgent = indexFallbackMoves(fallbacks, providerBySub);
  const qualified = new Set<string>();
  const providersByTask = new Map<string, Set<string>>();

  for (const job of jobs) {
    if (!job.taskId) continue;
    const prov = providerBySub.get(job.subscriptionId) ?? job.subscriptionId;
    const seen = addSetItem(providersByTask, job.taskId, prov);
    if (job.error === 'handed_on' || seen.size >= 2 || jobRanOnFallbackMove(job, movesByAgent)) {
      qualified.add(job.taskId);
    }
  }
  return qualified;
}

function evalBackupProvider(
  acceptedTasks: readonly VerifiedTask[],
  jobs: readonly RawJobRow[],
  fallbacks: readonly RawFallbackRow[],
  subscriptions: readonly RawSubscriptionRow[],
): EarnedHit | null {
  const backupTaskIds = buildBackupTaskIds(jobs, fallbacks, subscriptions);
  return firstMatchingTaskHit(acceptedTasks, item => backupTaskIds.has(item.task.id));
}

function traceRootGoalId(goalId: string, goalById: ReadonlyMap<string, RawGoalRow>): string | null {
  let cur = goalById.get(goalId);
  const visited = new Set<string>();
  while (cur?.parentGoalId && !visited.has(cur.id)) {
    visited.add(cur.id);
    cur = goalById.get(cur.parentGoalId);
  }
  if (!cur || cur.parentGoalId !== null || cur.status === 'dropped') return null;
  return cur.id;
}

function traceTaskGoalId(task: RawTaskRow, taskById: ReadonlyMap<string, RawTaskRow>): string | null {
  let cur: RawTaskRow | undefined = task;
  const visited = new Set<string>();
  while (cur && !cur.goalId && cur.parentId && !visited.has(cur.id)) {
    visited.add(cur.id);
    cur = taskById.get(cur.parentId);
  }
  return cur ? cur.goalId : null;
}

function countChildGoalsByRoot(
  allGoals: readonly RawGoalRow[],
  goalById: ReadonlyMap<string, RawGoalRow>,
): Map<string, number> {
  const childTotals = new Map<string, number>();
  for (const g of allGoals) {
    if (!g.parentGoalId || g.status === 'dropped') continue;
    const rootId = traceRootGoalId(g.id, goalById);
    if (rootId) childTotals.set(rootId, (childTotals.get(rootId) ?? 0) + 1);
  }
  return childTotals;
}

function advanceChildGoalTier(
  vg: VerifiedGoal,
  childTotals: ReadonlyMap<string, number>,
  reachedChildren: Map<string, number>,
  goalById: ReadonlyMap<string, RawGoalRow>,
): EarnedHit | null {
  const rootId = traceRootGoalId(vg.goal.id, goalById);
  const total = rootId ? (childTotals.get(rootId) ?? 0) : 0;
  if (!rootId || total <= 0) return null;
  const next = (reachedChildren.get(rootId) ?? 0) + 1;
  reachedChildren.set(rootId, next);
  return next / total >= FIRST_TIER_RATIO ? { earnedAtMs: vg.atMs, record: vg.record } : null;
}

function evalFirstTierByGoals(
  topGoals: readonly RawGoalRow[],
  allGoals: readonly RawGoalRow[],
  verifiedGoals: readonly VerifiedGoal[],
  goalById: ReadonlyMap<string, RawGoalRow>,
): EarnedHit | null {
  const childTotals = countChildGoalsByRoot(allGoals, goalById);
  const topSet = new Set(topGoals.map(g => g.id));
  const reachedChildren = new Map<string, number>();
  let best: EarnedHit | null = null;

  for (const vg of verifiedGoals) {
    const hit = topSet.has(vg.goal.id)
      ? { earnedAtMs: vg.atMs, record: vg.record }
      : advanceChildGoalTier(vg, childTotals, reachedChildren, goalById);
    best = pickEarliestHit(best, hit);
  }
  return best;
}

function isCountedGoalTask(task: RawTaskRow, assistantIds: ReadonlySet<string>): boolean {
  return task.status !== 'cancelled' && !taskTouchesAssistant(task, assistantIds);
}

function indexRootTasksForGoals(
  allTasks: readonly RawTaskRow[],
  activeRoots: ReadonlySet<string>,
  goalById: ReadonlyMap<string, RawGoalRow>,
  assistantIds: ReadonlySet<string>,
): { rootByTask: Map<string, string>; totalsByRoot: Map<string, number> } {
  const taskById = new Map(allTasks.map(t => [t.id, t]));
  const rootByTask = new Map<string, string>();
  const totalsByRoot = new Map<string, number>();
  for (const t of allTasks) {
    if (!isCountedGoalTask(t, assistantIds)) continue;
    const gId = traceTaskGoalId(t, taskById);
    const rootId = gId ? traceRootGoalId(gId, goalById) : null;
    if (!rootId || !activeRoots.has(rootId)) continue;
    rootByTask.set(t.id, rootId);
    totalsByRoot.set(rootId, (totalsByRoot.get(rootId) ?? 0) + 1);
  }
  return { rootByTask, totalsByRoot };
}

function evalFirstTierByTasks(
  topGoals: readonly RawGoalRow[],
  allTasks: readonly RawTaskRow[],
  acceptedTasks: readonly VerifiedTask[],
  goalById: ReadonlyMap<string, RawGoalRow>,
  assistantIds: ReadonlySet<string>,
): EarnedHit | null {
  const activeRoots = new Set(topGoals.map(g => g.id));
  const { rootByTask, totalsByRoot } = indexRootTasksForGoals(allTasks, activeRoots, goalById, assistantIds);
  const doneByRoot = new Map<string, number>();

  for (const item of acceptedTasks) {
    const rootId = rootByTask.get(item.task.id);
    if (!rootId) continue;
    const next = (doneByRoot.get(rootId) ?? 0) + 1;
    doneByRoot.set(rootId, next);
    if (next / totalsByRoot.get(rootId)! >= FIRST_TIER_RATIO) {
      return { earnedAtMs: item.earnedAtMs, record: item.record };
    }
  }
  return null;
}

function evalFirstTier(
  allGoals: readonly RawGoalRow[],
  verifiedGoals: readonly VerifiedGoal[],
  allTasks: readonly RawTaskRow[],
  acceptedTasks: readonly VerifiedTask[],
  assistantIds: ReadonlySet<string>,
): EarnedHit | null {
  const goalById = new Map(allGoals.map(g => [g.id, g]));
  const topGoals = allGoals.filter(g => g.parentGoalId === null && g.status !== 'dropped');
  const fromGoals = evalFirstTierByGoals(topGoals, allGoals, verifiedGoals, goalById);
  const fromTasks = evalFirstTierByTasks(topGoals, allTasks, acceptedTasks, goalById, assistantIds);
  return pickEarliestHit(fromGoals, fromTasks);
}

function evalGoldenCapstone(verifiedGoals: readonly VerifiedGoal[]): EarnedHit | null {
  const top = verifiedGoals.find(vg => vg.goal.parentGoalId === null);
  return top ? { earnedAtMs: top.atMs, record: top.record } : null;
}

function isHumanRequestDecision(status: string): boolean {
  return status === 'answered' || status === 'approved' || status === 'declined';
}

function firstHitByPersonForTasks(
  acceptedTasks: readonly VerifiedTask[],
  peopleForTask: (item: VerifiedTask) => Iterable<string> | undefined,
): Map<string, EarnedHit> {
  const byPerson = new Map<string, EarnedHit>();
  for (const item of acceptedTasks) {
    const people = peopleForTask(item);
    if (!people) continue;
    for (const personId of people) {
      if (!byPerson.has(personId)) byPerson.set(personId, { earnedAtMs: item.earnedAtMs, record: item.record });
    }
  }
  return byPerson;
}

function collectAnswerersByTask(requests: readonly RawRequestRow[]): Map<string, Set<string>> {
  const answerersByTask = new Map<string, Set<string>>();
  for (const req of requests) {
    if (isHumanRequestDecision(req.status) && req.answeredBy) {
      addSetItem(answerersByTask, req.taskId, req.answeredBy);
    }
  }
  return answerersByTask;
}

function evalAnswerFromAboveByPerson(
  acceptedTasks: readonly VerifiedTask[],
  requests: readonly RawRequestRow[],
): Map<string, EarnedHit> {
  const answerersByTask = collectAnswerersByTask(requests);
  return firstHitByPersonForTasks(acceptedTasks, item => answerersByTask.get(item.task.id));
}

function isReworkEvent(ev: RawTaskEventRow): boolean {
  if (ev.kind === 'verdict') return ev.verdictFailed && ev.hasText;
  if (ev.kind === 'report') return ev.testsRework;
  return ev.kind === 'submitted' && ev.repairCandidate;
}

function taskOwnerIds(task: RawTaskRow, ownerIds: readonly string[]): string[] {
  const explicit = [task.responsiblePersonId, task.createdByPersonId].filter((x): x is string => Boolean(x));
  return explicit.length > 0 ? explicit : [...ownerIds];
}

function collectDeclinedJudges(requests: readonly RawRequestRow[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const req of requests) {
    if (req.kind === 'approval' && req.status === 'declined' && req.answeredBy) {
      addSetItem(map, req.taskId, req.answeredBy);
    }
  }
  return map;
}

function evalStrictJudgeByPerson(
  acceptedTasks: readonly VerifiedTask[],
  taskEvents: readonly RawTaskEventRow[],
  requests: readonly RawRequestRow[],
  ownerIds: readonly string[],
): Map<string, EarnedHit> {
  const directJudges = collectDeclinedJudges(requests);
  const reworkTasks = new Set<string>(directJudges.keys());
  for (const ev of taskEvents) {
    if (isReworkEvent(ev)) reworkTasks.add(ev.taskId);
  }
  return firstHitByPersonForTasks(acceptedTasks, item => {
    if (!reworkTasks.has(item.task.id)) return undefined;
    return directJudges.get(item.task.id) ?? taskOwnerIds(item.task, ownerIds);
  });
}

function isoWeekIndex(ms: number): number {
  const d = new Date(ms);
  const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = (d.getUTCDay() + 6) % 7;
  const mondayMs = utcMidnight - day * 86_400_000;
  return Math.floor(mondayMs / (7 * 86_400_000));
}

function collectThirdDayMomentsByWeek(
  moments: readonly { atMs: number; record: RewardRecordRef }[],
): Map<number, EarnedHit> {
  const daysByWeek = new Map<number, Set<string>>();
  const thirdByWeek = new Map<number, EarnedHit>();
  const sorted = [...moments].sort((a, b) => a.atMs - b.atMs);
  for (const m of sorted) {
    const wk = isoWeekIndex(m.atMs);
    const days = addSetItem(daysByWeek, wk, utcDayKey(m.atMs));
    if (days.size === STEADY_NILE_DAYS_PER_WEEK && !thirdByWeek.has(wk)) {
      thirdByWeek.set(wk, { earnedAtMs: m.atMs, record: m.record });
    }
  }
  return thirdByWeek;
}

function latestWindowHit(thirdByWeek: ReadonlyMap<number, EarnedHit>, endWeek: number): EarnedHit {
  const windowHits = [0, 1, 2, 3].map(offset => thirdByWeek.get(endWeek - offset)!);
  return windowHits.reduce((latest, cur) => (cur.earnedAtMs > latest.earnedAtMs ? cur : latest));
}

function findSteadyNileHit(moments: readonly { atMs: number; record: RewardRecordRef }[]): EarnedHit | null {
  const thirdByWeek = collectThirdDayMomentsByWeek(moments);
  const qualifiedWeeks = [...thirdByWeek.keys()].sort((a, b) => a - b);
  let streak = 0;
  let prevWeek = -999;
  for (const wk of qualifiedWeeks) {
    streak = wk === prevWeek + 1 ? streak + 1 : 1;
    prevWeek = wk;
    if (streak >= STEADY_NILE_WEEKS) return latestWindowHit(thirdByWeek, wk);
  }
  return null;
}

function addMomentsForPeople(
  momentsByPerson: Map<string, { atMs: number; record: RewardRecordRef }[]>,
  personIds: Iterable<string>,
  atMs: number,
  record: RewardRecordRef,
): void {
  for (const pid of personIds) pushListItem(momentsByPerson, pid, { atMs, record });
}

function evalSteadyNileByPerson(
  acceptedTasks: readonly VerifiedTask[],
  verifiedTurns: readonly VerifiedRecordMoment[],
  verifiedChecks: readonly VerifiedRecordMoment[],
  verifiedGoals: readonly VerifiedGoal[],
  requests: readonly RawRequestRow[],
  people: readonly RawPersonRow[],
): Map<string, EarnedHit> {
  const ownerIds = people.filter(p => p.isOwner).map(p => p.id);
  const answerersByTask = collectAnswerersByTask(requests);
  const momentsByPerson = new Map<string, { atMs: number; record: RewardRecordRef }[]>();

  for (const item of acceptedTasks) {
    const ids = new Set([...taskOwnerIds(item.task, ownerIds), ...(answerersByTask.get(item.task.id) ?? [])]);
    addMomentsForPeople(momentsByPerson, ids, item.earnedAtMs, item.record);
  }
  for (const vg of verifiedGoals) {
    const ids = new Set([vg.goal.responsiblePersonId, vg.goal.createdByPersonId].filter((x): x is string => Boolean(x)));
    addMomentsForPeople(momentsByPerson, ids, vg.atMs, vg.record);
  }
  for (const m of [...verifiedTurns, ...verifiedChecks]) {
    addMomentsForPeople(momentsByPerson, ownerIds, m.atMs, m.record);
  }

  const out = new Map<string, EarnedHit>();
  for (const [personId, list] of momentsByPerson) {
    const hit = findSteadyNileHit(list);
    if (hit) out.set(personId, hit);
  }
  return out;
}

function toEarnedView(entry: AchievementCatalogueEntry, hit: EarnedHit): EarnedAchievementView {
  return {
    id: entry.id,
    scope: entry.scope,
    name: entry.name,
    captions: entry.captions,
    rule: entry.rule,
    tier: entry.tier,
    display: entry.display,
    artKey: entry.artKey,
    earnedAt: new Date(hit.earnedAtMs).toISOString(),
    record: hit.record,
  };
}

function buildSharedHitsMap(
  input: RewardsComputeInput,
  acceptedTasks: readonly VerifiedTask[],
  verifiedGoals: readonly VerifiedGoal[],
  activeAgentIds: ReadonlySet<string>,
  assistantIds: ReadonlySet<string>,
): Map<number, EarnedHit | null> {
  const activeAgentKey = (item: VerifiedTask): string | null =>
    item.creditAgentId && activeAgentIds.has(item.creditAgentId) ? item.creditAgentId : null;
  const topDeptKey = (item: VerifiedTask): string | null => item.topDeptId;

  return new Map<number, EarnedHit | null>([
    [3, evalCompanyTaskCount(acceptedTasks, 1)],
    [4, evalThresholdByGroup(acceptedTasks, activeAgentKey, agentLevelThreshold(2))],
    [12, evalFirefighter(acceptedTasks, input.jobs, input.smokeDepartmentIds)],
    [13, evalGongHeard(acceptedTasks, input.taskEvents, input.jobs, input.silentJobIds)],
    [15, evalBackupProvider(acceptedTasks, input.jobs, input.autoFallbacks, input.subscriptions)],
    [18, evalThresholdByGroup(acceptedTasks, activeAgentKey, agentLevelThreshold(5), MUDBRICK_AGENT_COUNT)],
    [19, evalThresholdByGroup(acceptedTasks, activeAgentKey, agentLevelThreshold(10))],
    [20, evalThresholdByGroup(acceptedTasks, activeAgentKey, agentLevelThreshold(30))],
    [21, evalThresholdByGroup(acceptedTasks, topDeptKey, DEPT_STAGE_TWO_TASKS)],
    [22, evalThresholdByGroup(acceptedTasks, topDeptKey, STATUE_TASKS_PER_STAGE)],
    [23, evalThresholdByGroup(acceptedTasks, topDeptKey, STATUE_ALLEY_TASKS)],
    [24, evalCompanyTaskCount(acceptedTasks, RESIDENCE_STAGE_TWO_TASKS)],
    [25, evalFirstTier(input.goals, verifiedGoals, input.tasks, acceptedTasks, assistantIds)],
    [26, evalGoldenCapstone(verifiedGoals)],
  ]);
}

function resolveHitForEntry(
  entry: AchievementCatalogueEntry,
  sharedHits: ReadonlyMap<number, EarnedHit | null>,
  personalHits: ReadonlyMap<number, Map<string, EarnedHit>>,
  viewerPersonId: string | null,
): EarnedHit | null {
  if (entry.scope === 'shared') return sharedHits.get(entry.researchNumber) ?? null;
  if (!viewerPersonId) return null;
  return personalHits.get(entry.researchNumber)?.get(viewerPersonId) ?? null;
}

function collectVisibleEarned(
  sharedHits: ReadonlyMap<number, EarnedHit | null>,
  personalHits: ReadonlyMap<number, Map<string, EarnedHit>>,
  viewerPersonId: string | null,
): EarnedAchievementView[] {
  const visibleEarned: EarnedAchievementView[] = [];
  for (const entry of ACHIEVEMENT_CATALOGUE) {
    const hit = resolveHitForEntry(entry, sharedHits, personalHits, viewerPersonId);
    if (hit) visibleEarned.push(toEarnedView(entry, hit));
  }
  return visibleEarned;
}

export function computeCompanyRewards(
  input: RewardsComputeInput,
  viewerPersonId: string | null,
): Omit<WorldRewardsView, 'showcase'> {
  const topDeptById = new Map(input.departments.map(d => [d.id, d.parentId ?? d.id]));
  const assistantIds = new Set(input.agents.filter(a => a.kind === 'assistant').map(a => a.id));
  const activeAgentIds = new Set(input.agents.filter(a => a.removedAt === null && a.kind !== 'assistant').map(a => a.id));
  const ownerIds = input.people.filter(p => p.isOwner).map(p => p.id);

  const acceptedTasks = extractVerifiedTasks(input, topDeptById, assistantIds);
  const verifiedTurns = extractVerifiedTurns(input);
  const verifiedChecks = extractVerifiedChecks(input);
  const verifiedGoals = extractVerifiedGoals(input);

  const sharedHits = buildSharedHitsMap(input, acceptedTasks, verifiedGoals, activeAgentIds, assistantIds);
  const personalHits = new Map<number, Map<string, EarnedHit>>([
    [5, evalAnswerFromAboveByPerson(acceptedTasks, input.requests)],
    [9, evalSteadyNileByPerson(acceptedTasks, verifiedTurns, verifiedChecks, verifiedGoals, input.requests, input.people)],
    [10, evalStrictJudgeByPerson(acceptedTasks, input.taskEvents, input.requests, ownerIds)],
  ]);
  const visibleEarned = collectVisibleEarned(sharedHits, personalHits, viewerPersonId);

  return {
    catalogue: [...ACHIEVEMENT_CATALOGUE],
    earned: visibleEarned,
    counts: {
      acceptedTasks: acceptedTasks.length,
      releasedTurns: verifiedTurns.length,
      passedChecks: verifiedChecks.length,
      reachedGoals: verifiedGoals.length,
    },
  };
}
