/* Canonical world-engine progression formulas and live company-to-world state contract.
   Single source of truth shared between server and web; contains zero theme-specific words. */

import { z } from 'zod';
import { currentLimits, type Limits, type ProviderId } from './index.js';

export const MAX_AGENT_LEVEL = 30;
export const STATUE_TASKS_PER_STAGE = 100;
export const DEFAULT_STATUE_STAGES = 20;

export const WORLD_BUILDING_KINDS = [
  'residence',
  'monument',
  'department',
  'district_hub',
  'supply',
  'house',
  'statue',
  'flophouse',
] as const;
export type WorldBuildingKind = (typeof WORLD_BUILDING_KINDS)[number];

export const WORLD_MODES = ['empty_lot', 'no_subscription', 'active'] as const;
export type WorldMode = (typeof WORLD_MODES)[number];

export const RESIDENCE_TIER_KEYS = [
  'camp',
  'mud_house',
  'stone_house',
  'columned_hall',
  'grand_residence',
] as const;
export type ResidenceTierKey = (typeof RESIDENCE_TIER_KEYS)[number];

export type DepartmentStatueProgress = Readonly<{
  index: number;
  stage: number;
  maxStage: number;
  completed: boolean;
  sizeTier: 1 | 2 | 3;
  span: 1 | 2 | 3;
}>;

export type ResidenceStageResult = Readonly<{
  stage: number;
  maxStage: number;
  tierKey: ResidenceTierKey;
}>;

export type GoalMonumentInput = Readonly<{
  status: 'active' | 'reached' | 'dropped';
  targetValue: number | null;
  currentValue: number | null;
  childGoalsTotal: number;
  childGoalsReached: number;
  tasksTotal: number;
  tasksDone: number;
}>;

export type GoalMonumentProgress = Readonly<{
  progress: number;
  stage: number;
  maxStage: number;
  reached: boolean;
  celebrating: boolean;
}>;

export type SubscriptionFullnessResult = Readonly<{
  fullness: number;
  exhausted: boolean;
  active: boolean;
}>;

export type MachinePowerResult = Readonly<{
  tier: 1 | 2 | 3;
  span: 2 | 3 | 4;
  score: number;
}>;

export type NextLevelProgress = Readonly<{
  level: number;
  currentThreshold: number;
  nextThreshold: number | null;
  remaining: number;
}>;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/* Threshold of accepted tasks required to reach level L (1..30):
   round(2 * (L - 1)^1.8) -> 0, 2, 7, 14, 24, 36, 50 ... 858.
   Rework returns never grant progress; only accepted (done) tasks count. */
export function agentLevelThreshold(level: number): number {
  const l = Math.max(1, Math.min(MAX_AGENT_LEVEL, Math.floor(level)));
  if (l <= 1) return 0;
  return Math.round(2 * Math.pow(l - 1, 1.8));
}

/* Computes an agent's canonical level (1..30) from accepted task count alone. */
export function agentLevelFromAcceptedTasks(acceptedTasks: number): number {
  const count = Math.max(0, Math.floor(acceptedTasks));
  let level = 1;
  for (let l = 2; l <= MAX_AGENT_LEVEL; l++) {
    if (count >= agentLevelThreshold(l)) level = l;
    else break;
  }
  return level;
}

/* Reports current level and how many accepted tasks remain until the next level. */
export function nextLevelProgress(acceptedTasks: number): NextLevelProgress {
  const count = Math.max(0, Math.floor(acceptedTasks));
  const level = agentLevelFromAcceptedTasks(count);
  const currentThreshold = agentLevelThreshold(level);
  if (level >= MAX_AGENT_LEVEL) {
    return { level, currentThreshold, nextThreshold: null, remaining: 0 };
  }
  const nextThreshold = agentLevelThreshold(level + 1);
  return {
    level,
    currentThreshold,
    nextThreshold,
    remaining: Math.max(0, nextThreshold - count),
  };
}

/* Maps agent level (1..30) onto a pack's house stage count (1..maxStage). */
export function houseStageFromLevel(level: number, maxStage = 10): number {
  const cap = Math.max(1, Math.floor(maxStage));
  const l = clamp(Math.floor(level), 1, MAX_AGENT_LEVEL);
  if (cap === 1) return 1;
  if (l <= 1) return 1;
  if (l >= MAX_AGENT_LEVEL) return cap;
  return clamp(1 + Math.floor(((l - 1) / (MAX_AGENT_LEVEL - 1)) * (cap - 1)) + (l >= 4 ? 1 : 0), 1, cap);
}

