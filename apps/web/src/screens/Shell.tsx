import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useT } from '../i18n';
import { notOpened, useOrg } from '../org';
import { forgetOwnerKey } from '../owner-key';
import type { Me, Org } from '../types';
import { LogoMark } from '../ui/icons';
import { Idents } from '../ui/Idents';
import { FirstContact } from '../ui/FirstContact';
import { RecoveryBanner } from '../ui/RecoveryBanner';
import { SwitchBanner } from '../ui/SwitchBanner';
import { LoadFailure, UpdateSaysIt, useLoadFailure } from '../ui/LoadFailure';
import { showsUpdate, UpdateBanner } from '../ui/UpdateBanner';
import { UpdateCut } from '../ui/UpdateCut';
import { useVersion, versionText } from '../ui/VersionMark';
import { useDecisions, useImprovements } from '../tasks';
import { GoalPanel } from '../ui/GoalPanel';
import { TaskPanel } from '../ui/TaskPanel';
import { useUpdates, type Updates } from '../updates';
import { About } from './About';
import type { StaffAsk } from './AgentWindow';
import { AgentWindowContext } from './AgentWindowContext';
import { AgentWindows, useAgentWindows } from './AgentWindows';
import { DepartmentView } from './Department';
import { useFeedbackInbox } from './Feedback';
import { FeedbackInbox } from './FeedbackInbox';
import { Improvements } from './Improvements';
import { Machines } from './Machines';
import { MapScreen } from './Map';
import { People } from './People';
import { Settings } from './Settings';
import { Subscriptions } from './Subscriptions';
import { Tasks } from './Tasks';
import { Versions } from './Versions';
import { takeEscape } from '../ui/escape';
import { placeOf, useRoute, type Route, type SettingsGroup, type TrackerPlace } from '../routes';
import { departmentIsMissing, RouteUnavailable, unavailableFailure } from './RouteUnavailable';
import { GuardBoundary, LightNotice } from '../ui/GuardBoundary';

type Tab = 'map' | 'tasks' | 'people' | 'subscriptions' | 'machines' | 'improvements' | 'inbox';
const TABS: Exclude<Tab, 'improvements' | 'inbox'>[] = ['map', 'tasks', 'people', 'subscriptions', 'machines'];
const ACCOUNT_DIALOGS = ['about', 'versions', 'settings'] as const;
type AccountDialogName = (typeof ACCOUNT_DIALOGS)[number];

function dialogOf(route: Route): AccountDialogName | null {
  return ACCOUNT_DIALOGS.find(kind => kind === route.kind) ?? null;
}

function workspaceOf(route: Route, backgrounds: Route[]) {
  const accountDialog = dialogOf(route);
  const contentRoute = accountDialog ? backgrounds[0]! : route;
  const taskId = contentRoute.kind === 'tasks' ? contentRoute.id ?? null : null;
  const card = contentRoute.kind === 'tasks' && contentRoute.card === 'goal' ? 'goal' : 'task';
  const pageRoute = taskId ? backgrounds[accountDialog ? 1 : 0] ?? { kind: 'tasks' } as const : contentRoute;
  const tab = pageRoute.kind === 'department' ? 'map' : pageRoute.kind;
  const deptId = pageRoute.kind === 'department' ? pageRoute.id : null;
  return { accountDialog, pageRoute, taskId, card, tab, deptId };
}

/* The window of the account menu open over the page. The groups of Settings are one window, so switching between them
   keeps the window and its focus. */
function AccountDialog({ route, me, updates, inbox, onRenamed, onGroup, onClose, onHome }: {
  route: Route | null; me: Me; updates: Updates; inbox: boolean; onRenamed: (name: string) => void;
  onGroup: (group?: SettingsGroup) => void; onClose: () => void; onHome: () => void;
}) {
  if (route?.kind === 'about') return <About inbox={inbox} onClose={onClose} />;
  if (route?.kind === 'versions') return <Versions updates={updates} onClose={onClose} onHome={onHome} />;
  if (route?.kind !== 'settings') return null;
  return <Settings me={me} group={route.group} onGroup={onGroup} onRenamed={onRenamed} onClose={onClose} />;
}

