/* Canonical world-engine progression formulas and live company-to-world state contract.
   Single source of truth shared between server and web; contains zero theme-specific words. */

import { z } from 'zod';
import { LOCALE_IDS, say, type Texts } from './locales.js';
import { currentLimits, type Limits, type ProviderId } from './index.js';

export const MAX_AGENT_LEVEL = 30;
export const STATUE_TASKS_PER_STAGE = 100;
export const DEFAULT_STATUE_STAGES = 20;
export const HUMAN_WAKE_COOLDOWN_MS = 60_000;

export const RESIDENT_ROLE_CLASSES = [
  'executor',
  'checker',
  'head',
  'turnkey',
  'day_laborer',
  'ruler',
] as const;
export type ResidentRoleClass = (typeof RESIDENT_ROLE_CLASSES)[number];

export const ROLE_ARCHETYPES = [
  'ruler',
  'head',
  'guard_captain',
  'architect',
  'checker',
  'builder',
  'scribe',
  'artisan',
  'patrol',
  'inspector_scout',
  'firefighter',
  'caravan_runner',
  'keykeeper',
  'machine_keeper',
  'gate_guard',
  'red_team',
  'road_builder',
  'turnkey_specialist',
  'day_laborer',
] as const;
export type RoleArchetype = (typeof ROLE_ARCHETYPES)[number];

export const RESIDENT_LIVE_STATES = [
  'working',
  'idle',
  'upgrading_home',
  'waiting_human',
  'exhausted',
  'turn_failed',
  'machine_offline',
] as const;
export type ResidentLiveState = (typeof RESIDENT_LIVE_STATES)[number];

/* All 75 role templates declared in templates/roles across all 11 Hornhoof department templates. */
export const ALL_HORNHOOF_ROLE_KEYS = [
  'BIZ-ANALYST', 'BIZ-HEAD', 'BIZ-PARTNER', 'BIZ-PM', 'BIZ-REV',
  'DEV-ARCH', 'DEV-BE', 'DEV-DOCS', 'DEV-ENG', 'DEV-FE', 'DEV-HEAD', 'DEV-OPS', 'DEV-PERF', 'DEV-PM', 'DEV-QA', 'DEV-RED', 'DEV-REV', 'DEV-SEC', 'DEV-TEST',
  'DSN-HEAD', 'DSN-PM', 'DSN-QA', 'DSN-SYS', 'DSN-UI',
  'FIN-AUDIT', 'FIN-BOOK', 'FIN-FPA', 'FIN-HEAD', 'FIN-PM',
  'HHD-BILLS', 'HHD-CAL', 'HHD-HEAD', 'HHD-PM', 'HHD-SUPPLY',
  'HOM-HEAD', 'HOM-NET', 'HOM-PM', 'HOM-SMART',
  'MKT-EDIT', 'MKT-HEAD', 'MKT-PM', 'MKT-SEO', 'MKT-SOCIAL', 'MKT-WRITE',
  'OPS-ACCT', 'OPS-BUGS', 'OPS-FIX', 'OPS-HEAD', 'OPS-INTEG', 'OPS-PM', 'OPS-PROGRAM', 'OPS-WATCH',
  'SAL-AE', 'SAL-HEAD', 'SAL-OPS', 'SAL-PM', 'SAL-REV', 'SAL-SDR',
  'SUP-HEAD', 'SUP-KB', 'SUP-PM', 'SUP-QA', 'SUP-T1', 'SUP-T2',
  'VID-BOARD', 'VID-COLOR', 'VID-EDIT', 'VID-GEN', 'VID-HEAD', 'VID-KEEP', 'VID-PM', 'VID-QA', 'VID-REF', 'VID-SOUND', 'VID-WRITE',
] as const;
export type HornhoofRoleKey = (typeof ALL_HORNHOOF_ROLE_KEYS)[number];

export type RoleClassification = Readonly<{
  roleClass: ResidentRoleClass;
  archetype: RoleArchetype;
  carriesStones: boolean;
  inspectsStones: boolean;
}>;

