import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useOrg } from '../org';
import type { Route } from '../routes';
import { useGoals, useLive, useTasks } from '../tasks';
import type { MachineView, Me, Org, SubView } from '../types';
import { GuideCoach } from './GuideCoach';
import { deriveGuideState, resumeTargetRoute } from './state';
import {
  consumeSetupHandoff,
  loadGuideRecord,
  saveGuideRecord,
  subscribeGuideEvents,
} from './storage';
import type { DerivedGuideState, GuideMode, GuideRecord, GuideStep, GuideStorageKey } from './types';

type ShellGuideControls = {
  active: boolean;
  skipped: boolean;
  skip: () => void;
  resume: () => void;
};

const INACTIVE: ShellGuideControls = { active: false, skipped: false, skip: () => undefined, resume: () => undefined };
const ShellGuideContext = createContext<ShellGuideControls>(INACTIVE);

export const useShellGuide = (): ShellGuideControls => useContext(ShellGuideContext);

/* Account menu row: renders NOTHING for ordinary (non-first-run) sessions so existing menus never change. */
export function GuideMenuRow({ onClose }: { onClose: () => void }) {
  const t = useT();
  const guide = useShellGuide();
  if (!guide.active) return null;
  return (
    <button className="mi" type="button" onClick={() => { onClose(); (guide.skipped ? guide.resume : guide.skip)(); }}>
      <span>{guide.skipped ? t.guide.resume : t.guide.skip}</span>
    </button>
  );
}

function initialRecord(key: GuideStorageKey, firstRunMode?: GuideMode): GuideRecord | null {
  return consumeSetupHandoff(key, firstRunMode) ?? loadGuideRecord(key);
}

function sameStepList(a: readonly GuideStep[], b: readonly GuideStep[]): boolean {
  return a.length === b.length && a.every((s, i) => b[i] === s);
}

function recordChanged(a: GuideRecord, b: GuideRecord): boolean {
  return (
    a.skipped !== b.skipped ||
    a.departmentId !== b.departmentId ||
    a.goalId !== b.goalId ||
    a.taskId !== b.taskId ||
    a.workConfirmed !== b.workConfirmed ||
    !sameStepList(a.done, b.done)
  );
}

/* Loads subscriptions, machines, goals, tasks and org ONLY while an active first-run guide exists. */
function useGuideSources(enabled: boolean) {
  const orgLive = useOrg(enabled);
  const subsLive = useLive(
    enabled ? '/api/subscriptions' : null,
    (b: { subscriptions: SubView[] }) => b.subscriptions,
    m => m.type === 'org' || m.type === 'subscription.signin' || m.type === 'subscription.connecting',
  );
  const machinesLive = useLive(
    enabled ? '/api/machines' : null,
    (b: { machines: MachineView[] }) => b.machines,
    m => m.type === 'org' || m.type === 'subscription.signin',
  );
  const goalsLive = useGoals(enabled);
  const tasksLive = useTasks({ status: 'all' }, enabled);

  const reloadAll = useCallback(() => {
    orgLive.load();
    subsLive.load();
    machinesLive.load();
    goalsLive.load();
    tasksLive.load();
  }, [orgLive.load, subsLive.load, machinesLive.load, goalsLive.load, tasksLive.load]);

  return { orgLive, subsLive, machinesLive, goalsLive, tasksLive, reloadAll };
}

function useGuideEventWiring(
  enabled: boolean,
  updateRecord: (mutate: (cur: GuideRecord) => GuideRecord) => void,
  sources: ReturnType<typeof useGuideSources>,
): void {
  useEffect(() => {
    if (!enabled) return;
    return subscribeGuideEvents(event => {
      if (event.type === 'task_created') {
        updateRecord(cur => ({ ...cur, taskId: event.id }));
        sources.tasksLive.load();
        sources.orgLive.load();
      } else if (event.type === 'goal_created') {
        if (event.id) updateRecord(cur => ({ ...cur, goalId: event.id ?? cur.goalId }));
        sources.goalsLive.load();
      } else {
        sources.reloadAll();
      }
    });
  }, [enabled, updateRecord, sources]);
}

function useGuideLatch(
  record: GuideRecord | null,
  derived: DerivedGuideState | null,
  updateRecord: (mutate: (cur: GuideRecord) => GuideRecord) => void,
  setConfirmedStep: (step: GuideStep | null) => void,
): void {
  const prevDone = useRef<Set<GuideStep>>(new Set(record?.done ?? []));
  useEffect(() => {
    if (!record || !derived) return;
    if (!record.skipped) {
      const newlyDone = derived.done.filter(s => !prevDone.current.has(s));
      if (newlyDone.length) setConfirmedStep(newlyDone[newlyDone.length - 1]!);
    }
    prevDone.current = new Set(derived.done);
    updateRecord(cur => ({
      ...cur,
      done: derived.done,
      departmentId: derived.departmentId ?? cur.departmentId,
      goalId: derived.goalId ?? cur.goalId,
      taskId: derived.taskId ?? cur.taskId,
      workConfirmed: cur.workConfirmed || derived.workConfirmed,
    }));
  }, [derived, record, updateRecord, setConfirmedStep]);
}