const DEPARTMENT_STAGE_THRESHOLDS_10 = [0, 10, 25, 50, 100, 200, 400, 800, 1500, 3000] as const;

/* Computes department building stage (1..maxStage) from the department's accepted tasks. */
export function departmentStageFromAcceptedTasks(acceptedTasks: number, maxStage = 10): number {
  const cap = Math.max(1, Math.floor(maxStage));
  const count = Math.max(0, Math.floor(acceptedTasks));
  let stage10 = 1;
  for (let i = 1; i < DEPARTMENT_STAGE_THRESHOLDS_10.length; i++) {
    if (count >= DEPARTMENT_STAGE_THRESHOLDS_10[i]!) stage10 = i + 1;
    else break;
  }
  if (cap === 10) return stage10;
  return clamp(Math.round(((stage10 - 1) / 9) * (cap - 1)) + 1, 1, cap);
}

/* Computes a department's statue alley progress: every tasksPerStage (100) accepted tasks advances
   one stage, up to stagesPerStatue (20) stages per statue. Completed statues remain standing while
   a larger next statue (1x1 -> 2x2 -> 3x3) starts beside them. */
export function departmentStatuesFromAcceptedTasks(
  acceptedTasks: number,
  stagesPerStatue = DEFAULT_STATUE_STAGES,
  tasksPerStage = STATUE_TASKS_PER_STAGE,
): DepartmentStatueProgress[] {
  const stages = Math.max(1, Math.floor(stagesPerStatue));
  const step = Math.max(1, Math.floor(tasksPerStage));
  const totalSteps = Math.floor(Math.max(0, acceptedTasks) / step);
  if (totalSteps <= 0) return [];

  const completedCount = Math.floor(totalSteps / stages);
  const activeStage = totalSteps % stages;
  const result: DepartmentStatueProgress[] = [];

  for (let i = 0; i < completedCount; i++) {
    const tier = Math.min(3, i + 1) as 1 | 2 | 3;
    result.push({
      index: i + 1,
      stage: stages,
      maxStage: stages,
      completed: true,
      sizeTier: tier,
      span: tier,
    });
  }
  if (activeStage > 0) {
    const tier = Math.min(3, completedCount + 1) as 1 | 2 | 3;
    result.push({
      index: completedCount + 1,
      stage: activeStage,
      maxStage: stages,
      completed: false,
      sizeTier: tier,
      span: tier,
    });
  }
  return result;
}

const RESIDENCE_STAGE_THRESHOLDS_5 = [0, 50, 250, 1000, 5000] as const;

/* Computes ruler residence stage from total accepted tasks across the company (5 canonical tiers). */
export function residenceStageFromAcceptedTasks(companyAcceptedTasks: number, maxStage = 5): ResidenceStageResult {
  const cap = Math.max(1, Math.floor(maxStage));
  const count = Math.max(0, Math.floor(companyAcceptedTasks));
  let idx = 0;
  for (let i = 1; i < RESIDENCE_STAGE_THRESHOLDS_5.length; i++) {
    if (count >= RESIDENCE_STAGE_THRESHOLDS_5[i]!) idx = i;
    else break;
  }
  const tierKey = RESIDENCE_TIER_KEYS[idx]!;
  const stage = cap === 5 ? idx + 1 : clamp(Math.round((idx / 4) * (cap - 1)) + 1, 1, cap);
  return { stage, maxStage: cap, tierKey };
}

/* Computes top-level goal monument height:
   currentValue / targetValue when numeric target exists; otherwise completed child goals ratio;
   otherwise completed tasks ratio. Reached goals display full height, golden capstone and celebration. */