/* One row of the account menu: it closes the menu, then does what it says. */
function MenuRow({ label, count, onPick, onClose }: { label: string; count?: { shown: number; said: string }; onPick: () => void; onClose: () => void }) {
  return (
    <button
      className="mi"
      type="button"
      aria-label={count?.shown ? count.said : undefined}
      onClick={() => {
        onClose();
        onPick();
      }}
    >
      <span>{label}</span>
      {count && count.shown > 0 && <span className="nav-count" aria-hidden="true">{count.shown}</span>}
    </button>
  );
}

type MenuProps = {
  me: Me;
  onClose: () => void;
  onSignOut: () => void;
  onImprovements?: () => void;
  onInbox?: () => void;
  onVersions?: () => void;
  onSettings: () => void;
  onAbout: () => void;
  onContact: () => void;
  toDecide: number;
};

/* The pages of the whole company: what employees found to improve with how many wait for a decision, the feedback
   inbox and Versions. Nothing, and no line above it, for a person who sees only some departments. */
function CompanyRows({ onClose, onImprovements, onInbox, onVersions, toDecide }: Omit<MenuProps, 'me' | 'onSignOut' | 'onSettings' | 'onAbout' | 'onContact'>) {
  const t = useT();
  if (!onImprovements && !onInbox && !onVersions) return null;
  return (
    <>
      <hr className="am-sep" />
      {onImprovements && <MenuRow label={t.shell.tabs.improvements} count={{ shown: toDecide, said: t.improvements.nav(toDecide) }} onPick={onImprovements} onClose={onClose} />}
      {onInbox && <MenuRow label={t.inbox.menu} onPick={onInbox} onClose={onClose} />}
      {onVersions && <MenuRow label={t.updates.menu} onPick={onVersions} onClose={onClose} />}
    </>
  );
}

/* The short account menu as Design's reference draws it: the person and the version, then rows in groups with a line
   between them: giving the orchestrator access to this machine, Settings, the pages of the whole company, About and Log
   out. onImprovements, onInbox and onVersions: only for people who see the whole company, onInbox only on Hornhoof's own
   installation. Themes and the language live in Settings, feedback in About. */
function AccountMenu({ me, onClose, onSignOut, onSettings, onAbout, onContact, ...company }: MenuProps) {
  const t = useT();
  const version = useVersion();

  return (
    <div className="account-menu">
      <div className="am-head">
        <b>{me.person.name}</b>
        <span><bdi dir="ltr">{me.person.email}</bdi></span>
        {version && <span className="menu-version"><Idents text={t.shell.version(versionText(version))} idents={[versionText(version)]} /></span>}
      </div>
      <hr className="am-sep" />
      <MenuRow label={t.firstContact.title} onPick={onContact} onClose={onClose} />
      <MenuRow label={t.settings.menu} onPick={onSettings} onClose={onClose} />
      <CompanyRows onClose={onClose} {...company} />
      <hr className="am-sep" />
      <MenuRow label={t.about.menu} onPick={onAbout} onClose={onClose} />
      <MenuRow label={t.shell.logOut} onPick={onSignOut} onClose={onClose} />
    </div>
  );
}

/* The pages of the account menu for people who see the whole company: what employees found to improve, and on Hornhoof's
   own installation the feedback inbox. */
function CompanyPage({ tab, improvements, inbox, onTask, onHome }: {
  tab: Route['kind']; improvements: ReturnType<typeof useImprovements>; inbox: boolean; onTask: (taskId: string) => void; onHome: () => void;
}) {
  if (tab === 'improvements') return <Improvements improvements={improvements.improvements} failure={improvements.failure} inbox={inbox} onChanged={improvements.load} onTask={onTask} onHome={onHome} />;
  if (tab === 'inbox') return <FeedbackInbox onHome={onHome} />;
  return null;
}

