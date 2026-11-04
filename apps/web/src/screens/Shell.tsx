import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { deptLabel, errorText, LANGUAGES, useLanguage, useT } from '../i18n';
import { liveOf, useOrg } from '../org';
import { currentTheme, setTheme, type Theme } from '../theme';
import type { Me, Org } from '../types';
import { AgentCard } from '../ui/AgentCard';
import { LogoMark } from '../ui/icons';
import { UpdateBanner } from '../ui/UpdateBanner';
import { useVersion, versionText } from '../ui/VersionMark';
import { useDecisions, useImprovements } from '../tasks';
import { TaskPanel } from '../ui/TaskPanel';
import { useUpdates, type Updates } from '../updates';
import { About } from './About';
import { AgentWindow, type StaffAsk } from './AgentWindow';
import { AgentWindowContext } from './AgentWindowContext';
import { DepartmentView } from './Department';
import { Improvements } from './Improvements';
import { Machines } from './Machines';
import { MapScreen } from './Map';
import { People } from './People';
import { Settings } from './Settings';
import { Subscriptions } from './Subscriptions';
import { Tasks } from './Tasks';
import { Versions } from './Versions';

type Tab = 'map' | 'tasks' | 'people' | 'subscriptions' | 'machines' | 'improvements';
/* The agent window is on the right, settings and tasks on the left. agentId is 'orchestrator' or an employee's id. */
type Panel = { kind: 'window' | 'card'; agentId: string; request?: number } | { kind: 'task'; taskId: string } | null;
const TABS: Tab[] = ['map', 'tasks', 'people', 'subscriptions', 'machines'];
const THEMES: Theme[] = ['light', 'dark'];

function mapPanels(panel: Panel) {
  return { windowOpen: panel?.kind === 'window', leftPanelOpen: panel !== null && panel.kind !== 'window' };
}

type AccountDialogName = 'about' | 'versions' | 'settings';