const ROLE_EXACT_MAP: Readonly<Record<string, { roleClass: ResidentRoleClass; archetype: RoleArchetype }>> = {
  /* Operations: security, reliability, accounts, integrations and machine tenders. */
  'OPS-HEAD': { roleClass: 'head', archetype: 'guard_captain' },
  'OPS-WATCH': { roleClass: 'executor', archetype: 'patrol' },
  'OPS-BUGS': { roleClass: 'checker', archetype: 'inspector_scout' },
  'OPS-FIX': { roleClass: 'executor', archetype: 'firefighter' },
  'OPS-INTEG': { roleClass: 'executor', archetype: 'caravan_runner' },
  'OPS-ACCT': { roleClass: 'executor', archetype: 'keykeeper' },
  'OPS-PROGRAM': { roleClass: 'executor', archetype: 'machine_keeper' },
  'OPS-PM': { roleClass: 'executor', archetype: 'scribe' },

  /* Development: builders, architects, reviewers, testers, security and release engineers. */
  'DEV-HEAD': { roleClass: 'head', archetype: 'head' },
  'DEV-ARCH': { roleClass: 'executor', archetype: 'architect' },
  'DEV-ENG': { roleClass: 'executor', archetype: 'builder' },
  'DEV-BE': { roleClass: 'executor', archetype: 'builder' },
  'DEV-FE': { roleClass: 'executor', archetype: 'builder' },
  'DEV-PERF': { roleClass: 'executor', archetype: 'builder' },
  'DEV-OPS': { roleClass: 'executor', archetype: 'road_builder' },
  'DEV-DOCS': { roleClass: 'executor', archetype: 'scribe' },
  'DEV-PM': { roleClass: 'executor', archetype: 'scribe' },
  'DEV-REV': { roleClass: 'checker', archetype: 'checker' },
  'DEV-TEST': { roleClass: 'checker', archetype: 'checker' },
  'DEV-QA': { roleClass: 'checker', archetype: 'checker' },
  'DEV-SEC': { roleClass: 'checker', archetype: 'gate_guard' },
  'DEV-RED': { roleClass: 'checker', archetype: 'red_team' },

  /* Design. */
  'DSN-HEAD': { roleClass: 'head', archetype: 'head' },
  'DSN-UI': { roleClass: 'executor', archetype: 'artisan' },
  'DSN-SYS': { roleClass: 'executor', archetype: 'artisan' },
  'DSN-PM': { roleClass: 'executor', archetype: 'scribe' },
  'DSN-QA': { roleClass: 'checker', archetype: 'checker' },

  /* Marketing. */
  'MKT-HEAD': { roleClass: 'head', archetype: 'head' },
  'MKT-WRITE': { roleClass: 'executor', archetype: 'scribe' },
  'MKT-SEO': { roleClass: 'executor', archetype: 'scribe' },
  'MKT-SOCIAL': { roleClass: 'executor', archetype: 'caravan_runner' },
  'MKT-PM': { roleClass: 'executor', archetype: 'scribe' },
  'MKT-EDIT': { roleClass: 'checker', archetype: 'checker' },

  /* Video production: relief carvers, storyboarders, writers and reviewers. */
  'VID-HEAD': { roleClass: 'head', archetype: 'head' },
  'VID-WRITE': { roleClass: 'executor', archetype: 'scribe' },
  'VID-BOARD': { roleClass: 'executor', archetype: 'artisan' },
  'VID-COLOR': { roleClass: 'executor', archetype: 'artisan' },
  'VID-EDIT': { roleClass: 'executor', archetype: 'artisan' },
  'VID-GEN': { roleClass: 'executor', archetype: 'artisan' },
  'VID-KEEP': { roleClass: 'executor', archetype: 'artisan' },
  'VID-REF': { roleClass: 'executor', archetype: 'artisan' },
  'VID-SOUND': { roleClass: 'executor', archetype: 'artisan' },
  'VID-PM': { roleClass: 'executor', archetype: 'scribe' },
  'VID-QA': { roleClass: 'checker', archetype: 'checker' },

  /* Sales, Business Development, Support, Finance, Home Devices and Household. */
  'SAL-HEAD': { roleClass: 'head', archetype: 'head' },
  'SAL-AE': { roleClass: 'executor', archetype: 'caravan_runner' },
  'SAL-SDR': { roleClass: 'executor', archetype: 'caravan_runner' },
  'SAL-OPS': { roleClass: 'executor', archetype: 'keykeeper' },
  'SAL-PM': { roleClass: 'executor', archetype: 'scribe' },
  'SAL-REV': { roleClass: 'checker', archetype: 'checker' },

  'BIZ-HEAD': { roleClass: 'head', archetype: 'head' },
  'BIZ-ANALYST': { roleClass: 'executor', archetype: 'scribe' },
  'BIZ-PARTNER': { roleClass: 'executor', archetype: 'caravan_runner' },
  'BIZ-PM': { roleClass: 'executor', archetype: 'scribe' },
  'BIZ-REV': { roleClass: 'checker', archetype: 'checker' },

  'SUP-HEAD': { roleClass: 'head', archetype: 'head' },
  'SUP-T1': { roleClass: 'executor', archetype: 'firefighter' },
  'SUP-T2': { roleClass: 'executor', archetype: 'firefighter' },
  'SUP-KB': { roleClass: 'executor', archetype: 'scribe' },
  'SUP-PM': { roleClass: 'executor', archetype: 'scribe' },
  'SUP-QA': { roleClass: 'checker', archetype: 'checker' },

  'FIN-HEAD': { roleClass: 'head', archetype: 'head' },
  'FIN-BOOK': { roleClass: 'executor', archetype: 'keykeeper' },
  'FIN-FPA': { roleClass: 'executor', archetype: 'scribe' },
  'FIN-PM': { roleClass: 'executor', archetype: 'scribe' },
  'FIN-AUDIT': { roleClass: 'checker', archetype: 'checker' },

  'HOM-HEAD': { roleClass: 'head', archetype: 'head' },
  'HOM-NET': { roleClass: 'executor', archetype: 'machine_keeper' },
  'HOM-SMART': { roleClass: 'executor', archetype: 'machine_keeper' },
  'HOM-PM': { roleClass: 'executor', archetype: 'scribe' },

  'HHD-HEAD': { roleClass: 'head', archetype: 'head' },
  'HHD-SUPPLY': { roleClass: 'executor', archetype: 'keykeeper' },
  'HHD-BILLS': { roleClass: 'executor', archetype: 'scribe' },
  'HHD-CAL': { roleClass: 'executor', archetype: 'scribe' },
  'HHD-PM': { roleClass: 'executor', archetype: 'scribe' },
};

