/* Pack-agnostic side cards for Stage 8 world entity clicks and Department Mode.
   Covers every entity type (employee/house, subscription supply, machine hub, goal monument,
   department statue, orchestrator residence, and full Department Mode with overview + management).
   Contains zero theme-specific words; adapts automatically to the active theme's CSS surface tokens. */

import type {
  WorldLiveAgent,
  WorldLiveDepartment,
  WorldLiveGoal,
  WorldLiveMachine,
  WorldLiveSnapshot,
  WorldLiveSubscription,
} from '@hornhoof/protocol/world';
import { useEffect, useId, useState } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useLanguage, useT } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { AgentCardView, Department, Me, Org } from '../types';
import { ApprovalPolicy } from '../ui/ApprovalPolicy';
import { Bar } from '../ui/Bar';
import { BriefingPanel } from '../ui/Briefing';
import { DeptBranchesIfKept } from '../ui/DeptBranches';
import { Repositories } from '../ui/RepoSettings';
import { StaffCard } from '../ui/StaffCard';
import { DeptSubUnits } from '../ui/SubUnits';
import { OneShotMarks } from '../ui/TaskWorkflow';
import type { CityBuilding } from '../world/city-layout';
import type { DepartmentFocusSpec } from '../world/department-focus';
import type { ResidentEntity } from '../world/residents';
import { clock } from './Subscriptions';

export type WorldSelection =
  | { kind: 'agent'; agentId: string; resident?: ResidentEntity; building?: CityBuilding }
  | { kind: 'subscription'; subscriptionId: string; building: CityBuilding }
  | { kind: 'machine'; machineId: string; building: CityBuilding }
  | { kind: 'goal'; goalId: string; building: CityBuilding }
  | { kind: 'statue'; departmentId: string; building: CityBuilding }
  | { kind: 'orchestrator'; building?: CityBuilding }
  | { kind: 'department'; departmentId: string; building?: CityBuilding };

export type WorldSideCardsProps = Readonly<{
  me: Me;
  org: Org;
  snapshot: WorldLiveSnapshot;
  selection: WorldSelection | null;
  departmentFocus: DepartmentFocusSpec | null;
  residents: readonly ResidentEntity[];
  wakeStatus: string | null;
  canRelocateBuilding: (building: CityBuilding) => boolean;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectDepartment: (departmentId: string) => void;
  onWakeAgent: (agentId: string) => void;
  onStartRelocate: (building: CityBuilding) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenOrchestrator: () => void;
  onOpenTask?: (taskId: string) => void;
  onOpenGoal?: (goalId: string) => void;
  onOpenTracker?: (departmentId: string) => void;
  onOpenTab?: (tab: 'subscriptions' | 'machines') => void;
  onHire?: (dept: Department) => void;
}>;

function formatRam(bytes: number | null): string {
  if (!bytes || !Number.isFinite(bytes)) return '-';
  const gb = Math.round((bytes / 1024 ** 3) * 10) / 10;
  return `${gb} GB`;
}

function CardHeader({
  title,
  subtitle,
  badge,
  badgeColor,
  onClose,
}: {
  title: string;
  subtitle?: string;
  badge?: string;
  badgeColor?: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <header className="dv-drawer-h world-card-head">
      <div className="world-card-titles">
        <div className="world-card-title-row">
          {badgeColor && <span className="world-banner-dot" style={{ backgroundColor: badgeColor }} aria-hidden="true" />}
          <h3>{title}</h3>
          {badge && <span className="world-card-badge">{badge}</span>}
        </div>
        {subtitle && <p className="muted world-card-sub">{subtitle}</p>}
      </div>
      <button className="btn small ghost" type="button" onClick={onClose} aria-label={t.skins.worldCard.close}>
        {t.skins.worldCard.close}
      </button>
    </header>
  );
}

