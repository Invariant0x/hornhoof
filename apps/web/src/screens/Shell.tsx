import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../api';
import { deptLabel, errorText, LANGUAGES, useLanguage, useT } from '../i18n';
import { notOpened, useOrg } from '../org';
import type { Me, Org } from '../types';
import { LogoMark } from '../ui/icons';
import { Outbound } from '../ui/Outbound';
import { UpdateBanner } from '../ui/UpdateBanner';
import { UpdateCut } from '../ui/UpdateCut';
import { useVersion, versionText } from '../ui/VersionMark';
import { useDecisions, useImprovements } from '../tasks';
import { TaskPanel } from '../ui/TaskPanel';
import { ThemeChoice, ThemeTemplateDialog } from '../ui/ThemePicker';
import { useUpdates, type Updates } from '../updates';
import { About } from './About';
import type { StaffAsk } from './AgentWindow';
import { AgentWindowContext } from './AgentWindowContext';
import { AgentWindows, useAgentWindows } from './AgentWindows';
import { DepartmentView } from './Department';
import { Improvements } from './Improvements';
import { Machines } from './Machines';
import { MapScreen } from './Map';
import { People } from './People';
import { Profile } from './Profile';
import { Settings } from './Settings';
import { Subscriptions } from './Subscriptions';
import { Tasks } from './Tasks';
import { Versions } from './Versions';
import { takeEscape } from '../ui/escape';
import { useRoute, type Route } from '../routes';
import { departmentIsMissing, RouteUnavailable, unavailableFailure } from './RouteUnavailable';

type Tab = 'map' | 'tasks' | 'people' | 'subscriptions' | 'machines' | 'improvements';
const TABS: Tab[] = ['map', 'tasks', 'people', 'subscriptions', 'machines'];
const ACCOUNT_DIALOGS = ['about', 'versions', 'profile', 'settings', 'theme'] as const;
type AccountDialogName = (typeof ACCOUNT_DIALOGS)[number];

function dialogOf(route: Route): AccountDialogName | null {
  return ACCOUNT_DIALOGS.find(kind => kind === route.kind) ?? null;
}

function workspaceOf(route: Route, backgrounds: Route[]) {
  const accountDialog = dialogOf(route);
  const contentRoute = accountDialog ? backgrounds[0]! : route;
  const taskId = contentRoute.kind === 'tasks' ? contentRoute.id ?? null : null;
  const pageRoute = taskId ? backgrounds[accountDialog ? 1 : 0] ?? { kind: 'tasks' } as const : contentRoute;
  const tab = pageRoute.kind === 'department' ? 'map' : pageRoute.kind;
  const deptId = pageRoute.kind === 'department' ? pageRoute.id : null;
  return { accountDialog, pageRoute, taskId, tab, deptId };
}

function AccountDialog({ active, me, updates, onRenamed, onClose, onHome }: { active: AccountDialogName | null; me: Me; updates: Updates; onRenamed: (name: string) => void; onClose: () => void; onHome: () => void }) {
  if (!active) return null;
  return {
    about: <About onClose={onClose} />,
    versions: <Versions updates={updates} onClose={onClose} onHome={onHome} />,
    profile: <Profile me={me} onRenamed={onRenamed} onClose={onClose} />,
    settings: <Settings me={me} onClose={onClose} onHome={onHome} />,
    theme: <ThemeTemplateDialog onClose={onClose} />,
  }[active];
}