function AccountDialog({ active, me, updates, onClose }: { active: AccountDialogName | null; me: Me; updates: Updates; onClose: () => void }) {
  if (!active) return null;
  return {
    about: <About onClose={onClose} />,
    versions: <Versions updates={updates} onClose={onClose} />,
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
  onSettings,
  onAbout,
  toDecide,
}: {
  me: Me;
  onClose: () => void;
  onSignOut: () => void;
  onImprovements?: () => void;
  onVersions?: () => void;
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

/* An explicit opening also brings a minimized window back, including when its agent did not change. */
function useAgentOpener(setPanel: (panel: Panel) => void) {
  const requests = useRef(0);
  return useCallback((agentId: string) => {
    setPanel({ kind: 'window', agentId, request: ++requests.current });
  }, [setPanel]);
}

/* Resolve the orchestrator after the company loads too, since lists may open before that response arrives. */
function agentPanelFor(panel: Panel, org: Org | null) {
  if (!panel || panel.kind === 'task') return null;
  const agentId = panel.agentId === org?.orchestrator?.id ? 'orchestrator' : panel.agentId;
  return { ...panel, agentId };
}

function AgentWindowError({ panel, org, failure }: { panel: Panel; org: Org | null; failure: unknown }) {
  const t = useT();
  const message = useRef<HTMLParagraphElement>(null);
  useEffect(() => { message.current?.focus(); }, [panel, org, failure]);
  if (panel?.kind !== 'window' || org || failure === null) return null;
  return <p ref={message} tabIndex={-1} className="alert" role="alert">{errorText(t, failure)}</p>;
}

/* welcome: setup just finished, so the orchestrator's window opens at once. */
export function Shell({ me, welcome = false, onSignOut }: { me: Me; welcome?: boolean; onSignOut: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('map');
  const [menu, setMenu] = useState(false);
  const company = me.person.scopeKind === 'company';
  /* The orchestrator's window opens over the map, for people who see the whole company. */
  const [panel, setPanel] = useState<Panel>(welcome && company ? { kind: 'window', agentId: 'orchestrator' } : null);
  const [deptId, setDeptId] = useState<string | null>(null);
  const [staff, setStaff] = useState<StaffAsk | null>(null);
  const { org, failure: orgFailure } = useOrg(panel !== null || deptId !== null);
  const openAgent = useAgentOpener(setPanel);
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
  const agentPanel = agentPanelFor(panel, org);
  const [accountDialog, setAccountDialog] = useState<AccountDialogName | null>(null);
  const account = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(false);
      accountButton.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!account.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
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
              {me.person.name.trim().charAt(0).toUpperCase()}
            </button>
            {menu && <AccountMenu me={me} onClose={() => setMenu(false)} onSignOut={() => void signOut()} onImprovements={company ? () => setTab('improvements') : undefined} onVersions={company ? () => setAccountDialog('versions') : undefined} onSettings={company ? () => setAccountDialog('settings') : undefined} onAbout={() => setAccountDialog('about')} toDecide={toDecide} />}
          </div>
        </div>
      </header>
      {company && <UpdateBanner updates={updates} onDetails={() => setAccountDialog('versions')} />}
      <main className={`body${tab === 'map' ? '' : ' page'}${panel ? ` with-${panel.kind}` : ''}`}>
        <AgentWindowError panel={panel} org={org} failure={orgFailure} />
        {tab === 'map' && (
          <MapScreen
            me={me}
            {...mapPanels(panel)}
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
            selected={agentPanel?.agentId ?? null}
            selectedTask={panel?.kind === 'task' ? panel.taskId : null}
            panel={panel?.kind ?? null}
            serverNow={org?.serverNow}
            onBack={() => setDeptId(null)}
            onOpen={openAgent}
            onOpenTask={taskId => setPanel({ kind: 'task', taskId })}
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
            selected={panel?.kind === 'task' ? panel.taskId : null}
            onOpenTask={taskId => setPanel({ kind: 'task', taskId })}
            onOpenAgent={openAgent}
            onOpenOrchestrator={company ? () => openAgent('orchestrator') : undefined}
          />
        )}
        {tab === 'people' && <People me={me} />}
        {tab === 'subscriptions' && <Subscriptions me={me} />}
        {tab === 'machines' && <Machines me={me} />}
        {tab === 'improvements' && company && <Improvements improvements={improvements} failure={improvementsFailure} onChanged={loadImprovements} onTask={taskId => setPanel({ kind: 'task', taskId })} />}
      </main>
      {agentPanel?.kind === 'window' && org && (
        <AgentWindow
          key={agentPanel.agentId}
          me={me}
          org={org}
          agentId={agentPanel.agentId}
          openRequest={agentPanel.request}
          requests={decisions.requests}
          onRequestsChanged={decisions.load}
          staff={agentPanel.agentId === 'orchestrator' ? staff : null}
          onClose={() => setPanel(null)}
          onCard={() => setPanel({ kind: 'card', agentId: agentPanel.agentId })}
        />
      )}
      {panel?.kind === 'task' && (
        <TaskPanel
          key={panel.taskId}
          taskId={panel.taskId}
          onClose={() => setPanel(null)}
          onOpen={taskId => setPanel({ kind: 'task', taskId })}
          requests={decisions.requestsOf(panel.taskId)}
          onRequestsChanged={decisions.load}
          onOpenAgent={openAgent}
        />
      )}
      {agentPanel?.kind === 'card' && (
        <AgentCard key={agentPanel.agentId} me={me} agentId={agentPanel.agentId} {...liveOf(org, agentPanel.agentId)} onClose={() => setPanel(null)} onTerminal={() => openAgent(agentPanel.agentId)} />
      )}
      <AccountDialog active={accountDialog} me={me} updates={updates} onClose={() => { setAccountDialog(null); accountButton.current?.focus(); }} />
    </div>
    </AgentWindowContext>
  );
}
