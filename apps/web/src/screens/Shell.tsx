import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { deptLabel, LANGUAGES, useLanguage, useT } from '../i18n';
import { useOrg } from '../org';
import { currentTheme, setTheme, type Theme } from '../theme';
import type { Me } from '../types';
import { AgentCard } from '../ui/AgentCard';
import { LogoMark } from '../ui/icons';
import { UpdateBanner } from '../ui/UpdateBanner';
import { useVersion, versionText } from '../ui/VersionMark';
import { useImprovements, useRequests } from '../tasks';
import { TaskPanel } from '../ui/TaskPanel';
import { useUpdates } from '../updates';
import { AgentWindow, type StaffAsk } from './AgentWindow';
import { DepartmentView } from './Department';
import { Improvements } from './Improvements';
import { MapScreen } from './Map';
import { People } from './People';
import { Settings } from './Settings';
import { Subscriptions } from './Subscriptions';
import { Tasks } from './Tasks';
import { Versions } from './Versions';

type Tab = 'map' | 'tasks' | 'people' | 'subscriptions' | 'improvements';
/* The right panel: an agent's terminal or its card, or a task. agentId is 'orchestrator' or an employee's id. */
type Panel = { kind: 'window' | 'card'; agentId: string } | { kind: 'task'; taskId: string } | null;
const TABS: Tab[] = ['map', 'tasks', 'people', 'subscriptions'];
const THEMES: Theme[] = ['light', 'dark'];

/* onImprovements, onVersions and onSettings: only for people who see the whole company. */
function AccountMenu({
  me,
  onClose,
  onSignOut,
  onImprovements,
  onVersions,
  onSettings,
  toDecide,
}: {
  me: Me;
  onClose: () => void;
  onSignOut: () => void;
  onImprovements?: () => void;
  onVersions?: () => void;
  onSettings?: () => void;
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
  const { org } = useOrg(panel !== null || deptId !== null);
  const dept = deptId ? org?.departments.find(d => d.id === deptId) : undefined;
  /* A department removed while its view was open closes the view. */
  useEffect(() => {
    if (org && deptId && !dept) setDeptId(null);
  }, [org, deptId, dept]);
  const updates = useUpdates(company);
  /* What agents wait for, counted in the navigation. */
  const { requests, load: loadRequests } = useRequests();
  const waiting = requests?.length ?? 0;
  const { improvements, failure: improvementsFailure, load: loadImprovements } = useImprovements(company);
  const toDecide = improvements?.filter(i => i.status === 'open').length ?? 0;
  const agentPanel = panel && panel.kind !== 'task' ? panel : null;
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    <div className="shell">
      <header className="topbar">
        <div className="tb-brand glass">
          <LogoMark />
          <span className="sr">{me.company.name}</span>
        </div>
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
                onClick={() => setTab(id)}
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
            {menu && <AccountMenu me={me} onClose={() => setMenu(false)} onSignOut={signOut} onImprovements={company ? () => setTab('improvements') : undefined} onVersions={company ? () => setVersionsOpen(true) : undefined} onSettings={company ? () => setSettingsOpen(true) : undefined} toDecide={toDecide} />}
          </div>
        </div>
      </header>
      {company && <UpdateBanner updates={updates} onDetails={() => setVersionsOpen(true)} />}
      <main className={`body${panel ? ` with-${panel.kind}` : ''}`}>
        {tab === 'map' && (
          <MapScreen
            me={me}
            windowOpen={panel !== null}
            onOpenOrchestrator={() => setPanel({ kind: 'window', agentId: 'orchestrator' })}
            inside={!!dept}
            onOpenDepartment={setDeptId}
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
            onBack={() => setDeptId(null)}
            onOpen={agentId => setPanel({ kind: 'window', agentId })}
            onOpenTask={taskId => setPanel({ kind: 'task', taskId })}
            onHire={() => {
              setStaff({ id: dept.id, name: deptLabel(t, dept), at: Date.now() });
              setPanel({ kind: 'window', agentId: 'orchestrator' });
            }}
          />
        )}
        {tab === 'tasks' && (
          <Tasks
            me={me}
            requests={requests}
            onRequestsChanged={loadRequests}
            selected={panel?.kind === 'task' ? panel.taskId : null}
            onOpenTask={taskId => setPanel({ kind: 'task', taskId })}
            onOpenAgent={agentId => setPanel({ kind: 'window', agentId })}
            onOpenOrchestrator={company ? () => setPanel({ kind: 'window', agentId: 'orchestrator' }) : undefined}
          />
        )}
        {tab === 'people' && <People me={me} />}
        {tab === 'subscriptions' && <Subscriptions me={me} />}
        {tab === 'improvements' && company && <Improvements improvements={improvements} failure={improvementsFailure} onChanged={loadImprovements} onTask={taskId => setPanel({ kind: 'task', taskId })} />}
      </main>
      {panel?.kind === 'window' && org && (
        <AgentWindow
          key={panel.agentId}
          me={me}
          org={org}
          agentId={panel.agentId}
          staff={panel.agentId === 'orchestrator' ? staff : null}
          onClose={() => setPanel(null)}
          onCard={() => setPanel({ kind: 'card', agentId: panel.agentId })}
        />
      )}
      {panel?.kind === 'task' && (
        <TaskPanel
          key={panel.taskId}
          taskId={panel.taskId}
          onClose={() => setPanel(null)}
          onOpen={taskId => setPanel({ kind: 'task', taskId })}
          requests={(requests ?? []).filter(r => r.task.id === panel.taskId)}
          company={company}
          onRequestsChanged={loadRequests}
          onOpenAgent={agentId => setPanel({ kind: 'window', agentId })}
        />
      )}
      {panel?.kind === 'card' && (
        <AgentCard key={panel.agentId} me={me} agentId={panel.agentId} onClose={() => setPanel(null)} onTerminal={() => setPanel({ kind: 'window', agentId: panel.agentId })} />
      )}
      {versionsOpen && <Versions updates={updates} onClose={() => setVersionsOpen(false)} />}
      {settingsOpen && <Settings me={me} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
