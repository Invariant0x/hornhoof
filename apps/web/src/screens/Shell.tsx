import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { LANGUAGES, useLanguage, useT } from '../i18n';
import { useOrg } from '../org';
import { currentTheme, setTheme, type Theme } from '../theme';
import type { Me } from '../types';
import { LogoMark } from '../ui/icons';
import { useVersion, versionText } from '../ui/VersionMark';
import { MapScreen } from './Map';
import { OrchestratorWindow } from './Orchestrator';
import { People } from './People';
import { Subscriptions } from './Subscriptions';

type Tab = 'map' | 'people' | 'subscriptions';
const TABS: Tab[] = ['map', 'people', 'subscriptions'];
const THEMES: Theme[] = ['light', 'dark'];

function AccountMenu({ me, onClose, onSignOut }: { me: Me; onClose: () => void; onSignOut: () => void }) {
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
  const [windowOpen, setWindowOpen] = useState(welcome && company);
  const { org } = useOrg(windowOpen);
  const account = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
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
          {TABS.map(id => (
            <button key={id} type="button" className={tab === id ? 'on' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {t.shell.tabs[id]}
            </button>
          ))}
        </nav>
        <div className="tb-right">
          <div className="account" ref={account}>
            <button className="avatar glass" type="button" aria-label={t.shell.account} aria-expanded={menu} onClick={() => setMenu(!menu)}>
              {me.person.name.trim().charAt(0).toUpperCase()}
            </button>
            {menu && <AccountMenu me={me} onClose={() => setMenu(false)} onSignOut={signOut} />}
          </div>
        </div>
      </header>
      <main className="body">
        {tab === 'map' && <MapScreen me={me} windowOpen={windowOpen} onOpenOrchestrator={() => setWindowOpen(true)} />}
        {tab === 'people' && <People me={me} />}
        {tab === 'subscriptions' && <Subscriptions me={me} />}
      </main>
      {windowOpen && org && <OrchestratorWindow me={me} org={org} onClose={() => setWindowOpen(false)} />}
    </div>
  );
}