/* Maps any Hornhoof agent to its canonical Stage 5 behavior class and archetype.
   Enforces hard invariants: heads and rulers never carry stones; checkers inspect and can return stones. */
export function classifyAgentRole(input: Readonly<{
  kind: 'orchestrator' | 'head' | 'worker';
  roleKey: string | null;
  isTurnkey: boolean;
}>): RoleClassification {
  if (input.kind === 'orchestrator') {
    return { roleClass: 'ruler', archetype: 'ruler', carriesStones: false, inspectsStones: false };
  }
  const normalized = (input.roleKey ?? '').trim().toUpperCase();
  if (input.kind === 'head' || normalized.endsWith('-HEAD')) {
    const archetype: RoleArchetype = normalized === 'OPS-HEAD' ? 'guard_captain' : 'head';
    return { roleClass: 'head', archetype, carriesStones: false, inspectsStones: false };
  }
  if (input.isTurnkey) {
    return { roleClass: 'turnkey', archetype: 'turnkey_specialist', carriesStones: true, inspectsStones: false };
  }
  const exact = ROLE_EXACT_MAP[normalized];
  if (exact) {
    return {
      roleClass: exact.roleClass,
      archetype: exact.archetype,
      carriesStones: exact.roleClass === 'executor',
      inspectsStones: exact.roleClass === 'checker',
    };
  }
  if (/(?:-REV|-TEST|-QA|-AUDIT|-EDIT|-CRITIC)$/.test(normalized)) {
    return { roleClass: 'checker', archetype: 'checker', carriesStones: false, inspectsStones: true };
  }
  if (/-ARCH$/.test(normalized)) {
    return { roleClass: 'executor', archetype: 'architect', carriesStones: true, inspectsStones: false };
  }
  if (/-SEC$/.test(normalized)) {
    return { roleClass: 'checker', archetype: 'gate_guard', carriesStones: false, inspectsStones: true };
  }
  if (/-RED$/.test(normalized)) {
    return { roleClass: 'checker', archetype: 'red_team', carriesStones: false, inspectsStones: true };
  }
  if (/-WRITE$|-DOCS$/.test(normalized)) {
    return { roleClass: 'executor', archetype: 'scribe', carriesStones: true, inspectsStones: false };
  }
  if (normalized.startsWith('VID-') || normalized.startsWith('DSN-')) {
    return { roleClass: 'executor', archetype: 'artisan', carriesStones: true, inspectsStones: false };
  }
  return { roleClass: 'executor', archetype: 'builder', carriesStones: true, inspectsStones: false };
}