/* House or Resident -> Employee side card with level, task, subscription, machine, history, simple quick chat and full window link. */
function AgentSideCard({
  agent,
  resident,
  building,
  snapshot,
  wakeStatus,
  canRelocate,
  onClose,
  onSelectDepartment,
  onWakeAgent,
  onStartRelocate,
  onOpenAgent,
  onOpenTask,
}: {
  agent: WorldLiveAgent | null;
  resident?: ResidentEntity;
  building?: CityBuilding;
  snapshot: WorldLiveSnapshot;
  wakeStatus: string | null;
  canRelocate: boolean;
  onClose: () => void;
  onSelectDepartment: (departmentId: string) => void;
  onWakeAgent: (agentId: string) => void;
  onStartRelocate: (building: CityBuilding) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const t = useT();
  const wc = t.skins.worldCard;
  const [cardDetail, setCardDetail] = useState<AgentCardView | null>(null);
  const agentId = agent?.id ?? resident?.agentId ?? '';

  useEffect(() => {
    if (!agentId || resident?.roleClass === 'day_laborer') {
      setCardDetail(null);
      return;
    }
    let alive = true;
    void api
      .get<AgentCardView>(`/api/agents/${encodeURIComponent(agentId)}`)
      .then(data => {
        if (alive) setCardDetail(data);
      })
      .catch(() => {
        if (alive) setCardDetail(null);
      });
    return () => {
      alive = false;
    };
  }, [agentId, resident?.roleClass]);

  const name = agent?.name ?? resident?.name ?? building?.label ?? agentId;
  const roleClass = resident?.roleClass ?? agent?.roleClass ?? 'executor';
  const liveState = resident?.liveState ?? agent?.liveState ?? 'idle';
  const level = agent?.level ?? resident?.level ?? 1;
  const acceptedTasks = agent?.acceptedTasks ?? resident?.acceptedTasks ?? 0;
  const nextRemaining = agent?.nextLevelRemaining ?? resident?.nextLevelRemaining ?? 0;
  const deptId = agent?.departmentId ?? resident?.departmentId ?? building?.departmentId ?? null;
  const dept = deptId ? snapshot.departments.find(d => d.id === deptId) : null;
  const sub = agent?.subscriptionId ? snapshot.subscriptions.find(s => s.id === agent.subscriptionId) : null;
  const machine = agent?.machineId ? snapshot.machines.find(m => m.id === agent.machineId) : null;
  const currentTask = agent?.currentTask ?? resident?.currentTask ?? null;
  const history = cardDetail?.changes?.slice(0, 4) ?? [];

  return (
    <aside className="dv-drawer world-card" data-testid="world-side-card" data-card-kind="agent" aria-label={name}>
      <CardHeader
        title={name}
        subtitle={wc.roleClasses[roleClass]}
        badge={wc.liveStates[liveState]}
        onClose={onClose}
      />
      <div className="dv-drawer-b world-card-body">
        <dl className="world-card-grid">
          <div>
            <dt>{wc.level}</dt>
            <dd data-testid="world-card-level">
              {roleClass === 'day_laborer' ? '-' : wc.levelShort(level)}
            </dd>
          </div>
          <div>
            <dt>{wc.acceptedTasks}</dt>
            <dd>{acceptedTasks}</dd>
          </div>
          <div>
            <dt>{wc.toNextLevel}</dt>
            <dd>{nextRemaining > 0 ? nextRemaining : wc.maxLevel}</dd>
          </div>
          <div>
            <dt>{wc.department}</dt>
            <dd>
              {dept ? (
                <button className="world-link-btn" type="button" onClick={() => onSelectDepartment(dept.id)}>
                  {dept.name}
                </button>
              ) : (
                wc.cityWide
              )}
            </dd>
          </div>
          <div>
            <dt>{wc.subscription}</dt>
            <dd>{sub ? `${sub.label} (${PROVIDER_NAMES[sub.provider]})` : agent?.model || wc.unassigned}</dd>
          </div>
          <div>
            <dt>{wc.machine}</dt>
            <dd>{machine ? machine.hostname : resident?.machineHostname ?? wc.unassigned}</dd>
          </div>
        </dl>

        <section className="world-card-section">
          <h4>{wc.currentTask}</h4>
          {currentTask ? (
            <button
              className="world-task-pill"
              type="button"
              onClick={() => onOpenTask?.(currentTask.id)}
            >
              <strong>#{currentTask.number}</strong> {currentTask.title}
            </button>
          ) : (
            <p className="muted">{wc.noCurrentTask}</p>
          )}
        </section>

        <section className="world-card-section">
          <h4>{wc.history}</h4>
          {history.length > 0 ? (
            <ul className="world-card-list">
              {history.map((ch, idx) => (
                <li key={`${ch.at}-${ch.field}-${idx}`}>
                  <span>{ch.field}</span>
                  <small className="muted">{ch.personName ?? ch.actingAgent?.name ?? (ch.byOrchestrator ? t.map.orchestrator : '')}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{wc.noHistory}</p>
          )}
        </section>

        {wakeStatus && <p className="world-card-notice" role="status">{wakeStatus}</p>}
        {building?.pendingRelocation && (
          <p className="world-card-notice" role="status">
            {wc.pendingMove(building.pendingRelocation.taskNumber)}
          </p>
        )}

        <div className="world-card-actions">
          {roleClass !== 'day_laborer' && agentId && (
            <>
              <button className="btn small ghost" type="button" onClick={() => onWakeAgent(agentId)}>
                {wc.wakeBtn}
              </button>
              <button className="btn small" type="button" onClick={() => onOpenAgent(agentId)}>
                {wc.openAgentWindow}
              </button>
            </>
          )}
          {building && canRelocate && !building.pendingRelocation && (
            <button className="btn small ghost" type="button" onClick={() => onStartRelocate(building)}>
              {wc.relocateBtn}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* Granary or Well -> Subscription side card: remaining limit, next refill time, and agents working on it. */
function SubscriptionSideCard({
  subscription,
  building,
  snapshot,
  canRelocate,
  onClose,
  onSelectAgent,
  onStartRelocate,
  onOpenTab,
}: {
  subscription: WorldLiveSubscription | null;
  building: CityBuilding;
  snapshot: WorldLiveSnapshot;
  canRelocate: boolean;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onStartRelocate: (building: CityBuilding) => void;
  onOpenTab?: (tab: 'subscriptions' | 'machines') => void;
}) {
  const t = useT();
  const wc = t.skins.worldCard;
  const { language } = useLanguage();
  const label = subscription?.label ?? building.label;
  const fullnessRatio = Math.max(0, Math.min(1, subscription?.fullness ?? building.fullness ?? 0));
  const fullnessPct = Math.round(fullnessRatio * 100);
  const remainingTone = fullnessRatio <= 0.1 ? ' max' : fullnessRatio <= 0.3 ? ' hi' : '';
  const resets = subscription?.resetsAt ? clock(language, subscription.resetsAt) : null;
  const users = [
    ...(snapshot.orchestrator && snapshot.orchestrator.subscriptionId === subscription?.id ? [snapshot.orchestrator] : []),
    ...snapshot.agents.filter(a => a.subscriptionId === subscription?.id),
  ];

  return (
    <aside className="dv-drawer world-card" data-testid="world-side-card" data-card-kind="subscription" aria-label={label}>
      <CardHeader
        title={label}
        subtitle={subscription ? `${PROVIDER_NAMES[subscription.provider]} · ${subscription.kind === 'api_key' ? t.subs.pay.api_key : t.subs.pay.personal}` : undefined}
        badge={`${fullnessPct}%`}
        onClose={onClose}
      />
      <div className="dv-drawer-b world-card-body">
        <section className="world-card-section">
          <div className="world-metric-row">
            <span>{wc.remaining}</span>
            <strong data-testid="world-sub-remaining">{fullnessPct}%</strong>
          </div>
          <span
            className={`bar${remainingTone}`}
            data-testid="world-sub-bar"
            role="progressbar"
            aria-valuenow={fullnessPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <i style={{ width: `${fullnessPct}%` }} />
          </span>
        </section>

        <dl className="world-card-grid">
          <div>
            <dt>{wc.resetsAt}</dt>
            <dd data-testid="world-sub-reset">{resets ?? wc.noResetTime}</dd>
          </div>
          <div>
            <dt>{wc.connection}</dt>
            <dd>{subscription?.active ? wc.online : subscription?.status ?? '-'}</dd>
          </div>
        </dl>

        <section className="world-card-section">
          <h4>{wc.whoWorksHere} ({users.length})</h4>
          {users.length > 0 ? (
            <ul className="world-card-list">
              {users.map(a => (
                <li key={a.id}>
                  <button className="world-link-btn" type="button" onClick={() => onSelectAgent(a.id)}>
                    {a.name}
                  </button>
                  <small className="muted">{wc.levelShort(a.level)}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{wc.noAgentsAssigned}</p>
          )}
        </section>

        <div className="world-card-actions">
          {onOpenTab && (
            <button className="btn small" type="button" onClick={() => onOpenTab('subscriptions')}>
              {wc.openSubscriptions}
            </button>
          )}
          {canRelocate && !building.pendingRelocation && (
            <button className="btn small ghost" type="button" onClick={() => onStartRelocate(building)}>
              {wc.relocateBtn}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* District Hub -> Machine side card: online status, load/hardware, and agents running on this machine. */
function MachineSideCard({
  machine,
  building,
  snapshot,
  canRelocate,
  onClose,
  onSelectAgent,
  onStartRelocate,
  onOpenTab,
}: {
  machine: WorldLiveMachine | null;
  building: CityBuilding;
  snapshot: WorldLiveSnapshot;
  canRelocate: boolean;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onStartRelocate: (building: CityBuilding) => void;
  onOpenTab?: (tab: 'subscriptions' | 'machines') => void;
}) {
  const t = useT();
  const wc = t.skins.worldCard;
  const hostname = machine?.hostname ?? building.label;
  const hosted = snapshot.agents.filter(a => a.machineId === machine?.id);
  const working = hosted.filter(a => a.liveState === 'working').length;
  const loadRatio = hosted.length > 0 ? Math.max(0, Math.min(1, working / hosted.length)) : 0;
  const loadPct = Math.round(loadRatio * 100);

  return (
    <aside className="dv-drawer world-card" data-testid="world-side-card" data-card-kind="machine" aria-label={hostname}>
      <CardHeader
        title={hostname}
        subtitle={machine ? `${machine.cores ?? '-'} CPU · ${formatRam(machine.memory)}` : undefined}
        badge={machine?.online ? wc.online : wc.offline}
        onClose={onClose}
      />
      <div className="dv-drawer-b world-card-body">
        <section className="world-card-section">
          <div className="world-metric-row">
            <span>{wc.load}</span>
            <strong data-testid="world-machine-load">{working}/{hosted.length} ({loadPct}%)</strong>
          </div>
          <Bar used={loadRatio} />
        </section>

        <dl className="world-card-grid">
          <div>
            <dt>{wc.connection}</dt>
            <dd>{machine?.online ? wc.online : wc.offline}</dd>
          </div>
          <div>
            <dt>{wc.specs}</dt>
            <dd>{machine ? `${machine.cores ?? '-'} CPU / ${formatRam(machine.memory)}` : '-'}</dd>
          </div>
        </dl>

        <section className="world-card-section">
          <h4>{wc.agentsOnMachine} ({hosted.length})</h4>
          {hosted.length > 0 ? (
            <ul className="world-card-list">
              {hosted.map(a => (
                <li key={a.id}>
                  <button className="world-link-btn" type="button" onClick={() => onSelectAgent(a.id)}>
                    {a.name}
                  </button>
                  <small className="muted">{wc.liveStates[a.liveState ?? 'idle']}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{wc.noAgentsAssigned}</p>
          )}
        </section>

        <div className="world-card-actions">
          {onOpenTab && (
            <button className="btn small" type="button" onClick={() => onOpenTab('machines')}>
              {wc.openMachines}
            </button>
          )}
          {canRelocate && !building.pendingRelocation && (
            <button className="btn small ghost" type="button" onClick={() => onStartRelocate(building)}>
              {wc.relocateBtn}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* Goal Monument -> Goal side card: progress, subgoals, and link to GoalPanel. */
function GoalSideCard({
  goal,
  building,
  canRelocate,
  onClose,
  onStartRelocate,
  onOpenGoal,
}: {
  goal: WorldLiveGoal | null;
  building: CityBuilding;
  canRelocate: boolean;
  onClose: () => void;
  onStartRelocate: (building: CityBuilding) => void;
  onOpenGoal?: (goalId: string) => void;
}) {
  const t = useT();
  const wc = t.skins.worldCard;
  const title = goal ? `#${goal.number} ${goal.title}` : building.label;
  const progressRatio = Math.max(0, Math.min(1, goal?.progress ?? building.progress ?? 0));
  const pct = Math.round(progressRatio * 100);
  const subgoals = goal?.childGoals ?? [];

  return (
    <aside className="dv-drawer world-card" data-testid="world-side-card" data-card-kind="goal" aria-label={title}>
      <CardHeader
        title={title}
        subtitle={goal?.targetValue != null ? `${goal.currentValue ?? 0} / ${goal.targetValue} ${goal.unit}`.trim() : undefined}
        badge={goal?.reached ? wc.goalReached : wc.goalActive}
        onClose={onClose}
      />
      <div className="dv-drawer-b world-card-body">
        <section className="world-card-section">
          <div className="world-metric-row">
            <span>{wc.goalProgress}</span>
            <strong data-testid="world-goal-progress">{pct}%</strong>
          </div>
          <Bar used={progressRatio} />
          {goal && (
            <p className="muted world-card-sub">
              {wc.acceptedTasks}: {goal.tasksDone}/{goal.tasksTotal}
              {goal.childGoalsTotal > 0 ? ` · ${wc.subgoals}: ${goal.childGoalsReached}/${goal.childGoalsTotal}` : ''}
            </p>
          )}
        </section>

        <section className="world-card-section">
          <h4>{wc.subgoals}</h4>
          {subgoals.length > 0 ? (
            <ul className="world-card-list">
              {subgoals.map(sub => (
                <li key={sub.id}>
                  <button className="world-link-btn" type="button" onClick={() => onOpenGoal?.(sub.id)}>
                    #{sub.number} {sub.title}
                  </button>
                  <small className="muted">{sub.status === 'reached' ? wc.goalReached : wc.goalActive}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{wc.noSubgoals}</p>
          )}
        </section>

        <div className="world-card-actions">
          {goal && onOpenGoal && (
            <button className="btn small" type="button" onClick={() => onOpenGoal(goal.id)}>
              {wc.openGoalPanel}
            </button>
          )}
          {canRelocate && !building.pendingRelocation && (
            <button className="btn small ghost" type="button" onClick={() => onStartRelocate(building)}>
              {wc.relocateBtn}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* Statue -> Department progress side card: completed tasks count & entry into Department Mode. */
function StatueSideCard({
  department,
  building,
  onClose,
  onSelectDepartment,
}: {
  department: WorldLiveDepartment | null;
  building: CityBuilding;
  onClose: () => void;
  onSelectDepartment: (departmentId: string) => void;
}) {
  const t = useT();
  const wc = t.skins.worldCard;
  const title = department?.name ?? building.label;
  const accepted = department?.acceptedTasks ?? building.acceptedTasks ?? 0;

  return (
    <aside className="dv-drawer world-card" data-testid="world-side-card" data-card-kind="statue" aria-label={title}>
      <CardHeader
        title={title}
        subtitle={wc.statueTitle}
        badge={wc.statueProgress(building.stage, building.maxStage)}
        onClose={onClose}
      />
      <div className="dv-drawer-b world-card-body">
        <p data-testid="world-statue-tasks"><strong>{wc.statueTasksDone(accepted)}</strong></p>
        <Bar used={Math.max(0, Math.min(1, building.stage / Math.max(1, building.maxStage)))} />
        <div className="world-card-actions">
          {department && (
            <button className="btn small" type="button" onClick={() => onSelectDepartment(department.id)}>
              {wc.openDeptMode}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* Palace / Tent -> Orchestrator side card with residence stage, simple quick chat and full Orchestrator window button. */
function OrchestratorSideCard({
  org,
  snapshot,
  building,
  canOpen,
  onClose,
  onOpenOrchestrator,
}: {
  org: Org;
  snapshot: WorldLiveSnapshot;
  building?: CityBuilding;
  canOpen: boolean;
  onClose: () => void;
  onOpenOrchestrator: () => void;
}) {
  const t = useT();
  const wc = t.skins.worldCard;
  const orch = snapshot.orchestrator;
  const title = orch?.name ?? org.orchestrator?.name ?? t.map.orchestrator;
  const stage = building?.stage ?? snapshot.company.residenceStage;
  const maxStage = building?.maxStage ?? 5;

  return (
    <aside className="dv-drawer world-card" data-testid="world-side-card" data-card-kind="orchestrator" aria-label={title}>
      <CardHeader
        title={title}
        subtitle={wc.residenceStage(stage, maxStage)}
        badge={`${org.agents.working}/${org.agents.total}`}
        onClose={onClose}
      />
      <div className="dv-drawer-b world-card-body">
        <dl className="world-card-grid">
          <div>
            <dt>{wc.companyAccepted}</dt>
            <dd>{snapshot.company.acceptedTasksTotal}</dd>
          </div>
          <div>
            <dt>{wc.workingAgents}</dt>
            <dd>{org.agents.working} / {org.agents.total}</dd>
          </div>
        </dl>

        {canOpen && (
          <div className="world-card-actions">
            <button className="btn small" type="button" onClick={onOpenOrchestrator}>
              {wc.openOrchestratorWindow}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

/* Department Building -> Department Mode side card preserving every existing department capability on the city map. */
function DepartmentModeCard({
  me,
  org,
  worldDept,
  orgDept,
  snapshot,
  focus,
  onClose,
  onSelectAgent,
  onOpenTask,
  onOpenTracker,
  onHire,
}: {
  me: Me;
  org: Org;
  worldDept: WorldLiveDepartment | null;
  orgDept: Department | null;
  snapshot: WorldLiveSnapshot;
  focus: DepartmentFocusSpec | null;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onOpenTask?: (taskId: string) => void;
  onOpenTracker?: (departmentId: string) => void;
  onHire?: (dept: Department) => void;
}) {
  const t = useT();
  const wc = t.skins.worldCard;
  const id = useId();
  const [tab, setTab] = useState<'overview' | 'manage'>('overview');
  const [hiring, setHiring] = useState(false);
  const [switchErr, setSwitchErr] = useState<string | null>(null);
  const [switched, setSwitched] = useState<Record<string, boolean>>({});

  const deptId = orgDept?.id ?? worldDept?.id ?? '';
  const title = orgDept ? deptLabel(t, orgDept) : (worldDept?.name ?? deptId);
  const roleCode = orgDept?.roleCode ?? worldDept?.roleCode ?? '';
  const deptAgents = snapshot.agents.filter(a => a.departmentId === deptId);
  const activeTasks = deptAgents.filter(a => a.currentTask !== null).map(a => ({ agent: a, task: a.currentTask! }));
  const company = me.person.scopeKind === 'company';
  const runs = company || (orgDept ? orgDept.people.some(p => p.id === me.person.id) : false);
  const canGive = company || runs;

  async function toggleAgent(agentId: string, nextOn: boolean) {
    setSwitchErr(null);
    setSwitched(prev => ({ ...prev, [agentId]: nextOn }));
    try {
      await api.patch(`/api/agents/${encodeURIComponent(agentId)}`, { on: nextOn });
    } catch (err) {
      setSwitched(prev => {
        const copy = { ...prev };
        delete copy[agentId];
        return copy;
      });
      setSwitchErr(errorText(t, err));
    }
  }

  return (
    <aside
      className="dv-drawer world-card world-dept-card"
      data-testid="world-side-card"
      data-card-kind="department"
      aria-label={title}
    >
      <CardHeader
        title={title}
        subtitle={`${roleCode} · ${wc.acceptedTasks}: ${worldDept?.acceptedTasks ?? 0}`}
        badge={wc.deptModeBadge}
        badgeColor={focus?.bannerColor}
        onClose={onClose}
      />

      <div className="world-card-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'overview'}
          className={`btn small ghost${tab === 'overview' ? ' on' : ''}`}
          onClick={() => setTab('overview')}
        >
          {wc.deptTabOverview}
        </button>
        {orgDept && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'manage'}
            className={`btn small ghost${tab === 'manage' ? ' on' : ''}`}
            onClick={() => setTab('manage')}
          >
            {wc.deptTabManage}
          </button>
        )}
      </div>

      <div className="dv-drawer-b world-card-body">
        {hiring && orgDept && (
          <StaffCard
            department={{ id: orgDept.id, name: title }}
            onDone={() => setHiring(false)}
            onHide={() => setHiring(false)}
          />
        )}

        {tab === 'overview' && (
          <>
            {focus && (
              <section className="world-card-section" data-testid="world-dept-workpaths">
                <h4>{wc.deptWorkPaths} ({focus.links.length})</h4>
                <ul className="world-legend-list">
                  <li>
                    <span className="world-legend-swatch" style={{ backgroundColor: focus.bannerColor }} />
                    <span>{wc.legendHandoff}</span>
                  </li>
                  <li>
                    <span className="world-legend-swatch" style={{ backgroundColor: '#4CC9F0' }} />
                    <span>{wc.legendChecker}</span>
                  </li>
                  <li>
                    <span className="world-legend-swatch" style={{ backgroundColor: '#F8E18C' }} />
                    <span>{wc.legendHead}</span>
                  </li>
                  <li>
                    <span className="world-legend-swatch dashed" style={{ borderColor: '#FFB703' }} />
                    <span>{wc.legendOneShot}</span>
                  </li>
                </ul>
              </section>
            )}

            <section className="world-card-section">
              <h4>{wc.deptPeople} ({deptAgents.length})</h4>
              {switchErr && <p className="alert" role="alert">{switchErr}</p>}
              {deptAgents.length > 0 ? (
                <ul className="world-card-list">
                  {deptAgents.map(a => {
                    const orgEmp = orgDept?.employees.find(e => e.id === a.id);
                    const isOn = switched[a.id] ?? (orgEmp ? orgEmp.status !== 'off' : true);
                    return (
                      <li key={a.id}>
                        <button className="world-link-btn" type="button" onClick={() => onSelectAgent(a.id)}>
                          <span>{a.name}</span>
                          <small className="muted">
                            {wc.roleClasses[a.roleClass ?? 'executor']} · {wc.levelShort(a.level)}
                          </small>
                        </button>
                        {orgEmp && canGive && (
                          <input
                            type="checkbox"
                            className="sw"
                            checked={isOn}
                            aria-label={a.name}
                            onChange={ev => void toggleAgent(a.id, ev.target.checked)}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">{wc.noAgentsAssigned}</p>
              )}
            </section>

            <section className="world-card-section">
              <h4>{wc.deptActiveTasks} ({activeTasks.length})</h4>
              {activeTasks.length > 0 ? (
                <ul className="world-card-list">
                  {activeTasks.map(({ agent, task }) => (
                    <li key={`${agent.id}-${task.id}`}>
                      <button className="world-task-pill" type="button" onClick={() => onOpenTask?.(task.id)}>
                        <strong>#{task.number}</strong> {task.title}
                        <small className="muted"> ({agent.name})</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{wc.deptNoActiveTasks}</p>
              )}
            </section>

            <section className="world-card-section">
              <h4>{wc.deptPipeline}</h4>
              {orgDept?.pipelines && orgDept.pipelines.length > 0 ? (
                <div className="world-pipeline-list">
                  {orgDept.pipelines.map(pipe => (
                    <div key={pipe.id} className="world-pipeline-block">
                      <strong>{pipe.name}</strong>
                      <ol className="world-stage-list">
                        {pipe.stages.map(st => (
                          <li key={st.id}>
                            <span>{st.name}</span>
                            {st.oneShot && <OneShotMarks stage={st.oneShot} calls={orgDept.calls} />}
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">{wc.deptNoPipeline}</p>
              )}
            </section>
          </>
        )}

        {tab === 'manage' && orgDept && (
          <>
            <DeptSubUnits department={orgDept} company={runs} />
            {canGive && (
              <ApprovalPolicy
                departmentId={orgDept.id}
                ownerPersonId={orgDept.people[0]?.id ?? org.people[0]?.id ?? me.person.id}
              />
            )}
            <section aria-labelledby={`${id}-briefing`}>
              <h4 id={`${id}-briefing`}>{t.briefing.title}</h4>
              <BriefingPanel placeId={orgDept.id} />
            </section>
            {runs && <Repositories department={orgDept} />}
            <DeptBranchesIfKept department={orgDept} shown={runs} />
          </>
        )}

        <div className="world-card-actions">
          {onOpenTracker && deptId && (
            <button className="btn small ghost" type="button" onClick={() => onOpenTracker(deptId)}>
              {wc.openDeptTasks}
            </button>
          )}
          {runs && orgDept && (
            <button
              className="btn small"
              type="button"
              onClick={() => {
                if (company && onHire) onHire(orgDept);
                else setHiring(true);
              }}
            >
              {wc.hireIntoDept}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

export function WorldSideCards({
  me,
  org,
  snapshot,
  selection,
  departmentFocus,
  residents,
  wakeStatus,
  canRelocateBuilding,
  onClose,
  onSelectAgent,
  onSelectDepartment,
  onWakeAgent,
  onStartRelocate,
  onOpenAgent,
  onOpenOrchestrator,
  onOpenTask,
  onOpenGoal,
  onOpenTracker,
  onOpenTab,
  onHire,
}: WorldSideCardsProps) {
  if (!selection) return null;

  if (selection.kind === 'agent') {
    const agent = snapshot.agents.find(a => a.id === selection.agentId) ?? null;
    const resident = selection.resident ?? residents.find(r => r.agentId === selection.agentId);
    return (
      <AgentSideCard
        agent={agent}
        resident={resident}
        building={selection.building}
        snapshot={snapshot}
        wakeStatus={wakeStatus}
        canRelocate={selection.building ? canRelocateBuilding(selection.building) : false}
        onClose={onClose}
        onSelectDepartment={onSelectDepartment}
        onWakeAgent={onWakeAgent}
        onStartRelocate={onStartRelocate}
        onOpenAgent={onOpenAgent}
        onOpenTask={onOpenTask}
      />
    );
  }

  if (selection.kind === 'subscription') {
    const sub = snapshot.subscriptions.find(s => s.id === selection.subscriptionId) ?? null;
    return (
      <SubscriptionSideCard
        subscription={sub}
        building={selection.building}
        snapshot={snapshot}
        canRelocate={canRelocateBuilding(selection.building)}
        onClose={onClose}
        onSelectAgent={onSelectAgent}
        onStartRelocate={onStartRelocate}
        onOpenTab={onOpenTab}
      />
    );
  }

  if (selection.kind === 'machine') {
    const machine = snapshot.machines.find(m => m.id === selection.machineId) ?? null;
    return (
      <MachineSideCard
        machine={machine}
        building={selection.building}
        snapshot={snapshot}
        canRelocate={canRelocateBuilding(selection.building)}
        onClose={onClose}
        onSelectAgent={onSelectAgent}
        onStartRelocate={onStartRelocate}
        onOpenTab={onOpenTab}
      />
    );
  }

  if (selection.kind === 'goal') {
    const goal = snapshot.goals.find(g => g.id === selection.goalId) ?? null;
    return (
      <GoalSideCard
        goal={goal}
        building={selection.building}
        canRelocate={canRelocateBuilding(selection.building)}
        onClose={onClose}
        onStartRelocate={onStartRelocate}
        onOpenGoal={onOpenGoal}
      />
    );
  }

  if (selection.kind === 'statue') {
    const dept = snapshot.departments.find(d => d.id === selection.departmentId) ?? null;
    return (
      <StatueSideCard
        department={dept}
        building={selection.building}
        onClose={onClose}
        onSelectDepartment={onSelectDepartment}
      />
    );
  }

  if (selection.kind === 'orchestrator') {
    return (
      <OrchestratorSideCard
        org={org}
        snapshot={snapshot}
        building={selection.building}
        canOpen={me.person.scopeKind === 'company'}
        onClose={onClose}
        onOpenOrchestrator={onOpenOrchestrator}
      />
    );
  }

  const worldDept = snapshot.departments.find(d => d.id === selection.departmentId) ?? null;
  const orgDept = org.departments.find(d => d.id === selection.departmentId) ?? null;
  return (
    <DepartmentModeCard
      me={me}
      org={org}
      worldDept={worldDept}
      orgDept={orgDept}
      snapshot={snapshot}
      focus={departmentFocus}
      onClose={onClose}
      onSelectAgent={onSelectAgent}
      onOpenTask={onOpenTask}
      onOpenTracker={onOpenTracker}
      onHire={onHire}
    />
  );
}