function ShellTabs({ tab, waiting, navigate }: { tab: Route['kind']; waiting: number; navigate: ReturnType<typeof useRoute>['navigate'] }) {
  const t = useT();
  return (
    <nav className="tabs glass" aria-label={t.shell.sections}>
      {TABS.map(id => {
        const count = id === 'tasks' ? waiting : 0;
        return (
          <button
            key={id}
            type="button"
            className={tab === id ? 'on' : ''}
            aria-current={tab === id ? 'page' : undefined}
            aria-label={count ? t.tasks.navWaiting(count) : undefined}
            onClick={() => {
              navigate({ kind: id });
            }}
          >
            {t.shell.tabs[id]}
            {count > 0 && <span className="nav-count" aria-hidden="true">{count}</span>}
          </button>
        );
      })}
    </nav>
  );
}

function ShellAccount({ me, menu, setMenu, company, inbox, navigate, openAccount, onSignOut, onContact, toDecide, account, accountButton }: {
  me: Me; menu: boolean; setMenu: (open: boolean) => void; company: boolean; inbox: boolean;
  navigate: ReturnType<typeof useRoute>['navigate']; openAccount: (next: Route) => void;
  onSignOut: () => void; onContact: () => void; toDecide: number;
  account: RefObject<HTMLDivElement | null>; accountButton: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  return (
    <div className="tb-right">
      <div className="account" ref={account}>
        <button ref={accountButton} className="avatar glass" type="button" aria-label={t.shell.account} aria-expanded={menu} onClick={() => setMenu(!menu)}>
          {me.person.name.trim().charAt(0).toUpperCase()}
        </button>
        {menu && <AccountMenu me={me} onClose={() => setMenu(false)} onSignOut={onSignOut} onContact={onContact} onImprovements={company ? () => navigate({ kind: 'improvements' }) : undefined} onInbox={company && inbox ? () => navigate({ kind: 'inbox' }) : undefined} onVersions={company ? () => openAccount({ kind: 'versions' }) : undefined} onSettings={() => openAccount({ kind: 'settings', group: 'profile' })} onAbout={() => openAccount({ kind: 'about' })} toDecide={toDecide} />}
      </div>
    </div>
  );
}

/* What waits for people as the navigation counts it and the screens show it, and whose decisions the Tasks screen shows
   after a click on a person's card: null shows everyone's. */
function useDecisionsView() {
  const { decisions, failure, load } = useDecisions();
  const requests = decisions?.requests ?? [];
  return {
    all: decisions,
    requests,
    failure,
    load,
    /* What agents ask, the orchestrator's cards and his request for the computer. */
    waiting: decisions?.counts.total ?? 0,
    /* What agents ask on one task, for its panel. */
    requestsOf: (taskId: string) => requests.filter(r => r.task.id === taskId),
  };
}

function AgentWindowError({ shown, org, failure }: { shown: string | null; org: Org | null; failure: unknown }) {
  const t = useT();
  const message = useRef<HTMLParagraphElement>(null);
  const said = useLoadFailure(failure);
  useEffect(() => { message.current?.focus(); }, [shown, org, said]);
  if (!shown || org || said === null) return null;
  return <p ref={message} tabIndex={-1} className="alert" role="alert">{errorText(t, said)}</p>;
}

type Department = Org['departments'][number];
type MapRouteProps = {
  tab: Route['kind']; me: Me; dept: Department | undefined; missingDepartment: boolean;
  goHome: () => void; openAgent: (id: string) => void; openDecisions: (id: string) => void;
};

function MapWorkspace({ tab, me, dept, deptId, denied, missingDepartment, panel, goHome, openAgent, navigate, openDecisions }: MapRouteProps & {
  deptId: string | null; denied: boolean; panel: 'window' | 'task' | null; navigate: ReturnType<typeof useRoute>['navigate'];
}) {
  if (tab !== 'map' || denied || missingDepartment || (deptId && !dept)) return null;
  return (
    <MapScreen
      me={me}
      onHome={goHome}
      windowOpen={panel === 'window'}
      leftPanelOpen={panel === 'task'}
      onOpenOrchestrator={() => openAgent('orchestrator')}
      inside={!!dept}
      onOpenDepartment={id => navigate(id ? { kind: 'department', id } : { kind: 'map' })}
      onOpenDecisions={openDecisions}
    />
  );
}

/* A department still loading, or one whose load the update holds: the panel says so, and the load asks again after it. */
function DepartmentFallback({ deptId, org, orgFailure }: { deptId: string | null; org: Org | null; orgFailure: unknown }) {
  const failure = useLoadFailure(orgFailure);
  return deptId && !org && failure === null ? <div className="dview" aria-busy="true"><div className="dcanvas" /></div> : null;
}

function DepartmentWorkspace({ tab, me, dept, deptId, denied, missingDepartment, org, orgFailure, shown, panel, goHome, openAgent, openTask, openDecisions, openTracker, openDepartment, onHire }: MapRouteProps & {
  deptId: string | null; denied: boolean; org: Org | null; orgFailure: unknown; shown: string | null; panel: 'window' | 'task' | null;
  openTask: (id: string) => void; openTracker: (departmentId: string) => void; openDepartment: (id: string) => void; onHire: (dept: Department) => void;
}) {
  if (tab !== 'map' || denied || missingDepartment) return null;
  if (!dept) return <DepartmentFallback deptId={deptId} org={org} orgFailure={orgFailure} />;
  return (
    <DepartmentView
      key={dept.id}
      me={me}
      department={dept}
      deputies={org?.people ?? []}
      selected={shown}
      panel={panel}
      serverNow={org?.serverNow}
      onBack={goHome}
      onOpen={openAgent}
      onOpenTask={openTask}
      onOpenDecisions={openDecisions}
      onOpenTracker={openTracker}
      onOpenDepartment={openDepartment}
      onHire={() => onHire(dept)}
    />
  );
}

/* Setup or an accepted invitation opens the orchestrator's first contact at once. */
export function Shell({ me, welcome = false, onSignOut }: { me: Me; welcome?: boolean; onSignOut: () => void }) {
  const t = useT();
  const { route, navigate, backgrounds, switchOverlay, closeOverlay } = useRoute();
  const { accountDialog, pageRoute, taskId, card, tab, deptId } = workspaceOf(route, backgrounds);
  const goHome = () => navigate({ kind: 'map' });
  const openAccount = (next: Route) => navigate(next, route);
  const [menu, setMenu] = useState(false);
  const [contact, setContact] = useState(welcome);
  const [selfName, setSelfName] = useState(me.person.name);
  const currentMe = { ...me, person: { ...me.person, name: selfName } };
  const company = me.person.scopeKind === 'company';
  const inbox = useFeedbackInbox();
  const denied = !company && ['improvements', 'inbox', 'versions'].some(kind => kind === route.kind || kind === pageRoute.kind);
  /* The orchestrator's window opens over the map, for people who see the whole company. */
  const windows = useAgentWindows(null);
  /* A task's panel stands on the left, on its own: it and a window on the screen take each other's place. */
  const [staff, setStaff] = useState<StaffAsk | null>(null);
  const { org, failure: orgFailure } = useOrg(windows.ids.length > 0 || taskId !== null || deptId !== null);
  const orchestratorId = org?.orchestrator?.id;
  if (orchestratorId && windows.ids.includes(orchestratorId)) windows.nameOrchestrator(orchestratorId);
  const { open: openWindow, hide: hideWindow } = windows;
  useEffect(() => {
    if (taskId) hideWindow();
  }, [taskId, hideWindow]);
  /* An agent the company shows this person but does not open to them gets no window, wherever its name is clicked. */
  const openAgent = useCallback((agentId: string) => {
    if (org && notOpened(org, agentId)) return;
    if (taskId) navigate(pageRoute);
    openWindow(agentId);
  }, [org, openWindow, taskId, navigate, pageRoute]);
  const openTask = useCallback((id: string) => {
    hideWindow();
    navigate({ kind: 'tasks', id }, pageRoute);
  }, [hideWindow, navigate, pageRoute]);
  const openGoal = useCallback((id: string) => {
    hideWindow();
    navigate({ kind: 'tasks', id, card: 'goal' }, pageRoute);
  }, [hideWindow, navigate, pageRoute]);
  /* The tracker's graph grown from a task or a goal. */
  const openGraph = (root: { task?: string; goal?: string }) => navigate(root.task ? { kind: 'tasks', root: root.task, view: 'graph' } : { kind: 'tasks', goal: root.goal, view: 'graph' });
  const toPlace = (place: TrackerPlace) => navigate({ kind: 'tasks', ...place });
  const trackerPlace: TrackerPlace = pageRoute.kind === 'tasks' ? placeOf(pageRoute) : {};
  const shownPanel = windows.shown ? 'window' : taskId ? 'task' : null;
  const dept = deptId ? org?.departments.find(d => d.id === deptId) : undefined;
  const missingDepartment = departmentIsMissing({ deptId, org, orgFailure });
  const updates = useUpdates(company);
  const decisions = useDecisionsView();
  /* A person's card, on the map or in a department, opens the decisions screen showing theirs. */
  const openDecisions = (personId: string) => {
    navigate({ kind: 'tasks', show: 'waits', personId });
  };
  const { improvements, failure: improvementsFailure, load: loadImprovements } = useImprovements(company);
  const toDecide = improvements?.filter(i => i.status === 'open').length ?? 0;
  const account = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const closeContact = useCallback(() => { setContact(false); accountButton.current?.focus(); }, []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (!takeEscape(e)) return;
      setMenu(false);
      accountButton.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!account.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menu]);

  /* The person's key leaves this device with their session, whatever the server answered. */
  async function signOut() {
    try {
      await api.post('/api/auth/logout');
    } finally {
      await forgetOwnerKey();
      onSignOut();
    }
  }

  return (
    <AgentWindowContext value={openAgent}>
    <UpdateSaysIt value={company && showsUpdate(updates)}>
    <div className="shell">
      <header className="topbar">
        <div className="tb-brand glass">
          <LogoMark />
          <span className="sr">{me.company.name}</span>
        </div>
        <ShellTabs tab={tab} waiting={decisions.waiting} navigate={navigate} />
        <ShellAccount me={currentMe} menu={menu} setMenu={setMenu} company={company} inbox={inbox} navigate={navigate} openAccount={openAccount} onSignOut={() => void signOut()} onContact={() => setContact(true)} toDecide={toDecide} account={account} accountButton={accountButton} />
      </header>
      {/* The bars of the shell stand first in the page, each in its own row under the header, and what the page shows
          comes after them. */}
      <main className={`body${tab === 'map' ? '' : ' page'}${shownPanel ? ` with-${shownPanel}` : ''}${tab === 'tasks' ? ' tracker-page' : ''}`}>
        <SwitchBanner>
          {company && <UpdateBanner updates={updates} onDetails={() => openAccount({ kind: 'versions' })} />}
          <RecoveryBanner me={currentMe} again={accountDialog} onOpen={() => openAccount({ kind: 'settings', group: 'company' })} />
        </SwitchBanner>
        <AgentWindowError shown={windows.shown} org={org} failure={orgFailure} />
        {deptId && !unavailableFailure(orgFailure) && <LoadFailure failure={orgFailure} />}
        {(route.kind === 'unavailable' || route.kind === 'invite' || missingDepartment || denied) && <RouteUnavailable onHome={goHome} />}
        <GuardBoundary block="map" reset={deptId}>
          <MapWorkspace tab={tab} me={me} dept={dept} deptId={deptId} denied={denied} missingDepartment={missingDepartment} panel={shownPanel} goHome={goHome} openAgent={openAgent} navigate={navigate} openDecisions={openDecisions} />
        </GuardBoundary>
        <GuardBoundary block="department" reset={deptId}>
        <DepartmentWorkspace tab={tab} me={me} dept={dept} deptId={deptId} denied={denied} missingDepartment={missingDepartment} org={org} orgFailure={orgFailure} shown={windows.shown} panel={shownPanel} goHome={goHome} openAgent={openAgent} openTask={openTask} openDecisions={openDecisions} openTracker={id => navigate({ kind: 'tasks', department: id })} openDepartment={id => navigate({ kind: 'department', id })} onHire={dept => {
          setStaff({ id: dept.id, name: deptLabel(t, dept), at: Date.now() });
          openAgent('orchestrator');
        }} />
        </GuardBoundary>
        {tab === 'tasks' && (
          <GuardBoundary block="tasks">
          <Tasks
            me={currentMe}
            place={trackerPlace}
            onPlace={toPlace}
            onHome={goHome}
            decisions={decisions.all}
            decisionsFailure={decisions.failure}
            onDecisionsChanged={decisions.load}
            selected={taskId}
            onOpenTask={openTask}
            onOpenGoal={openGoal}
            onOpenAgent={openAgent}
            onOpenOrchestrator={company ? () => openAgent('orchestrator') : undefined}
          />
          </GuardBoundary>
        )}
        {pageRoute.kind === 'people' && <People me={currentMe} selected={pageRoute.id ?? null} onSelect={id => navigate(id ? { kind: 'people', id } : { kind: 'people' })} onHome={goHome} onRenamed={setSelfName} />}
        {tab === 'subscriptions' && <Subscriptions me={me} onHome={goHome} />}
        {pageRoute.kind === 'machines' && <Machines me={me} selected={pageRoute.id ?? null} onSelect={id => navigate(id ? { kind: 'machines', id } : { kind: 'machines' })} onHome={goHome} />}
        {company && <CompanyPage tab={tab} improvements={{ improvements, failure: improvementsFailure, load: loadImprovements }} inbox={inbox} onTask={openTask} onHome={goHome} />}
      </main>
      <AgentWindows windows={windows} onOpen={openAgent} me={me} org={org} staff={staff} requests={decisions.requests} onRequestsChanged={decisions.load} />
      <LightNotice />
      {contact && <FirstContact onClose={closeContact} />}
      {taskId && card === 'task' && (
        <TaskPanel
          key={`task:${taskId}`}
          taskId={taskId}
          kind={tab === 'tasks' ? 'at-end' : undefined}
          active={!accountDialog && !menu}
          onClose={() => navigate(pageRoute)}
          onOpen={openTask}
          onOpenGoal={openGoal}
          onGraph={openGraph}
          onHome={goHome}
          requests={decisions.requestsOf(taskId)}
          onRequestsChanged={decisions.load}
          onOpenAgent={openAgent}
        />
      )}
      {taskId && card === 'goal' && (
        <GoalPanel
          key={`goal:${taskId}`}
          goalId={taskId}
          kind={tab === 'tasks' ? 'at-end' : undefined}
          active={!accountDialog && !menu}
          onClose={() => navigate(pageRoute)}
          onOpen={openTask}
          onOpenGoal={openGoal}
          onGraph={openGraph}
          onHome={goHome}
        />
      )}
      <AccountDialog route={!accountDialog || (!company && accountDialog === 'versions') ? null : route} me={currentMe} updates={updates} inbox={inbox} onHome={goHome} onRenamed={setSelfName} onGroup={group => switchOverlay(group ? { kind: 'settings', group } : { kind: 'settings' })} onClose={() => { closeOverlay(); accountButton.current?.focus(); }} />
      {company && updates.cut && <UpdateCut cut={updates.cut} updates={updates} />}
    </div>
    </UpdateSaysIt>
    </AgentWindowContext>
  );
}