/* Maps canonical level (1..30) onto visual outfit progression tiers (1..5). */
export function outfitTierFromLevel(level: number): 1 | 2 | 3 | 4 | 5 {
  const l = Math.max(1, Math.min(MAX_AGENT_LEVEL, Math.floor(level)));
  if (l >= 18) return 5;
  if (l >= 10) return 4;
  if (l >= 6) return 3;
  if (l >= 3) return 2;
  return 1;
}

/* Derives one of the 7 canonical live resident states purely from real Hornhoof runtime facts. */
export function deriveResidentLiveState(input: Readonly<{
  machineOnline: boolean;
  allRestingNoSubscription: boolean;
  subscriptionExhausted: boolean;
  hasFailedTurn: boolean;
  waitingForHuman: boolean;
  isWorking: boolean;
  recentlyLeveledUp: boolean;
}>): ResidentLiveState {
  if (!input.machineOnline) return 'machine_offline';
  if (input.allRestingNoSubscription || input.subscriptionExhausted) return 'exhausted';
  if (input.hasFailedTurn) return 'turn_failed';
  if (input.waitingForHuman) return 'waiting_human';
  if (input.isWorking) return 'working';
  if (input.recentlyLeveledUp) return 'upgrading_home';
  return 'idle';
}

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

/* Extracts the earliest future limit-window reset timestamp for a subscription (ISO string or null). */
export function nextSubscriptionResetAt(
  limits: Limits | null,
  limitsUpdatedAt: string | Date | null,
  now = Date.now(),
): string | null {
  const live = currentLimits(limits, limitsUpdatedAt, now);
  if (!live) return null;
  let earliestMs = Infinity;
  let earliestIso: string | null = null;
  const consider = (resetsAt: string | null) => {
    if (!resetsAt) return;
    const ms = Date.parse(resetsAt);
    if (!Number.isFinite(ms) || ms <= now) return;
    if (ms < earliestMs) {
      earliestMs = ms;
      earliestIso = resetsAt;
    }
  };
  for (const w of live.windows) consider(w.resetsAt);
  if (live.groups) {
    for (const g of live.groups) {
      for (const w of g.windows) consider(w.resetsAt);
    }
  }
  return earliestIso;
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
  hasSmoke?: boolean;
  hasStuckTask?: boolean;
  hasRecentRework?: boolean;
}>;

export type WorldLiveCurrentTask = Readonly<{
  id: string;
  number: number;
  title: string;
  goalId: string | null;
}>;

