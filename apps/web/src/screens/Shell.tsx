import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { deptLabel, errorText, LANGUAGES, useLanguage, useT } from '../i18n';
import { useOrg } from '../org';
import { currentTheme, setTheme, type Theme } from '../theme';
import type { Me, Org } from '../types';
import { LogoMark } from '../ui/icons';
import { UpdateBanner } from '../ui/UpdateBanner';
import { UpdateCut } from '../ui/UpdateCut';
import { useVersion, versionText } from '../ui/VersionMark';
import { useDecisions, useImprovements } from '../tasks';
import { TaskPanel } from '../ui/TaskPanel';
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

type Tab = 'map' | 'tasks' | 'people' | 'subscriptions' | 'machines' | 'improvements';
const TABS: Tab[] = ['map', 'tasks', 'people', 'subscriptions', 'machines'];
const THEMES: Theme[] = ['light', 'dark'];

type AccountDialogName = 'about' | 'versions' | 'profile' | 'settings';

function AccountDialog({ active, me, updates, onRenamed, onClose }: { active: AccountDialogName | null; me: Me; updates: Updates; onRenamed: (name: string) => void; onClose: () => void }) {
  if (!active) return null;
  return {
    about: <About onClose={onClose} />,
    versions: <Versions updates={updates} onClose={onClose} />,
    profile: <Profile me={me} onRenamed={onRenamed} onClose={onClose} />,
    settings: <Settings me={me} onClose={onClose} />,
  }[active];
}