type ProviderProps = {
  me: Me;
  firstRunMode?: GuideMode;
  route: Route;
  org: Org | null;
  orgFailure: unknown;
  contactOpen: boolean;
  dialogOpen: boolean;
  navigate: (next: Route) => void;
  openTask: (id: string) => void;
  children: ReactNode;
};

function useDerivedGuide(
  record: GuideRecord | null,
  me: Me,
  route: Route,
  org: Org | null,
  orgFailure: unknown,
  blocked: boolean,
  sources: ReturnType<typeof useGuideSources>,
): DerivedGuideState | null {
  const effectiveOrg = sources.orgLive.org ?? org;
  const effectiveOrgFailure = orgFailure ?? sources.orgLive.failure;
  return useMemo(() => {
    if (!record || !record.active) return null;
    return deriveGuideState({
      record, me, route, now: Date.now(), blockedByOverlay: blocked,
      org: effectiveOrg, orgFailure: effectiveOrgFailure,
      subs: sources.subsLive.data, subsFailure: sources.subsLive.failure,
      machines: sources.machinesLive.data, machinesFailure: sources.machinesLive.failure,
      goals: sources.goalsLive.goals, goalsFailure: sources.goalsLive.failure,
      tasks: sources.tasksLive.tasks, tasksFailure: sources.tasksLive.failure,
    });
  }, [record, me, route, effectiveOrg, effectiveOrgFailure, sources.subsLive.data, sources.subsLive.failure, sources.machinesLive.data, sources.machinesLive.failure, sources.goalsLive.goals, sources.goalsLive.failure, sources.tasksLive.tasks, sources.tasksLive.failure, blocked]);
}

function guideSummaryActive(record: GuideRecord | null, derived: DerivedGuideState | null): boolean {
  if (!record || !record.active) return false;
  return !derived || !derived.workConfirmed || derived.taskAccessible;
}

function ShellGuideOverlay({ active, record, derived, blocked, confirmedStep, focusRequest, onSkip, onOpenTask }: {
  active: boolean;
  record: GuideRecord | null;
  derived: DerivedGuideState | null;
  blocked: boolean;
  confirmedStep: GuideStep | null;
  focusRequest: number;
  onSkip: () => void;
  onOpenTask: (id: string) => void;
}) {
  if (!active || !derived || !record) return null;
  const open = derived.taskId ? () => onOpenTask(derived.taskId!) : undefined;
  return (
    <GuideCoach
      visible={!record.skipped && !blocked}
      step={derived.step}
      phase={derived.phase}
      confirmedStep={confirmedStep}
      anchors={derived.anchors}
      focusRequest={focusRequest}
      onSkip={onSkip}
      onFinish={onSkip}
      onOpenTask={open}
    />
  );
}

export function ShellGuideProvider({ me, firstRunMode, route, org, orgFailure, contactOpen, dialogOpen, navigate, openTask, children }: ProviderProps) {
  const blocked = contactOpen || dialogOpen;
  const storageKey = useMemo<GuideStorageKey>(
    () => ({ origin: window.location.origin, companyId: me.company.id, personId: me.person.id }),
    [me.company.id, me.person.id],
  );
  const [record, setRecord] = useState<GuideRecord | null>(() => initialRecord(storageKey, firstRunMode));
  const [focusRequest, setFocusRequest] = useState(0);
  const [confirmedStep, setConfirmedStep] = useState<GuideStep | null>(null);
  const enabled = Boolean(record && record.active);
  const sources = useGuideSources(enabled);

  const updateRecord = useCallback((mutate: (cur: GuideRecord) => GuideRecord) => {
    setRecord(cur => {
      if (!cur) return cur;
      const next = mutate(cur);
      if (!recordChanged(cur, next)) return cur;
      saveGuideRecord(storageKey, next);
      return next;
    });
  }, [storageKey]);

  useGuideEventWiring(enabled, updateRecord, sources);
  const derived = useDerivedGuide(record, me, route, org, orgFailure, blocked, sources);
  useGuideLatch(record, derived, updateRecord, setConfirmedStep);

  const skip = useCallback(() => {
    setConfirmedStep(null);
    updateRecord(cur => ({ ...cur, skipped: true }));
  }, [updateRecord]);

  const resume = useCallback(() => {
    setConfirmedStep(null);
    updateRecord(cur => ({ ...cur, skipped: false }));
    sources.reloadAll();
    if (derived) {
      const target = resumeTargetRoute(derived);
      if (target.kind !== route.kind) navigate(target);
    }
    setFocusRequest(n => n + 1);
  }, [updateRecord, sources.reloadAll, derived, route.kind, navigate]);

  const active = guideSummaryActive(record, derived);
  const skipped = Boolean(record && record.skipped);
  const controls = useMemo<ShellGuideControls>(
    () => (active ? { active: true, skipped, skip, resume } : INACTIVE),
    [active, skipped, skip, resume],
  );

  return (
    <ShellGuideContext value={controls}>
      {children}
      <ShellGuideOverlay active={active} record={record} derived={derived} blocked={blocked} confirmedStep={confirmedStep} focusRequest={focusRequest} onSkip={skip} onOpenTask={openTask} />
    </ShellGuideContext>
  );
}