export type WorldLiveAgent = Readonly<{
  id: string;
  name: string;
  kind: 'orchestrator' | 'head' | 'worker';
  model?: string;
  roleKey: string | null;
  isTurnkey?: boolean;
  roleClass?: ResidentRoleClass;
  archetype?: RoleArchetype;
  outfitTier?: 1 | 2 | 3 | 4 | 5;
  liveState?: ResidentLiveState;
  currentTask?: WorldLiveCurrentTask | null;
  hasRecentRework?: boolean;
  talkingToAgentId?: string | null;
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

export type WorldLiveActiveCall = Readonly<{
  id: string;
  callerAgentId: string;
  departmentId: string | null;
  taskNumber: number;
  judge: boolean;
  machineId: string | null;
  provider: ProviderId | null;
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
  resetsAt?: string | null;
}>;

export type WorldLiveChildGoal = Readonly<{
  id: string;
  number: number;
  title: string;
  status: 'active' | 'reached';
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
  childGoals?: readonly WorldLiveChildGoal[];
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
  activeCalls?: readonly WorldLiveActiveCall[];
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

/* Stage 7 theme-agnostic world pack skills, voice channel boundaries and company theme contract.
   Concrete world packs register their own skills and name catalogs outside this core module. */

export const DEFAULT_COMPANY_THEME = 'cyberpunk';
export const STANDARD_COMPANY_THEMES = ['cyberpunk', 'light', 'matrix', 'pixel'] as const;
export type StandardCompanyTheme = (typeof STANDARD_COMPANY_THEMES)[number];

export const WORLD_VOICE_FORBIDDEN_CHANNELS = [
  'agent_to_agent',
  'orchestrator',
  'task',
  'commit',
  'code',
  'document',
  'external_post',
] as const;
export type WorldVoiceForbiddenChannel = (typeof WORLD_VOICE_FORBIDDEN_CHANNELS)[number];

export const WORLD_VOICE_CHANNELS = ['human_chat', ...WORLD_VOICE_FORBIDDEN_CHANNELS] as const;
export type WorldVoiceChannel = (typeof WORLD_VOICE_CHANNELS)[number];

export function isWorldVoiceAllowed(channel: WorldVoiceChannel): boolean {
  return channel === 'human_chat';
}

/* A text in every language the pack has it in; English always. */
export type WorldLangText = Texts;

export type WorldSkillKind = 'core' | 'procedure' | 'checklist' | 'gate';

export type WorldSkillChannelPolicy = Readonly<{
  humanChat: boolean;
  agentToAgent: false;
  orchestrator: false;
  tasks: false;
  commits: false;
  code: false;
  documents: false;
  externalPosts: false;
  preservesMeaningAndBadNews: true;
}>;

export type WorldSkillVoiceSpec = Readonly<{
  samples: WorldLangText;
  salutations: readonly string[];
  channels: WorldSkillChannelPolicy;
}>;

export type WorldPackSkillSpec = Readonly<{
  id: string;
  kind: WorldSkillKind;
  title: WorldLangText;
  description: WorldLangText;
  body: string;
  voice?: WorldSkillVoiceSpec;
}>;

export type WorldPackNamesSpec = Readonly<{
  ruler: WorldLangText;
  /* The crew's names by language: English always, and a language with no list takes the English one. */
  employees: Readonly<{ en: readonly string[] } & { [language: string]: readonly string[] | undefined }>;
}>;

export type WorldPackBehaviorSpec = Readonly<{
  id: string;
  label: WorldLangText;
  skills: readonly WorldPackSkillSpec[];
  names: WorldPackNamesSpec;
}>;

export type WorldThemeView = Readonly<{
  theme: string;
  activePack: Readonly<{
    id: string;
    label: WorldLangText;
    skillIds: readonly string[];
    voiceSamples?: WorldLangText;
  }> | null;
  canEdit: boolean;
  renamedAgentsCount?: number;
  restoredNamesCount?: number;
}>;

export const WORLD_NAME_LANGUAGES = LOCALE_IDS;
export type WorldNameLanguage = (typeof LOCALE_IDS)[number];

export type WorldAgentRenameCandidate = Readonly<{
  id: string;
  kind: 'orchestrator' | 'head' | 'worker';
  name: string;
  originalName: string | null;
}>;

export type WorldAgentRenamePlanItem = Readonly<{
  agentId: string;
  kind: 'orchestrator' | 'head' | 'worker';
  currentName: string;
  proposedName: string;
  preservedOriginalName: string;
}>;

export type WorldRenamePreview = Readonly<{
  packId: string;
  packLabel: WorldLangText;
  lang: WorldNameLanguage;
  items: readonly WorldAgentRenamePlanItem[];
  alreadyRenamedCount: number;
}>;

export type WorldRenameResult = Readonly<{
  packId: string;
  lang: WorldNameLanguage;
  renamedCount: number;
  items: readonly WorldAgentRenamePlanItem[];
}>;

export type WorldRestoreNamesResult = Readonly<{
  restoredCount: number;
  items: readonly Readonly<{
    agentId: string;
    previousName: string;
    restoredName: string;
  }>[];
}>;

export const WorldRenamePreviewQuerySchema = z.object({
  lang: z.enum(WORLD_NAME_LANGUAGES).default('en'),
});

export const WorldRenameExecuteSchema = z.object({
  lang: z.enum(WORLD_NAME_LANGUAGES).default('en'),
  confirmed: z.literal(true),
}).strict();
export type WorldRenameExecuteInput = z.infer<typeof WorldRenameExecuteSchema>;

export const WorldRestoreNamesSchema = z.object({
  confirmed: z.literal(true),
}).strict();
export type WorldRestoreNamesInput = z.infer<typeof WorldRestoreNamesSchema>;

/* Picks the next unused era name from a world pack in the requested language without collisions. */
export function pickNextWorldEraName(
  pack: WorldPackBehaviorSpec,
  language: WorldNameLanguage,
  existingNames: Iterable<string>,
  kind: 'orchestrator' | 'head' | 'worker',
): string {
  const taken = new Set<string>();
  for (const name of existingNames) {
    const clean = name.trim().toLowerCase();
    if (clean) taken.add(clean);
  }
  const baseList: readonly string[] = kind === 'orchestrator' ? [say(pack.names.ruler, language)] : (pack.names.employees[language] ?? pack.names.employees.en);
  const fallback = baseList.length ? baseList : [say(pack.label, language)];

  for (const candidate of fallback) {
    const clean = candidate.trim();
    if (clean && !taken.has(clean.toLowerCase())) return clean;
  }
  for (let suffix = 2; suffix < 10_000; suffix++) {
    for (const candidate of fallback) {
      const clean = `${candidate.trim()} ${suffix}`;
      if (!taken.has(clean.toLowerCase())) return clean;
    }
  }
  return `${fallback[0]!.trim()} ${taken.size + 1}`;
}

/* Computes a deterministic bulk rename plan for all active non-assistant agents while preserving pre-world names. */
export function planWorldAgentRenames(
  pack: WorldPackBehaviorSpec,
  language: WorldNameLanguage,
  activeAgents: readonly WorldAgentRenameCandidate[],
): WorldAgentRenamePlanItem[] {
  const used = new Set<string>();
  const items: WorldAgentRenamePlanItem[] = [];
  for (const agent of activeAgents) {
    const proposedName = pickNextWorldEraName(pack, language, used, agent.kind);
    used.add(proposedName.toLowerCase());
    items.push({
      agentId: agent.id,
      kind: agent.kind,
      currentName: agent.name,
      proposedName,
      preservedOriginalName: agent.originalName ?? agent.name,
    });
  }
  return items;
}

const THEME_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const WorldThemeUpdateSchema = z.object({
  theme: z.string().trim().min(1).max(60).regex(THEME_ID_PATTERN),
}).strict();
export type WorldThemeUpdateInput = z.infer<typeof WorldThemeUpdateSchema>;

const VOICE_BODY_REQUIRED_HINTS: readonly Readonly<{ label: string; pattern: RegExp }>[] = [
  { label: 'human-only scope', pattern: /human|people/i },
  { label: 'agent-to-agent prohibition', pattern: /agent-to-agent|other agents|between agents|message_employee/i },
  { label: 'orchestrator prohibition', pattern: /orchestrator/i },
  { label: 'tasks prohibition', pattern: /task/i },
  { label: 'commits prohibition', pattern: /commit/i },
  { label: 'code prohibition', pattern: /code/i },
  { label: 'documents prohibition', pattern: /document/i },
  { label: 'posts/external prohibition', pattern: /post|external/i },
  { label: 'meaning and bad-news preservation', pattern: /bad news/i },
];

/* Validates a world pack's skills and era name lists without knowing any specific theme. */
export function validateWorldPackBehavior(pack: WorldPackBehaviorSpec): string[] {
  const issues: string[] = [];
  if (!THEME_ID_PATTERN.test(pack.id)) {
    issues.push(`Invalid world pack id "${pack.id}".`);
  }
  if (!pack.label.en.trim()) {
    issues.push(`World pack "${pack.id}" must declare an en label.`);
  }
  if (!pack.skills.length) {
    issues.push(`World pack "${pack.id}" must declare at least one skill.`);
  }

  const skillIds = new Set<string>();
  let voiceSkills = 0;
  for (const skill of pack.skills) {
    if (!THEME_ID_PATTERN.test(skill.id)) {
      issues.push(`Invalid skill id "${skill.id}" in world pack "${pack.id}".`);
    }
    if (skillIds.has(skill.id)) {
      issues.push(`Duplicate skill id "${skill.id}" in world pack "${pack.id}".`);
    }
    skillIds.add(skill.id);
    if (!skill.title.en.trim()) {
      issues.push(`Skill "${skill.id}" must declare an en title.`);
    }
    if (!skill.description.en.trim()) {
      issues.push(`Skill "${skill.id}" must declare an en description.`);
    }
    if (!skill.body.trim()) {
      issues.push(`Skill "${skill.id}" body must be non-empty.`);
    }
    if (skill.voice) {
      voiceSkills += 1;
      const { samples, salutations, channels } = skill.voice;
      if (!samples.en.trim()) {
        issues.push(`Voice skill "${skill.id}" must declare an en sample phrase.`);
      }
      if (!salutations.length || salutations.some(s => !s.trim())) {
        issues.push(`Voice skill "${skill.id}" must declare non-empty salutations.`);
      }
      if (!channels.humanChat) {
        issues.push(`Voice skill "${skill.id}" must allow humanChat.`);
      }
      if (
        channels.agentToAgent !== false ||
        channels.orchestrator !== false ||
        channels.tasks !== false ||
        channels.commits !== false ||
        channels.code !== false ||
        channels.documents !== false ||
        channels.externalPosts !== false ||
        channels.preservesMeaningAndBadNews !== true
      ) {
        issues.push(`Voice skill "${skill.id}" violates mandatory non-human channel prohibitions.`);
      }
      for (const hint of VOICE_BODY_REQUIRED_HINTS) {
        if (!hint.pattern.test(skill.body)) {
          issues.push(`Voice skill "${skill.id}" body is missing explicit rule for ${hint.label}.`);
        }
      }
    }
  }
  if (voiceSkills === 0) {
    issues.push(`World pack "${pack.id}" must declare at least one voice skill.`);
  }

  if (!pack.names.ruler.en.trim()) {
    issues.push(`World pack "${pack.id}" must declare a ruler name in en.`);
  }
  for (const [lang, list] of Object.entries(pack.names.employees) as [string, readonly string[]][]) {
    if (!list.length) {
      issues.push(`World pack "${pack.id}" must declare employee names for "${lang}".`);
    }
    const seen = new Set<string>();
    for (const raw of list) {
      const normalized = raw.trim().toLowerCase();
      if (!normalized) {
        issues.push(`World pack "${pack.id}" has an empty employee name in "${lang}".`);
      } else if (seen.has(normalized)) {
        issues.push(`World pack "${pack.id}" has duplicate employee name "${raw}" in "${lang}".`);
      }
      seen.add(normalized);
    }
  }
  return issues;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Detects whether text contains any voice salutation declared by the given world pack. */
export function containsWorldVoicePhrase(text: string, pack: WorldPackBehaviorSpec): boolean {
  const source = text.trim();
  if (!source) return false;
  for (const skill of pack.skills) {
    if (!skill.voice) continue;
    const phrases = new Set<string>([
      ...Object.values(skill.voice.samples).filter((sample): sample is string => sample !== undefined),
      ...skill.voice.salutations,
    ]);
    for (const phrase of phrases) {
      const clean = phrase.trim();
      if (!clean) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(clean)}($|[^\\p{L}\\p{N}_])`, 'iu');
      if (re.test(source)) return true;
    }
  }
  return false;
}