/* onImprovements, onVersions and onSettings: only for people who see the whole company. */
function AccountMenu({
  me,
  onClose,
  onSignOut,
  onImprovements,
  onVersions,
  onProfile,
  onSettings,
  onAbout,
  toDecide,
}: {
  me: Me;
  onClose: () => void;
  onSignOut: () => void;
  onImprovements?: () => void;
  onVersions?: () => void;
  onProfile: () => void;
  onSettings?: () => void;
  onAbout: () => void;
  toDecide: number;
}) {
  const t = useT();
  const { language, setLanguage } = useLanguage();
  const [theme, setThemeState] = useState<Theme>(currentTheme);
  const version = useVersion();

  function pickTheme(next: Theme) {
    setTheme(next);
    setThemeState(next);
  }

  return (
    <div className="account-menu">
      <p>
        <b>{me.person.name}</b>
        <span>{me.person.email}</span>
      </p>
      <div className="menu-row" role="group" aria-label={t.shell.theme}>
        <span>{t.shell.theme}</span>
        <div className="seg">
          {THEMES.map(id => (
            <button key={id} type="button" aria-pressed={theme === id} onClick={() => pickTheme(id)}>
              {t.shell[id]}
            </button>
          ))}
        </div>
      </div>
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

/* What waits for people as the navigation counts it and the screens show it, and whose decisions the Tasks screen shows
   after a click on a person's card: null shows everyone's. */
function useDecisionsView() {
  const { decisions, load } = useDecisions();
  const [personId, showPerson] = useState<string | null>(null);
  const requests = decisions?.requests ?? [];
  return {
    all: decisions,
    requests,
    load,
    /* What agents ask, the orchestrator's cards and his request for the computer. */
    waiting: decisions?.counts.total ?? 0,
    personId,
    showPerson,
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

/* welcome: setup just finished, so the orchestrator's window opens at once. */
export function Shell({ me, welcome = false, onSignOut }: { me: Me; welcome?: boolean; onSignOut: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('map');
  const [menu, setMenu] = useState(false);
  const [selfName, setSelfName] = useState(me.person.name);
  const currentMe = { ...me, person: { ...me.person, name: selfName } };
  const company = me.person.scopeKind === 'company';
  /* The orchestrator's window opens over the map, for people who see the whole company. */
  const windows = useAgentWindows(welcome && company ? 'orchestrator' : null);
  /* A task's panel stands on the left, on its own: it and a window on the screen take each other's place. */
  const [taskId, setTaskId] = useState<string | null>(null);
  const [deptId, setDeptId] = useState<string | null>(null);
  const [staff, setStaff] = useState<StaffAsk | null>(null);
  const { org, failure: orgFailure } = useOrg(windows.ids.length > 0 || taskId !== null || deptId !== null);
  const orchestratorId = org?.orchestrator?.id;
  if (orchestratorId && windows.ids.includes(orchestratorId)) windows.nameOrchestrator(orchestratorId);
  const { open: openWindow, hide: hideWindow } = windows;
  const openAgent = useCallback((agentId: string) => {
    setTaskId(null);
    openWindow(agentId);
  }, [openWindow]);
  const openTask = useCallback((id: string) => {
    hideWindow();
    setTaskId(id);
  }, [hideWindow]);
  const shownPanel = windows.shown ? 'window' : taskId ? 'task' : null;
  const dept = deptId ? org?.departments.find(d => d.id === deptId) : undefined;
  /* A department removed while its view was open closes the view. */
  useEffect(() => {
    if (org && deptId && !dept) setDeptId(null);
  }, [org, deptId, dept]);
  const updates = useUpdates(company);
  const decisions = useDecisionsView();
  /* A person's card, on the map or in a department, opens the decisions screen showing theirs. */
  const openDecisions = (personId: string) => {
    setDeptId(null);
    decisions.showPerson(personId);
    setTab('tasks');
  };
  const { improvements, failure: improvementsFailure, load: loadImprovements } = useImprovements(company);
  const toDecide = improvements?.filter(i => i.status === 'open').length ?? 0;
  const [accountDialog, setAccountDialog] = useState<AccountDialogName | null>(null);
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
        <nav className="tabs glass" aria-label={t.shell.sections}>
          {TABS.map(id => {
            const count = id === 'tasks' ? decisions.waiting : 0;
            return (
              <button
                key={id}
                type="button"
                className={tab === id ? 'on' : ''}
                aria-current={tab === id ? 'page' : undefined}
                aria-label={count ? t.tasks.navWaiting(count) : undefined}
                onClick={() => {
                  setTab(id);
                  decisions.showPerson(null);
                }}
              >
                {t.shell.tabs[id]}
                {count > 0 && <span className="nav-count" aria-hidden="true">{count}</span>}
              </button>
            );
          })}
        </nav>
        <div className="tb-right">
          <div className="account" ref={account}>
            <button ref={accountButton} className="avatar glass" type="button" aria-label={t.shell.account} aria-expanded={menu} onClick={() => setMenu(!menu)}>
              {currentMe.person.name.trim().charAt(0).toUpperCase()}
            </button>
            {menu && <AccountMenu me={currentMe} onClose={() => setMenu(false)} onSignOut={() => void signOut()} onImprovements={company ? () => setTab('improvements') : undefined} onVersions={company ? () => setAccountDialog('versions') : undefined} onProfile={() => setAccountDialog('profile')} onSettings={company ? () => setAccountDialog('settings') : undefined} onAbout={() => setAccountDialog('about')} toDecide={toDecide} />}
          </div>
        </div>
      </header>
      {company && <UpdateBanner updates={updates} onDetails={() => setAccountDialog('versions')} />}
      <main className={`body${tab === 'map' ? '' : ' page'}${shownPanel ? ` with-${shownPanel}` : ''}`}>
        <AgentWindowError shown={windows.shown} org={org} failure={orgFailure} />
        {tab === 'map' && (
          <MapScreen
            me={me}
            windowOpen={shownPanel === 'window'}
            leftPanelOpen={shownPanel === 'task'}
            onOpenOrchestrator={() => openAgent('orchestrator')}
            inside={!!dept}
            onOpenDepartment={setDeptId}
            onOpenDecisions={openDecisions}
          />
        )}
        {tab === 'map' && dept && (
          <DepartmentView
            me={me}
            department={dept}
            deputies={org?.people ?? []}
            selected={windows.shown}
            selectedTask={taskId}
            panel={shownPanel}
            serverNow={org?.serverNow}
            onBack={() => setDeptId(null)}
            onOpen={openAgent}
            onOpenTask={openTask}
            onOpenDecisions={openDecisions}
            onHire={() => {
              setStaff({ id: dept.id, name: deptLabel(t, dept), at: Date.now() });
              openAgent('orchestrator');
            }}
          />
        )}
        {tab === 'tasks' && (
          <Tasks
            decisions={decisions.all}
            onDecisionsChanged={decisions.load}
            personId={decisions.personId}
            onClearPerson={() => decisions.showPerson(null)}
            selected={taskId}
            onOpenTask={openTask}
            onOpenAgent={openAgent}
            onOpenOrchestrator={company ? () => openAgent('orchestrator') : undefined}
          />
        )}
        {tab === 'people' && <People me={currentMe} />}
        {tab === 'subscriptions' && <Subscriptions me={me} />}
        {tab === 'machines' && <Machines me={me} />}
        {tab === 'improvements' && company && <Improvements improvements={improvements} failure={improvementsFailure} onChanged={loadImprovements} onTask={openTask} />}
      </main>
      <AgentWindows windows={windows} onOpen={openAgent} me={me} org={org} staff={staff} requests={decisions.requests} onRequestsChanged={decisions.load} />
      {taskId && (
        <TaskPanel
          key={taskId}
          taskId={taskId}
          onClose={() => setTaskId(null)}
          onOpen={setTaskId}
          requests={decisions.requestsOf(taskId)}
          onRequestsChanged={decisions.load}
          onOpenAgent={openAgent}
        />
      )}
      <AccountDialog active={accountDialog} me={currentMe} updates={updates} onRenamed={setSelfName} onClose={() => { setAccountDialog(null); accountButton.current?.focus(); }} />
      {company && updates.cut && <UpdateCut cut={updates.cut} updates={updates} />}
    </div>
    </AgentWindowContext>
  );
}