/* onImprovements, onVersions and onSettings: only for people who see the whole company. */
function AccountMenu({
  me,
  onClose,
  onSignOut,
  onOutbound,
  onImprovements,
  onVersions,
  onProfile,
  onSettings,
  onAbout,
  onTemplate,
  toDecide,
}: {
  me: Me;
  onClose: () => void;
  onSignOut: () => void;
  onOutbound: () => void;
  onImprovements?: () => void;
  onVersions?: () => void;
  onProfile: () => void;
  onSettings?: () => void;
  onAbout: () => void;
  onTemplate: () => void;
  toDecide: number;
}) {
  const t = useT();
  const { language, setLanguage } = useLanguage();
  const version = useVersion();

  return (
    <div className="account-menu">
      <p>
        <b>{me.person.name}</b>
        <span>{me.person.email}</span>
      </p>
      <ThemeChoice />
      <button className="btn small ghost" type="button" onClick={() => { onClose(); onTemplate(); }}>
        {t.themeTemplate.menu}
      </button>
      <div className="menu-row" role="group" aria-label={t.shell.language}>
        <span>{t.shell.language}</span>
        <div className="seg">
          {LANGUAGES.map(l => (
            <button key={l.id} type="button" lang={l.id} aria-pressed={language === l.id} onClick={() => setLanguage(l.id)}>
              {l.name}
            </button>
          ))}
        </div>
      </div>
      {version && <p className="menu-version">{t.shell.version(versionText(version))}</p>}
      <button
        className="btn small ghost"
        type="button"
        onClick={() => {
          onClose();
          onOutbound();
        }}
      >
        {t.shell.tabs.outbound}
      </button>
      {onImprovements && (
        <button
          className="btn small ghost"
          type="button"
          aria-label={toDecide ? t.improvements.nav(toDecide) : undefined}
          onClick={() => {
            onClose();
            onImprovements();
          }}
        >
          {t.shell.tabs.improvements}
          {toDecide > 0 && <span className="nav-count" aria-hidden="true">{toDecide}</span>}
        </button>
      )}
      {onVersions && (
        <button
          className="btn small ghost"
          type="button"
          onClick={() => {
            onClose();
            onVersions();
          }}
        >
          {t.updates.menu}
        </button>
      )}
      <button className="btn small ghost" type="button" onClick={() => { onClose(); onProfile(); }}>
        {t.profile.title}
      </button>
      {onSettings && (
        <button
          className="btn small ghost"
          type="button"
          onClick={() => {
            onClose();
            onSettings();
          }}
        >
          {t.settings.menu}
        </button>
      )}
      <button className="btn small ghost" type="button" onClick={() => { onClose(); onAbout(); }}>
        {t.about.menu}
      </button>
      <button
        className="btn small ghost"
        type="button"
        onClick={() => {
          onClose();
          onSignOut();
        }}
      >
        {t.shell.logOut}
      </button>
    </div>
  );
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

function ShellAccount({ me, menu, setMenu, company, navigate, openAccount, onSignOut, toDecide, account, accountButton }: {
  me: Me; menu: boolean; setMenu: (open: boolean) => void; company: boolean;
  navigate: ReturnType<typeof useRoute>['navigate']; openAccount: (kind: AccountDialogName) => void;
  onSignOut: () => void; toDecide: number;
  account: RefObject<HTMLDivElement | null>; accountButton: RefObject<HTMLButtonElement | null>;
}) {
  const t = useT();
  return (
    <div className="tb-right">
      <div className="account" ref={account}>
        <button ref={accountButton} className="avatar glass" type="button" aria-label={t.shell.account} aria-expanded={menu} onClick={() => setMenu(!menu)}>
          {me.person.name.trim().charAt(0).toUpperCase()}
        </button>
        {menu && <AccountMenu me={me} onClose={() => setMenu(false)} onSignOut={onSignOut} onOutbound={() => navigate({ kind: 'outbound' })} onImprovements={company ? () => navigate({ kind: 'improvements' }) : undefined} onVersions={company ? () => openAccount('versions') : undefined} onProfile={() => openAccount('profile')} onSettings={company ? () => openAccount('settings') : undefined} onAbout={() => openAccount('about')} onTemplate={() => openAccount('theme')} toDecide={toDecide} />}
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
  useEffect(() => { message.current?.focus(); }, [shown, org, failure]);
  if (!shown || org || failure === null) return null;
  return <p ref={message} tabIndex={-1} className="alert agent-window-error" role="alert">{errorText(t, failure)}</p>;
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

function DepartmentWorkspace({ tab, me, dept, missingDepartment, org, shown, taskId, panel, goHome, openAgent, openTask, openDecisions, onHire }: MapRouteProps & {
  org: Org | null; shown: string | null; taskId: string | null; panel: 'window' | 'task' | null;
  openTask: (id: string) => void; onHire: (dept: Department) => void;
}) {
  if (tab !== 'map' || !dept || missingDepartment) return null;
  return (
    <DepartmentView
      me={me}
      department={dept}
      deputies={org?.people ?? []}
      selected={shown}
      selectedTask={taskId}
      panel={panel}
      serverNow={org?.serverNow}
      onBack={goHome}
      onOpen={openAgent}
      onOpenTask={openTask}
      onOpenDecisions={openDecisions}
      onHire={() => onHire(dept)}
    />
  );
}

/* welcome: setup just finished, so the orchestrator's window opens at once. */
export function Shell({ me, welcome = false, onSignOut }: { me: Me; welcome?: boolean; onSignOut: () => void }) {
  const t = useT();
  const { route, navigate, backgrounds, closeOverlay } = useRoute();
  const { accountDialog, pageRoute, taskId, tab, deptId } = workspaceOf(route, backgrounds);
  const goHome = () => navigate({ kind: 'map' });
  const openAccount = (kind: AccountDialogName) => navigate({ kind }, route);
  const [menu, setMenu] = useState(false);
  const [selfName, setSelfName] = useState(me.person.name);
  const currentMe = { ...me, person: { ...me.person, name: selfName } };
  const company = me.person.scopeKind === 'company';
  const denied = !company && ['improvements', 'settings', 'versions'].some(kind => kind === route.kind || kind === pageRoute.kind);
  /* The orchestrator's window opens over the map, for people who see the whole company. */
  const windows = useAgentWindows(welcome && company ? 'orchestrator' : null);
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
  const shownPanel = windows.shown ? 'window' : taskId ? 'task' : null;
  const dept = deptId ? org?.departments.find(d => d.id === deptId) : undefined;
  const missingDepartment = departmentIsMissing({ deptId, org, orgFailure });
  const updates = useUpdates(company);
  const decisions = useDecisionsView();
  /* A person's card, on the map or in a department, opens the decisions screen showing theirs. */
  const openDecisions = (personId: string) => {
    navigate({ kind: 'tasks', personId });
  };
  const { improvements, failure: improvementsFailure, load: loadImprovements } = useImprovements(company);
  const toDecide = improvements?.filter(i => i.status === 'open').length ?? 0;
  const account = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);

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

  async function signOut() {
    try {
      await api.post('/api/auth/logout');
    } finally {
      onSignOut();
    }
  }

  return (
    <AgentWindowContext value={openAgent}>
    <div className="shell">
      <header className="topbar">
        <div className="tb-brand glass">
          <LogoMark />
          <span className="sr">{me.company.name}</span>
        </div>
        <ShellTabs tab={tab} waiting={decisions.waiting} navigate={navigate} />
        <ShellAccount me={currentMe} menu={menu} setMenu={setMenu} company={company} navigate={navigate} openAccount={openAccount} onSignOut={() => void signOut()} toDecide={toDecide} account={account} accountButton={accountButton} />
      </header>
      {company && <UpdateBanner updates={updates} onDetails={() => openAccount('versions')} />}
      <main className={`body${tab === 'map' ? '' : ' page'}${shownPanel ? ` with-${shownPanel}` : ''}`}>
        <AgentWindowError shown={windows.shown} org={org} failure={orgFailure} />
        {(route.kind === 'unavailable' || route.kind === 'invite' || missingDepartment || denied) && <RouteUnavailable onHome={goHome} />}
        {deptId && orgFailure !== null && !unavailableFailure(orgFailure) && <p className="alert" role="alert">{errorText(t, orgFailure)}</p>}
        <MapWorkspace tab={tab} me={me} dept={dept} deptId={deptId} denied={denied} missingDepartment={missingDepartment} panel={shownPanel} goHome={goHome} openAgent={openAgent} navigate={navigate} openDecisions={openDecisions} />
        <DepartmentWorkspace tab={tab} me={me} dept={dept} missingDepartment={missingDepartment} org={org} shown={windows.shown} taskId={taskId} panel={shownPanel} goHome={goHome} openAgent={openAgent} openTask={openTask} openDecisions={openDecisions} onHire={dept => {
          setStaff({ id: dept.id, name: deptLabel(t, dept), at: Date.now() });
          openAgent('orchestrator');
        }} />
        {tab === 'tasks' && (
          <Tasks
            onHome={goHome}
            decisions={decisions.all}
            decisionsFailure={decisions.failure}
            onDecisionsChanged={decisions.load}
            personId={pageRoute.kind === 'tasks' ? pageRoute.personId ?? null : null}
            onClearPerson={() => navigate({ kind: 'tasks' })}
            selected={taskId}
            onOpenTask={openTask}
            onOpenAgent={openAgent}
            onOpenOrchestrator={company ? () => openAgent('orchestrator') : undefined}
          />
        )}
        {pageRoute.kind === 'people' && <People me={currentMe} selected={pageRoute.id ?? null} onSelect={id => navigate(id ? { kind: 'people', id } : { kind: 'people' })} onHome={goHome} onRenamed={setSelfName} />}
        {tab === 'subscriptions' && <Subscriptions me={me} onHome={goHome} />}
        {pageRoute.kind === 'machines' && <Machines me={me} selected={pageRoute.id ?? null} onSelect={id => navigate(id ? { kind: 'machines', id } : { kind: 'machines' })} onHome={goHome} />}
        {tab === 'outbound' && <Outbound onOpenTask={openTask} onHome={goHome} />}
        {tab === 'improvements' && company && <Improvements improvements={improvements} failure={improvementsFailure} onChanged={loadImprovements} onTask={openTask} onHome={goHome} />}
      </main>
      <AgentWindows windows={windows} onOpen={openAgent} me={me} org={org} staff={staff} requests={decisions.requests} onRequestsChanged={decisions.load} />
      {taskId && (
        <TaskPanel
          key={taskId}
          taskId={taskId}
          active={!accountDialog && !menu}
          onClose={() => navigate(pageRoute)}
          onOpen={openTask}
          onHome={goHome}
          requests={decisions.requestsOf(taskId)}
          onRequestsChanged={decisions.load}
          onOpenAgent={openAgent}
        />
      )}
      <AccountDialog active={!company && (accountDialog === 'settings' || accountDialog === 'versions') ? null : accountDialog} me={currentMe} updates={updates} onHome={goHome} onRenamed={setSelfName} onClose={() => { closeOverlay(); accountButton.current?.focus(); }} />
      {company && updates.cut && <UpdateCut cut={updates.cut} updates={updates} />}
    </div>
    </AgentWindowContext>
  );
}