export function goalMonumentProgress(input: GoalMonumentInput, maxStage = 10): GoalMonumentProgress {
  const cap = Math.max(1, Math.floor(maxStage));
  if (input.status === 'reached') {
    return { progress: 1, stage: cap, maxStage: cap, reached: true, celebrating: true };
  }

  let progress = 0;
  if (input.targetValue !== null && Number.isFinite(input.targetValue) && input.targetValue > 0) {
    const cur = input.currentValue !== null && Number.isFinite(input.currentValue) ? Math.max(0, input.currentValue) : 0;
    progress = clamp(cur / input.targetValue, 0, 1);
  } else if (input.childGoalsTotal > 0) {
    progress = clamp(Math.max(0, input.childGoalsReached) / input.childGoalsTotal, 0, 1);
  } else if (input.tasksTotal > 0) {
    progress = clamp(Math.max(0, input.tasksDone) / input.tasksTotal, 0, 1);
  }

  const stage = progress <= 0 ? 1 : clamp(Math.round(progress * cap), 1, cap);
  return { progress, stage, maxStage: cap, reached: false, celebrating: false };
}

/* Computes supply building fullness (0..1) from a subscription's live remaining limit. */
export function subscriptionFullness(
  sub: Readonly<{ status: string; limits: Limits | null; limitsUpdatedAt: string | Date | null }>,
  now = Date.now(),
): SubscriptionFullnessResult {
  if (sub.status !== 'ready') {
    return { fullness: 0, exhausted: true, active: false };
  }
  const live = currentLimits(sub.limits, sub.limitsUpdatedAt, now);
  if (!live) {
    return { fullness: 1, exhausted: false, active: true };
  }
  if (live.status === 'rejected') {
    return { fullness: 0, exhausted: true, active: true };
  }
  const utils: number[] = [];
  for (const w of live.windows) {
    if (typeof w.utilization === 'number' && Number.isFinite(w.utilization)) {
      utils.push(clamp(w.utilization, 0, 1));
    }
  }
  if (live.groups) {
    for (const g of live.groups) {
      if (g.status === 'rejected') {
        utils.push(1);
      } else {
        for (const w of g.windows) {
          if (typeof w.utilization === 'number' && Number.isFinite(w.utilization)) {
            utils.push(clamp(w.utilization, 0, 1));
          }
        }
      }
    }
  }
  if (utils.length === 0) {
    return { fullness: 1, exhausted: false, active: true };
  }
  const maxUsed = Math.max(...utils);
  const fullness = Math.round(clamp(1 - maxUsed, 0, 1) * 1000) / 1000;
  return {
    fullness,
    exhausted: fullness <= 0.001,
    active: true,
  };
}

/* Sizes a machine's district hub building from its reported CPU cores and RAM bytes. */
export function machinePowerTier(cores: number | null, memoryBytes: number | null): MachinePowerResult {
  const cpu = typeof cores === 'number' && cores > 0 ? cores : 2;
  const ramGb = typeof memoryBytes === 'number' && memoryBytes > 0 ? memoryBytes / (1024 ** 3) : 0;
  const score = Math.round((cpu + ramGb / 4) * 10) / 10;
  if (score >= 24) return { tier: 3, span: 4, score };
  if (score >= 10) return { tier: 2, span: 3, score };
  return { tier: 1, span: 2, score };
}

const FLOPHOUSE_THRESHOLDS_6 = [1, 5, 20, 60, 150, 400] as const;

/* Scales a shared day-laborer lodge (flophouse) by the count of one-shot calls. */
export function flophouseStageFromCalls(callCount: number, maxStage = 6): number {
  const count = Math.max(0, Math.floor(callCount));
  if (count <= 0) return 0;
  const cap = Math.max(1, Math.floor(maxStage));
  let stage6 = 1;
  for (let i = 1; i < FLOPHOUSE_THRESHOLDS_6.length; i++) {
    if (count >= FLOPHOUSE_THRESHOLDS_6[i]!) stage6 = i + 1;
    else break;
  }
  if (cap === 6) return stage6;
  return clamp(Math.round(((stage6 - 1) / 5) * (cap - 1)) + 1, 1, cap);
}

/* Determines whether the world renders as an empty lot (no template, no staff),
   resting starter city (template or staff present, zero ready subscriptions) or active city. */
export function deriveWorldMode(input: Readonly<{
  template: string | null;
  departmentsCount: number;
  employeesCount: number;
  readySubscriptionsCount: number;
}>): WorldMode {
  if (!input.template && input.departmentsCount === 0 && input.employeesCount === 0) {
    return 'empty_lot';
  }
  if (input.readySubscriptionsCount <= 0) {
    return 'no_subscription';
  }
  return 'active';
}

/* Wire contract for live Hornhoof company data read by the isometric world engine. */

