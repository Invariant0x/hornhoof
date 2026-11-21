import type { Language } from '../i18n';
import type { Route } from '../routes';
import type { GoalView, MachineView, Me, Org, SubView, TaskLine } from '../types';

export const GUIDE_STEPS = [
  'company',
  'account',
  'plan',
  'machine',
  'department',
  'staff',
  'goal',
  'task',
  'work',
] as const;

export type GuideStep = (typeof GUIDE_STEPS)[number];
export type GuideMode = 'api_key' | 'personal' | 'later';

export type GuidePhase =
  | 'guidance'
  | 'confirmed'
  | 'recovery'
  | 'loading'
  | 'waiting_machine'
  | 'needs_login'
  | 'needs_setup'
  | 'created'
  | 'queued'
  | 'unavailable'
  | 'working'
  | 'link_ready';

export type GuideVoiceTriplet = readonly [guidance: string, confirmed: string, recovery: string];
export type GuideVoiceLocale = Record<GuideStep, GuideVoiceTriplet>;
export type GuideVoicePack = Partial<Record<Language, Partial<Record<GuideStep, readonly [string?, string?, string?]>>>>;

export type GuideCompanionKind = 'signal' | 'reed';

export type GuideStorageKey = {
  origin: string;
  companyId: string;
  personId: string;
};

/* Minimal onboarding record: never stores secrets, commands, form drafts, or answers. */
export type GuideRecord = {
  version: 1;
  active: boolean;
  skipped: boolean;
  mode: GuideMode;
  done: GuideStep[];
  departmentId: string | null;
  goalId: string | null;
  taskId: string | null;
  workConfirmed: boolean;
};

export type PreSetupGuide = {
  version: 1;
  skipped: boolean;
};

export type GuideSnapshot = {
  record: GuideRecord;
  me: Me;
  route: Route;
  org: Org | null;
  orgFailure: unknown;
  subs: SubView[] | undefined;
  subsFailure: unknown;
  machines: MachineView[] | undefined;
  machinesFailure: unknown;
  goals: GoalView[] | undefined;
  goalsFailure: unknown;
  tasks: TaskLine[] | undefined;
  tasksFailure: unknown;
  now: number;
  blockedByOverlay?: boolean;
};

export type DerivedGuideState = {
  step: GuideStep;
  phase: GuidePhase;
  done: GuideStep[];
  anchors: string[];
  departmentId: string | null;
  goalId: string | null;
  taskId: string | null;
  workConfirmed: boolean;
  /* Whether the final summary can still be opened on the task card. */
  taskAccessible: boolean;
};

export type GuideEvent =
  | { type: 'goal_created'; id?: string }
  | { type: 'task_created'; id: string }
  | { type: 'refresh' };