export type WorldLiveMachine = Readonly<{
  id: string;
  hostname: string;
  cores: number | null;
  memory: number | null;
  powerTier: 1 | 2 | 3;
  hubSpan: 2 | 3 | 4;
  online: boolean;
  isDefault: boolean;
}>;

export type WorldLiveDepartment = Readonly<{
  id: string;
  name: string;
  templateKey: string | null;
  roleCode: string;
  acceptedTasks: number;
  stage: number;
  statues: readonly DepartmentStatueProgress[];
  oneShotCallsCount: number;
  headAgentId: string | null;
}>;

export type WorldLiveAgent = Readonly<{
  id: string;
  name: string;
  kind: 'orchestrator' | 'head' | 'worker';
  roleKey: string | null;
  departmentId: string | null;
  machineId: string | null;
  subscriptionId: string | null;
  provider: ProviderId | null;
  acceptedTasks: number;
  level: number;
  houseStage: number;
  nextLevelRemaining: number;
  resting: boolean;
}>;

export type WorldLiveSubscription = Readonly<{
  id: string;
  label: string;
  provider: ProviderId;
  kind: 'personal' | 'api_key';
  status: string;
  fullness: number;
  exhausted: boolean;
  active: boolean;
}>;

export type WorldLiveGoal = Readonly<{
  id: string;
  number: number;
  title: string;
  departmentId: string | null;
  status: 'active' | 'reached';
  targetValue: number | null;
  currentValue: number | null;
  unit: string;
  childGoalsTotal: number;
  childGoalsReached: number;
  tasksTotal: number;
  tasksDone: number;
  progress: number;
  stage: number;
  reached: boolean;
  celebrating: boolean;
  isPrimary: boolean;
}>;

export type WorldRelocationStatus = 'pending' | 'applied' | 'cancelled';

export type WorldRelocationStored = Readonly<{
  id: string;
  buildingId: string;
  buildingKind: WorldBuildingKind;
  buildingLabel: string;
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
  taskId: string;
  taskNumber: number;
  assigneeAgentId: string;
  departmentId: string | null;
  createdAt: string;
}>;

export type WorldRelocationRecord = WorldRelocationStored & Readonly<{
  taskStatus: string;
  status: WorldRelocationStatus;
  resolvedAt: string | null;
}>;

export type WorldLiveSnapshot = Readonly<{
  generatedAt: string;
  company: Readonly<{
    id: string;
    name: string;
    template: string | null;
    seed: string;
    worldMode: WorldMode;
    acceptedTasksTotal: number;
    residenceStage: number;
    residenceTierKey: ResidenceTierKey;
    allRestingNoSubscription: boolean;
    oneShotCallsTotal: number;
    flophouseStage: number;
  }>;
  orchestrator: WorldLiveAgent | null;
  machines: readonly WorldLiveMachine[];
  departments: readonly WorldLiveDepartment[];
  agents: readonly WorldLiveAgent[];
  subscriptions: readonly WorldLiveSubscription[];
  goals: readonly WorldLiveGoal[];
  relocations: readonly WorldRelocationRecord[];
  savedLayout: Record<string, unknown> | null;
  permissions: Readonly<{
    canRelocateAny: boolean;
    relocatableDepartmentIds: readonly string[];
  }>;
}>;

export const WorldRelocationRequestSchema = z.object({
  buildingId: z.string().trim().min(1).max(120),
  buildingKind: z.enum(WORLD_BUILDING_KINDS),
  buildingLabel: z.string().trim().min(1).max(100),
  fromCol: z.number().int().min(-10_000).max(10_000),
  fromRow: z.number().int().min(-10_000).max(10_000),
  toCol: z.number().int().min(-10_000).max(10_000),
  toRow: z.number().int().min(-10_000).max(10_000),
  departmentId: z.uuid().nullable().optional(),
  agentId: z.uuid().nullable().optional(),
  confirmed: z.literal(true),
}).strict();
export type WorldRelocationRequest = z.infer<typeof WorldRelocationRequestSchema>;

export const WorldLayoutSaveSchema = z.object({
  packId: z.string().trim().min(1).max(80),
  seed: z.string().trim().min(1).max(120),
  layout: z.record(z.string(), z.unknown()),
}).strict();
export type WorldLayoutSaveInput = z.infer<typeof WorldLayoutSaveSchema>;
